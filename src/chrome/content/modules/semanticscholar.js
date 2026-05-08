/* global SnowballHTTP, SnowballError, SnowballLog */

/**
 * Semantic Scholar enrichment provider.
 *
 * Used purely for SPECTER2 paper embeddings via the batch endpoint:
 *   POST https://api.semanticscholar.org/graph/v1/paper/batch?fields=embedding
 *   Body: { "ids": ["DOI:10.x/y", ...] }   // up to 500 IDs per call
 *
 * Activated only when the user has set `semanticScholarAPIKey` in prefs;
 * the provider refuses to run without one (no fallback to anonymous use)
 * to keep the contract crisp: "no key, no S2 traffic."
 *
 * Note on auth: S2 keys go in the `x-api-key` header — never in the URL —
 * which means the SnowballLog scrubber doesn't need to know about them, but
 * we never log raw headers anyway so this is just defense in depth.
 */
var SemanticScholarProvider = class {
  static MAX_BATCH = 500;

  constructor({ apiKey = "", timeoutMs = 60000, maxRetries } = {}) {
    this.baseURL = "https://api.semanticscholar.org";
    this.apiKey = String(apiKey || "").trim();
    this.timeoutMs = Math.max(1000, Math.min(120000, Number(timeoutMs) || 60000));
    this.maxRetries = Number.isFinite(maxRetries) ? maxRetries : undefined;
  }

  isEnabled() {
    return !!this.apiKey;
  }

  /**
   * Returns Map<lowercased-doi, Float32Array> for papers S2 has embeddings for.
   * Missing or non-DOI papers are silently omitted.
   *
   * Aborts cleanly on `signal`. Network/timeout failures surface a warning
   * via SnowballLog and return whatever has succeeded so far — partial
   * enrichment is better than no enrichment.
   */
  async fetchEmbeddings(dois, signal = null) {
    const out = new Map();
    if (!this.isEnabled()) return out;
    if (!Array.isArray(dois) || !dois.length) return out;

    // Normalize + dedup. S2 expects DOIs in lowercase.
    const seen = new Set();
    const uniq = [];
    for (const d of dois) {
      const v = String(d || "").trim().toLowerCase();
      if (!v) continue;
      // Strip any leading https://doi.org/ that might have slipped through.
      const norm = v.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "");
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      uniq.push(norm);
    }
    if (!uniq.length) return out;

    for (let i = 0; i < uniq.length; i += SemanticScholarProvider.MAX_BATCH) {
      if (signal?.aborted) break;
      const chunk = uniq.slice(i, i + SemanticScholarProvider.MAX_BATCH);

      const url = new URL(`${this.baseURL}/graph/v1/paper/batch`);
      url.searchParams.set("fields", "embedding");

      const reqBody = JSON.stringify({
        ids: chunk.map(d => `DOI:${d}`)
      });

      let response;
      try {
        response = await SnowballHTTP.fetchJSON(url, {
          method: "POST",
          body: reqBody,
          headers: this._authHeaders({ "Content-Type": "application/json" }),
          signal,
          timeoutMs: this.timeoutMs,
          ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {})
        });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        SnowballLog.warn("Semantic Scholar batch failed", {
          chunkSize: chunk.length,
          error: SnowballLog.formatError(error)
        });
        continue;
      }

      // S2 returns null entries (positionally) for IDs it can't resolve.
      if (!Array.isArray(response)) continue;
      for (let j = 0; j < response.length && j < chunk.length; j++) {
        const item = response[j];
        const vec = item && item.embedding && item.embedding.vector;
        if (!Array.isArray(vec) || !vec.length) continue;
        try {
          out.set(chunk[j], Float32Array.from(vec));
        } catch (_) { /* skip malformed vector */ }
      }
    }

    return out;
  }

  _authHeaders(extra = {}) {
    const h = Object.assign({}, extra);
    if (this.apiKey) {
      // S2 supports either header name; using x-api-key per their docs.
      h["x-api-key"] = this.apiKey;
    }
    return h;
  }
};
