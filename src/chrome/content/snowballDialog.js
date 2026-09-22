// Review dialog controller. Candidate storage and dedupe live in
// modules/candidateStore.js, and all filtering, sorting, and display text
// in modules/candidateView.js; this file only wires those to the DOM and
// to the OpenAlex stream.
var SnowballDialog = {
  args: null,
  // SnowballCandidateStore — created fresh in init().
  store: null,
  abortController: null,
  loadingWasCanceled: false,
  limitWasReached: false,
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

  /** All candidates in arrival order (owned by the store). */
  get candidates() {
    return this.store ? this.store.candidates : [];
  },

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
      } catch (_) {
        /* ignore */
      }
      try {
        const summary = document.getElementById("snowball-summary");
        if (summary) {
          summary.textContent = "Snowball Sources failed to load";
        }
        const detail = document.getElementById("snowball-detail-abstract");
        if (detail) {
          detail.textContent = String(error?.message || error);
        }
      } catch (_) {
        /* ignore */
      }
    }
  },

  init(args) {
    this.args = args || {};
    this.store = new SnowballCandidateStore();
    this.seedWorks = [];
    this.seedContext = null;
    this.weights =
      this.args.weights && typeof this.args.weights === "object" ? this.args.weights : null;
    this.state.minCitedBy = Number.isFinite(this.args.flags?.minCitedBy)
      ? Math.max(0, this.args.flags.minCitedBy)
      : 0;

    this.bindControls();
    this.initSplitter();
    this.applyUIState(this.args.uiState);
    this.applyColumnVisibility(this.args.columns);
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
        this.seedContext = SnowballRanking.buildSeedContext(this.args.seeds, [], {
          weights: this.weights
        });
      }
      this.startStreaming();
    } else {
      this.setStatus("No seed items provided.");
      this.setLoading(false);
    }
  },

  // ---------- Streaming ----------------------------------------------------

  async startStreaming() {
    this.loadingWasCanceled = false;
    this.limitWasReached = false;
    this.setLoading(true);
    this.setStatus("Starting…");

    const apiKey = String(this.args.providerConfig?.apiKey || "").trim();
    if (!apiKey) {
      this.setLoading(false);
      this.setStatus("OpenAlex API key required");
      this.setProgress(
        "Enter your OpenAlex API key in Snowball Sources Preferences before searching."
      );
      return;
    }

    let provider;
    try {
      if (typeof OpenAlexProvider === "undefined") {
        throw new Error("OpenAlexProvider not loaded — chrome modules failed to register.");
      }
      provider = new OpenAlexProvider(this.args.providerConfig || {});
    } catch (error) {
      this.setLoading(false);
      this.setStatus("Failed to start");
      this.setProgress(String(error?.message || error));
      try {
        Zotero?.debug?.(`Snowball Sources: provider init failed: ${error?.stack || error}`);
      } catch (_) {
        /* ignore */
      }
      return;
    }

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const limitResults = this.args.providerConfig?.limitResults === true;
    const configuredMaxTotal = Number(this.args.providerConfig?.maxCandidatesTotal);
    const maxTotal =
      Number.isFinite(configuredMaxTotal) && configuredMaxTotal >= 1
        ? Math.trunc(configuredMaxTotal)
        : 1000;
    const skipExisting = this.args.flags?.skipAlreadyInLibrary !== false;
    const libraryID = this.args.target?.libraryID;

    let added = 0;
    let streamErrorMessage = null;
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

        if (event.type === "work-progress") {
          const unique = this.candidates.length;
          this.setProgress(
            SnowballCandidateView.workProgressText(unique, event.active, event.queued)
          );
          if (unique === 0) {
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
            this.seedContext = SnowballRanking.buildSeedContext(this.args.seeds, this.seedWorks, {
              weights: this.weights
            });
          }
          continue;
        }

        if (event.type === "candidate") {
          const wasNew = await this.ingestCandidate(event.candidate, {
            libraryID,
            skipExisting
          });
          if (wasNew) {
            added++;
            if (limitResults && added >= maxTotal) {
              this.limitWasReached = true;
              this.abortController.abort();
              break;
            }
          }
          this.scheduleRefresh();
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") {
        let friendly = "";
        try {
          if (typeof formatUserError === "function") {
            friendly = formatUserError(error);
          } else if (
            typeof SnowballLog !== "undefined" &&
            typeof SnowballLog.scrub === "function"
          ) {
            friendly = SnowballLog.scrub(String(error?.userMessage || error?.message || error));
          }
        } catch (_) {
          /* use the generic message below */
        }
        streamErrorMessage = String(friendly || "Unable to complete the search. Please try again.");
        try {
          if (typeof SnowballLog !== "undefined") {
            SnowballLog.error("stream failed", { error: SnowballLog.formatError(error) });
          } else {
            Zotero?.debug?.(`Snowball stream failed: ${error?.stack || error}`);
          }
        } catch (_) {
          /* ignore */
        }
      }
    } finally {
      this.flushRefresh();
      // After the OpenAlex stream finishes (or is canceled), optionally
      // refine scores with Semantic Scholar SPECTER2 embeddings — but
      // ONLY if the user provided an S2 API key. No key, no S2 traffic.
      if (!signal.aborted && !streamErrorMessage) {
        try {
          await this.refineWithSemanticScholar();
        } catch (error) {
          if (error?.name !== "AbortError") {
            try {
              if (typeof SnowballLog !== "undefined") {
                SnowballLog.warn("S2 refinement failed", { error: SnowballLog.formatError(error) });
              }
            } catch (_) {
              /* ignore */
            }
          }
        }
      }

      this.setLoading(false);
      this.flushRefresh();
      const end = SnowballCandidateView.streamEndText({
        errorMessage: streamErrorMessage,
        limitReached: this.limitWasReached,
        aborted: signal.aborted,
        total: this.candidates.length
      });
      this.setStatus(end.status);
      this.setProgress(end.progress);
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

    const seedDois = (this.args.seeds || []).map((s) => s?.doi).filter(Boolean);
    const candDois = this.candidates.map((c) => c?.doi).filter(Boolean);
    if (!seedDois.length || !candDois.length) {
      this.setProgress(
        "Semantic Scholar: not enough DOIs for refinement; keeping baseline scores."
      );
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
      const doi = String(c.doi || "")
        .trim()
        .toLowerCase()
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

    this.setProgress(
      `Refined ${enriched} of ${this.candidates.length} candidate${this.candidates.length === 1 ? "" : "s"} with Semantic Scholar`
    );
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
    const match = this.store.findMatch(raw);
    if (match.duplicate) {
      SnowballCandidateStore.mergeDuplicate(match.duplicate, raw);
      return false;
    }

    const candidate = SnowballCandidateStore.createCandidate(raw, match.trigrams);

    if (libraryID && typeof SnowballZoteroItems !== "undefined") {
      try {
        await SnowballZoteroItems.markExistingCandidate(candidate, libraryID);
      } catch (error) {
        try {
          if (typeof SnowballLog !== "undefined") {
            SnowballLog.warn("markExistingCandidate failed", {
              error: SnowballLog.formatError(error)
            });
          } else {
            Zotero?.debug?.(`markExistingCandidate failed: ${error}`);
          }
        } catch (_) {
          /* ignore */
        }
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

    this.store.insert(candidate, match.key);
    return true;
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
    const filterInput = this.control("snowball-filter");
    filterInput.addEventListener("input", () => {
      this.state.filter = filterInput.value;
      this.refresh();
    });

    const directionFilter = this.control("snowball-direction-filter");
    directionFilter.addEventListener("change", () => {
      this.state.direction = directionFilter.value;
      this.refresh();
    });

    const hideExisting = this.control("snowball-hide-existing");
    hideExisting.addEventListener("change", () => {
      this.state.hideExisting = hideExisting.checked;
      this.refresh();
    });

    document.getElementById("snowball-stop")?.addEventListener("command", () => this.stop());
    document.getElementById("snowball-cancel")?.addEventListener("command", () => window.close());
    document
      .getElementById("snowball-add-selected")
      ?.addEventListener("command", () => this.addSelected());

    // Min-cites runtime input (default seeded from prefs).
    const minCitesInput = this.control("snowball-mincites-input");
    if (minCitesInput) {
      minCitesInput.value = String(this.state.minCitedBy || 0);
      minCitesInput.addEventListener("input", () => {
        const n = Number(minCitesInput.value);
        this.state.minCitedBy = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
        this.refresh();
      });
    }

    const selectAll = this.control("snowball-select-all");
    selectAll.addEventListener("change", () => {
      for (const candidate of this.getVisibleCandidates()) {
        candidate._selected = selectAll.checked;
      }
      this.refresh();
    });

    for (const th of document.querySelectorAll("th.sortable")) {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort-key");
        this.state.sort = SnowballCandidateView.nextSort(this.state.sort, key);
        this.refresh();
      });
    }

    // Toast / details-overlay wiring (in-dialog replacements for the
    // ugly default `[JavaScript Application]` alert popup).
    document
      .getElementById("snowball-toast-dismiss")
      ?.addEventListener("click", () => this.hideToast());
    document
      .getElementById("snowball-overlay-close")
      ?.addEventListener("click", () => this.hideOverlay());
    document
      .getElementById("snowball-overlay-ok")
      ?.addEventListener("click", () => this.hideOverlay());
    // Click outside the overlay card to dismiss.
    const overlayEl = document.getElementById("snowball-details-overlay");
    overlayEl?.addEventListener("click", (event) => {
      if (event.target === overlayEl) this.hideOverlay();
    });
    // Esc dismisses overlay/toast.
    window.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const overlay = document.getElementById("snowball-details-overlay");
      if (overlay && !overlay.hasAttribute("hidden")) {
        event.preventDefault();
        this.hideOverlay();
      }
    });

    // Allow ⌘F / Ctrl+F to focus the filter box.
    window.addEventListener("keydown", (event) => {
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
        try {
          this.abortController.abort();
        } catch (_) {
          /* ignore */
        }
      }
      // Final write before the window dies — synchronous so the prefs
      // hit disk before we're gone.
      try {
        this._saveUIStateNow();
      } catch (_) {
        /* ignore */
      }
    });
  },

  // ---------- UI state persistence ----------------------------------------

  applyUIState(state) {
    if (!state || typeof state !== "object") return;
    try {
      if (Number.isFinite(state.width) && Number.isFinite(state.height)) {
        const w = Math.max(900, Math.min(3000, state.width));
        const h = Math.max(520, Math.min(3000, state.height));
        // Defer to next tick so the dialog has finished its initial layout
        // before we resize it (some Mozilla builds ignore resizeTo() called
        // during onload).
        setTimeout(() => {
          try {
            window.resizeTo(w, h);
          } catch (_) {
            /* ignore */
          }
        }, 0);
      }
      if (Number.isFinite(state.detailsWidth)) {
        const dw = Math.max(240, Math.min(2000, state.detailsWidth));
        document.documentElement.style.setProperty(
          "--snowball-details-width",
          `${Math.round(dw)}px`
        );
      }
    } catch (_) {
      /* ignore */
    }
  },

  /**
   * Toggle column visibility based on prefs. We add `hide-col-X` classes
   * on the dialog root; CSS rules pair those classes with the existing
   * `col-X` class on every <th>/<td> to set `display: none`. Title is
   * intentionally never hidden.
   */
  applyColumnVisibility(columns) {
    if (!columns || typeof columns !== "object") return;
    const dialog = document.querySelector(".snowball-dialog");
    if (!dialog) return;
    for (const [key, visible] of Object.entries(columns)) {
      const cls = `hide-col-${key}`;
      if (visible === false) dialog.classList.add(cls);
      else dialog.classList.remove(cls);
    }
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
        width: Math.round(window.outerWidth || 0),
        height: Math.round(window.outerHeight || 0),
        detailsWidth: detailsWidth || 0
      };
      // Hand off to the controller. Going via args.plugin keeps prefs
      // writes scoped to a single owner regardless of how many dialogs
      // are open.
      const plugin = this.args && this.args.plugin;
      if (plugin && typeof plugin.saveUIState === "function") {
        plugin.saveUIState(state);
      }
    } catch (_) {
      /* ignore */
    }
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

    const onDown = (event) => {
      if (event.button !== 0) return;
      dragging = true;
      startX = event.clientX;
      startWidth = details.getBoundingClientRect().width;
      splitter.classList.add("dragging");
      // Prevent text selection while dragging.
      event.preventDefault();
    };

    const onMove = (event) => {
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

  getVisibleCandidates() {
    return SnowballCandidateView.filterAndSort(this.candidates, this.state);
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

    tr.addEventListener("click", (event) => {
      if (/** @type {Element} */ (event.target)?.localName !== "input") {
        this.showDetails(candidate._index);
      }
    });

    this.appendCheckboxCell(tr, candidate);
    this.appendScoreCell(tr, candidate.relevanceScore, candidate);
    this.appendDirectionCell(tr, candidate.direction);
    this.appendStatusCell(tr, candidate.alreadyInLibrary);
    this.appendTextCell(tr, candidate.year || "", "col-year");
    this.appendTextCell(tr, candidate.title || "", "col-title");
    this.appendTextCell(tr, SnowballCandidateView.formatAuthors(candidate, 5), "col-authors");
    this.appendTextCell(tr, candidate.venue || "", "col-venue");
    this.appendTextCell(
      tr,
      SnowballCandidateView.formatNumber(candidate.citedByCount),
      "col-cited"
    );

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
    const checkbox = this.control("snowball-select-all");
    if (!checkbox) return;
    if (!visible.length) {
      checkbox.checked = false;
      checkbox.indeterminate = false;
      checkbox.disabled = true;
      return;
    }
    checkbox.disabled = false;
    const all = visible.every((c) => c._selected);
    const some = visible.some((c) => c._selected);
    checkbox.checked = all;
    checkbox.indeterminate = !all && some;
  },

  updateCounts(visible) {
    const selected = this.store.selected().length;

    const summary = document.getElementById("snowball-summary");
    if (summary) {
      summary.textContent = SnowballCandidateView.summaryText({
        total: this.candidates.length,
        visible: visible.length,
        loading: this.loading
      });
    }

    const counter = document.getElementById("snowball-selection-count");
    if (counter) {
      counter.textContent = SnowballCandidateView.selectionText(selected);
    }

    const addButton = this.control("snowball-add-selected");
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
    input.addEventListener("click", (event) => event.stopPropagation());
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

  appendScoreCell(tr, score, _candidate) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-score";
    const value = SnowballCandidateView.scorePercent(score);
    const pill = this.createHTMLElement("span");
    pill.className = `snowball-score-pill snowball-score-${SnowballCandidateView.scoreTier(value)}`;
    pill.textContent = String(value);
    cell.appendChild(pill);
    tr.appendChild(cell);
    return cell;
  },

  appendDirectionCell(tr, direction) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-direction";
    const pill = this.createHTMLElement("span");
    const key = direction || "unknown";
    pill.className = `snowball-pill snowball-direction-${key}`;
    pill.textContent = SnowballCandidateView.directionLabel(direction);
    cell.appendChild(pill);
    tr.appendChild(cell);
    return cell;
  },

  appendStatusCell(tr, alreadyInLibrary) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-status";
    const pill = this.createHTMLElement("span");
    const status = SnowballCandidateView.statusLabel(alreadyInLibrary);
    pill.className = `snowball-pill snowball-status-${status.kind}`;
    pill.textContent = status.text;
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

    document.getElementById("snowball-detail-title").textContent = candidate.title || "Untitled";

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
      if (candidate.year) push(text(candidate.year));
      if (candidate.venue) push(text(candidate.venue));
      // Prefer DOI link, fall back to candidate.url, fall back to OpenAlex page.
      const linkSpec = SnowballCandidateView.resolveDetailLink(candidate);
      if (linkSpec) push(this._createDetailLink(linkSpec.label, linkSpec.url));
    }

    document.getElementById("snowball-detail-authors").textContent =
      SnowballCandidateView.formatAuthors(candidate, 12) || "No authors listed.";

    document.getElementById("snowball-detail-abstract").textContent =
      candidate.abstract || "No abstract available.";

    this._renderScoreBreakdown(candidate);
  },

  /**
   * Render the per-signal contribution breakdown as a definition list at
   * the bottom of the details pane. We store `_scoreBreakdown` on every
   * candidate when scoreCandidate runs, so this is just a presentation
   * pass — no recomputation.
   */
  _renderScoreBreakdown(candidate) {
    const section = document.getElementById("snowball-detail-breakdown");
    const list = document.getElementById("snowball-detail-breakdown-list");
    if (!section || !list) return;

    const rows = SnowballCandidateView.breakdownRows(candidate?._scoreBreakdown);
    if (!rows.length) {
      section.setAttribute("hidden", "hidden");
      return;
    }

    list.replaceChildren();
    for (const { label, value, hint } of rows) {
      const dt = this.createHTMLElement("dt");
      dt.textContent = label;
      const dd = this.createHTMLElement("dd");

      const num = this.createHTMLElement("span");
      num.className = "snowball-detail-breakdown-num";
      num.textContent = SnowballCandidateView.formatSigned(value);
      // Tint penalties red, contributions in the secondary text color.
      if (value < 0) num.classList.add("is-negative");
      else if (value > 0) num.classList.add("is-positive");
      dd.appendChild(num);

      if (hint) {
        const h = this.createHTMLElement("span");
        h.className = "snowball-detail-breakdown-hint";
        h.textContent = hint;
        dd.appendChild(h);
      }

      list.appendChild(dt);
      list.appendChild(dd);
    }

    section.removeAttribute("hidden");
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
    a.addEventListener("click", (event) => {
      event.preventDefault();
      try {
        if (typeof Zotero !== "undefined" && typeof Zotero.launchURL === "function") {
          Zotero.launchURL(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      } catch (_) {
        /* ignore */
      }
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
   * @param {string} [opts.message]
   * @param {"success"|"warning"|"error"} [opts.kind="success"]
   * @param {{label:string,onClick:()=>void}} [opts.action]
   *        Optional inline action button (e.g. "View details").
   * @param {number} [opts.autoCloseMs=0]
   *        Hide the toast after this many ms. 0 = persistent.
   */
  showToast({ message, kind = "success", action = null, autoCloseMs = 0 } = {}) {
    const toast = document.getElementById("snowball-toast");
    const messageEl = document.getElementById("snowball-toast-message");
    const actionEl = document.getElementById("snowball-toast-action");
    const iconEl = document.getElementById("snowball-toast-icon");
    if (!toast || !messageEl || !actionEl || !iconEl) return;

    toast.classList.remove("toast-success", "toast-warning", "toast-error");
    toast.classList.add(`toast-${kind}`);
    messageEl.textContent = String(message || "");
    iconEl.textContent =
      kind === "success" ? "✓" : kind === "warning" ? "!" : kind === "error" ? "✕" : "•";

    // Reset action button between calls.
    actionEl.onclick = null;
    if (action && action.label && typeof action.onClick === "function") {
      actionEl.removeAttribute("hidden");
      actionEl.textContent = action.label;
      actionEl.onclick = () => {
        try {
          action.onClick();
        } catch (e) {
          try {
            if (typeof SnowballLog !== "undefined") {
              SnowballLog.warn("toast action failed", { error: SnowballLog.formatError(e) });
            }
          } catch (_) {
            /* ignore */
          }
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
    const body = document.getElementById("snowball-overlay-body");
    if (!overlay || !body) return;

    body.replaceChildren();
    const ul = this.createHTMLElement("ul");
    ul.className = "snowball-failed-list";
    for (const f of Array.isArray(failed) ? failed : []) {
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
    document.getElementById("snowball-details-overlay")?.setAttribute("hidden", "hidden");
  },

  // ---------- Add to Zotero ------------------------------------------------

  async addSelected() {
    const button = this.control("snowball-add-selected");
    button.disabled = true;

    try {
      const selected = this.store.selected();
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
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      const addedN = result?.added?.length || 0;
      const skippedN = result?.skipped?.length || 0;
      const failedN = failed.length;
      const pdfsN = Number(result?.downloadsStarted) || 0;

      const summary = SnowballCandidateView.formatAddSummary(addedN, skippedN, failedN, pdfsN);

      if (failedN === 0) {
        // Happy path: brief confirmation, then close the dialog.
        this.showToast({ message: summary, kind: "success", autoCloseMs: 2200 });
        setTimeout(() => {
          try {
            window.close();
          } catch (_) {
            /* ignore */
          }
        }, 2200);
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
      const friendly =
        typeof formatUserError === "function"
          ? formatUserError(error)
          : error?.message || String(error);
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.error("addSelected failed", { error: SnowballLog.formatError(error) });
        }
      } catch (_) {
        /* ignore */
      }
      this.showToast({
        message: `Couldn't add items: ${friendly}`,
        kind: "error",
        autoCloseMs: 0
      });
      button.disabled = false;
    }
  },

  // ---------- Helpers -------------------------------------------------------

  /**
   * Create an HTML element inside this XUL document, typed by tag name so
   * e.g. "input" gives an HTMLInputElement.
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tagName
   * @returns {HTMLElementTagNameMap[K]}
   */
  createHTMLElement(tagName) {
    return /** @type {any} */ (document.createElementNS("http://www.w3.org/1999/xhtml", tagName));
  },

  /**
   * getElementById for form controls. The HTML inputs and XUL buttons in
   * this dialog all have value/checked/disabled at runtime; lib.dom only
   * knows getElementById returns a generic HTMLElement.
   * @param {string} id
   * @returns {HTMLInputElement | null}
   */
  control(id) {
    return /** @type {HTMLInputElement | null} */ (document.getElementById(id));
  }
};

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("load", () => SnowballDialog.onLoad(window.arguments[0]), { once: true });
}
