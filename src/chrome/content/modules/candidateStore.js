/* global SnowballUtil */

/**
 * In-memory store of snowball candidates for one review-dialog session.
 *
 * Owns the candidate list plus deduplication: an exact match on DOI /
 * OpenAlex ID / normalized title+year, then a fuzzy title match
 * (trigram Jaccard) within the same publication year. Duplicate sightings
 * are merged into the stored candidate instead of adding a new row.
 *
 * No DOM and no Zotero APIs, so it can be unit tested under Node.
 *
 * Usage (the dialog does library lookup and scoring between the two steps):
 *
 *   const match = store.findMatch(raw);
 *   if (match.duplicate) { SnowballCandidateStore.mergeDuplicate(match.duplicate, raw); }
 *   else { const c = SnowballCandidateStore.createCandidate(raw, match.trigrams); …; store.insert(c, match.key); }
 */
var SnowballCandidateStore = class {
  // Trigram-Jaccard similarity at or above which two same-year titles are
  // treated as the same work (catches "Title" vs "Title: A Subtitle").
  static TRIGRAM_DEDUPE_THRESHOLD = 0.85;

  // Year-bucket key for candidates with no publication year.
  static NO_YEAR = "_no_year_";

  constructor() {
    /** @type {any[]} */
    this.candidates = [];
    /** @type {Map<string, any>} exact dedupe key -> stored candidate */
    this.dedupeIndex = new Map();
    /** @type {Map<string, any[]>} year -> stored candidates, for fuzzy dedupe */
    this.yearBuckets = new Map();
  }

  /**
   * Exact dedupe key: DOI first, then OpenAlex ID, then normalized
   * title + year. Returns "" when the candidate has none of these.
   * @param {any} candidate
   * @returns {string}
   */
  static dedupeKey(candidate) {
    const doi = String(candidate?.doi || "")
      .trim()
      .toLowerCase();
    if (doi) return `doi:${doi}`;
    if (candidate?.openAlexID) return `oa:${candidate.openAlexID}`;
    const title = String(candidate?.title || "")
      .trim()
      .toLowerCase();
    return title ? `title:${title}:${candidate.year || ""}` : "";
  }

  /**
   * Merge a duplicate sighting (`raw`) into an already-stored candidate.
   * Seen from both directions → "both"; keep the higher citation count;
   * fill in fields the stored copy is missing.
   * @param {any} existing
   * @param {any} raw
   */
  static mergeDuplicate(existing, raw) {
    if (raw.direction && existing.direction !== raw.direction) {
      existing.direction = "both";
    }
    existing.citedByCount = Math.max(existing.citedByCount || 0, raw.citedByCount || 0);
    if (!existing.abstract && raw.abstract) existing.abstract = raw.abstract;
    if (!existing.venue && raw.venue) existing.venue = raw.venue;
    if (!existing.doi && raw.doi) existing.doi = raw.doi;
    if (!Array.isArray(existing.referencedWorks) || !existing.referencedWorks.length) {
      if (Array.isArray(raw.referencedWorks) && raw.referencedWorks.length) {
        existing.referencedWorks = raw.referencedWorks;
      }
    }
  }

  /**
   * Copy `raw` into a new candidate object. It is not stored until
   * insert() is called, so callers can enrich it first.
   * @param {any} raw
   * @param {Set<string> | null} trigrams
   */
  static createCandidate(raw, trigrams) {
    const candidate = Object.assign({}, raw);
    candidate._titleTrigrams = trigrams || SnowballUtil.trigrams(raw.title || "");
    return candidate;
  }

  /**
   * Find an existing candidate that `raw` duplicates.
   * @param {any} raw
   * @returns {{ key: string, trigrams: Set<string> | null, duplicate: any }}
   *   `duplicate` is null when `raw` is new. Pass `key` and `trigrams` on to
   *   createCandidate()/insert() to avoid recomputing them.
   */
  findMatch(raw) {
    const key = SnowballCandidateStore.dedupeKey(raw);
    if (key && this.dedupeIndex.has(key)) {
      return { key, trigrams: null, duplicate: this.dedupeIndex.get(key) };
    }
    const trigrams = SnowballUtil.trigrams(raw.title || "");
    const duplicate = trigrams.size ? this._findFuzzy(raw.year, trigrams) : null;
    return { key, trigrams, duplicate };
  }

  /**
   * Store a candidate created by createCandidate(). Assigns `_index`.
   * @param {any} candidate
   * @param {string} [key] exact dedupe key from findMatch()
   * @returns {any} the stored candidate
   */
  insert(candidate, key = SnowballCandidateStore.dedupeKey(candidate)) {
    candidate._index = this.candidates.length;
    if (key) this.dedupeIndex.set(key, candidate);
    const bucketKey = this._bucketKey(candidate.year);
    if (!this.yearBuckets.has(bucketKey)) this.yearBuckets.set(bucketKey, []);
    this.yearBuckets.get(bucketKey).push(candidate);
    this.candidates.push(candidate);
    return candidate;
  }

  get size() {
    return this.candidates.length;
  }

  /** @returns {any[]} candidates the user has checked */
  selected() {
    return this.candidates.filter((c) => c._selected);
  }

  _bucketKey(year) {
    return year != null ? String(year) : SnowballCandidateStore.NO_YEAR;
  }

  // Compare only within the same year so the fuzzy pass stays cheap: a
  // paraphrased duplicate is almost always the same work in the same year.
  _findFuzzy(year, trigrams) {
    const bucket = this.yearBuckets.get(this._bucketKey(year));
    if (!bucket) return null;
    for (const existing of bucket) {
      const existingTrigrams = existing._titleTrigrams;
      if (!existingTrigrams || !existingTrigrams.size) continue;
      const similarity = SnowballUtil.jaccardSets(existingTrigrams, trigrams);
      if (similarity >= SnowballCandidateStore.TRIGRAM_DEDUPE_THRESHOLD) return existing;
    }
    return null;
  }
};
