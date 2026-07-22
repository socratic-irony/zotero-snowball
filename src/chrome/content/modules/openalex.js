/* global Zotero, SnowballUtil, SnowballLog, SnowballHTTP, SnowballError */

const OPENALEX_MAX_ABSTRACT_POSITION = 10_000;
const OPENALEX_MAX_ABSTRACT_TOKEN_LENGTH = 256;
const OPENALEX_MAX_ABSTRACT_ENTRIES = 10_000;
const OPENALEX_MAX_ABSTRACT_LENGTH = 8_000;
const OPENALEX_MAX_AUTHORS = 100;
const OPENALEX_MAX_AUTHOR_NAME_LENGTH = 256;
const OPENALEX_BACKWARD_CHUNK_SIZE = 100;
const OPENALEX_MAX_WORKERS = 20;
const OPENALEX_MAX_SEED_LABEL_LENGTH = 160;
const OPENALEX_EVENT_BUFFER_SIZE = 100;
const OPENALEX_TERMINAL_ERROR_CODES = new Set([
  "OPENALEX_CREDENTIALS",
  "OPENALEX_BUDGET_EXHAUSTED",
  "OPENALEX_THROTTLED"
]);

var OpenAlexAsyncQueue = class {
  constructor(capacity = Number.POSITIVE_INFINITY) {
    const numericCapacity = Number(capacity);
    this.capacity = Number.isFinite(numericCapacity)
      ? Math.max(0, Math.trunc(numericCapacity))
      : Number.POSITIVE_INFINITY;
    this.values = [];
    this.readers = [];
    this.writers = [];
    this.closed = false;
    this.error = null;
  }

  drainWriters() {
    while (
      !this.closed &&
      !this.error &&
      this.writers.length > 0 &&
      this.values.length < this.capacity
    ) {
      const writer = this.writers.shift();
      this.values.push(writer.value);
      writer.resolve(true);
    }
  }

  settleWriters() {
    for (const writer of this.writers.splice(0)) {
      writer.resolve(false);
    }
  }

  push(value) {
    if (this.closed || this.error) return false;

    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ value, done: false });
      return true;
    }

    if (this.values.length < this.capacity) {
      this.values.push(value);
      return true;
    }

    return new Promise((resolve) => {
      this.writers.push({ value, resolve });
    });
  }

  close() {
    if (this.closed || this.error) return;
    this.closed = true;
    this.settleWriters();
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ value: undefined, done: true });
    }
  }

  fail(error) {
    if (this.closed || this.error) return;
    this.error = error || new Error("Async queue failed.");
    this.values.length = 0;
    this.settleWriters();
    for (const reader of this.readers.splice(0)) {
      reader.reject(this.error);
    }
  }

  next() {
    if (this.error) return Promise.reject(this.error);
    if (this.values.length > 0) {
      const value = this.values.shift();
      this.drainWriters();
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });

    if (this.capacity === 0 && this.writers.length > 0) {
      const writer = this.writers.shift();
      writer.resolve(true);
      return Promise.resolve({ value: writer.value, done: false });
    }

    return new Promise((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator]() {
    return this;
  }
};

