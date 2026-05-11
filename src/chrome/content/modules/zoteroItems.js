/* global Zotero */

var SnowballZoteroItems = {
  getTargetContext(seedItems, explicitCollection) {
    const pane = Zotero.getActiveZoteroPane();
    const first = seedItems[0];
    const collection = explicitCollection || pane.getSelectedCollection() || null;

    return {
      libraryID: first.libraryID,
      collectionID: collection ? collection.id : null,
      collectionKey: collection ? collection.key : null
    };
  },

  extractSeedRecords(items) {
    return items.map(item => ({
      zoteroItemID: item.id,
      libraryID: item.libraryID,
      key: item.key,
      title: item.getField("title") || "",
      doi: this.normalizeDOI(item.getField("DOI") || ""),
      year: this.extractYear(item.getField("date") || ""),
      abstract: item.getField("abstractNote") || "",
      creators: item.getCreators ? item.getCreators() : []
    }));
  },

  normalizeDOI(doi) {
    return String(doi || "")
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .toLowerCase();
  },

  extractYear(dateString) {
    const match = String(dateString || "").match(/\b(18|19|20|21)\d{2}\b/);
    return match ? Number(match[0]) : null;
  },

  async markExistingCandidates(candidates, libraryID) {
    for (const candidate of candidates) {
      await this.markExistingCandidate(candidate, libraryID);
    }
    return candidates;
  },

  async markExistingCandidate(candidate, libraryID) {
    candidate.alreadyInLibrary = false;
    candidate.existingItemID = null;

    const doi = this.normalizeDOI(candidate.doi || "");
    if (doi) {
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("DOI", "is", doi);
      const ids = await s.search();
      if (ids.length) {
        candidate.alreadyInLibrary = true;
        candidate.existingItemID = ids[0];
        return candidate;
      }
    }

    if (candidate.title) {
      const s = new Zotero.Search();
      s.libraryID = libraryID;
      s.addCondition("title", "is", candidate.title);
      const ids = await s.search();
      if (ids.length) {
        candidate.alreadyInLibrary = true;
        candidate.existingItemID = ids[0];
      }
    }

    return candidate;
  },

  applyDefaultSelection(candidates, skipAlreadyInLibrary) {
    for (const candidate of candidates) {
      candidate.selectedByDefault = !(skipAlreadyInLibrary && candidate.alreadyInLibrary);
    }

    return candidates;
  },

  /**
   * Adds candidates to Zotero. Each candidate gets its own try/catch inside
   * the transaction so a single malformed item can't roll back the whole
   * batch.
   *
   * @param {object[]} candidates
   * @param {object}   target  { libraryID, collectionID? }
   * @param {object}   [opts]
   * @param {boolean}  [opts.downloadPDFs=true]  Kick off background PDF
   *        downloads for any candidate carrying `pdfURL`. Downloads run
   *        AFTER the DB transaction commits so they don't deadlock the
   *        write path or block the bulk-add.
   *
   * @returns {Promise<{added, skipped, failed, downloadsStarted}>}
   */
  async addCandidates(candidates, target, opts = {}) {
    const downloadPDFs = opts?.downloadPDFs !== false;

    const added = [];
    const skipped = [];
    const failed = [];
    // Collected during the transaction; PDF imports fire AFTER it commits.
    const pdfTargets = [];

    if (!Array.isArray(candidates) || !candidates.length) {
      return { added, skipped, failed, downloadsStarted: 0 };
    }
    if (!target || !Number.isFinite(target.libraryID)) {
      throw new Error("addCandidates: target.libraryID is required.");
    }

    await Zotero.DB.executeTransaction(async () => {
      for (const candidate of candidates) {
        try {
          if (candidate.alreadyInLibrary && candidate.existingItemID) {
            const existing = await Zotero.Items.getAsync(candidate.existingItemID);
            if (!existing) {
              failed.push({ candidate, reason: "existing-item-missing" });
              continue;
            }
            if (target.collectionID) {
              existing.addToCollection(target.collectionID);
            }
            existing.addTag("snowballed");
            existing.addTag("snowball:existing");
            await existing.save();
            skipped.push(candidate);
            continue;
          }

          const item = this.createZoteroItemFromCandidate(candidate, target.libraryID);
          if (target.collectionID) {
            item.addToCollection(target.collectionID);
          }
          item.addTag("snowballed");
          item.addTag("snowball:openalex");
          for (const tag of this.directionTags(candidate.direction)) {
            item.addTag(tag);
          }
          await item.save();
          added.push(candidate);

          // Queue a PDF download if OpenAlex gave us an OA URL. Filtered
          // through safeURL so we never queue a javascript:/data: link.
          if (downloadPDFs) {
            const pdfURL = this._safePDFURL(candidate.pdfURL);
            if (pdfURL && item.id) {
              pdfTargets.push({ candidate, itemID: item.id, pdfURL });
            }
          }
        } catch (error) {
          failed.push({
            candidate,
            reason: error?.message ? String(error.message).slice(0, 200) : "unknown"
          });
          try {
            if (typeof SnowballLog !== "undefined") {
              SnowballLog.warn("Failed to add candidate", {
                title: String(candidate.title || "").slice(0, 120),
                doi: candidate.doi || "",
                error: SnowballLog.formatError(error)
              });
            } else if (typeof Zotero !== "undefined" && Zotero.debug) {
              Zotero.debug(`Snowball Sources: failed to add candidate: ${error}`);
            }
          } catch (_) { /* ignore */ }
        }
      }
    });

    // Fire PDF downloads OUTSIDE the transaction so they don't deadlock
    // Zotero's write path. Fire-and-forget: the user sees a count in the
    // success toast and Zotero's own notifier shows download progress.
    if (pdfTargets.length) {
      this._kickOffPDFDownloads(pdfTargets, target.libraryID);
    }

    return {
      added,
      skipped,
      failed,
      downloadsStarted: pdfTargets.length
    };
  },

  _safePDFURL(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    return /^https?:\/\//i.test(s) ? s : "";
  },

  /**
   * Spawn PDF-import requests in the background. We don't await — Zotero
   * has its own internal queue and the user shouldn't wait for downloads
   * before the dialog closes. Failures land in the Zotero debug log via
   * SnowballLog so the user can triage later if a download silently
   * doesn't appear.
   */
  _kickOffPDFDownloads(targets, libraryID) {
    if (!targets?.length) return;
    if (!Zotero?.Attachments?.importFromURL) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.warn("PDF downloads requested but Zotero.Attachments.importFromURL is unavailable");
        }
      } catch (_) { /* ignore */ }
      return;
    }
    for (const t of targets) {
      // Promise intentionally unawaited.
      Zotero.Attachments.importFromURL({
        libraryID,
        parentItemID: t.itemID,
        url: t.pdfURL,
        title: "Full Text PDF",
        contentType: "application/pdf"
      }).catch(error => {
        try {
          if (typeof SnowballLog !== "undefined") {
            SnowballLog.warn("PDF download failed", {
              title: String(t.candidate?.title || "").slice(0, 120),
              url: t.pdfURL,
              error: SnowballLog.formatError(error)
            });
          }
        } catch (_) { /* ignore */ }
      });
    }
  },

  // Where each item type stores the candidate's "venue" string. Anything not
  // listed here gets the venue stashed in `extra` so the data isn't lost.
  VENUE_FIELD_BY_TYPE: {
    journalArticle:    "publicationTitle",
    magazineArticle:   "publicationTitle",
    newspaperArticle:  "publicationTitle",
    bookSection:       "bookTitle",
    conferencePaper:   "proceedingsTitle",
    preprint:          "repository",
    book:              "publisher",
    thesis:            "university",
    dataset:           "repository"
  },

  createZoteroItemFromCandidate(candidate, libraryID) {
    const itemType = this.mapItemType(candidate.type);
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID;

    // `title` is universal; everything else is set defensively so a single
    // type-incompatible field can't roll back the whole add transaction.
    this.safeSetField(item, "title", candidate.title || "");
    this.safeSetField(
      item,
      "date",
      candidate.publicationDate || (candidate.year ? String(candidate.year) : "")
    );
    this.safeSetField(item, "DOI", this.normalizeDOI(candidate.doi || ""));
    this.safeSetField(item, "url", candidate.url || "");
    this.safeSetField(item, "abstractNote", candidate.abstract || "");

    if (candidate.venue) {
      const venueField = this.VENUE_FIELD_BY_TYPE[itemType];
      const placed = venueField
        ? this.safeSetField(item, venueField, candidate.venue)
        : false;
      if (!placed) {
        // Fallback so the venue isn't silently dropped for unknown types.
        this.appendToExtra(item, `Venue: ${candidate.venue}`);
      }
    }

    if (candidate.authors?.length) {
      item.setCreators(candidate.authors.map(author => ({
        firstName: author.firstName || "",
        lastName: author.lastName || author.name || "",
        creatorType: "author"
      })));
    }

    return item;
  },

  safeSetField(item, field, value) {
    if (value === undefined || value === null || value === "") {
      return false;
    }
    try {
      item.setField(field, value);
      return true;
    } catch (error) {
      try {
        Zotero?.debug?.(
          `Snowball Sources: skipped field "${field}" on type "${item.itemType}": ${error?.message || error}`
        );
      } catch (_) { /* ignore */ }
      return false;
    }
  },

  appendToExtra(item, line) {
    try {
      const current = item.getField("extra") || "";
      const next = current ? `${current}\n${line}` : line;
      item.setField("extra", next);
    } catch (_) { /* if even extra fails, give up silently */ }
  },

  directionTags(direction) {
    if (direction === "both") {
      return ["snowball:forward", "snowball:backward"];
    }

    return [
      direction === "forward"
        ? "snowball:forward"
        : "snowball:backward"
    ];
  },

  mapItemType(openAlexType) {
    const type = String(openAlexType || "").toLowerCase();

    if (type.includes("chapter")) {
      return "bookSection";
    }

    if (type.includes("book")) {
      return "book";
    }

    if (type.includes("preprint")) {
      return "preprint";
    }

    if (type.includes("dataset")) {
      return "dataset";
    }

    if (type.includes("thesis") || type.includes("dissertation")) {
      return "thesis";
    }

    return "journalArticle";
  }
};
