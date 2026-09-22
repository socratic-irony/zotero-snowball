/**
 * Pure presentation helpers for the review dialog: filtering, sorting,
 * and every piece of text the dialog shows about candidates.
 *
 * No DOM and no Zotero APIs, so it can be unit tested under Node. The
 * dialog (snowballDialog.js) only turns these values into elements.
 */
var SnowballCandidateView = {
  // Columns whose values are text; everything else sorts numerically.
  STRING_SORT_KEYS: new Set(["title", "authors", "venue", "direction"]),

  // ---------- Filtering + sorting ------------------------------------------

  /**
   * @param {string} key
   * @returns {boolean}
   */
  isStringSortKey(key) {
    return this.STRING_SORT_KEYS.has(key);
  },

  /**
   * Sort state after the user clicks a column header: clicking the active
   * column flips direction; a new column starts ascending for text and
   * descending for numbers (so the most-cited / highest-scored / newest
   * items come first).
   * @param {{ key: string, dir: string }} current
   * @param {string} key
   */
  nextSort(current, key) {
    if (current && current.key === key) {
      return { key, dir: current.dir === "asc" ? "desc" : "asc" };
    }
    return { key, dir: this.isStringSortKey(key) ? "asc" : "desc" };
  },

  sortValue(candidate, key) {
    switch (key) {
      case "authors":
        return this.formatAuthors(candidate, 5).toLowerCase();
      case "title":
        return (candidate.title || "").toLowerCase();
      case "venue":
        return (candidate.venue || "").toLowerCase();
      case "direction":
        return candidate.direction || "";
      case "alreadyInLibrary":
        return candidate.alreadyInLibrary ? 1 : 0;
      case "relevanceScore":
        return Number(candidate.relevanceScore) || 0;
      case "year":
        return Number(candidate.year) || 0;
      case "citedByCount":
        return Number(candidate.citedByCount) || 0;
      default:
        return "";
    }
  },

  /**
   * Comparator for Array.prototype.sort. Missing values (empty string or
   * 0) always sort last, whichever direction is active.
   */
  compare(a, b, key, dir) {
    const mult = dir === "asc" ? 1 : -1;
    const av = this.sortValue(a, key);
    const bv = this.sortValue(b, key);
    const aMissing = av === "" || av === 0;
    const bMissing = bv === "" || bv === 0;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === "string" && typeof bv === "string") {
      return av.localeCompare(bv) * mult;
    }
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  },

  /**
   * Apply the dialog's filters, then sort. Returns a new array; the input
   * is not modified.
   * @param {any[]} candidates
   * @param {{ hideExisting?: boolean, direction?: string, filter?: string,
   *           minCitedBy?: number, sort?: { key: string, dir: string } }} state
   */
  filterAndSort(candidates, state) {
    let list = Array.isArray(candidates) ? candidates : [];
    const s = state || {};

    if (s.hideExisting) {
      list = list.filter((c) => !c.alreadyInLibrary);
    }

    // "Backward only" still shows works seen in both directions.
    if (s.direction && s.direction !== "all") {
      list = list.filter((c) => c.direction === s.direction || c.direction === "both");
    }

    const query = String(s.filter || "")
      .trim()
      .toLowerCase();
    if (query) {
      list = list.filter(
        (c) =>
          (c.title || "").toLowerCase().includes(query) ||
          this.formatAuthors(c, 99).toLowerCase().includes(query) ||
          (c.venue || "").toLowerCase().includes(query)
      );
    }

    const minCitedBy = Number(s.minCitedBy) || 0;
    if (minCitedBy > 0) {
      list = list.filter((c) => (Number(c.citedByCount) || 0) >= minCitedBy);
    }

    const key = s.sort?.key || "relevanceScore";
    const dir = s.sort?.dir || "desc";
    return list.slice().sort((a, b) => this.compare(a, b, key, dir));
  },

  // ---------- Cell / label text --------------------------------------------

  formatAuthors(candidate, limit = 5) {
    return (candidate?.authors || [])
      .map(
        (author) => author?.name || [author?.firstName, author?.lastName].filter(Boolean).join(" ")
      )
      .filter(Boolean)
      .slice(0, limit)
      .join(", ");
  },

  formatNumber(value) {
    return (Number(value) || 0).toLocaleString();
  },

  /** Relevance score (0–1+) as the integer shown in the Score column. */
  scorePercent(score) {
    return Math.round((Number(score) || 0) * 100);
  },

  /** Color band for a score badge. */
  scoreTier(percent) {
    if (percent >= 50) return "high";
    if (percent >= 25) return "mid";
    return "low";
  },

  directionLabel(direction) {
    switch (direction) {
      case "backward":
        return "← Backward";
      case "forward":
        return "Forward →";
      case "both":
        return "↔ Both";
      default:
        return direction || "";
    }
  },

  /** @returns {{ text: string, kind: "existing" | "new" }} */
  statusLabel(alreadyInLibrary) {
    return alreadyInLibrary
      ? { text: "In library", kind: "existing" }
      : { text: "New", kind: "new" };
  },

  /** "1 candidate" / "3 candidates" */
  pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  },

  // ---------- Toolbar / footer text ----------------------------------------

  /** Toolbar summary, e.g. "42 candidates" or "10 of 42 candidates". */
  summaryText({ total, visible, loading }) {
    if (loading && total === 0) return "Searching…";
    const word = total === 1 ? "candidate" : "candidates";
    return total === visible ? `${total} ${word}` : `${visible} of ${total} ${word}`;
  },

  selectionText(selected) {
    return `${selected} selected`;
  },

  /** Progress line while the parallel crawler is running. */
  workProgressText(unique, active, queued) {
    const clamp = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0);
    return `${this.pluralize(unique, "unique candidate")} found — ${clamp(active)} active, ${clamp(queued)} queued`;
  },

  /**
   * Status + progress text once streaming stops. Precedence: error, then
   * result limit, then user stop, then normal completion.
   * @returns {{ status: string, progress: string }}
   */
  streamEndText({ errorMessage = null, limitReached = false, aborted = false, total = 0 }) {
    const loaded = `${this.pluralize(total, "candidate")} loaded`;
    if (errorMessage) {
      return { status: "Search failed", progress: `Search failed — ${errorMessage} — ${loaded}` };
    }
    if (limitReached) return { status: "Limit reached", progress: `Limit reached — ${loaded}` };
    if (aborted) return { status: "Stopped", progress: `Stopped — ${loaded}` };
    return { status: "Done", progress: `Done — ${loaded}` };
  },

  /** Toast text after "Add Selected to Zotero". */
  formatAddSummary(addedN, skippedN, failedN, pdfsN = 0) {
    const parts = [];
    if (addedN > 0) parts.push(`Added ${this.pluralize(addedN, "item")} to Zotero`);
    if (skippedN > 0) parts.push(`updated ${skippedN} existing`);
    if (failedN > 0) parts.push(`${failedN} couldn't be added`);
    if (pdfsN > 0) parts.push(`downloading ${this.pluralize(pdfsN, "PDF")} in the background`);
    if (!parts.length) return "Nothing added.";
    const joined = parts.join("; ");
    return joined.charAt(0).toUpperCase() + joined.slice(1);
  },

  // ---------- Details pane --------------------------------------------------

  /**
   * Rows for the "Why this score?" section, from the `_scoreBreakdown`
   * that SnowballRanking.scoreCandidate stores on each candidate. Signals
   * that don't apply to this candidate (no embedding, no penalty) are
   * omitted.
   * @returns {{ label: string, value: number, hint: string | null }[]}
   */
  breakdownRows(b) {
    if (!b) return [];
    const rows = [];
    const add = (label, value, hint = null) =>
      rows.push({ label, value: Number(value) || 0, hint });

    add("Text similarity", b.text);
    add(
      "Bibliographic coupling",
      b.bibCoupling,
      b.bibCouplingRaw ? `${this.pluralize(b.bibCouplingRaw, "shared ref")}` : null
    );
    add(
      "Co-citation",
      b.coCitation,
      b.coCitationRaw ? `${this.pluralize(b.coCitationRaw, "seed")} cite this` : null
    );
    add("Author overlap", b.authorOverlap);
    add("Title fuzzy match", b.titleTrigram);
    add("Citation count", b.citation);
    if (b.embedding > 0) add("Semantic Scholar embedding", b.embedding);
    if (b.abstractPenalty) add("No abstract", b.abstractPenalty);
    if (b.duplicatePenalty) add("Already in library", b.duplicatePenalty);
    if (b.directionBoost) add("Both directions bonus", b.directionBoost);
    return rows;
  },

  /** Signed two-decimal number for a breakdown row, e.g. "+0.42". */
  formatSigned(value) {
    const v = Number(value) || 0;
    return (v >= 0 ? "+" : "") + v.toFixed(2);
  },

  /**
   * Link shown in the details pane: the DOI resolver when there's a DOI,
   * otherwise the landing page (http/https only), otherwise the OpenAlex
   * record. Returns null when none apply.
   * @returns {{ label: string, url: string } | null}
   */
  resolveDetailLink(candidate) {
    const doi = String(candidate?.doi || "").trim();
    if (doi) {
      const bare = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "");
      return { label: `DOI: ${bare}`, url: `https://doi.org/${encodeURI(bare)}` };
    }
    if (typeof candidate?.url === "string" && /^https?:\/\//i.test(candidate.url)) {
      return { label: "Open in browser", url: candidate.url };
    }
    if (candidate?.openAlexID) {
      return {
        label: candidate.openAlexID,
        url: `https://openalex.org/${encodeURIComponent(candidate.openAlexID)}`
      };
    }
    return null;
  }
};
