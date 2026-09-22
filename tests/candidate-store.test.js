const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

// Load the dialog's pure modules into one VM context, the same way the
// dialog XHTML loads them into its window.
function load() {
  const context = vm.createContext({});
  for (const name of ["util.js", "candidateStore.js", "candidateView.js"]) {
    const file = path.join(ROOT, "src", "chrome", "content", "modules", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  return context;
}

// Values created inside the VM have that realm's prototypes; round-trip
// through JSON before deepEqual comparisons.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Mirror the dialog's ingest flow: match, then merge or create + insert.
function ingest(store, Store, raw) {
  const match = store.findMatch(raw);
  if (match.duplicate) {
    Store.mergeDuplicate(match.duplicate, raw);
    return false;
  }
  store.insert(Store.createCandidate(raw, match.trigrams), match.key);
  return true;
}

// ---------- SnowballCandidateStore ------------------------------------------

test("dedupeKey prefers DOI, then OpenAlex ID, then title+year", () => {
  const { SnowballCandidateStore: Store } = load();
  assert.equal(
    Store.dedupeKey({ doi: " 10.1/ABC ", openAlexID: "W1", title: "T" }),
    "doi:10.1/abc"
  );
  assert.equal(Store.dedupeKey({ openAlexID: "W1", title: "T" }), "oa:W1");
  assert.equal(Store.dedupeKey({ title: "  Some Title ", year: 2020 }), "title:some title:2020");
  assert.equal(Store.dedupeKey({ title: "Some Title" }), "title:some title:");
  assert.equal(Store.dedupeKey({}), "");
});

test("insert assigns sequential indexes and selected() returns checked candidates", () => {
  const { SnowballCandidateStore: Store } = load();
  const store = new Store();
  assert.equal(ingest(store, Store, { doi: "10.1/a", title: "Alpha" }), true);
  assert.equal(ingest(store, Store, { doi: "10.1/b", title: "Beta" }), true);
  assert.equal(store.size, 2);
  assert.deepEqual(plain(store.candidates.map((c) => c._index)), [0, 1]);
  store.candidates[1]._selected = true;
  assert.deepEqual(plain(store.selected().map((c) => c.doi)), ["10.1/b"]);
});

test("exact duplicates merge: direction becomes both, citations max, gaps filled", () => {
  const { SnowballCandidateStore: Store } = load();
  const store = new Store();
  ingest(store, Store, {
    doi: "10.1/a",
    title: "Alpha",
    direction: "backward",
    citedByCount: 5,
    abstract: "",
    venue: "",
    referencedWorks: []
  });
  const isNew = ingest(store, Store, {
    doi: "10.1/A",
    title: "Alpha",
    direction: "forward",
    citedByCount: 12,
    abstract: "An abstract",
    venue: "Journal",
    referencedWorks: ["W9"]
  });

  assert.equal(isNew, false);
  assert.equal(store.size, 1);
  const [merged] = store.candidates;
  assert.equal(merged.direction, "both");
  assert.equal(merged.citedByCount, 12);
  assert.equal(merged.abstract, "An abstract");
  assert.equal(merged.venue, "Journal");
  assert.deepEqual(plain(merged.referencedWorks), ["W9"]);
});

test("merge keeps existing fields and direction when the sighting agrees", () => {
  const { SnowballCandidateStore: Store } = load();
  const existing = { direction: "backward", citedByCount: 20, abstract: "Keep me", venue: "V" };
  Store.mergeDuplicate(existing, {
    direction: "backward",
    citedByCount: 3,
    abstract: "Replace?",
    venue: "Other"
  });
  assert.equal(existing.direction, "backward");
  assert.equal(existing.citedByCount, 20);
  assert.equal(existing.abstract, "Keep me");
  assert.equal(existing.venue, "V");
});

test("a later sighting with a DOI is merged into its DOI-less twin by fuzzy title", () => {
  const { SnowballCandidateStore: Store } = load();
  const store = new Store();
  ingest(store, Store, { title: "Attention Is All You Need", year: 2017, direction: "backward" });
  const isNew = ingest(store, Store, {
    title: "Attention is all you need.",
    year: 2017,
    doi: "10.1/attn",
    direction: "forward"
  });
  assert.equal(isNew, false);
  assert.equal(store.size, 1);
  assert.equal(store.candidates[0].doi, "10.1/attn");
  assert.equal(store.candidates[0].direction, "both");
});

test("fuzzy dedupe only compares within the same year", () => {
  const { SnowballCandidateStore: Store } = load();
  const store = new Store();
  ingest(store, Store, { title: "Attention Is All You Need", year: 2017 });
  assert.equal(ingest(store, Store, { title: "Attention Is All You Need", year: 2019 }), true);
  assert.equal(store.size, 2);
});

test("fuzzy dedupe does not merge titles below the similarity threshold", () => {
  const { SnowballCandidateStore: Store } = load();
  const store = new Store();
  ingest(store, Store, { title: "Deep learning for protein folding", year: 2021 });
  assert.equal(
    ingest(store, Store, { title: "Deep learning for weather forecasting", year: 2021 }),
    true
  );
  assert.equal(store.size, 2);
});

test("candidates without a year share one bucket for fuzzy dedupe", () => {
  const { SnowballCandidateStore: Store } = load();
  const store = new Store();
  ingest(store, Store, { title: "An untitled working paper on citation graphs" });
  const isNew = ingest(store, Store, { title: "An Untitled Working Paper on Citation Graphs." });
  assert.equal(isNew, false);
  assert.equal(store.size, 1);
});

// ---------- SnowballCandidateView: filtering + sorting ------------------------

function sample() {
  return [
    {
      title: "Alpha paper",
      venue: "Nature",
      direction: "backward",
      alreadyInLibrary: false,
      citedByCount: 100,
      relevanceScore: 0.4,
      year: 2019,
      authors: [{ name: "Ada Lovelace" }]
    },
    {
      title: "Beta study",
      venue: "Science",
      direction: "forward",
      alreadyInLibrary: true,
      citedByCount: 5,
      relevanceScore: 0.9,
      year: 2022,
      authors: [{ firstName: "Grace", lastName: "Hopper" }]
    },
    {
      title: "Gamma review",
      venue: "",
      direction: "both",
      alreadyInLibrary: false,
      citedByCount: 0,
      relevanceScore: 0.1,
      year: 0,
      authors: []
    }
  ];
}

const titles = (list) => plain(list.map((c) => c.title));

test("filterAndSort defaults to relevance descending and does not mutate input", () => {
  const { SnowballCandidateView: View } = load();
  const input = sample();
  const before = titles(input);
  const out = View.filterAndSort(input, {});
  assert.deepEqual(titles(out), ["Beta study", "Alpha paper", "Gamma review"]);
  assert.deepEqual(titles(input), before);
});

test("filterAndSort hides library items and applies direction (both always passes)", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(titles(View.filterAndSort(sample(), { hideExisting: true })).sort(), [
    "Alpha paper",
    "Gamma review"
  ]);
  assert.deepEqual(titles(View.filterAndSort(sample(), { direction: "backward" })).sort(), [
    "Alpha paper",
    "Gamma review"
  ]);
  assert.deepEqual(titles(View.filterAndSort(sample(), { direction: "forward" })).sort(), [
    "Beta study",
    "Gamma review"
  ]);
  assert.equal(View.filterAndSort(sample(), { direction: "all" }).length, 3);
});

test("filterAndSort text query matches title, author, or venue case-insensitively", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(titles(View.filterAndSort(sample(), { filter: "  HOPPER " })), ["Beta study"]);
  assert.deepEqual(titles(View.filterAndSort(sample(), { filter: "nature" })), ["Alpha paper"]);
  assert.deepEqual(titles(View.filterAndSort(sample(), { filter: "review" })), ["Gamma review"]);
  assert.equal(View.filterAndSort(sample(), { filter: "zzz" }).length, 0);
});