var OpenAlexProvider = class {
  static clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  static isTerminalOpenAlexError(error) {
    return OPENALEX_TERMINAL_ERROR_CODES.has(error?.code);
  }

  constructor({
    apiKey = "",
    maxForwardPerSeed = 100,
    maxBackwardPerSeed = 100,
    includeForward = true,
    includeBackward = true,
    maxCandidatesTotal = 1000,
    maxWorkers = OPENALEX_MAX_WORKERS,
    eventBufferSize = OPENALEX_EVENT_BUFFER_SIZE,
    timeoutMs = 30000
  } = {}) {
    this.baseURL = "https://api.openalex.org";
    // Trim defensively: a stray newline in a copy/pasted key would invalidate
    // every request.
    this.apiKey = String(apiKey || "").trim();
    // Clamp every limit so a malformed pref can't cause runaway memory or
    // request storms.
    // Retain legacy options for callers of the batch API. streamSnowball()
    // intentionally ignores per-seed acquisition limits.
    this.maxForwardPerSeed = OpenAlexProvider.clampInt(maxForwardPerSeed, 0, 1000, 100);
    this.maxBackwardPerSeed = OpenAlexProvider.clampInt(maxBackwardPerSeed, 0, 1000, 100);
    this.maxCandidatesTotal = OpenAlexProvider.clampInt(maxCandidatesTotal, 1, 10000, 1000);
    this.maxWorkers = OpenAlexProvider.clampInt(
      maxWorkers,
      1,
      OPENALEX_MAX_WORKERS,
      OPENALEX_MAX_WORKERS
    );
    this.eventBufferSize = OpenAlexProvider.clampInt(
      eventBufferSize,
      1,
      10000,
      OPENALEX_EVENT_BUFFER_SIZE
    );
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

  // Legacy batch API. The UI uses streamSnowball(), whose shared consumer
  // owns unique-candidate limits and whose traversal is always exhaustive.
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
      if (error?.name === "AbortError" || OpenAlexProvider.isTerminalOpenAlexError(error)) {
        throw error;
      }
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
      if (error?.name === "AbortError" || OpenAlexProvider.isTerminalOpenAlexError(error)) {
        throw error;
      }
      this.debug(`Title lookup failed for "${title}": ${error}`);
      return null;
    }
  }

  async getBackwardReferences(seed, work, signal = null) {
    const ids = this.normalizeReferencedWorks(work?.referenced_works);
    const works = await this.batchGetWorksByOpenAlexIDs(ids, signal);

    return works.map((candidate) =>
      this.normalizeCandidate(candidate, {
        direction: "backward",
        seed
      })
    );
  }

  async getForwardCitations(seed, work, signal = null) {
    const candidates = [];
    try {
      for await (const candidate of this.streamForward(seed, work, signal)) {
        candidates.push(candidate);
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      this.debug(`Forward citation lookup failed for ${this.shortOpenAlexID(work?.id)}: ${error}`);
    }
    return candidates;
  }

  async batchGetWorksByOpenAlexIDs(ids, signal = null) {
    const cleanIDs = this.normalizeReferencedWorks(ids);

    const chunks = SnowballUtil.chunk(cleanIDs, OPENALEX_BACKWARD_CHUNK_SIZE);
    const all = [];

    for (const chunk of chunks) {
      const url = new URL(`${this.baseURL}/works`);
      url.searchParams.set("filter", `openalex:${chunk.join("|")}`);
      url.searchParams.set("per_page", String(OPENALEX_BACKWARD_CHUNK_SIZE));
      url.searchParams.set("select", this.fields);
      this.addAuth(url);

      try {
        const response = await this.fetchJSON(url, 1, signal);
        all.push(...(response.results || []));
      } catch (error) {
        if (error?.name === "AbortError") throw error;
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

  normalizeReferencedWorks(value, max = Number.POSITIVE_INFINITY) {
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
    if (!index || typeof index !== "object" || Array.isArray(index)) {
      return "";
    }

    const words = [];
    let processedKeys = 0;
    let processedEntries = 0;

    for (const word in index) {
      if (!Object.prototype.hasOwnProperty.call(index, word)) continue;
      if (processedKeys >= OPENALEX_MAX_ABSTRACT_ENTRIES) break;
      processedKeys++;

      const positions = index[word];
      if (!Array.isArray(positions)) continue;
      const token = OpenAlexProvider.clampStr(word, OPENALEX_MAX_ABSTRACT_TOKEN_LENGTH);

      for (const position of positions) {
        if (processedEntries >= OPENALEX_MAX_ABSTRACT_ENTRIES) break;
        processedEntries++;
        if (
          !Number.isFinite(position) ||
          !Number.isInteger(position) ||
          position < 0 ||
          position >= OPENALEX_MAX_ABSTRACT_POSITION
        ) {
          continue;
        }
        words[position] = token;
      }
    }

    return OpenAlexProvider.clampStr(words.filter(Boolean).join(" "), OPENALEX_MAX_ABSTRACT_LENGTH);
  }

  extractAuthors(authorships) {
    if (!Array.isArray(authorships)) return [];

    return authorships.slice(0, OPENALEX_MAX_AUTHORS).map((authorship) => {
      const display = OpenAlexProvider.clampStr(
        authorship?.author?.display_name || "",
        OPENALEX_MAX_AUTHOR_NAME_LENGTH
      );
      const parts = display.trim().split(/\s+/).filter(Boolean);

      return {
        name: display,
        firstName: OpenAlexProvider.clampStr(
          parts.length > 1 ? parts.slice(0, -1).join(" ") : "",
          OPENALEX_MAX_AUTHOR_NAME_LENGTH
        ),
        lastName: OpenAlexProvider.clampStr(
          parts.length > 1 ? parts[parts.length - 1] : display,
          OPENALEX_MAX_AUTHOR_NAME_LENGTH
        )
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

  shortSeedLabel(seed) {
    return OpenAlexProvider.clampStr(
      seed?.title || seed?.doi || "",
      OPENALEX_MAX_SEED_LABEL_LENGTH
    );
  }

  static abortError() {
    if (typeof DOMException !== "undefined") {
      return new DOMException("aborted", "AbortError");
    }
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
  }

  async *streamSnowball(seedRecords, signal = null) {
    const seeds = Array.isArray(seedRecords) ? seedRecords : [];
    yield {
      type: "status",
      phase: "resolving",
      message: `Resolving ${seeds.length} seed(s)…`
    };
    if (signal?.aborted) return;

    const jobs = new OpenAlexAsyncQueue();
    const events = new OpenAlexAsyncQueue(this.eventBufferSize);
    const requestController = new AbortController();
    const requestSignal = requestController.signal;
    const workers = [];
    let queuedJobs = 0;
    let activeJobs = 0;
    let pendingJobs = 0;
    let completedJobs = 0;
    let terminal = false;
    let finishing = false;

    const pushEvent = async (event) => {
      if (terminal) return false;
      return !!(await events.push(event));
    };

    const emitProgress = async (seed) =>
      pushEvent({
        type: "work-progress",
        queued: queuedJobs,
        active: activeJobs,
        pending: pendingJobs,
        completed: completedJobs,
        seed: this.shortSeedLabel(seed)
      });

    const emitStatus = async (phase, message) => pushEvent({ type: "status", phase, message });

    const abort = () => {
      if (terminal) return;
      terminal = true;
      requestController.abort();
      jobs.fail(OpenAlexProvider.abortError());
      events.close();
    };

    const fail = (error) => {
      if (terminal) return;
      terminal = true;
      requestController.abort();
      jobs.fail(error);
      events.fail(error);
    };

    const abortHandler = () => abort();
    signal?.addEventListener("abort", abortHandler, { once: true });

    const enqueue = (job) => {
      if (terminal || requestSignal.aborted) return false;
      pendingJobs++;
      queuedJobs++;
      if (!jobs.push(job)) {
        pendingJobs--;
        queuedJobs--;
        return false;
      }
      return true;
    };

    const emitCandidates = async (results, direction, seed) => {
      for (const work of results) {
        if (terminal || requestSignal.aborted) return false;
        const candidate = this.normalizeCandidate(work, { direction, seed });
        if (candidate && !(await pushEvent({ type: "candidate", candidate }))) return false;
      }
      return true;
    };

    const executeJob = async (job) => {
      const label = this.shortSeedLabel(job.seed) || "seed";

      if (job.kind === "resolve") {
        if (
          !(await emitStatus(
            "resolving",
            `Resolving seed ${job.seedIndex + 1} of ${seeds.length}: ${label}`
          ))
        ) {
          return;
        }
        const work = await this.resolveSeed(job.seed, requestSignal);
        if (!work) {
          await emitStatus("resolve-error", `Could not resolve ${label}; continuing.`);
          return;
        }

        if (terminal || requestSignal.aborted) return;
        // Keep the seed event bounded for ranking consumers. The original
        // Work remains private to the queued jobs below so traversal is not
        // limited by this context payload.
        if (
          !(await pushEvent({
            type: "seed-resolved",
            seedIndex: job.seedIndex,
            seed: job.seed,
            work: {
              id: this.shortOpenAlexID(work.id),
              referenced_works: this.normalizeReferencedWorks(work.referenced_works, 5000)
            }
          }))
        ) {
          return;
        }

        if (this.includeBackward) {
          const ids = this.normalizeReferencedWorks(work.referenced_works);
          for (const chunk of SnowballUtil.chunk(ids, OPENALEX_BACKWARD_CHUNK_SIZE)) {
            enqueue({
              kind: "backward",
              seed: job.seed,
              seedIndex: job.seedIndex,
              ids: chunk
            });
          }
        }

        if (this.includeForward) {
          const openAlexID = this.shortOpenAlexID(work.id);
          if (openAlexID) {
            enqueue({
              kind: "forward",
              seed: job.seed,
              seedIndex: job.seedIndex,
              openAlexID,
              cursor: "*"
            });
          }
        }
        return;
      }

      if (job.kind === "backward") {
        if (!(await emitStatus("backward", `Fetching backward references for ${label}…`))) return;
        const response = await this.fetchBackwardChunk(job.ids, requestSignal);
        const results = Array.isArray(response?.results) ? response.results : [];
        await emitCandidates(results, "backward", job.seed);
        return;
      }

      if (job.kind === "forward") {
        if (!(await emitStatus("forward", `Fetching forward citations for ${label}…`))) return;
        const response = await this.fetchForwardPage(job.openAlexID, job.cursor, requestSignal);
        const results = Array.isArray(response?.results) ? response.results : [];
        if (!(await emitCandidates(results, "forward", job.seed))) return;

        const nextCursor = response?.meta?.next_cursor || null;
        if (!terminal && !requestSignal.aborted && nextCursor) {
          enqueue({
            kind: "forward",
            seed: job.seed,
            seedIndex: job.seedIndex,
            openAlexID: job.openAlexID,
            cursor: nextCursor
          });
        }
      }
    };

    const maybeFinish = async () => {
      if (terminal || finishing || pendingJobs !== 0 || activeJobs !== 0) return;
      finishing = true;
      jobs.close();
      if (!(await pushEvent({ type: "status", phase: "done", message: "Done" }))) return;
      if (terminal) return;
      terminal = true;
      events.close();
    };

    const runWorker = async () => {
      while (!terminal) {
        let result;
        try {
          result = await jobs.next();
        } catch (error) {
          if (terminal || requestSignal.aborted || error?.name === "AbortError") return;
          fail(error);
          return;
        }
        if (result.done || terminal) return;

        const job = result.value;
        queuedJobs--;
        activeJobs++;
        try {
          if (!(await emitProgress(job.seed))) return;
          await executeJob(job);
        } catch (error) {
          if (error?.name === "AbortError" || requestSignal.aborted) {
            abort();
          } else if (OpenAlexProvider.isTerminalOpenAlexError(error)) {
            fail(error);
          } else if (!terminal) {
            const kind = job.kind === "resolve" ? "seed resolution" : `${job.kind} crawl`;
            await emitStatus(
              "error",
              `${kind} failed for ${this.shortSeedLabel(job.seed) || "seed"}; continuing.`
            );
            this.debug(`${kind} failed: ${error}`);
          }
        } finally {
          activeJobs--;
          pendingJobs--;
          completedJobs++;
          if (!terminal) {
            if (await emitProgress(job.seed)) await maybeFinish();
          }
        }
      }
    };

    for (let i = 0; i < seeds.length; i++) {
      enqueue({ kind: "resolve", seed: seeds[i], seedIndex: i });
    }

    for (let i = 0; i < this.maxWorkers && !terminal; i++) {
      workers.push(runWorker());
    }
    await maybeFinish();

    try {
      for await (const event of events) {
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", abortHandler);
      if (!terminal) abort();
      await Promise.all(workers);
    }
  }

  async fetchBackwardChunk(ids, signal = null) {
    const cleanIDs = this.normalizeReferencedWorks(ids);
    if (cleanIDs.length === 0) return { results: [] };

    const url = new URL(`${this.baseURL}/works`);
    url.searchParams.set("filter", `openalex:${cleanIDs.join("|")}`);
    url.searchParams.set("per_page", String(OPENALEX_BACKWARD_CHUNK_SIZE));
    url.searchParams.set("select", this.fields);
    this.addAuth(url);
    return this.fetchJSON(url, 1, signal);
  }

  async fetchForwardPage(openAlexID, cursor, signal = null) {
    const url = new URL(`${this.baseURL}/works`);
    url.searchParams.set("filter", `cites:${openAlexID}`);
    url.searchParams.set("per_page", String(OPENALEX_BACKWARD_CHUNK_SIZE));
    url.searchParams.set("select", this.fields);
    url.searchParams.set("cursor", cursor);
    this.addAuth(url);
    return this.fetchJSON(url, 1, signal);
  }

  async *streamBackward(seed, work, signal) {
    const cleanIDs = this.normalizeReferencedWorks(work?.referenced_works);

    for (const chunk of SnowballUtil.chunk(cleanIDs, OPENALEX_BACKWARD_CHUNK_SIZE)) {
      if (signal?.aborted) return;
      const response = await this.fetchBackwardChunk(chunk, signal);
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const w of results) {
        if (signal?.aborted) return;
        const candidate = this.normalizeCandidate(w, { direction: "backward", seed });
        if (candidate) yield candidate;
      }
    }
  }

  async *streamForward(seed, work, signal) {
    const openAlexID = this.shortOpenAlexID(work?.id);
    if (!openAlexID) return;

    let cursor = "*";

    while (cursor) {
      if (signal?.aborted) return;
      const response = await this.fetchForwardPage(openAlexID, cursor, signal);
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const w of results) {
        if (signal?.aborted) return;
        const candidate = this.normalizeCandidate(w, { direction: "forward", seed });
        if (candidate) yield candidate;
      }
      cursor = response?.meta?.next_cursor || null;
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
