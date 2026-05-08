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
  }

  addToAllWindows() {
    for (const win of Zotero.getMainWindows?.() || []) {
      this.addToWindow(win);
    }
  }

  removeFromWindow(window) {
    this.windows.delete(window);
    window.document.querySelector('[href="snowball-sources.ftl"]')?.remove();
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
        maxForwardPerSeed:  this.prefInt("maxForwardPerSeed",  100, 0, 1000),
        maxBackwardPerSeed: this.prefInt("maxBackwardPerSeed", 100, 0, 1000),
        maxCandidatesTotal: this.prefInt("maxCandidatesTotal", 500, 1, 10000),
        timeoutMs:          this.prefInt("requestTimeoutMs",  30000, 1000, 120000),
        includeForward:     this.prefBool("includeForward",   true),
        includeBackward:    this.prefBool("includeBackward",  true)
      };
      // Refuse to launch with an entirely empty fetch scope.
      if (!providerConfig.includeForward && !providerConfig.includeBackward) {
        this.alert("Both forward and backward citations are disabled in preferences. Enable at least one to snowball.");
        return;
      }

      this.openReviewDialog({
        seeds: seedRecords,
        target,
        providerConfig,
        flags: {
          skipAlreadyInLibrary: this.prefBool("skipAlreadyInLibrary", true)
        }
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
    return SnowballZoteroItems.addCandidates(candidates, target);
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

  alert(message) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.alert(message);
  }
};
