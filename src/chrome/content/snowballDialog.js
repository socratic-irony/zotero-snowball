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
    sort: { key: "relevanceScore", dir: "desc" },
    selectedIndex: -1
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

    this.bindControls();
    this.initSplitter();
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
        this.seedContext = SnowballRanking.buildSeedContext(this.args.seeds, []);
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
              this.args.seeds, this.seedWorks
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

    // Allow ⌘F / Ctrl+F to focus the filter box.
    window.addEventListener("keydown", event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "f") {
        event.preventDefault();
        filterInput.focus();
        filterInput.select();
      }
    });

    // Cancel any in-flight stream when the user closes the window.
    window.addEventListener("unload", () => {
      if (this.abortController && !this.abortController.signal.aborted) {
        try { this.abortController.abort(); } catch (_) { /* ignore */ }
      }
    });
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
    this.appendScoreCell(tr, candidate.relevanceScore);
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

  appendScoreCell(tr, score) {
    const cell = this.createHTMLElement("td");
    cell.className = "col-score";
    const value = Math.round((Number(score) || 0) * 100);
    const pill = this.createHTMLElement("span");
    pill.className = "snowball-score-pill";
    pill.textContent = String(value);
    if (value >= 50)      pill.classList.add("snowball-score-high");
    else if (value >= 25) pill.classList.add("snowball-score-mid");
    else                  pill.classList.add("snowball-score-low");
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

    document.getElementById("snowball-detail-meta").textContent = [
      candidate.year || "",
      candidate.venue || "",
      candidate.doi ? `DOI: ${candidate.doi}` : (candidate.openAlexID || "")
    ].filter(Boolean).join("  ·  ");

    document.getElementById("snowball-detail-authors").textContent =
      this.formatAuthors(candidate, 12) || "No authors listed.";

    document.getElementById("snowball-detail-abstract").textContent =
      candidate.abstract || "No abstract available.";
  },

  // ---------- Add to Zotero ------------------------------------------------

  async addSelected() {
    const button = document.getElementById("snowball-add-selected");
    button.disabled = true;

    try {
      const selected = this.candidates.filter(c => c._selected);
      if (!selected.length) {
        window.alert("Select at least one candidate to add.");
        return;
      }
      const result = await this.args.plugin.addCandidatesToZotero(selected, this.args.target);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      const addedN = result?.added?.length || 0;
      const skippedN = result?.skipped?.length || 0;
      const failedN = failed.length;

      let message = `Added ${addedN}; updated/skipped ${skippedN}.`;
      if (failedN) {
        message += `\n\n${failedN} item${failedN === 1 ? "" : "s"} could not be added.`;
        // Show up to 3 reasons so the user gets an actionable hint without
        // a wall of text. Full details are in the Zotero debug log.
        const sample = failed.slice(0, 3).map(f =>
          `• ${(f.candidate?.title || "(untitled)").slice(0, 80)} — ${f.reason || "unknown"}`
        );
        message += "\n\n" + sample.join("\n");
        if (failedN > sample.length) {
          message += `\n…and ${failedN - sample.length} more (see Zotero debug log).`;
        }
      }
      window.alert(message);
      window.close();
    } catch (error) {
      const friendly = (typeof formatUserError === "function")
        ? formatUserError(error)
        : (error?.message || String(error));
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.error("addSelected failed", { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
      window.alert(`Snowball Sources failed while adding items: ${friendly}`);
      button.disabled = false;
    }
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
