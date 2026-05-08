const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadModules(names, extraContext = {}) {
  const context = vm.createContext({
    console,
    URL,
    fetch,
    setTimeout,
    clearTimeout,
    Zotero: {
      debug() {},
      Item: FakeZoteroItem
    },
    ...extraContext
  });

  for (const name of names) {
    const file = path.join(ROOT, "src", "chrome", "content", "modules", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }

  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeZoteroItem {
  constructor(itemType) {
    this.itemType = itemType;
    this.fields = {};
    this.creators = [];
    this.tags = [];
    this.collections = [];
  }

  setField(field, value) {
    this.fields[field] = value;
  }

  setCreators(creators) {
    this.creators = creators;
  }

  addTag(tag) {
    this.tags.push(tag);
  }

  addToCollection(collectionID) {
    this.collections.push(collectionID);
  }
}

test("utility helpers chunk, normalize text, and format scores", () => {
  const { SnowballUtil } = loadModules(["util.js"]);

  assert.deepEqual(plain(SnowballUtil.chunk([1, 2, 3, 4, 5], 2)), [[1, 2], [3, 4], [5]]);
  assert.equal(SnowballUtil.normalizeText("  A Study: of Snowball-Sources!! "), "a study of snowball sources");
  assert.equal(SnowballUtil.formatScore(0.834), 83);
});

test("Zotero item helpers normalize seeds and map OpenAlex candidates", () => {
  const { SnowballZoteroItems } = loadModules(["zoteroItems.js"]);

  assert.equal(SnowballZoteroItems.normalizeDOI(" https://doi.org/10.123/ABC "), "10.123/abc");
  assert.equal(SnowballZoteroItems.normalizeDOI("doi:10.555/XYZ"), "10.555/xyz");
  assert.equal(SnowballZoteroItems.extractYear("online first 2024-05-01"), 2024);
  assert.equal(SnowballZoteroItems.extractYear("no date"), null);
  assert.equal(SnowballZoteroItems.mapItemType("book-chapter"), "bookSection");
  assert.equal(SnowballZoteroItems.mapItemType("dataset"), "dataset");
  assert.equal(SnowballZoteroItems.mapItemType("article"), "journalArticle");

  const item = SnowballZoteroItems.createZoteroItemFromCandidate({
    type: "article",
    title: "Candidate Source",
    publicationDate: "2024-05-01",
    doi: "https://doi.org/10.1000/Test",
    url: "https://example.test/work",
    abstract: "Local abstract",
    venue: "Journal of Tests",
    authors: [{ firstName: "Jane", lastName: "Smith" }]
  }, 7);

  assert.equal(item.libraryID, 7);
  assert.equal(item.itemType, "journalArticle");
  assert.equal(item.fields.title, "Candidate Source");
  assert.equal(item.fields.DOI, "10.1000/test");
  assert.equal(item.fields.publicationTitle, "Journal of Tests");
  assert.deepEqual(plain(item.creators), [{ firstName: "Jane", lastName: "Smith", creatorType: "author" }]);
});

test("OpenAlex provider normalizes, reconstructs, and deduplicates candidates", () => {
  const { OpenAlexProvider } = loadModules(["util.js", "openalex.js"]);
  const provider = new OpenAlexProvider({});

  assert.equal(provider.shortOpenAlexID("https://openalex.org/W123"), "W123");
  assert.equal(provider.reconstructAbstract({ snowball: [1], sources: [2], Find: [0] }), "Find snowball sources");
  assert.deepEqual(plain(provider.extractAuthors([
    { author: { display_name: "Jane Q Smith" } },
    { author: { display_name: "Prince" } }
  ])), [
    { name: "Jane Q Smith", firstName: "Jane Q", lastName: "Smith" },
    { name: "Prince", firstName: "", lastName: "Prince" }
  ]);

  const candidate = provider.normalizeCandidate({
    id: "https://openalex.org/W1",
    doi: "https://doi.org/10.1/ABC",
    display_name: "Forward Source",
    publication_year: 2025,
    publication_date: "2025-01-02",
    type: "article",
    cited_by_count: 42,
    primary_location: {
      landing_page_url: "https://publisher.test/work",
      pdf_url: "https://publisher.test/work.pdf",
      source: { display_name: "Test Venue" }
    },
    abstract_inverted_index: { hello: [0], world: [1] },
    authorships: [{ author: { display_name: "Jane Smith" } }]
  }, {
    direction: "forward",
    seed: { title: "Seed", zoteroItemID: 99 }
  });

  assert.equal(candidate.provider, "openalex");
  assert.equal(candidate.title, "Forward Source");
  assert.equal(candidate.venue, "Test Venue");
  assert.equal(candidate.abstract, "hello world");
  assert.equal(candidate.seedZoteroItemID, 99);

  const deduped = provider.deduplicateCandidates([
    { doi: "10.1/abc", openAlexID: "W1", direction: "forward", citedByCount: 5, abstract: "" },
    { doi: "10.1/ABC", openAlexID: "W1", direction: "backward", citedByCount: 9, abstract: "later abstract" },
    { title: "No DOI", year: 2023, direction: "forward", citedByCount: 1 }
  ]);

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].direction, "both");
  assert.equal(deduped[0].citedByCount, 9);
  assert.equal(deduped[0].abstract, "later abstract");
});

test("ranking prefers overlapping new candidates and penalizes existing duplicates", () => {
  const { SnowballRanking } = loadModules(["ranking.js"]);
  const seedRecords = [{
    title: "Citation snowball systematic review",
    abstract: "Evidence synthesis and citation chasing for research discovery"
  }];

  const scored = SnowballRanking.scoreCandidates([
    {
      title: "Unrelated particle physics note",
      abstract: "Collider event selection",
      citedByCount: 100,
      direction: "forward",
      alreadyInLibrary: false
    },
    {
      title: "Citation chasing for systematic evidence synthesis",
      abstract: "Snowball review methods for research discovery",
      citedByCount: 4,
      direction: "both",
      alreadyInLibrary: false
    },
    {
      title: "Citation snowball systematic review",
      abstract: "Evidence synthesis and citation chasing for research discovery",
      citedByCount: 4,
      direction: "forward",
      alreadyInLibrary: true
    }
  ], seedRecords);

  assert.equal(scored[0].title, "Citation chasing for systematic evidence synthesis");
  assert.ok(scored[0].relevanceScore > scored[1].relevanceScore);
  assert.ok(scored[1].relevanceScore > scored[2].relevanceScore);
});