test("filterAndSort applies the minimum citation count", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(titles(View.filterAndSort(sample(), { minCitedBy: 5 })).sort(), [
    "Alpha paper",
    "Beta study"
  ]);
  assert.equal(View.filterAndSort(sample(), { minCitedBy: 0 }).length, 3);
});

test("sorting puts missing values last in both directions", () => {
  const { SnowballCandidateView: View } = load();
  const byYear = (dir) => titles(View.filterAndSort(sample(), { sort: { key: "year", dir } }));
  assert.deepEqual(byYear("desc"), ["Beta study", "Alpha paper", "Gamma review"]);
  assert.deepEqual(byYear("asc"), ["Alpha paper", "Beta study", "Gamma review"]);

  const byVenue = (dir) => titles(View.filterAndSort(sample(), { sort: { key: "venue", dir } }));
  assert.deepEqual(byVenue("asc"), ["Alpha paper", "Beta study", "Gamma review"]);
  assert.deepEqual(byVenue("desc"), ["Beta study", "Alpha paper", "Gamma review"]);
});

test("nextSort flips the active column and picks a default for new columns", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(plain(View.nextSort({ key: "year", dir: "desc" }, "year")), {
    key: "year",
    dir: "asc"
  });
  assert.deepEqual(plain(View.nextSort({ key: "year", dir: "asc" }, "title")), {
    key: "title",
    dir: "asc"
  });
  assert.deepEqual(plain(View.nextSort({ key: "title", dir: "asc" }, "citedByCount")), {
    key: "citedByCount",
    dir: "desc"
  });
});

