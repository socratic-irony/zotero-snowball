/* global Zotero, SnowballUtil, SnowballLog, SnowballHTTP, SnowballError */

var OpenAlexProvider = class {
  static clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  constructor({
    apiKey = "",
    maxForwardPerSeed = 100,
    maxBackwardPerSeed = 100,
    includeForward = true,
    includeBackward = true,
    maxCandidatesTotal = 500,
    timeoutMs = 30000
  } = {}) {
    this.baseURL = "https://api.openalex.org";
    // Trim defensively: a stray newline in a copy/pasted key would invalidate
    // every request.
    this.apiKey = String(apiKey || "").trim();
    // Clamp every limit so a malformed pref can't cause runaway memory or
    // request storms.
    this.maxForwardPerSeed = OpenAlexProvider.clampInt(maxForwardPerSeed, 0, 1000, 100);
    this.maxBackwardPerSeed = OpenAlexProvider.clampInt(maxBackwardPerSeed, 0, 1000, 100);
    this.maxCandidatesTotal = OpenAlexProvider.clampInt(maxCandidatesTotal, 1, 10000, 500);
    this.timeoutMs = OpenAlexProvider.clampInt(timeoutMs, 1000, 120000, 30000);
    this.includeForward = !!includeForward;
    this.includeBackward = !!includeBackward;

    this.fields = [
      "id",
      "doi",
      "display_name",
      "title",
      "publication_year",
      "publication_date",
      "type",
      "authorships",
      "primary_location",
      "best_oa_location",
      "cited_by_count",
      "referenced_works",
      "abstract_inverted_index",
      "ids"
    ].join(",");
  }

  async snowball(seedRecords) {
    const allCandidates = [];
    const resolvedSeeds = [];

    for (const seed of seedRecords) {
      try {
        const resolved = await this.resolveSeed(seed);
        if (resolved) {
          resolvedSeeds.push({ seed, work: resolved });
        }
      } catch (error) {
        this.debug(`Seed resolution failed for "${seed.title || seed.doi}": ${error}`);
      }
    }

    for (const { seed, work } of resolvedSeeds) {
      if (this.includeBackward) {
        const backward = await this.getBackwardReferences(seed, work);
        allCandidates.push(...backward);
      }

      if (this.includeForward) {
        const forward = await this.getForwardCitations(seed, work);
        allCandidates.push(...forward);
      }
    }

    return this.deduplicateCandidates(allCandidates).slice(0, this.maxCandidatesTotal);
  }

  async resolveSeed(seed, signal = null) {
    if (seed.doi) {
      const work = await this.getWorkByDOI(seed.doi, signal);
      if (work) {
        return work;
      }
    }

    if (seed.title) {
      return this.searchWorkByTitle(seed.title, seed.year, signal);
    }

    return null;
  }

  async getWorkByDOI(doi, signal = null) {
    const url = new URL(`${this.baseURL}/works/doi:${encodeURIComponent(doi)}`);
    url.searchParams.set("select", this.fields);
    this.addAuth(url);

    try {
      return await this.fetchJSON(url, 1, signal);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.debug(`DOI lookup failed for ${doi}: ${error}`);
      return null;
    }
  }

  async searchWorkByTitle(title, year, signal = null) {
    const url = new URL(`${this.baseURL}/works`);
    url.searchParams.set("search", title);
    url.searchParams.set("per_page", "5");
    url.searchParams.set("select", this.fields);

    if (year) {
      url.searchParams.set("filter", `publication_year:${year}`);
    }

    this.addAuth(url);

    try {
      const response = await this.fetchJSON(url, 1, signal);
      return response.results?.[0] || null;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.debug(`Title lookup failed for "${title}": ${error}`);
      return null;
    }
  }

  async getBackwardReferences(seed, work) {
    const ids = (work.referenced_works || []).slice(0, this.maxBackwardPerSeed);
    const works = await this.batchGetWorksByOpenAlexIDs(ids);

    return works.map((candidate) =>
      this.normalizeCandidate(candidate, {
        direction: "backward",
        seed
      })
    );
  }

  async getForwardCitations(seed, work) {
    const openAlexID = this.shortOpenAlexID(work.id);
    if (!openAlexID) {
      return [];
    }

    const url = new URL(`${this.baseURL}/works`);
    url.searchParams.set("filter", `cites:${openAlexID}`);
    url.searchParams.set("per_page", String(Math.min(this.maxForwardPerSeed, 100)));
    url.searchParams.set("select", this.fields);
    this.addAuth(url);

    try {
      const response = await this.fetchJSON(url);
      const results = response.results || [];

      return results.map((candidate) =>
        this.normalizeCandidate(candidate, {
          direction: "forward",
          seed
        })
      );
    } catch (error) {
      this.debug(`Forward citation lookup failed for ${openAlexID}: ${error}`);
      return [];
    }
  }

  async batchGetWorksByOpenAlexIDs(ids) {
    const cleanIDs = ids.map((id) => this.shortOpenAlexID(id)).filter(Boolean);

    const chunks = SnowballUtil.chunk(cleanIDs, 100);
    const all = [];

    for (const chunk of chunks) {
      const url = new URL(`${this.baseURL}/works`);
      url.searchParams.set("filter", `openalex:${chunk.join("|")}`);
      url.searchParams.set("per_page", String(chunk.length));
      url.searchParams.set("select", this.fields);
      this.addAuth(url);

      try {
        const response = await this.fetchJSON(url);
        all.push(...(response.results || []));
      } catch (error) {
        this.debug(`Batch hydration failed for ${chunk.length} works: ${error}`);
      }
    }

    return all;
  }

  normalizeCandidate(work, { direction, seed }) {
    if (!work || typeof work !== "object") return null;

    const location = this.bestLocation(work);
    const source = (location && location.source) || {};
    const doi = OpenAlexProvider.clampStr(work.doi || work.ids?.doi || "", 256);

    // Truncate user-controlled strings: reasonable upper bounds keep an
    // adversarial provider from running the UI out of memory or slowing
    // the table render.
    return {
      provider: "openalex",
      providerID: OpenAlexProvider.clampStr(work.id || "", 256),
      openAlexID: OpenAlexProvider.clampStr(work.id || "", 256),
      semanticScholarID: "",
      doi,
      title: OpenAlexProvider.clampStr(work.display_name || work.title || "", 1000),
      year: Number.isFinite(work.publication_year) ? work.publication_year : null,
      publicationDate: OpenAlexProvider.clampStr(work.publication_date || "", 32),
      type: OpenAlexProvider.clampStr(work.type || "", 64),
      venue: OpenAlexProvider.clampStr(source.display_name || "", 256),
      url: this.safeURL(location?.landing_page_url || doi || work.id || ""),
      pdfURL: this.safeURL(location?.pdf_url || ""),
      citedByCount: Number.isFinite(work.cited_by_count) ? Math.max(0, work.cited_by_count) : 0,
      // Expose the candidate's own reference list so downstream ranking can
      // compute bibliographic coupling against the seeds. Capped at 1000
      // refs to keep candidate objects bounded.
      referencedWorks: this.normalizeReferencedWorks(work.referenced_works, 1000),
      abstract: OpenAlexProvider.clampStr(
        this.reconstructAbstract(work.abstract_inverted_index),
        8000
      ),
      authors: this.extractAuthors(Array.isArray(work.authorships) ? work.authorships : []),
      direction,
      seedTitle: OpenAlexProvider.clampStr(seed?.title || "", 1000),
      seedZoteroItemID: seed?.zoteroItemID || null,
      relevanceScore: 0,
      alreadyInLibrary: false,
      existingItemID: null,
      selectedByDefault: true
    };
  }

  /**
   * Only return the URL if it looks like a normal http(s) link. Anything
   * else (javascript:, data:, file:, mailto:, …) is dropped to "" so it
   * can't end up rendered as a clickable link or written into Zotero.
   */
  safeURL(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) return "";
    return OpenAlexProvider.clampStr(s, 2000);
  }

  static clampStr(value, max) {
    const s = String(value == null ? "" : value);
    if (s.length <= max) return s;
    return s.slice(0, max);
  }

  normalizeReferencedWorks(value, max) {
    if (!Array.isArray(value)) return [];
    const out = [];
    const seen = new Set();
    for (const v of value) {
      if (out.length >= max) break;
      const id = this.shortOpenAlexID(v);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  bestLocation(work) {
    const primary = work.primary_location || {};
    const oa = work.best_oa_location || {};

    if (primary.landing_page_url || primary.pdf_url || primary.source) {
      return primary;
    }

    return oa;
  }

  reconstructAbstract(index) {
    if (!index) {
      return "";
    }

    const words = [];
    for (const [word, positions] of Object.entries(index)) {
      for (const position of positions) {
        words[position] = word;
      }
    }

    return words.filter(Boolean).join(" ");
  }

  extractAuthors(authorships) {
    return authorships.map((authorship) => {
      const display = authorship.author?.display_name || "";
      const parts = display.trim().split(/\s+/).filter(Boolean);

      return {
        name: display,
        firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : "",
        lastName: parts.length > 1 ? parts[parts.length - 1] : display
      };
    });
  }

  shortOpenAlexID(id) {
    return String(id || "").replace(/^https:\/\/openalex\.org\//, "");
  }

  addAuth(url) {
    if (this.apiKey) {
      url.searchParams.set("api_key", this.apiKey);
    }
  }

  /**
   * Thin shim around SnowballHTTP that adds the OpenAlex API key (if any)
   * to outbound URLs without ever logging it. Delegates retries, timeouts,
   * and error normalization to SnowballHTTP.
   */
  async fetchJSON(url, _attempt = 1, signal = null) {
    if (signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (typeof SnowballHTTP === "undefined") {
      throw new SnowballError("MODULE_LOAD", "HTTP module failed to load.");
    }
    return SnowballHTTP.fetchJSON(url, {
      signal,
      timeoutMs: this.timeoutMs
    });
  }

  // ---------- Streaming API -----------------------------------------------
  // Emits { type } status events plus normalized candidates, one at a time,
  // so the UI can populate progressively and the user can cancel mid-flight.

  async *streamSnowball(seedRecords, signal = null) {
    yield {
      type: "status",
      phase: "resolving",
      message: `Resolving ${seedRecords.length} seed(s)…`
    };

    const resolvedSeeds = [];
    for (let i = 0; i < seedRecords.length; i++) {
      if (signal?.aborted) return;
      const seed = seedRecords[i];
      yield {
        type: "status",
        phase: "resolving",
        message: `Resolving seed ${i + 1} of ${seedRecords.length}: ${seed.title || seed.doi || ""}`
      };
      try {
        const work = await this.resolveSeed(seed, signal);
        if (work) {
          resolvedSeeds.push({ seed, work });
          // Emit the resolved seed so the dialog can build the seed context
          // (referenced_works, author set, title trigrams) used by the
          // ranking module. We pass a *trimmed* shape so consumers don't
          // accidentally hold onto the entire OpenAlex Work payload.
          yield {
            type: "seed-resolved",
            seedIndex: i,
            seed,
            work: {
              id: this.shortOpenAlexID(work.id),
              referenced_works: this.normalizeReferencedWorks(work.referenced_works, 5000)
            }
          };
        }
      } catch (error) {
        if (error?.name === "AbortError") return;
        this.debug(`Seed resolution failed for "${seed.title || seed.doi}": ${error}`);
      }
    }

    for (let i = 0; i < resolvedSeeds.length; i++) {
      if (signal?.aborted) return;
      const { seed, work } = resolvedSeeds[i];

      if (this.includeBackward) {
        yield {
          type: "status",
          phase: "backward",
          message: `Fetching backward references for seed ${i + 1} of ${resolvedSeeds.length}…`
        };
        try {
          for await (const candidate of this.streamBackward(seed, work, signal)) {
            yield { type: "candidate", candidate };
          }
        } catch (error) {
          if (error?.name === "AbortError") return;
          this.debug(`Backward stream failed: ${error}`);
        }
      }

      if (signal?.aborted) return;

      if (this.includeForward) {
        yield {
          type: "status",
          phase: "forward",
          message: `Fetching forward citations for seed ${i + 1} of ${resolvedSeeds.length}…`
        };
        try {
          for await (const candidate of this.streamForward(seed, work, signal)) {
            yield { type: "candidate", candidate };
          }
        } catch (error) {
          if (error?.name === "AbortError") return;
          this.debug(`Forward stream failed: ${error}`);
        }
      }
    }

    yield { type: "status", phase: "done", message: "Done" };
  }

  async *streamBackward(seed, work, signal) {
    const ids = (work.referenced_works || []).slice(0, this.maxBackwardPerSeed);
    const cleanIDs = ids.map((id) => this.shortOpenAlexID(id)).filter(Boolean);

    // 50 per page so the UI sees results sooner than the 100-page batch.
    for (const chunk of SnowballUtil.chunk(cleanIDs, 50)) {
      if (signal?.aborted) return;
      const url = new URL(`${this.baseURL}/works`);
      url.searchParams.set("filter", `openalex:${chunk.join("|")}`);
      url.searchParams.set("per_page", String(chunk.length));
      url.searchParams.set("select", this.fields);
      this.addAuth(url);

      const response = await this.fetchJSON(url, 1, signal);
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const w of results) {
        if (signal?.aborted) return;
        const candidate = this.normalizeCandidate(w, { direction: "backward", seed });
        if (candidate) yield candidate;
      }
    }
  }

  async *streamForward(seed, work, signal) {
    const openAlexID = this.shortOpenAlexID(work.id);
    if (!openAlexID) return;

    // 50 per page + cursor pagination so candidates surface as soon as
    // each page is fetched, up to maxForwardPerSeed total.
    const perPage = 50;
    let cursor = "*";
    let yielded = 0;

    while (cursor && yielded < this.maxForwardPerSeed) {
      if (signal?.aborted) return;
      const url = new URL(`${this.baseURL}/works`);
      url.searchParams.set("filter", `cites:${openAlexID}`);
      url.searchParams.set("per_page", String(perPage));
      url.searchParams.set("select", this.fields);
      url.searchParams.set("cursor", cursor);
      this.addAuth(url);

      const response = await this.fetchJSON(url, 1, signal);
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const w of results) {
        if (signal?.aborted) return;
        if (yielded >= this.maxForwardPerSeed) return;
        const candidate = this.normalizeCandidate(w, { direction: "forward", seed });
        if (candidate) {
          yielded++;
          yield candidate;
        }
      }
      cursor = response?.meta?.next_cursor || null;
      if (!cursor) break;
    }
  }

  deduplicateCandidates(candidates) {
    const seen = new Map();

    for (const candidate of candidates) {
      const key = this.dedupeKey(candidate);
      if (!key) {
        continue;
      }

      if (!seen.has(key)) {
        seen.set(key, candidate);
        continue;
      }

      const existing = seen.get(key);

      existing.direction = existing.direction === candidate.direction ? existing.direction : "both";

      existing.citedByCount = Math.max(existing.citedByCount || 0, candidate.citedByCount || 0);

      if (!existing.abstract && candidate.abstract) {
        existing.abstract = candidate.abstract;
      }

      if (!existing.venue && candidate.venue) {
        existing.venue = candidate.venue;
      }
    }

    return Array.from(seen.values());
  }

  dedupeKey(candidate) {
    const doi = this.normalizeDOI(candidate.doi || "");
    if (doi) {
      return `doi:${doi}`;
    }

    if (candidate.openAlexID) {
      return `openalex:${candidate.openAlexID}`;
    }

    const title = SnowballUtil.normalizeText(candidate.title || "");
    return title ? `title:${title}:${candidate.year || ""}` : "";
  }

  normalizeDOI(doi) {
    return String(doi || "")
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .toLowerCase();
  }

  debug(message, context) {
    // Delegate to SnowballLog when available so secrets are scrubbed; fall
    // back to Zotero.debug only if the log module didn't load.
    if (typeof SnowballLog !== "undefined") {
      SnowballLog.debug(message, context);
      return;
    }
    if (typeof Zotero !== "undefined" && Zotero.debug) {
      Zotero.debug(`Snowball Sources: ${message}`);
    }
  }
};
