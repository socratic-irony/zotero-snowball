var SnowballUtil = {
  chunk(items, size) {
    if (!Array.isArray(items) || size <= 0) {
      return [];
    }
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  },

  normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  },

  formatScore(score) {
    return Math.round((score || 0) * 100);
  },

  /**
   * Strip the `https://openalex.org/` prefix (or any leading URL) so an
   * OpenAlex Work ID round-trips to its canonical short form `W123…`.
   * Returns "" for missing/garbage input.
   */
  shortOpenAlexID(id) {
    return String(id || "").replace(/^https?:\/\/openalex\.org\//i, "").trim();
  },

  /**
   * Set of length-3 character n-grams of `text` after normalization.
   * Used for fuzzy title matching that catches near-duplicates that
   * exact-title and DOI dedupe miss (e.g. "Attention Is All You Need"
   * vs "Attention is All You Need: …"). Empty set for very short input.
   */
  trigrams(text) {
    const norm = String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (norm.length < 3) return new Set();
    const out = new Set();
    for (let i = 0; i <= norm.length - 3; i++) {
      out.add(norm.slice(i, i + 3));
    }
    return out;
  },

  /**
   * Jaccard similarity of two Sets: |a∩b| / |a∪b|. Returns 0 for empty sets.
   * Iterates over the smaller set for speed.
   */
  jaccardSets(a, b) {
    const sizeA = a?.size || 0;
    const sizeB = b?.size || 0;
    if (sizeA === 0 && sizeB === 0) return 0;
    const [small, large] = sizeA < sizeB ? [a, b] : [b, a];
    let inter = 0;
    for (const item of small) if (large.has(item)) inter++;
    const union = sizeA + sizeB - inter;
    return union ? inter / union : 0;
  },

  /**
   * Cosine similarity of two dense numeric vectors (typed-arrays or
   * regular arrays). Returns 0 if either vector is zero-length or all
   * zeros. Uses Math.min on lengths so a length mismatch never throws.
   */
  cosineDense(a, b) {
    if (!a || !b) return 0;
    const len = Math.min(a.length || 0, b.length || 0);
    if (!len) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < len; i++) {
      const x = a[i], y = b[i];
      dot += x * y;
      na  += x * x;
      nb  += y * y;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  },

  /**
   * Lowercase + strip diacritics + drop non-alphanumerics. Good enough to
   * match "MacKenzie" / "mackenzie" / "Mac Kenzie" or "Müller" / "Muller".
   */
  normalizeAuthorName(name) {
    return String(name || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
};
