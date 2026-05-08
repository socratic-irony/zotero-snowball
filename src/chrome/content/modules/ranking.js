/* global SnowballUtil */

/**
 * Snowball Sources relevance ranking.
 *
 * The composite score combines several independent signals so a single
 * weak signal can't dominate. Every signal is normalized into [0, 1]
 * before being multiplied by its weight; the final score is clamped to
 * [0, ∞) for the table.
 *
 *   text          : cosine over TF terms of title+abstract               (0–1)
 *   bibCoupling   : shared references with the seed pool, saturated      (0–1)
 *   coCitation    : fraction of seeds that reference this candidate      (0–1)
 *   authorOverlap : fraction of candidate authors who also appear in
 *                   the seed pool                                        (0–1)
 *   titleTrigram  : best Jaccard of length-3 char n-grams vs any seed    (0–1)
 *   citation      : log10(citedByCount + 1) / 10, capped at 1            (0–1)
 *   embedding     : cosine of seed-mean SPECTER2 vs candidate vector,
 *                   only set when Semantic Scholar enrichment ran        (0–1)
 *
 *   Penalties / nudges (added directly, can be negative):
 *     abstractPenalty   : −0.05 if the candidate has no abstract
 *     duplicatePenalty  : −0.35 if already in the user's library
 *     directionBoost    : +0.10 when seen as both forward AND backward
 */
