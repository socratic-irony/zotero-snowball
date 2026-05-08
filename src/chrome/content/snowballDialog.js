var SnowballDialog = {
  args: null,
  candidates: [],
  // dedupe key -> candidate (kept in sync with this.candidates)
  dedupeIndex: new Map(),
  // year-bucket index for fuzzy trigram dedupe (catches paraphrased titles)
  yearBuckets: new Map(),
  // Trigram-Jaccard threshold above which two same-year candidates count as duplicates
  TRIGRAM_DEDUPE_THRESHOLD: 0.85,
  abortController: null,
  loading: false,
  pendingRefresh: null,
  // Resolved seed Works (from OpenAlex) accumulated as `seed-resolved` events arrive.
  seedWorks: [],
  // Built/rebuilt from (seedRecords, seedWorks) — input to scoreCandidate.
  seedContext: null,
  state: {
    filter: "",
    direction: "all",
    hideExisting: false,
    minCitedBy: 0,
    sort: { key: "relevanceScore", dir: "desc" },
    selectedIndex: -1
  },
  // Reference to the resolved provider weights, passed through to ranking.
  weights: null,

  // ---------- Lifecycle -----------------------------------------------------

  onLoad(args) {
    // Wrap init so any error is logged loudly to the Zotero debug log
    // instead of silently blanking the dialog.
    try {
      this.init(args);
    } catch (error) {
      const message = `Snowball Sources dialog init failed: ${error?.stack || error}`;
      try {
        if (typeof Zotero !== "undefined" && Zotero.debug) {
          Zotero.debug(message);
        }
      } catch (_) { /* ignore */ }
      try {
        const summary = document.getElementById("snowball-summary");
        if (summary) {
          summary.textContent = "Snowball Sources failed to load";
        }
        const detail = document.getElementById("snowball-detail-abstract");
        if (detail) {
          detail.textContent = String(error?.message || error);
        }
      } catch (_) { /* ignore */ }
    }
  },

  init(args) {
    this.args = args || {};
    this.candidates = [];
    this.dedupeIndex = new Map();
    this.yearBuckets = new Map();
    this.seedWorks = [];
    this.seedContext = null;
    this.weights = (this.args.weights && typeof this.args.weights === "object")
      ? this.args.weights : null;
    this.state.minCitedBy = Number.isFinite(this.args.flags?.minCitedBy)
      ? Math.max(0, this.args.flags.minCitedBy) : 0;

    this.bindControls();
    this.initSplitter();
    this.applyUIState(this.args.uiState);
    this.refresh();

    // Pre-loaded mode (used by tests / future caller that already has
    // candidates): we still support an args.candidates list if provided.
    if (Array.isArray(this.args.candidates) && this.args.candidates.length) {
      for (const c of this.args.candidates) {
        this.ingestCandidate(c, { skipScore: true });
      }
      this.flushRefresh();
      const visible = this.getVisibleCandidates();
      if (visible.length) {
        this.showDetails(visible[0]._index);
      }
      return;
    }

    // Streaming mode: drive the OpenAlex provider ourselves so the user
    // sees results as they arrive and can cancel mid-flight.
    if (Array.isArray(this.args.seeds) && this.args.seeds.length) {
      // Pre-build the seed context from text-only signals so candidates
      // arriving before the first `seed-resolved` event still get scored
      // sensibly. Once seed Works arrive we rebuild with full signals.
      if (typeof SnowballRanking !== "undefined") {
        this.seedContext = SnowballRanking.buildSeedContext(
          this.args.seeds, [], { weights: this.weights }
        );
      }
      this.startStreaming();
    } else {
      this.setStatus("No seed items provided.");
      this.setLoading(false);
    }
  },

  // ---------- Streaming ----------------------------------------------------

  async startStreaming() {
    this.setLoading(true);
    this.setStatus("Starting…");

    let provider;
    try {
      if (typeof OpenAlexProvider === "undefined") {
        throw new Error(
          "OpenAlexProvider not loaded — chrome modules failed to register."
        );
      }
      provider = new OpenAlexProvider(this.args.providerConfig || {});
    } catch (error) {
      this.setLoading(false);
      this.setStatus("Failed to start");
      this.setProgress(String(error?.message || error));
      try { Zotero?.debug?.(`Snowball Sources: provider init failed: ${error?.stack || error}`); }
      catch (_) { /* ignore */ }
      return;
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const maxTotal = this.args.providerConfig?.maxCandidatesTotal || 500;
    const skipExisting = this.args.flags?.skipAlreadyInLibrary !== false;
    const libraryID = this.args.target?.libraryID;

    let added = 0;
    try {
      for await (const event of provider.streamSnowball(this.args.seeds, signal)) {
        if (signal.aborted) break;

        if (event.type === "status") {
          this.setProgress(event.message);
          // Keep the summary up-to-date while we wait for the first
          // candidate so the user sees movement instead of "Starting…".
          if (this.candidates.length === 0) {
            this.setStatus("Searching…");
          }
          continue;
        }

        if (event.type === "seed-resolved") {
          // Accumulate the resolved Work and rebuild the seed context so
          // bibliographic-coupling / co-citation / author-overlap signals
          // become available as soon as a single seed resolves. Cheap
          // (≤ a few seeds × small sets).
          if (event.work) this.seedWorks.push(event.work);
          if (typeof SnowballRanking !== "undefined") {
            this.seedContext = SnowballRanking.buildSeedContext(
              this.args.seeds, this.seedWorks, { weights: this.weights }
            );
          }
          continue;
        }

        if (event.type === "candidate") {
          if (added >= maxTotal) {
            this.abortController.abort();
            break;
          }
          const wasNew = await this.ingestCandidate(event.candidate, {
            libraryID,
            skipExisting
          });
          if (wasNew) added++;
          this.scheduleRefresh();
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        try {
          if (typeof SnowballLog !== "undefined") {
            SnowballLog.error("stream failed", { error: SnowballLog.formatError(error) });
          } else {
            Zotero?.debug?.(`Snowball stream failed: ${error?.stack || error}`);
          }
        } catch (_) { /* ignore */ }
      }
    } finally {
      this.flushRefresh();
      // After the OpenAlex stream finishes (or is canceled), optionally
      // refine scores with Semantic Scholar SPECTER2 embeddings — but
      // ONLY if the user provided an S2 API key. No key, no S2 traffic.
      if (!signal.aborted) {
        try {
          await this.refineWithSemanticScholar();
        } catch (error) {
          if (error?.name !== "AbortError") {
            try {
              if (typeof SnowballLog !== "undefined") {
                SnowballLog.warn("S2 refinement failed", { error: SnowballLog.formatError(error) });
              }
            } catch (_) { /* ignore */ }
          }
        }
      }

      this.setLoading(false);
      this.flushRefresh();
      const total = this.candidates.length;
      if (signal.aborted && this.loadingWasCanceled) {
        this.setProgress(`Stopped — ${total} candidate${total === 1 ? "" : "s"} loaded`);
      } else {
        this.setProgress(`Done — ${total} candidate${total === 1 ? "" : "s"}`);
      }
      // First candidate selected once everything settles, if nothing picked.
      if (this.state.selectedIndex < 0) {
        const visible = this.getVisibleCandidates();
        if (visible.length) {
          this.showDetails(visible[0]._index);
        }
      }
    }
  },

  /**
   * Optional post-stream pass: ask Semantic Scholar for SPECTER2
   * embeddings for the seeds and the deduped candidates, compute the
   * seed centroid, score each candidate by cosine to the centroid, and
   * re-run the composite scorer with the new signal mixed in.
   *
   * Activated only when an S2 API key is set in prefs. Failure is
   * non-fatal: existing scores stay; a warning lands in the debug log.
   */
  async refineWithSemanticScholar() {
    const key = this.args.providerConfig?.semanticScholarAPIKey;
    if (!key) return;
    if (typeof SemanticScholarProvider === "undefined") return;
    if (!this.candidates.length || !this.seedContext) return;

    const signal = this.abortController?.signal || null;
    const s2 = new SemanticScholarProvider({
      apiKey: key,
      timeoutMs: this.args.providerConfig?.timeoutMs || 60000
    });
    if (!s2.isEnabled()) return;

    this.setStatus("Refining with Semantic Scholar…");
    this.setProgress("Fetching SPECTER2 embeddings…");

    const seedDois = (this.args.seeds || []).map(s => s?.doi).filter(Boolean);
    const candDois = this.candidates.map(c => c?.doi).filter(Boolean);
    if (!seedDois.length || !candDois.length) {
      this.setProgress("Semantic Scholar: not enough DOIs for refinement; keeping baseline scores.");
      return;
    }

    let seedEmbeds, candEmbeds;
    try {
      [seedEmbeds, candEmbeds] = await Promise.all([
        s2.fetchEmbeddings(seedDois, signal),
        s2.fetchEmbeddings(candDois, signal)
      ]);
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    }

    if (!seedEmbeds.size || !candEmbeds.size) {
      this.setProgress("Semantic Scholar returned no embeddings; keeping baseline scores.");
      return;
    }

    // Seed centroid (mean vector across resolved seed embeddings).
    const seedVecs = Array.from(seedEmbeds.values());
    const dim = seedVecs[0].length;
    const centroid = new Float32Array(dim);
    for (const v of seedVecs) {
      for (let i = 0; i < dim; i++) centroid[i] += v[i];
    }
    for (let i = 0; i < dim; i++) centroid[i] /= seedVecs.length;

    // Apply embedding similarity to each candidate that has a vector.
    let enriched = 0;
    for (const c of this.candidates) {
      const doi = String(c.doi || "").trim().toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
        .replace(/^doi:/i, "");
      const v = doi ? candEmbeds.get(doi) : null;
      if (!v) continue;
      c._embeddingSimilarity = SnowballUtil.cosineDense(centroid, v);
      enriched++;
    }

    // Re-run the composite scorer so the embedding signal is mixed in.
    if (typeof SnowballRanking !== "undefined" && this.seedContext) {
      for (const c of this.candidates) {
        SnowballRanking.scoreCandidate(c, this.seedContext);
      }
    }

    this.setProgress(`Refined ${enriched} of ${this.candidates.length} candidate${this.candidates.length === 1 ? "" : "s"} with Semantic Scholar`);
  },

  stop() {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.loadingWasCanceled = true;
      this.abortController.abort();
    }
  },

  /**
   * Add a candidate to the local store, deduping by DOI/openalex/title and
   * merging direction (backward+forward → both). Runs library lookup and
   * scoring in-line so newly-arriving rows are sortable immediately.
   *
   * Returns true if the candidate was new (vs. a merge into an existing one).
   */
  async ingestCandidate(raw, { libraryID = null, skipExisting = true, skipScore = false } = {}) {
    // Fast-path: exact dedupe by DOI / OpenAlex ID / normalized title+year.
    const key = this.dedupeKey(raw);
    if (key && this.dedupeIndex.has(key)) {
      this.mergeDuplicate(this.dedupeIndex.get(key), raw);
      return false;
    }

    // Fuzzy fallback: catch paraphrased duplicates ("Attention Is All You
    // Need" vs "Attention is All You Need: …") that exact-key dedupe
    // misses. Only compare within the same year-bucket to keep this O(N)
    // overall instead of O(N²) across the full candidate set.
    const candTrigrams = (typeof SnowballUtil !== "undefined")
      ? SnowballUtil.trigrams(raw.title || "")
      : new Set();
    if (candTrigrams.size) {
      const fuzzy = this.findFuzzyDuplicate(raw, candTrigrams);
      if (fuzzy) {
        this.mergeDuplicate(fuzzy, raw);
        return false;
      }
    }

    const candidate = Object.assign({}, raw);
    candidate._index = this.candidates.length;
    candidate._titleTrigrams = candTrigrams;

    if (libraryID && typeof SnowballZoteroItems !== "undefined") {
      try {
        await SnowballZoteroItems.markExistingCandidate(candidate, libraryID);
      } catch (error) {
        try {
          if (typeof SnowballLog !== "undefined") {
            SnowballLog.warn("markExistingCandidate failed", { error: SnowballLog.formatError(error) });
          } else {
            Zotero?.debug?.(`markExistingCandidate failed: ${error}`);
          }
        } catch (_) { /* ignore */ }
      }
    }

    if (!skipScore && this.seedContext && typeof SnowballRanking !== "undefined") {
      SnowballRanking.scoreCandidate(candidate, this.seedContext);
    }

    if (candidate.alreadyInLibrary && skipExisting) {
      candidate._selected = false;
    } else {
      candidate._selected = candidate.selectedByDefault !== false;
    }

    if (key) this.dedupeIndex.set(key, candidate);
    // Add to year bucket for the trigram fallback. Year-less candidates
    // share a single "_no_year_" bucket; comparison cost there is bounded
    // by maxCandidatesTotal and titles are short enough that Jaccard is
    // negligible per pair.
    const bucketKey = candidate.year != null ? String(candidate.year) : "_no_year_";
    if (!this.yearBuckets.has(bucketKey)) this.yearBuckets.set(bucketKey, []);
    this.yearBuckets.get(bucketKey).push(candidate);

    this.candidates.push(candidate);
    return true;
  },

  /**
   * Merge `raw` into `existing` (an already-stored candidate). Any field
   * upgrade we want to do on dedupe lives here so both the exact and
   * fuzzy paths share semantics.
   */
  mergeDuplicate(existing, raw) {
    if (existing.direction !== raw.direction && raw.direction) {
      existing.direction = "both";
    }
    existing.citedByCount = Math.max(
      existing.citedByCount || 0,
      raw.citedByCount || 0
    );
    if (!existing.abstract && raw.abstract) existing.abstract = raw.abstract;
    if (!existing.venue && raw.venue) existing.venue = raw.venue;
    if (!existing.doi && raw.doi) existing.doi = raw.doi;
    if (!Array.isArray(existing.referencedWorks) || !existing.referencedWorks.length) {
      if (Array.isArray(raw.referencedWorks) && raw.referencedWorks.length) {
        existing.referencedWorks = raw.referencedWorks;
      }
    }
  },

  findFuzzyDuplicate(raw, candTrigrams) {
    if (typeof SnowballUtil === "undefined") return null;
    const bucketKey = raw.year != null ? String(raw.year) : "_no_year_";
    const bucket = this.yearBuckets.get(bucketKey);
    if (!bucket || !bucket.length) return null;
    for (const existing of bucket) {
      const existingTri = existing._titleTrigrams;
      if (!existingTri || !existingTri.size) continue;
      const j = SnowballUtil.jaccardSets(existingTri, candTrigrams);
      if (j >= this.TRIGRAM_DEDUPE_THRESHOLD) return existing;
    }
    return null;
  },

  dedupeKey(candidate) {
    const doi = String(candidate.doi || "").trim().toLowerCase();
    if (doi) return `doi:${doi}`;
    if (candidate.openAlexID) return `oa:${candidate.openAlexID}`;
    const title = String(candidate.title || "").trim().toLowerCase();
    return title ? `title:${title}:${candidate.year || ""}` : "";
  },

  // ---------- Loading / progress UI ---------------------------------------

  setLoading(isLoading) {
    this.loading = isLoading;
    const dialog = document.querySelector(".snowball-dialog");
    if (dialog) dialog.classList.toggle("is-loading", isLoading);
    const stopBtn = document.getElementById("snowball-stop");
    if (stopBtn) {
      if (isLoading) stopBtn.removeAttribute("hidden");
      else stopBtn.setAttribute("hidden", "hidden");
    }
    const loadingEl = document.getElementById("snowball-loading");
    if (loadingEl) {
      if (isLoading) loadingEl.removeAttribute("hidden");
      else loadingEl.setAttribute("hidden", "hidden");
    }
  },

  setStatus(text) {
    const summary = document.getElementById("snowball-summary");
    if (summary) summary.textContent = text;
  },

  setProgress(text) {
    const el = document.getElementById("snowball-progress");
    if (el) el.textContent = text || "";
  },

  /**
   * Throttle full-table re-renders during streaming: at most one render per
   * animation frame is enough to keep the UI responsive without thrashing.
   */
  scheduleRefresh() {
    if (this.pendingRefresh) return;
    this.pendingRefresh = window.requestAnimationFrame(() => {
      this.pendingRefresh = null;
      this.refresh();
    });
  },

  flushRefresh() {
    if (this.pendingRefresh) {
      window.cancelAnimationFrame(this.pendingRefresh);
      this.pendingRefresh = null;
    }
    this.refresh();
  },

  // ---------- Control wiring ------------------------------------------------

  bindControls() {
    const filterInput = document.getElementById("snowball-filter");
    filterInput.addEventListener("input", event => {
      this.state.filter = event.target.value;
      this.refresh();
    });

    document.getElementById("snowball-direction-filter")
      .addEventListener("change", event => {
        this.state.direction = event.target.value;
        this.refresh();
      });

    document.getElementById("snowball-hide-existing")
      .addEventListener("change", event => {
        this.state.hideExisting = event.target.checked;
        this.refresh();
      });

    // Min-cites runtime input (default seeded from prefs).
    const minCitesInput = document.getElementById("snowball-mincites-input");
    if (minCitesInput) {
      minCitesInput.value = String(this.state.minCitedBy || 0);
      minCitesInput.addEventListener("input", event => {
        const n = Number(event.target.value);
        this.state.minCitedBy = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
        this.refresh();
      });
    }


    document.getElementById("snowball-select-all")
      .addEventListener("change", event => {
        const visible = this.getVisibleCandidates();
        for (const candidate of visible) {
          candidate._selected = event.target.checked;
        }
        this.refresh();
      });

    for (const th of document.querySelectorAll("th.sortable")) {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort-key");
        if (this.state.sort.key === key) {
          this.state.sort.dir = this.state.sort.dir === "asc" ? "desc" : "asc";
        } else {
          this.state.sort.key = key;
          // String columns default to ascending; numeric to descending so
          // the most-cited / highest-scored / newest items surface first.
          this.state.sort.dir = this.isStringSortKey(key) ? "asc" : "desc";
        }
        this.refresh();
      });
    }

    // Toast / details-overlay wiring (in-dialog replacements for the
    // ugly default `[JavaScript Application]` alert popup).
    document.getElementById("snowball-toast-dismiss")
      ?.addEventListener("click", () => this.hideToast());
    document.getElementById("snowball-overlay-close")
      ?.addEventListener("click", () => this.hideOverlay());
    document.getElementById("snowball-overlay-ok")
      ?.addEventListener("click", () => this.hideOverlay());
    // Click outside the overlay card to dismiss.
    document.getElementById("snowball-details-overlay")
      ?.addEventListener("click", event => {
        if (event.target.id === "snowball-details-overlay") this.hideOverlay();
      });
    // Esc dismisses overlay/toast.
    window.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      const overlay = document.getElementById("snowball-details-overlay");
      if (overlay && !overlay.hasAttribute("hidden")) {
        event.preventDefault();
        this.hideOverlay();
      }
    });

    // Allow ⌘F / Ctrl+F to focus the filter box.
    window.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "f") {
        event.preventDefault();
        filterInput.focus();
        filterInput.select();
      }
    });

    // Persist window size on resize end (debounced via rAF), and again on
    // unload so a Cmd-W close still saves the latest dimensions.
    window.addEventListener("resize", () => this._scheduleUIStateSave());

    // Cancel any in-flight stream when the user closes the window.
    window.addEventListener("unload", () => {
      if (this.abortController && !this.abortController.signal.aborted) {
        try { this.abortController.abort(); } catch (_) { /* ignore */ }
      }
      // Final write before the window dies — synchronous so the prefs
      // hit disk before we're gone.
      try { this._saveUIStateNow(); } catch (_) { /* ignore */ }
    });
  },

  // ---------- UI state persistence ----------------------------------------

  applyUIState(state) {
    if (!state || typeof state !== "object") return;
    try {
      if (Number.isFinite(state.width) && Number.isFinite(state.height)) {
        const w = Math.max(900,  Math.min(3000, state.width));
        const h = Math.max(520,  Math.min(3000, state.height));
        // Defer to next tick so the dialog has finished its initial layout
        // before we resize it (some Mozilla builds ignore resizeTo() called
        // during onload).
        setTimeout(() => {
          try { window.resizeTo(w, h); } catch (_) { /* ignore */ }
        }, 0);
      }
      if (Number.isFinite(state.detailsWidth)) {
        const dw = Math.max(240, Math.min(2000, state.detailsWidth));
        document.documentElement.style.setProperty(
          "--snowball-details-width", `${Math.round(dw)}px`
        );
      }
    } catch (_) { /* ignore */ }
  },

  _scheduleUIStateSave() {
    if (this._uiStateTimer) clearTimeout(this._uiStateTimer);
    this._uiStateTimer = setTimeout(() => {
      this._uiStateTimer = null;
      this._saveUIStateNow();
    }, 250);
  },

  _saveUIStateNow() {
    try {
      const detailsRoot = document.getElementById("snowball-details");
      const detailsWidth = detailsRoot
        ? Math.round(detailsRoot.getBoundingClientRect().width)
        : null;
      const state = {
        width:        Math.round(window.outerWidth || 0),
        height:       Math.round(window.outerHeight || 0),
        detailsWidth: detailsWidth || 0
      };
      // Hand off to the controller. Going via args.plugin keeps prefs
      // writes scoped to a single owner regardless of how many dialogs
      // are open.
      const plugin = this.args && this.args.plugin;
      if (plugin && typeof plugin.saveUIState === "function") {
        plugin.saveUIState(state);
      }
    } catch (_) { /* ignore */ }
  },

  initSplitter() {
    const splitter = document.getElementById("snowball-splitter");
    const root = document.documentElement;
    const details = document.getElementById("snowball-details");
    const body = document.querySelector(".snowball-body");

    if (!splitter || !details || !body) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onDown = event => {
      if (event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startWidth = details.getBoundingClientRect().width;
      splitter.classList.add("dragging");
      // Prevent text selection while dragging.
      event.preventDefault();
    };

    const onMove = event => {
      if (!dragging) return;
      const bodyRect = body.getBoundingClientRect();
      // Drag toward the left edge → details panel grows.
      const delta = startX - event.clientX;
      const minWidth = 240;
      const maxWidth = Math.max(minWidth, bodyRect.width - 360);
      const next = Math.max(minWidth, Math.min(maxWidth, startWidth + delta));
      root.style.setProperty("--snowball-details-width", `${Math.round(next)}px`);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove("dragging");
      // Persist the splitter offset on drag end (not during) so we don't
      // hammer the prefs file on every mousemove.
      this._scheduleUIStateSave();
    };

    splitter.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Double-click resets to the default width.
    splitter.addEventListener("dblclick", () => {
      root.style.removeProperty("--snowball-details-width");
    });
  },

  // ---------- Data view (filter + sort) ------------------------------------

  isStringSortKey(key) {
    return key === "title" || key === "authors" || key === "venue" || key === "direction";
  },

  sortValue(candidate, key) {
    switch (key) {
      case "authors":            return this.formatAuthors(candidate, 5).toLowerCase();
      case "title":              return (candidate.title || "").toLowerCase();
      case "venue":              return (candidate.venue || "").toLowerCase();
      case "direction":          return candidate.direction || "";
      case "alreadyInLibrary":   return candidate.alreadyInLibrary ? 1 : 0;
      case "relevanceScore":     return Number(candidate.relevanceScore) || 0;
      case "year":               return Number(candidate.year) || 0;
      case "citedByCount":       return Number(candidate.citedByCount) || 0;
      default:                   return "";
    }
  },

  getVisibleCandidates() {
    let list = this.candidates;

    if (this.state.hideExisting) {
      list = list.filter(c => !c.alreadyInLibrary);
    }

    if (this.state.direction !== "all") {
      list = list.filter(c =>
        c.direction === this.state.direction || c.direction === "both"
      );
    }

    const query = this.state.filter.trim().toLowerCase();
    if (query) {
      list = list.filter(c =>
        (c.title || "").toLowerCase().includes(query) ||
        this.formatAuthors(c, 99).toLowerCase().includes(query) ||
        (c.venue || "").toLowerCase().includes(query)
      );
    }

    // Min cited-by — drop candidates below the threshold. citedByCount of
    // 0 is allowed to pass when minCitedBy is 0.
    if (this.state.minCitedBy > 0) {
      const min = this.state.minCitedBy;
      list = list.filter(c => (Number(c.citedByCount) || 0) >= min);
    }

    const { key, dir } = this.state.sort;
    const mult = dir === "asc" ? 1 : -1;

    return list.slice().sort((a, b) => {
      const av = this.sortValue(a, key);
      const bv = this.sortValue(b, key);

      const aMissing = av === null || av === undefined || av === "" || av === 0;
      const bMissing = bv === null || bv === undefined || bv === "" || bv === 0;

      // Always push missing values to the bottom regardless of sort direction.
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;

      if (typeof av === "string") {
        return av.localeCompare(bv) * mult;
      }
      if (av < bv) return -1 * mult;
      if (av > bv) return 1 * mult;
      return 0;
    });
  },

  // ---------- Render --------------------------------------------------------

  refresh() {
    const visible = this.getVisibleCandidates();
    this.renderTable(visible);
    this.updateSortIndicators();
    this.updateSelectAllState(visible);
    this.updateCounts(visible);
  },

  renderTable(visible) {
    const tbody = document.getElementById("snowball-tbody");
    tbody.replaceChildren();

    const empty = document.getElementById("snowball-empty-state");
    if (!visible.length) {
      empty.removeAttribute("hidden");
      return;
    }
    empty.setAttribute("hidden", "hidden");

    for (const candidate of visible) {
      tbody.appendChild(this.renderRow(candidate));
    }
  },

  renderRow(candidate) {
    const tr = this.createHTMLElement("tr");
    tr.dataset.index = String(candidate._index);

    if (candidate._index === this.state.selectedIndex) {
      tr.classList.add("selected");
    }

    tr.addEventListener("click", event => {
      if (event.target?.localName !== "input") {
        this.showDetails(candidate._index);
      }
    });

    this.appendCheckboxCell(tr, candidate);
    this.appendScoreCell(tr, candidate.relevanceScore, candidate);
    this.appendDirectionCell(tr, candidate.direction);
    this.appendStatusCell(tr, candidate.alreadyInLibrary);
    this.appendTextCell(tr, candidate.year || "", "col-year");
    this.appendTextCell(tr, candidate.title || "", "col-title");
    this.appendTextCell(tr, this.formatAuthors(candidate, 5), "col-authors");
    this.appendTextCell(tr, candidate.venue || "", "col-venue");
    this.appendTextCell(tr, this.formatNumber(candidate.citedByCount), "col-cited");

    return tr;
  },

  updateSortIndicators() {
    for (const th of document.querySelectorAll("th.sortable")) {
      th.classList.remove("sort-asc", "sort-desc");
      if (th.getAttribute("data-sort-key") === this.state.sort.key) {
        th.classList.add(this.state.sort.dir === "asc" ? "sort-asc" : "sort-desc");
      }
    }
  },

  updateSelectAllState(visible) {
    const checkbox = document.getElementById("snowball-select-all");
    if (!checkbox) return;
    if (!visible.length) {
      checkbox.checked = false;
      checkbox.indeterminate = false;
      checkbox.disabled = true;
      return;
    }
    checkbox.disabled = false;
    const all = visible.every(c => c._selected);
    const some = visible.some(c => c._selected);
    checkbox.checked = all;
    checkbox.indeterminate = !all && some;
  },

  updateCounts(visible) {
    const total = this.candidates.length;
    const visibleCount = visible.length;
    const selected = this.candidates.filter(c => c._selected).length;
    const word = total === 1 ? "candidate" : "candidates";

    const summary = document.getElementById("snowball-summary");
    if (summary) {
      if (this.loading && total === 0) {
        summary.textContent = "Searching…";
      } else {
        summary.textContent = total === visibleCount
          ? `${total} ${word}`
          : `${visibleCount} of ${total} ${word}`;
      }
    }

    const counter = document.getElementById("snowball-selection-count");
    if (counter) {
      counter.textContent = selected === 1
        ? "1 selected"
        : `${selected} selected`;
    }

    const addButton = document.getElementById("snowball-add-selected");
    if (addButton) {
      addButton.disabled = selected === 0;
    }
  },

  // ---------- Cells ---------------------------------------------------------

  appendCheckboxCell(tr, candidate) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-add";
    const input = this.createHTMLElement("input");
    input.type = "checkbox";
    input.checked = !!candidate._selected;
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("change", () => {
      candidate._selected = input.checked;
      // Update select-all + counter without re-rendering the entire table.
      const visible = this.getVisibleCandidates();
      this.updateSelectAllState(visible);
      this.updateCounts(visible);
    });
    cell.appendChild(input);
    tr.appendChild(cell);
    return cell;
  },

  appendScoreCell(tr, score, candidate) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-score";
    const value = Math.round((Number(score) || 0) * 100);
    const pill = this.createHTMLElement("span");
    pill.className = "snowball-score-pill";
    pill.textContent = String(value);
    if (value >= 50)      pill.classList.add("snowball-score-high");
    else if (value >= 25) pill.classList.add("snowball-score-mid");
    else                  pill.classList.add("snowball-score-low");
    // Hover tooltip — custom positioned panel rather than the native
    // `title` attribute, which Zotero's chrome environment renders
    // unreliably (sometimes not at all) and limits to plain monospace.
    const breakdown = candidate?._scoreBreakdown;
    if (breakdown) {
      pill.dataset.hasBreakdown = "1";
      pill.addEventListener("mouseenter", e => this._showScoreTooltip(e, breakdown));
      pill.addEventListener("mousemove",  e => this._positionScoreTooltip(e));
      pill.addEventListener("mouseleave", () => this._hideScoreTooltip());
      pill.addEventListener("focus",      e => this._showScoreTooltip(e, breakdown));
      pill.addEventListener("blur",       () => this._hideScoreTooltip());
      pill.tabIndex = 0;
    }
    cell.appendChild(pill);
    tr.appendChild(cell);
    return cell;
  },

  // ---- Custom score tooltip ----------------------------------------------

  _showScoreTooltip(event, b) {
    const tip = document.getElementById("snowball-score-tooltip");
    if (!tip || !b) return;

    tip.replaceChildren();
    const dl = this.createHTMLElement("dl");
    dl.className = "snowball-score-tooltip-list";

    const addRow = (label, value, hint) => {
      const dt = this.createHTMLElement("dt");
      dt.textContent = label;
      const dd = this.createHTMLElement("dd");
      const num = this.createHTMLElement("span");
      num.className = "snowball-score-tooltip-num";
      const v = Number(value) || 0;
      num.textContent = (v >= 0 ? "+" : "") + v.toFixed(2);
      dd.appendChild(num);
      if (hint) {
        const h = this.createHTMLElement("span");
        h.className = "snowball-score-tooltip-hint";
        h.textContent = hint;
        dd.appendChild(h);
      }
      dl.appendChild(dt);
      dl.appendChild(dd);
    };

    addRow("Text similarity",      b.text);
    addRow("Bibliographic coupling", b.bibCoupling, b.bibCouplingRaw ? `${b.bibCouplingRaw} shared` : null);
    addRow("Co-citation",          b.coCitation, b.coCitationRaw ? `${b.coCitationRaw} seed${b.coCitationRaw === 1 ? "" : "s"}` : null);
    addRow("Author overlap",       b.authorOverlap);
    addRow("Title fuzzy match",    b.titleTrigram);
    addRow("Citation count",       b.citation);
    if (b.embedding > 0)    addRow("S2 embedding",       b.embedding);
    if (b.abstractPenalty)  addRow("Abstract penalty",   b.abstractPenalty);
    if (b.duplicatePenalty) addRow("Already in library", b.duplicatePenalty);
    if (b.directionBoost)   addRow("Both-directions",    b.directionBoost);

    tip.appendChild(dl);
    tip.removeAttribute("hidden");
    this._positionScoreTooltip(event);
  },

  _positionScoreTooltip(event) {
    const tip = document.getElementById("snowball-score-tooltip");
    const dialog = document.querySelector(".snowball-dialog");
    if (!tip || !dialog || tip.hasAttribute("hidden")) return;
    const dr = dialog.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    // Anchor near the cursor with a small offset; clamp inside the dialog.
    const margin = 8;
    let x = event.clientX - dr.left + 14;
    let y = event.clientY - dr.top + 14;
    if (x + tr.width + margin > dr.width) {
      // Flip to the left of the cursor when there's no room on the right.
      x = Math.max(margin, event.clientX - dr.left - tr.width - 14);
    }
    if (y + tr.height + margin > dr.height) {
      y = Math.max(margin, event.clientY - dr.top - tr.height - 14);
    }
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top  = `${Math.round(y)}px`;
  },

  _hideScoreTooltip() {
    document.getElementById("snowball-score-tooltip")?.setAttribute("hidden", "hidden");
  },

  appendDirectionCell(tr, direction) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-direction";
    const pill = this.createHTMLElement("span");
    const key = direction || "unknown";
    pill.className = `snowball-pill snowball-direction-${key}`;
    pill.textContent = this.directionLabel(direction);
    cell.appendChild(pill);
    tr.appendChild(cell);
    return cell;
  },

  appendStatusCell(tr, alreadyInLibrary) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-status";
    const pill = this.createHTMLElement("span");
    if (alreadyInLibrary) {
      pill.className = "snowball-pill snowball-status-existing";
      pill.textContent = "In library";
    } else {
      pill.className = "snowball-pill snowball-status-new";
      pill.textContent = "New";
    }
    cell.appendChild(pill);
    tr.appendChild(cell);
    return cell;
  },

  appendTextCell(row, value, className) {
    const cell = this.createHTMLElement("td");
    if (className) cell.className = className;
    cell.textContent = String(value ?? "");
    row.appendChild(cell);
    return cell;
  },

  // ---------- Details panel ------------------------------------------------

  showDetails(index) {
    if (index < 0) return;
    const candidate = this.candidates[index];
    if (!candidate) return;

    this.state.selectedIndex = index;

    const tbody = document.getElementById("snowball-tbody");
    if (tbody) {
      for (const row of tbody.querySelectorAll("tr.selected")) {
        row.classList.remove("selected");
      }
      const target = tbody.querySelector(`tr[data-index="${index}"]`);
      if (target) target.classList.add("selected");
    }

    document.getElementById("snowball-detail-title").textContent =
      candidate.title || "Untitled";

    // Meta line: year · venue · clickable DOI / landing-page link.
    const meta = document.getElementById("snowball-detail-meta");
    if (meta) {
      meta.replaceChildren();
      const sep = () => {
        const s = this.createHTMLElement("span");
        s.className = "snowball-meta-sep";
        s.textContent = "  ·  ";
        return s;
      };
      const text = (value) => {
        const span = this.createHTMLElement("span");
        span.textContent = String(value);
        return span;
      };
      let first = true;
      const push = (node) => {
        if (!first) meta.appendChild(sep());
        meta.appendChild(node);
        first = false;
      };
      if (candidate.year)  push(text(candidate.year));
      if (candidate.venue) push(text(candidate.venue));
      // Prefer DOI link, fall back to candidate.url, fall back to OpenAlex page.
      const linkSpec = this._resolveDetailLink(candidate);
      if (linkSpec) push(this._createDetailLink(linkSpec.label, linkSpec.url));
    }

    document.getElementById("snowball-detail-authors").textContent =
      this.formatAuthors(candidate, 12) || "No authors listed.";

    document.getElementById("snowball-detail-abstract").textContent =
      candidate.abstract || "No abstract available.";
  },

  _resolveDetailLink(candidate) {
    const doi = String(candidate.doi || "").trim();
    if (doi) {
      const safe = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
                       .replace(/^doi:/i, "");
      return { label: `DOI: ${safe}`, url: `https://doi.org/${encodeURI(safe)}` };
    }
    if (typeof candidate.url === "string" && /^https?:\/\//i.test(candidate.url)) {
      return { label: "Open in browser", url: candidate.url };
    }
    if (candidate.openAlexID) {
      return {
        label: candidate.openAlexID,
        url: `https://openalex.org/${encodeURIComponent(candidate.openAlexID)}`
      };
    }
    return null;
  },

  /**
   * Build a clickable detail link. Prefers Zotero.launchURL (which opens
   * in the user's default external browser per Zotero's rules); falls
   * back to window.open when launchURL isn't available.
   */
  _createDetailLink(label, url) {
    const a = this.createHTMLElement("a");
    a.className = "snowball-detail-link";
    a.href = url;
    a.textContent = label;
    a.title = url;
    a.addEventListener("click", event => {
      event.preventDefault();
      try {
        if (typeof Zotero !== "undefined" && typeof Zotero.launchURL === "function") {
          Zotero.launchURL(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      } catch (_) { /* ignore */ }
    });
    return a;
  },

  // ---------- Toast + details overlay -------------------------------------
  //
  // These replace the default browser alert popup (which renders with an
  // ugly "[JavaScript Application]" window header) with an in-dialog
  // notification region styled to match the rest of the UI.

  /**
   * Show an in-dialog toast.
   * @param {object} opts
   * @param {string} opts.message
   * @param {"success"|"warning"|"error"} [opts.kind="success"]
   * @param {{label:string,onClick:()=>void}} [opts.action]
   *        Optional inline action button (e.g. "View details").
   * @param {number} [opts.autoCloseMs=0]
   *        Hide the toast after this many ms. 0 = persistent.
   */
  showToast({ message, kind = "success", action = null, autoCloseMs = 0 } = {}) {
    const toast    = document.getElementById("snowball-toast");
    const messageEl = document.getElementById("snowball-toast-message");
    const actionEl  = document.getElementById("snowball-toast-action");
    const iconEl    = document.getElementById("snowball-toast-icon");
    if (!toast || !messageEl || !actionEl || !iconEl) return;

    toast.classList.remove("toast-success", "toast-warning", "toast-error");
    toast.classList.add(`toast-${kind}`);
    messageEl.textContent = String(message || "");
    iconEl.textContent =
      kind === "success" ? "✓" :
      kind === "warning" ? "!" :
      kind === "error"   ? "✕" : "•";

    // Reset action button between calls.
    actionEl.onclick = null;
    if (action && action.label && typeof action.onClick === "function") {
      actionEl.removeAttribute("hidden");
      actionEl.textContent = action.label;
      actionEl.onclick = () => {
        try { action.onClick(); } catch (e) {
          try {
            if (typeof SnowballLog !== "undefined") {
              SnowballLog.warn("toast action failed", { error: SnowballLog.formatError(e) });
            }
          } catch (_) { /* ignore */ }
        }
      };
    } else {
      actionEl.setAttribute("hidden", "hidden");
    }

    toast.removeAttribute("hidden");

    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    if (autoCloseMs > 0) {
      this._toastTimer = setTimeout(() => this.hideToast(), autoCloseMs);
    }
  },

  hideToast() {
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    const toast = document.getElementById("snowball-toast");
    toast?.setAttribute("hidden", "hidden");
  },

  /**
   * Show the failed-items details overlay. Builds a list of {title, reason}
   * rows so the user can see exactly what didn't make it into Zotero.
   */
  showFailedDetails(failed) {
    const overlay = document.getElementById("snowball-details-overlay");
    const body    = document.getElementById("snowball-overlay-body");
    if (!overlay || !body) return;

    body.replaceChildren();
    const ul = this.createHTMLElement("ul");
    ul.className = "snowball-failed-list";
    for (const f of (Array.isArray(failed) ? failed : [])) {
      const li = this.createHTMLElement("li");
      const title = this.createHTMLElement("div");
      title.className = "snowball-failed-title";
      title.textContent = String(f?.candidate?.title || "(untitled)");
      const reason = this.createHTMLElement("div");
      reason.className = "snowball-failed-reason";
      reason.textContent = String(f?.reason || "unknown error");
      li.appendChild(title);
      li.appendChild(reason);
      ul.appendChild(li);
    }
    body.appendChild(ul);

    overlay.removeAttribute("hidden");
  },

  hideOverlay() {
    document.getElementById("snowball-details-overlay")
      ?.setAttribute("hidden", "hidden");
  },

  // ---------- Add to Zotero ------------------------------------------------

  async addSelected() {
    const button = document.getElementById("snowball-add-selected");
    button.disabled = true;

    try {
      const selected = this.candidates.filter(c => c._selected);
      if (!selected.length) {
        this.showToast({
          message: "Select at least one candidate to add.",
          kind: "warning",
          autoCloseMs: 3000
        });
        button.disabled = false;
        return;
      }

      const result = await this.args.plugin.addCandidatesToZotero(selected, this.args.target);
      const failed   = Array.isArray(result?.failed) ? result.failed : [];
      const addedN   = result?.added?.length   || 0;
      const skippedN = result?.skipped?.length || 0;
      const failedN  = failed.length;

      const summary = this._formatAddSummary(addedN, skippedN, failedN);

      if (failedN === 0) {
        // Happy path: brief confirmation, then close the dialog.
        this.showToast({ message: summary, kind: "success", autoCloseMs: 2200 });
        setTimeout(() => { try { window.close(); } catch (_) { /* ignore */ } }, 2200);
      } else {
        // Partial failure: keep the dialog open so the user can investigate.
        this.showToast({
          message: summary,
          kind: "warning",
          action: {
            label: "View details",
            onClick: () => this.showFailedDetails(failed)
          },
          autoCloseMs: 0
        });
        button.disabled = false;
      }
    } catch (error) {
      const friendly = (typeof formatUserError === "function")
        ? formatUserError(error)
        : (error?.message || String(error));
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.error("addSelected failed", { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
      this.showToast({
        message: `Couldn't add items: ${friendly}`,
        kind: "error",
        autoCloseMs: 0
      });
      button.disabled = false;
    }
  },

  _formatAddSummary(addedN, skippedN, failedN) {
    const parts = [];
    if (addedN > 0)   parts.push(`Added ${addedN} ${addedN === 1 ? "item" : "items"} to Zotero`);
    if (skippedN > 0) parts.push(`updated ${skippedN} existing`);
    if (failedN > 0)  parts.push(`${failedN} couldn't be added`);
    if (!parts.length) return "Nothing added.";
    // Capitalize first; join with appropriate punctuation.
    let joined = parts.join("; ");
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  },

  // ---------- Helpers -------------------------------------------------------

  directionLabel(direction) {
    switch (direction) {
      case "backward": return "← Backward";
      case "forward":  return "Forward →";
      case "both":     return "↔ Both";
      default:         return direction || "";
    }
  },

  formatAuthors(candidate, limit = 5) {
    return (candidate.authors || [])
      .map(author => author.name || [author.firstName, author.lastName].filter(Boolean).join(" "))
      .filter(Boolean)
      .slice(0, limit)
      .join(", ");
  },

  formatNumber(value) {
    const n = Number(value) || 0;
    return n.toLocaleString();
  },

  formatScore(score) {
    return Math.round((Number(score) || 0) * 100);
  },

  createHTMLElement(tagName) {
    return document.createElementNS("http://www.w3.org/1999/xhtml", tagName);
  }
};