// ---------- SnowballCandidateView: text ---------------------------------------

test("formatAuthors uses name or first+last, skips blanks, and respects the limit", () => {
  const { SnowballCandidateView: View } = load();
  const c = {
    authors: [
      { name: "A One" },
      { firstName: "B", lastName: "Two" },
      { name: "" },
      { lastName: "Three" },
      { name: "D Four" }
    ]
  };
  assert.equal(View.formatAuthors(c, 5), "A One, B Two, Three, D Four");
  assert.equal(View.formatAuthors(c, 2), "A One, B Two");
  assert.equal(View.formatAuthors({}, 5), "");
});

test("score helpers map scores to percent and color tier", () => {
  const { SnowballCandidateView: View } = load();
  assert.equal(View.scorePercent(0.514), 51);
  assert.equal(View.scorePercent(undefined), 0);
  assert.equal(View.scoreTier(50), "high");
  assert.equal(View.scoreTier(49), "mid");
  assert.equal(View.scoreTier(25), "mid");
  assert.equal(View.scoreTier(24), "low");
});

test("direction and status labels", () => {
  const { SnowballCandidateView: View } = load();
  assert.equal(View.directionLabel("backward"), "← Backward");
  assert.equal(View.directionLabel("forward"), "Forward →");
  assert.equal(View.directionLabel("both"), "↔ Both");
  assert.equal(View.directionLabel(undefined), "");
  assert.deepEqual(plain(View.statusLabel(true)), { text: "In library", kind: "existing" });
  assert.deepEqual(plain(View.statusLabel(false)), { text: "New", kind: "new" });
});

test("summary, selection, and progress text", () => {
  const { SnowballCandidateView: View } = load();
  assert.equal(View.summaryText({ total: 0, visible: 0, loading: true }), "Searching…");
  assert.equal(View.summaryText({ total: 0, visible: 0, loading: false }), "0 candidates");
  assert.equal(View.summaryText({ total: 1, visible: 1, loading: false }), "1 candidate");
  assert.equal(View.summaryText({ total: 42, visible: 10, loading: true }), "10 of 42 candidates");
  assert.equal(View.selectionText(1), "1 selected");
  assert.equal(View.workProgressText(1, 3.7, -2), "1 unique candidate found — 3 active, 0 queued");
  assert.equal(View.workProgressText(5, "x", 4), "5 unique candidates found — 0 active, 4 queued");
});

test("streamEndText reports error, then limit, then stop, then done", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(
    plain(
      View.streamEndText({ errorMessage: "Boom", limitReached: true, aborted: true, total: 2 })
    ),
    { status: "Search failed", progress: "Search failed — Boom — 2 candidates loaded" }
  );
  assert.deepEqual(plain(View.streamEndText({ limitReached: true, aborted: true, total: 1 })), {
    status: "Limit reached",
    progress: "Limit reached — 1 candidate loaded"
  });
  assert.deepEqual(plain(View.streamEndText({ aborted: true, total: 3 })), {
    status: "Stopped",
    progress: "Stopped — 3 candidates loaded"
  });
  assert.deepEqual(plain(View.streamEndText({ total: 0 })), {
    status: "Done",
    progress: "Done — 0 candidates loaded"
  });
});