var SnowballRanking = {
  WEIGHTS: {
    text:          1.00,
    bibCoupling:   0.20,
    coCitation:    0.15,
    authorOverlap: 0.10,
    titleTrigram:  0.08,
    citation:      0.10,
    embedding:     0.40
  },

  // Saturate at this many shared refs per candidate. Anything beyond
  // adds nothing — we don't want a survey paper that shares 100 refs
  // with every seed swamping the rest of the table.
  BIB_COUPLING_SATURATION: 20,

  // -------- Public scoring API ---------------------------------------------

  scoreCandidates(candidates, seedRecords, seedWorks = []) {
    const ctx = this.buildSeedContext(seedRecords, seedWorks);
    for (const candidate of candidates) {
      this.scoreCandidate(candidate, ctx);
    }
    return candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  },

  /**
   * Build a reusable signature of the seed pool. Cheap; the dialog
   * rebuilds this on every `seed-resolved` event so partial seed
   * resolution still produces useful scores.
   */
  buildSeedContext(seedRecords, seedWorks = [], opts = {}) {
    const records = Array.isArray(seedRecords) ? seedRecords : [];
    const works = Array.isArray(seedWorks) ? seedWorks : [];

    const termVector = this.buildSeedVector(records);

    // For each unique reference across all seeds, count how many seeds
    // reference it. Used by both bibliographic coupling (look up each
    // candidate ref) and co-citation (look up the candidate's own ID).
    const refsMultiplicity = new Map();
    for (const work of works) {
      const refs = Array.isArray(work?.referenced_works) ? work.referenced_works : [];
      const seen = new Set();
      for (const r of refs) {
        const id = SnowballUtil.shortOpenAlexID(r);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        refsMultiplicity.set(id, (refsMultiplicity.get(id) || 0) + 1);
      }
    }

    const authorSet = new Set();
    for (const seed of records) {
      const creators = Array.isArray(seed?.creators) ? seed.creators : [];
      for (const c of creators) {
        const name = SnowballUtil.normalizeAuthorName(
          `${c.firstName || ""} ${c.lastName || c.name || ""}`
        );
        if (name) authorSet.add(name);
      }
    }

    // Per-seed trigram sets. We score against the MAX over seeds so a
    // candidate with a near-duplicate title to ANY one seed ranks high.
    const titleTrigrams = records.map(s => SnowballUtil.trigrams(s?.title || ""));

    return {
      termVector,
      refsMultiplicity,
      authorSet,
      titleTrigrams,
      seedCount: records.length,
      // Per-context weight override. Caller can pass user-customized
      // values from prefs; missing entries fall back to the defaults.
      weights: opts && opts.weights ? this._mergeWeights(opts.weights) : null
    };
  },

  /**
   * Public: take a partial map (e.g. {text: 1.2, embedding: 0}) and return
   * the full WEIGHTS object with overrides applied. Used by both the
   * context builder and tests.
   */
  _mergeWeights(overrides) {
    const out = {};
    for (const k of Object.keys(this.WEIGHTS)) {
      const v = Number(overrides?.[k]);
      out[k] = Number.isFinite(v) && v >= 0 ? v : this.WEIGHTS[k];
    }
    return out;
  },

  buildSeedVector(seedRecords) {
    const seedText = (Array.isArray(seedRecords) ? seedRecords : [])
      .map(seed => `${seed?.title || ""} ${seed?.abstract || ""}`)
      .join(" ");
    return this.termVector(seedText);
  },

  /**
   * Score a single candidate in-place, writing `relevanceScore` and
   * `_scoreBreakdown`. `ctx` is the output of buildSeedContext.
   *
   * Backward-compatible: if `ctx` is a plain Map (the old seedVector
   * shape used by tests), we still produce a sensible text-only score.
   */
  scoreCandidate(candidate, ctx) {
    if (!candidate) return candidate;

    if (ctx instanceof Map) ctx = { termVector: ctx, seedCount: 0 };
    if (!ctx) ctx = { termVector: new Map(), seedCount: 0 };

    // Text similarity (TF cosine over title+abstract)
    const candText = `${candidate.title || ""} ${candidate.abstract || ""}`;
    const candVector = this.termVector(candText);
    const text = this.cosine(ctx.termVector || new Map(), candVector);

    // Bibliographic coupling: sum the multiplicity of each candidate ref
    // across the seed pool. (A ref shared with 3 seeds counts 3x — that's
    // the multi-seed alignment we want.) Saturated to keep survey papers
    // from dominating.
    let bibCouplingRaw = 0;
    if (ctx.refsMultiplicity?.size && Array.isArray(candidate.referencedWorks)) {
      for (const r of candidate.referencedWorks) {
        const m = ctx.refsMultiplicity.get(r) || 0;
        bibCouplingRaw += m;
      }
    }
    const bibCoupling = Math.min(1, bibCouplingRaw / this.BIB_COUPLING_SATURATION);

    // Co-citation: fraction of seeds that reference this candidate.
    let coCitationRaw = 0;
    if (ctx.refsMultiplicity?.size && candidate.openAlexID) {
      const id = SnowballUtil.shortOpenAlexID(candidate.openAlexID);
      coCitationRaw = ctx.refsMultiplicity.get(id) || 0;
    }
    const coCitation = ctx.seedCount > 0
      ? Math.min(1, coCitationRaw / ctx.seedCount)
      : 0;

    // Author overlap: fraction of candidate authors who appear in any seed.
    let authorOverlap = 0;
    if (ctx.authorSet?.size && Array.isArray(candidate.authors) && candidate.authors.length) {
      let matches = 0;
      for (const a of candidate.authors) {
        const name = SnowballUtil.normalizeAuthorName(
          `${a?.firstName || ""} ${a?.lastName || a?.name || ""}`
        );
        if (name && ctx.authorSet.has(name)) matches++;
      }
      authorOverlap = matches / candidate.authors.length;
    }

    // Title trigram Jaccard (best across seeds).
    let titleTrigram = 0;
    if (Array.isArray(ctx.titleTrigrams) && ctx.titleTrigrams.length && candidate.title) {
      const cand = SnowballUtil.trigrams(candidate.title);
      for (const seed of ctx.titleTrigrams) {
        const j = SnowballUtil.jaccardSets(seed, cand);
        if (j > titleTrigram) titleTrigram = j;
      }
    }

    // Citation count (log-compressed, capped).
    const citationRaw = Math.log10((Number(candidate.citedByCount) || 0) + 1) / 10;
    const citation = Math.min(1, citationRaw);

    // Optional embedding similarity (set by S2 enrichment, otherwise 0).
    const embed = Math.max(0, Math.min(1, Number(candidate._embeddingSimilarity) || 0));

    const abstractPenalty  = candidate.abstract ? 0 : -0.05;
    const duplicatePenalty = candidate.alreadyInLibrary ? -0.35 : 0;
    const directionBoost   = candidate.direction === "both" ? 0.1 : 0;

    // Honor per-context weight overrides if the caller supplied them
    // (the dialog passes weights from prefs); otherwise use the tuned
    // module defaults.
    const W = (ctx && ctx.weights) ? ctx.weights : this.WEIGHTS;
    const composite =
      W.text          * text +
      W.bibCoupling   * bibCoupling +
      W.coCitation    * coCitation +
      W.authorOverlap * authorOverlap +
      W.titleTrigram  * titleTrigram +
      W.citation      * citation +
      W.embedding     * embed +
      abstractPenalty +
      duplicatePenalty +
      directionBoost;

    candidate.relevanceScore = Math.max(0, composite);

    // Persisted breakdown for a future "explain why this scored high"
    // tooltip and for tuning weights.
    candidate._scoreBreakdown = {
      text, bibCoupling, bibCouplingRaw, coCitation, coCitationRaw,
      authorOverlap, titleTrigram, citation, embedding: embed,
      abstractPenalty, duplicatePenalty, directionBoost
    };

    return candidate;
  },

  // -------- Term vector + cosine (existing baseline) -----------------------

  termVector(text) {
    const vector = new Map();
    for (const token of this.tokenize(text)) {
      vector.set(token, (vector.get(token) || 0) + 1);
    }
    return vector;
  },

  tokenize(text) {
    const stop = new Set([
      "the", "and", "for", "with", "that", "this", "from", "are", "was",
      "were", "have", "has", "had", "not", "but", "can", "may", "using",
      "use", "used", "into", "their", "there", "these", "those", "than",
      "study", "paper", "article"
    ]);
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(token => token.length > 2 && !stop.has(token));
  },

  cosine(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (const value of a.values()) normA += value * value;
    for (const value of b.values()) normB += value * value;
    for (const [key, value] of a.entries()) dot += value * (b.get(key) || 0);
    if (!normA || !normB) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
};
