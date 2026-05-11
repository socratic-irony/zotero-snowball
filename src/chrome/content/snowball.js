/* global Zotero, Services, OpenAlexProvider, SnowballZoteroItems, SnowballRanking */

var SnowballSourcesPlugin = class {
  constructor({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.registeredMenus = [];
    this.windows = new Set();
  }

  async startup() {
    this.registerMenus();
    this.addToAllWindows();
    Zotero.debug("Snowball Sources: startup complete");
  }

  registerMenus() {
    this.registeredMenus.push(
      Zotero.MenuManager.registerMenu({
        menuID: "snowball-sources-item-menu",
        pluginID: this.id,
        target: "main/library/item",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "snowball-sources-menu-selected",
            onShowing: (event, context) => {
              context.setVisible(
                !!context.items?.some(item => item.isRegularItem && item.isRegularItem())
              );
            },
            onCommand: async (event, context) => {
              await this.runForItems(context.items || []);
            }
          }
        ]
      })
    );

    this.registeredMenus.push(
      Zotero.MenuManager.registerMenu({
        menuID: "snowball-sources-collection-menu",
        pluginID: this.id,
        target: "main/library/collection",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "snowball-sources-menu-collection",
            onShowing: (event, context) => {
              context.setVisible(!!context.collection);
            },
            onCommand: async (event, context) => {
              await this.runForCollection(context.collection);
            }
          }
        ]
      })
    );

    this.registeredMenus.push(
      Zotero.MenuManager.registerMenu({
        menuID: "snowball-sources-tools-menu",
        pluginID: this.id,
        target: "main/menubar/tools",
        menus: [
          {
            menuType: "menuitem",
            l10nID: "snowball-sources-menu-tools",
            onCommand: async () => {
              await this.runForCurrentSelection();
            }
          },
          {
            menuType: "menuitem",
            l10nID: "snowball-sources-menu-prefs",
            onCommand: () => {
              this.openPrefsDialog();
            }
          }
        ]
      })
    );
  }

  addToWindow(window) {
    this.windows.add(window);
    window.MozXULElement.insertFTLIfNeeded("snowball-sources.ftl");
    this._installToolbarButton(window);
    this._installKeyboardShortcut(window);
  }

  /**
   * Inject a toolbar button into Zotero's items toolbar — the row that
   * holds "New Item" and "Lookup" — so the snowball action sits next to
   * other item-level commands. Falls back silently (logging) if the
   * expected container isn't present.
   *
   * Zotero 9 styles its built-in toolbar icons via CSS keyed to the
   * button id (the `image=` attribute is ignored on `.zotero-tb-button`
   * elements), so we inject a one-rule stylesheet alongside the button.
   * The icon lives under `chrome://snowball-sources/content/icons/` for
   * predictable resolution from the chrome registration.
   */
  _installToolbarButton(window) {
    try {
      const doc = window.document;
      if (doc.getElementById("snowball-toolbar-button")) return;

      // `zotero-items-toolbar` is the hbox inside `zotero-toolbar-item-tree`
      // that holds the per-item action buttons (Add, Lookup, Add Note…).
      // We try a few candidates to be tolerant of Zotero version drift.
      const candidates = [
        "zotero-items-toolbar",
        "zotero-toolbar-item-tree",
        "zotero-collections-toolbar",
        "zotero-tabs-toolbar"
      ];
      let toolbar = null;
      for (const id of candidates) {
        toolbar = doc.getElementById(id);
        if (toolbar) break;
      }
      if (!toolbar) {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.debug("toolbar not found; skipping toolbar button");
        }
        return;
      }

      // One-rule stylesheet so the button's icon shows up. We key the
      // selector to our button id so the rule can't accidentally hit
      // anything else.
      if (!doc.getElementById("snowball-toolbar-style")) {
        const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
        style.id = "snowball-toolbar-style";
        style.textContent = `
          #snowball-toolbar-button {
            list-style-image: url("chrome://snowball-sources/content/icons/toolbar-16.png");
          }
          #snowball-toolbar-button .toolbarbutton-icon {
            width: 16px;
            height: 16px;
          }
        `;
        doc.documentElement.appendChild(style);
      }

      const button = doc.createXULElement("toolbarbutton");
      button.id = "snowball-toolbar-button";
      button.className = "zotero-tb-button";
      button.setAttribute("tooltiptext", "Snowball Sources (⌘⇧S)");
      button.setAttribute("label", "Snowball Sources");
      button.addEventListener("command", () => {
        this.runForCurrentSelection().catch(error => {
          try {
            if (typeof SnowballLog !== "undefined") {
              SnowballLog.error("toolbar action failed", { error: SnowballLog.formatError(error) });
            }
          } catch (_) { /* ignore */ }
        });
      });
      toolbar.appendChild(button);

      if (typeof SnowballLog !== "undefined") {
        SnowballLog.debug("toolbar button installed", { toolbar: toolbar.id });
      }
    } catch (error) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.warn("toolbar button install failed", { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Register a keyboard shortcut on the window so Snowball Sources can be
   * triggered without touching the mouse. We use `accel,shift` so it maps
   * to ⌘⇧S on macOS and Ctrl+Shift+S elsewhere — the conventional
   * "intentional plugin action" modifier set on this platform family.
   */
  _installKeyboardShortcut(window) {
    try {
      const doc = window.document;
      if (doc.getElementById("snowball-key")) return;

      // Zotero's main keyset is `mainKeyset`. Fall back to creating a
      // bound keyset if that's not present.
      let keyset = doc.getElementById("mainKeyset");
      if (!keyset) {
        keyset = doc.createXULElement("keyset");
        keyset.id = "snowball-keyset";
        doc.documentElement.appendChild(keyset);
      }

      const key = doc.createXULElement("key");
      key.id = "snowball-key";
      key.setAttribute("key", "S");
      key.setAttribute("modifiers", "accel,shift");
      // XUL <key> dispatches `command` events when the shortcut fires.
      key.addEventListener("command", () => {
        this.runForCurrentSelection().catch(error => {
          try {
            if (typeof SnowballLog !== "undefined") {
              SnowballLog.error("keyboard action failed", { error: SnowballLog.formatError(error) });
            }
          } catch (_) { /* ignore */ }
        });
      });
      keyset.appendChild(key);
    } catch (error) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.warn("keyboard shortcut install failed", { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
    }
  }

  addToAllWindows() {
    for (const win of Zotero.getMainWindows?.() || []) {
      this.addToWindow(win);
    }
  }

  removeFromWindow(window) {
    this.windows.delete(window);
    window.document.querySelector('[href="snowball-sources.ftl"]')?.remove();
    // Remove the toolbar button and keyboard shortcut we injected, plus
    // the keyset we may have created if Zotero didn't have one.
    try { window.document.getElementById("snowball-toolbar-button")?.remove(); } catch (_) {}
    try { window.document.getElementById("snowball-toolbar-style")?.remove(); } catch (_) {}
    try { window.document.getElementById("snowball-key")?.remove(); } catch (_) {}
    try { window.document.getElementById("snowball-keyset")?.remove(); } catch (_) {}
  }

  shutdown() {
    for (const registeredID of this.registeredMenus) {
      try {
        Zotero.MenuManager.unregisterMenu(registeredID);
      } catch (error) {
        Zotero.debug(`Snowball Sources: menu unregister failed: ${error}`);
      }
    }

    this.registeredMenus = [];

    for (const win of Array.from(this.windows)) {
      this.removeFromWindow(win);
    }
  }

  async runForCurrentSelection() {
    const pane = Zotero.getActiveZoteroPane();
    const items = (pane.getSelectedItems?.() || [])
      .filter(item => item.isRegularItem && item.isRegularItem());

    if (items.length) {
      await this.runForItems(items);
      return;
    }

    const collection = pane.getSelectedCollection?.();
    if (collection) {
      await this.runForCollection(collection);
      return;
    }

    this.alert("Select one or more regular Zotero items, or a collection, before snowballing.");
  }

  async runForCollection(collection) {
    if (!collection) {
      this.alert("No Zotero collection selected.");
      return;
    }

    const items = (collection.getChildItems?.() || [])
      .filter(item => item.isRegularItem && item.isRegularItem());

    await this.runForItems(items, collection);
  }

  async runForItems(items, explicitCollection = null) {
    const regularItems = items.filter(item => item.isRegularItem && item.isRegularItem());

    if (!regularItems.length) {
      this.alert("No regular Zotero items selected.");
      return;
    }

    try {
      const maxSeeds = this.prefInt("maxSeeds", 50, 1, 500);
      const seeds = regularItems.slice(0, maxSeeds);
      const target = SnowballZoteroItems.getTargetContext(seeds, explicitCollection);
      const seedRecords = SnowballZoteroItems.extractSeedRecords(seeds);

      const providerConfig = {
        apiKey: this.prefStr("openAlexAPIKey", ""),
        // Semantic Scholar enrichment is opt-in: empty key disables it
        // entirely (no S2 traffic will be initiated by the dialog).
        semanticScholarAPIKey: this.prefStr("semanticScholarAPIKey", ""),
        maxForwardPerSeed:  this.prefInt("maxForwardPerSeed",  100, 0, 1000),
        maxBackwardPerSeed: this.prefInt("maxBackwardPerSeed", 100, 0, 1000),
        maxCandidatesTotal: this.prefInt("maxCandidatesTotal", 500, 1, 10000),
        timeoutMs:          this.prefInt("requestTimeoutMs",  30000, 1000, 120000),
        includeForward:     this.prefBool("includeForward",   true),
        includeBackward:    this.prefBool("includeBackward",  true)
      };
      // Custom score weights from prefs (defaults match the module's
      // tuned values). Each weight is clamped to [0, 2] so a malformed
      // pref can't push it negative or astronomically large.
      const weightDefaults = {
        text: 1.00, bibCoupling: 0.20, coCitation: 0.15,
        authorOverlap: 0.10, titleTrigram: 0.08, citation: 0.10,
        embedding: 0.40
      };
      const weights = {};
      for (const [k, def] of Object.entries(weightDefaults)) {
        const raw = Number(this.pref(`weights.${k}`, def));
        weights[k] = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : def;
      }
      // Refuse to launch with an entirely empty fetch scope.
      if (!providerConfig.includeForward && !providerConfig.includeBackward) {
        this.alert("Both forward and backward citations are disabled in preferences. Enable at least one to snowball.");
        return;
      }

      // Column-visibility prefs. Title is intentionally absent — it's
      // always shown.
      const columns = {
        score:     this.prefBool("columns.score",     true),
        direction: this.prefBool("columns.direction", true),
        status:    this.prefBool("columns.status",    true),
        year:      this.prefBool("columns.year",      true),
        authors:   this.prefBool("columns.authors",   true),
        venue:     this.prefBool("columns.venue",     true),
        citedBy:   this.prefBool("columns.citedBy",   true)
      };

      this.openReviewDialog({
        seeds: seedRecords,
        target,
        providerConfig,
        weights,
        columns,
        flags: {
          skipAlreadyInLibrary: this.prefBool("skipAlreadyInLibrary", true),
          minCitedBy:           this.prefInt("minCitedBy", 0, 0, 100000)
        },
        uiState: this._readUIState()
      });
    } catch (error) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.error("runForItems failed", { error: SnowballLog.formatError(error) });
        } else {
          Zotero.debug(`Snowball Sources: run failed: ${error?.stack || error}`);
        }
      } catch (_) { /* ignore */ }
      const friendly = (typeof formatUserError === "function")
        ? formatUserError(error)
        : (error?.message || String(error));
      this.alert(`Snowball Sources failed: ${friendly}`);
    }
  }

  openReviewDialog(args) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    // Non-modal so the dialog can drive its own async work and the user can
    // cancel mid-flight; `dependent` keeps it tied to the main window.
    const dialog = win.openDialog(
      "chrome://snowball-sources/content/snowballDialog.xhtml",
      "_blank",
      "chrome,dialog=no,centerscreen,resizable=yes,dependent=yes,width=1200,height=780",
      Object.assign({ plugin: this }, args)
    );
    // Inject `Zotero` into the dialog window so module code loaded inside
    // it (Zotero.debug / Zotero.Search / Zotero.Item) can resolve the
    // global without going through window.opener.
    if (dialog) {
      try { dialog.Zotero = Zotero; } catch (_) { /* ignore */ }
    }
  }

  openPrefsDialog() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const dialog = win.openDialog(
      "chrome://snowball-sources/content/snowballPrefs.xhtml",
      "_blank",
      "chrome,dialog=yes,centerscreen,resizable=no,modal=yes,width=520,height=520",
      { plugin: this }
    );
    if (dialog) {
      try { dialog.Zotero = Zotero; } catch (_) { /* ignore */ }
    }
  }

  async addCandidatesToZotero(candidates, target) {
    return SnowballZoteroItems.addCandidates(candidates, target, {
      downloadPDFs: this.prefBool("downloadPDFs", true)
    });
  }

  pref(name, fallback) {
    try {
      const value = Zotero.Prefs.get(`extensions.snowballSources.${name}`, true);
      return value === undefined || value === null ? fallback : value;
    } catch (error) {
      // Defensive: if the prefs branch is in a weird state, fall back to
      // the documented default rather than throwing into the calling code.
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.warn(`pref read failed: ${name}`, { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
      return fallback;
    }
  }

  /**
   * Read a pref with explicit type coercion + bounds. Used by callers that
   * need a sane integer or string regardless of upstream pref noise.
   */
  prefInt(name, fallback, min = -Infinity, max = Infinity) {
    const raw = this.pref(name, fallback);
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }

  prefBool(name, fallback) {
    const raw = this.pref(name, fallback);
    if (typeof raw === "boolean") return raw;
    return !!raw;
  }

  prefStr(name, fallback = "") {
    const raw = this.pref(name, fallback);
    return String(raw || "").trim();
  }

  setPref(name, value) {
    try {
      Zotero.Prefs.set(`extensions.snowballSources.${name}`, value, true);
    } catch (error) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.warn(`pref write failed: ${name}`, { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
      throw error;
    }
  }

  // ---------- UI state persistence ---------------------------------------
  // The dialog hands back its window size + splitter offset on close so
  // we can restore them on the next open. JSON-encoded into a single
  // pref to keep the schema small.

  _readUIState() {
    try {
      const raw = this.prefStr("uiState", "");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) { /* ignore */ }
    return null;
  }

  saveUIState(state) {
    try {
      if (!state || typeof state !== "object") return;
      // Drop any non-finite numbers so a runtime glitch can't poison the pref.
      const clean = {};
      for (const [k, v] of Object.entries(state)) {
        if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
      }
      this.setPref("uiState", JSON.stringify(clean));
    } catch (error) {
      try {
        if (typeof SnowballLog !== "undefined") {
          SnowballLog.warn("uiState save failed", { error: SnowballLog.formatError(error) });
        }
      } catch (_) { /* ignore */ }
    }
  }

  alert(message) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.alert(message);
  }
};
