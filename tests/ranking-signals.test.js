const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadModules(names, extra = {}) {
  const ctx = vm.createContext({
    console, URL, fetch, AbortController, DOMException,
    setTimeout, clearTimeout, Math, Date, JSON, Promise, Error,
    Float32Array, Map, Set,
    Zotero: { debug() {} },
    ...extra
  });
  for (const name of names) {
    const file = path.join(ROOT, "src", "chrome", "content", "modules", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  }
  return ctx;
}

// --------- util ----------------------------------------------------------

test("SnowballUtil.trigrams produces character n-grams of normalized text", () => {
  const { SnowballUtil } = loadModules(["util.js"]);
  const t = SnowballUtil.trigrams("ABC def!");
  assert.ok(t.has("abc"));
  assert.ok(t.has("c d") || t.has("bc "), "trigrams span the boundary after normalization");
  assert.ok(t.has("def"));
  // length-2 input → empty
  assert.equal(SnowballUtil.trigrams("ok").size, 0);
});

test("SnowballUtil.jaccardSets is symmetric and bounded [0,1]", () => {
  const { SnowballUtil } = loadModules(["util.js"]);
  const a = new Set(["ab", "bc", "cd"]);
  const b = new Set(["ab", "bc", "ef"]);
  const j = SnowballUtil.jaccardSets(a, b);
  assert.equal(j, SnowballUtil.jaccardSets(b, a), "symmetric");
  assert.ok(j > 0 && j < 1, `expected (0,1) got ${j}`);
  // Identical sets → 1, disjoint → 0
  assert.equal(SnowballUtil.jaccardSets(a, a), 1);
  assert.equal(SnowballUtil.jaccardSets(a, new Set(["x", "y"])), 0);
  // Empty / empty → 0 (no division)
  assert.equal(SnowballUtil.jaccardSets(new Set(), new Set()), 0);
});

test("SnowballUtil.cosineDense handles plain arrays and Float32Array", () => {
  const { SnowballUtil } = loadModules(["util.js"]);
  const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
  assert.ok(close(SnowballUtil.cosineDense([1, 0, 0], [1, 0, 0]), 1));
  assert.equal(SnowballUtil.cosineDense([1, 0, 0], [0, 1, 0]), 0);
  // Length mismatch should not throw; only the common prefix counts.
  assert.ok(close(SnowballUtil.cosineDense([1, 1], [1, 1, 9]), 1));
  // Zero vectors → 0
  assert.equal(SnowballUtil.cosineDense([0, 0], [0, 0]), 0);
  // Float32Array path
  const a = Float32Array.from([0.5, 0.5]);
  const b = Float32Array.from([0.5, 0.5]);
  assert.ok(close(SnowballUtil.cosineDense(a, b), 1, 1e-6));
});

test("SnowballUtil.normalizeAuthorName collapses case + diacritics", () => {
  const { SnowballUtil } = loadModules(["util.js"]);
  assert.equal(SnowballUtil.normalizeAuthorName("Müller, Hans"), "muller hans");
  assert.equal(SnowballUtil.normalizeAuthorName("MacKenzie  Jones"), "mackenzie jones");
});

test("SnowballUtil.shortOpenAlexID strips the openalex.org prefix", () => {
  const { SnowballUtil } = loadModules(["util.js"]);
  assert.equal(SnowballUtil.shortOpenAlexID("https://openalex.org/W12345"), "W12345");
  assert.equal(SnowballUtil.shortOpenAlexID("W67890"), "W67890");
  assert.equal(SnowballUtil.shortOpenAlexID(""), "");
});

// --------- ranking signals -----------------------------------------------

function makeRanking() {
  return loadModules(["util.js", "ranking.js"]);
}

test("buildSeedContext sums seed reference multiplicities", () => {
  const { SnowballRanking } = makeRanking();
  const seedRecords = [
    { title: "S1", abstract: "", creators: [{ firstName: "A", lastName: "Smith" }] },
    { title: "S2", abstract: "", creators: [{ firstName: "B", lastName: "Jones" }] }
  ];
  const seedWorks = [
    { id: "W_S1", referenced_works: ["W1", "W2", "W3"] },
    { id: "W_S2", referenced_works: ["W2", "W3", "W4"] }
  ];
  const ctx = SnowballRanking.buildSeedContext(seedRecords, seedWorks);
  assert.equal(ctx.refsMultiplicity.get("W1"), 1);
  assert.equal(ctx.refsMultiplicity.get("W2"), 2);
  assert.equal(ctx.refsMultiplicity.get("W3"), 2);
  assert.equal(ctx.refsMultiplicity.get("W4"), 1);
  // Author set normalized
  assert.ok(ctx.authorSet.has("a smith"));
  assert.ok(ctx.authorSet.has("b jones"));
  // Per-seed trigram sets
  assert.equal(ctx.titleTrigrams.length, 2);
  assert.equal(ctx.seedCount, 2);
});

test("scoreCandidate rewards bibliographic coupling", () => {
  const { SnowballRanking } = makeRanking();
  const seeds = [{ title: "X", abstract: "" }];
  const works = [{ id: "S1", referenced_works: ["A", "B", "C", "D", "E"] }];
  const ctx = SnowballRanking.buildSeedContext(seeds, works);

  // Give both candidates an abstract so the abstract penalty doesn't clamp
  // small score differences to 0 below the floor.
  const lowOverlap  = { title: "p", abstract: "x", referencedWorks: ["A"], authors: [], citedByCount: 1 };
  const highOverlap = { title: "p", abstract: "x", referencedWorks: ["A","B","C","D","E"], authors: [], citedByCount: 1 };

  SnowballRanking.scoreCandidate(lowOverlap, ctx);
  SnowballRanking.scoreCandidate(highOverlap, ctx);

  assert.ok(highOverlap._scoreBreakdown.bibCouplingRaw > lowOverlap._scoreBreakdown.bibCouplingRaw);
  assert.ok(highOverlap.relevanceScore > lowOverlap.relevanceScore,
    `expected higher score for higher overlap (${highOverlap.relevanceScore} vs ${lowOverlap.relevanceScore})`);
});

test("scoreCandidate rewards co-citation across seeds", () => {
  const { SnowballRanking } = makeRanking();
  const seeds = [
    { title: "S1", abstract: "" },
    { title: "S2", abstract: "" },
    { title: "S3", abstract: "" }
  ];
  const works = [
    { id: "S1", referenced_works: ["WC", "X"] },
    { id: "S2", referenced_works: ["WC", "Y"] },
    { id: "S3", referenced_works: ["WC", "Z"] }
  ];
  const ctx = SnowballRanking.buildSeedContext(seeds, works);

  const referencedByAll = { openAlexID: "WC", title: "candidate", authors: [], citedByCount: 0 };
  const referencedByOne = { openAlexID: "X",  title: "candidate", authors: [], citedByCount: 0 };

  SnowballRanking.scoreCandidate(referencedByAll, ctx);
  SnowballRanking.scoreCandidate(referencedByOne, ctx);

  assert.equal(referencedByAll._scoreBreakdown.coCitationRaw, 3);
  assert.equal(referencedByOne._scoreBreakdown.coCitationRaw, 1);
  assert.ok(referencedByAll.relevanceScore > referencedByOne.relevanceScore);
});

test("scoreCandidate rewards author overlap with the seed pool", () => {
  const { SnowballRanking } = makeRanking();
  const seeds = [
    { title: "x", abstract: "", creators: [
      { firstName: "Alice", lastName: "Author" },
      { firstName: "Bob", lastName: "Buddy" }
    ]}
  ];
  const ctx = SnowballRanking.buildSeedContext(seeds, []);

  const sharedAuthor = { title: "p", authors: [{ firstName: "Alice", lastName: "Author" }] };
  const noShared    = { title: "p", authors: [{ firstName: "Carol", lastName: "Other" }] };

  SnowballRanking.scoreCandidate(sharedAuthor, ctx);
  SnowballRanking.scoreCandidate(noShared, ctx);
  assert.equal(sharedAuthor._scoreBreakdown.authorOverlap, 1);
  assert.equal(noShared._scoreBreakdown.authorOverlap, 0);
  assert.ok(sharedAuthor.relevanceScore > noShared.relevanceScore);
});

test("scoreCandidate rewards near-duplicate titles via trigram Jaccard", () => {
  const { SnowballRanking } = makeRanking();
  const seeds = [{ title: "Attention Is All You Need", abstract: "" }];
  const ctx = SnowballRanking.buildSeedContext(seeds, []);

  const paraphrase = { title: "Attention is All You Need: Revisited" };
  const unrelated  = { title: "On the dynamics of polymer chains" };

  SnowballRanking.scoreCandidate(paraphrase, ctx);
  SnowballRanking.scoreCandidate(unrelated, ctx);
  assert.ok(paraphrase._scoreBreakdown.titleTrigram > 0.5,
    `expected high trigram-Jaccard for near-duplicate, got ${paraphrase._scoreBreakdown.titleTrigram}`);
  assert.ok(unrelated._scoreBreakdown.titleTrigram < 0.2);
});

test("scoreCandidate mixes embedding similarity when present", () => {
  const { SnowballRanking } = makeRanking();
  const seeds = [{ title: "x", abstract: "" }];
  const ctx = SnowballRanking.buildSeedContext(seeds, []);

  const noEmbed   = { title: "p", authors: [], citedByCount: 0 };
  const withEmbed = { title: "p", authors: [], citedByCount: 0, _embeddingSimilarity: 0.9 };

  SnowballRanking.scoreCandidate(noEmbed, ctx);
  SnowballRanking.scoreCandidate(withEmbed, ctx);
  assert.equal(noEmbed._scoreBreakdown.embedding, 0);
  assert.equal(withEmbed._scoreBreakdown.embedding, 0.9);
  // Embedding weight (0.40) × similarity (0.9) = 0.36 added.
  assert.ok(withEmbed.relevanceScore > noEmbed.relevanceScore + 0.3);
});

// --------- Semantic Scholar gating --------------------------------------

test("SemanticScholarProvider is disabled with no API key (no traffic)", async () => {
  // Loaded with a stub fetch; fail the test if the provider attempts to
  // contact S2 without a key.
  let fetchCalled = false;
  const ctx = loadModules(["log.js", "errors.js", "http.js", "semanticscholar.js"], {
    fetch: async () => { fetchCalled = true; throw new Error("should not be called"); }
  });
  const s2 = new ctx.SemanticScholarProvider({ apiKey: "" });
  assert.equal(s2.isEnabled(), false);
  const out = await s2.fetchEmbeddings(["10.0/abc", "10.0/def"], null);
  assert.equal(out.size, 0);
  assert.equal(fetchCalled, false, "S2 must not call fetch when no API key is set");
});

test("SemanticScholarProvider is enabled when an API key is provided", () => {
  const ctx = loadModules(["log.js", "errors.js", "http.js", "semanticscholar.js"]);
  const s2 = new ctx.SemanticScholarProvider({ apiKey: "abc123" });
  assert.equal(s2.isEnabled(), true);
});

test("SemanticScholarProvider trims and dedups DOIs before requesting", async () => {
  // Capture what the provider would send to SnowballHTTP.fetchJSON.
  let captured = null;
  const ctx = loadModules(["log.js", "errors.js", "http.js", "semanticscholar.js"]);
  ctx.SnowballHTTP.fetchJSON = async (url, opts) => {
    captured = { url: String(url), opts };
    return [];
  };
  const s2 = new ctx.SemanticScholarProvider({ apiKey: "key" });
  await s2.fetchEmbeddings([
    " 10.0/A ",
    "10.0/A",
    "https://doi.org/10.0/B",
    "DOI:10.0/C",
    ""
  ], null);
  assert.ok(captured, "expected an HTTP request");
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body.ids.sort(), ["DOI:10.0/a", "DOI:10.0/b", "DOI:10.0/c"]);
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers["x-api-key"], "key");
  assert.equal(captured.opts.headers["Content-Type"], "application/json");
});