test("formatAddSummary covers every combination the toast can show", () => {
  const { SnowballCandidateView: View } = load();
  assert.equal(View.formatAddSummary(0, 0, 0, 0), "Nothing added.");
  assert.equal(View.formatAddSummary(1, 0, 0, 0), "Added 1 item to Zotero");
  assert.equal(
    View.formatAddSummary(5, 2, 1, 3),
    "Added 5 items to Zotero; updated 2 existing; 1 couldn't be added; downloading 3 PDFs in the background"
  );
  assert.equal(View.formatAddSummary(0, 2, 0, 0), "Updated 2 existing");
  assert.equal(
    View.formatAddSummary(1, 0, 0, 1),
    "Added 1 item to Zotero; downloading 1 PDF in the background"
  );
});

test("breakdownRows lists core signals and only the conditional ones that apply", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(plain(View.breakdownRows(null)), []);

  const minimal = plain(
    View.breakdownRows({
      text: 0.4,
      bibCoupling: 0,
      coCitation: 0,
      authorOverlap: 0,
      titleTrigram: 0,
      citation: 0.1
    })
  );
  assert.deepEqual(
    minimal.map((r) => r.label),
    [
      "Text similarity",
      "Bibliographic coupling",
      "Co-citation",
      "Author overlap",
      "Title fuzzy match",
      "Citation count"
    ]
  );
  assert.ok(minimal.every((r) => r.hint === null));

  const full = plain(
    View.breakdownRows({
      text: 0.4,
      bibCoupling: 0.2,
      bibCouplingRaw: 1,
      coCitation: 0.5,
      coCitationRaw: 3,
      authorOverlap: 0,
      titleTrigram: 0,
      citation: 0,
      embedding: 0.8,
      abstractPenalty: -0.05,
      duplicatePenalty: -0.35,
      directionBoost: 0.1
    })
  );
  const byLabel = Object.fromEntries(full.map((r) => [r.label, r]));
  assert.equal(byLabel["Bibliographic coupling"].hint, "1 shared ref");
  assert.equal(byLabel["Co-citation"].hint, "3 seeds cite this");
  assert.equal(byLabel["Semantic Scholar embedding"].value, 0.8);
  assert.equal(byLabel["No abstract"].value, -0.05);
  assert.equal(byLabel["Already in library"].value, -0.35);
  assert.equal(byLabel["Both directions bonus"].value, 0.1);
});

test("formatSigned always shows a sign and two decimals", () => {
  const { SnowballCandidateView: View } = load();
  assert.equal(View.formatSigned(0), "+0.00");
  assert.equal(View.formatSigned(0.456), "+0.46");
  assert.equal(View.formatSigned(-0.35), "-0.35");
});

test("resolveDetailLink prefers DOI, then http(s) URL, then OpenAlex", () => {
  const { SnowballCandidateView: View } = load();
  assert.deepEqual(
    plain(View.resolveDetailLink({ doi: "https://doi.org/10.1/X y", url: "https://e.com" })),
    {
      label: "DOI: 10.1/X y",
      url: "https://doi.org/10.1/X%20y"
    }
  );
  assert.deepEqual(plain(View.resolveDetailLink({ doi: "doi:10.1/z" })), {
    label: "DOI: 10.1/z",
    url: "https://doi.org/10.1/z"
  });
  assert.deepEqual(
    plain(View.resolveDetailLink({ url: "https://example.com/p", openAlexID: "W1" })),
    {
      label: "Open in browser",
      url: "https://example.com/p"
    }
  );
  assert.deepEqual(
    plain(View.resolveDetailLink({ url: "javascript:alert(1)", openAlexID: "W1" })),
    {
      label: "W1",
      url: "https://openalex.org/W1"
    }
  );
  assert.equal(View.resolveDetailLink({}), null);
});
