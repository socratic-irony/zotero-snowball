Below is an MVP handoff spec for a local coding model. It is deliberately conservative: start from Zotero’s official sample plugin shape, avoid a build system at first, keep the `.xpi` package simple, and implement OpenAlex-only snowballing before optional Semantic Scholar enrichment.

# MVP: Zotero Snowball Sources Plugin

## 1. Goal

Build a Zotero desktop plugin that lets a user select either:

1. one or more regular Zotero items, or
2. a Zotero collection,

then trace citations backward and forward using OpenAlex, show candidate sources in a review dialog, rank them by quick local relevance, and let the user add selected candidates to the same Zotero library and collection.

The MVP should not auto-import everything. It should always show a review dialog first.

## 2. Target Zotero version and plugin format

Target Zotero 9 first. Zotero 9.0 was released on April 10, 2026, and the current Zotero changelog lists Zotero 9.0.3 on May 6, 2026. ([Zotero][1])

Use Zotero’s current bootstrapped plugin format:

```text
manifest.json
bootstrap.js
prefs.js
locale/
chrome/
modules/
icons/
```

Zotero’s developer docs say Zotero 7+ bootstrapped plugins require a WebExtension-style `manifest.json` and a `bootstrap.js` with lifecycle/window hooks. ([Zotero][2]) Zotero 8’s developer page says most Zotero 7 guidance remains relevant, while Zotero 8 moved the Mozilla base forward to Firefox 140 and uses standard JS modules and standard promises. ([Zotero][3])

Use Zotero’s official sample plugin repo as the starting reference: `zotero/make-it-red`. Zotero’s plugin development page explicitly points developers to the official sample plugin, and the Make It Red repo says `src-2.0` is a bootstrapped plugin for Zotero 7. ([Zotero][4])

The single most important packaging rule: the `.xpi` is a ZIP archive, and `manifest.json` plus `bootstrap.js` must be at the archive root. The official Make It Red build script enters each source directory and then runs `zip -r ../build/...xpi *`, which avoids zipping the parent folder into the package. ([GitHub][5])

Correct `.xpi` layout:

```text
snowball-sources-0.1.0.xpi
  manifest.json
  bootstrap.js
  prefs.js
  chrome/
    content/
      snowball.js
      snowballDialog.xhtml
      snowballDialog.js
      snowballDialog.css
  locale/
    en-US/
      snowball-sources.ftl
  modules/
    openalex.js
    zoteroItems.js
    ranking.js
    util.js
  icons/
    icon-48.png
    icon-96.png
```

Incorrect `.xpi` layout:

```text
snowball-sources-0.1.0.xpi
  snowball-sources/
    manifest.json
    bootstrap.js
    ...
```

## 3. MVP behavior

The MVP should add these commands:

1. `Snowball Selected Item(s)` in the item context menu.
2. `Snowball This Collection` in the collection context menu.
3. Optional: `Snowball Sources...` in the Tools menu.

Use Zotero’s official `Zotero.MenuManager.registerMenu()` API where possible. Zotero 8 added this API for menu popups and says plugins should use it instead of manually injecting content when possible. Available targets include `main/menubar/tools`, `main/library/item`, `main/library/collection`, `main/library/addAttachment`, and `main/library/addNote`. ([Zotero][3])

The first MVP should use only context menus and Tools menu. A standalone toolbar button can be a later enhancement because it is more likely to require manual DOM injection and cleanup.

## 4. Data source strategy

### Default provider: OpenAlex

Use OpenAlex as the default citation graph provider.

OpenAlex’s base URL is:

```text
https://api.openalex.org
```

The relevant entity is `/works`. OpenAlex describes Works as scholarly documents such as journal articles, books, datasets, and theses. ([OpenAlex Developers][6])

OpenAlex supports:

Backward citations / references:

```text
GET https://api.openalex.org/works/{id}
```

Use the `referenced_works` field. OpenAlex defines `referenced_works` as OpenAlex IDs for works that the work cites. ([OpenAlex Developers][7])

Forward citations:

```text
GET https://api.openalex.org/works?filter=cites:{OPENALEX_ID}
```

The Works overview lists `cites` and `referenced_works` as supported work filters. ([OpenAlex Developers][6])

Metadata fields:

```text
id
doi
display_name
title
publication_year
publication_date
type
authorships
primary_location
best_oa_location
cited_by_count
referenced_works
abstract_inverted_index
ids
```

OpenAlex abstracts are not returned as plain text. They are returned as `abstract_inverted_index`, an inverted index of word positions, because OpenAlex does not include plaintext abstracts due to legal constraints. ([OpenAlex Developers][7])

Use `select=` aggressively to keep responses small. OpenAlex’s docs recommend the `select` parameter for returning only specific top-level fields, and note that it works on list and single-entity endpoints. ([OpenAlex Developers][8])

Use an OpenAlex API key preference. OpenAlex says API keys are free and should be used at scale; the free key gives a daily free usage allowance. ([OpenAlex][9]) Also implement rate-limit handling for `429 Too Many Requests`; OpenAlex says responses include rate-limit headers and recommends using `per_page=100`, OR syntax for batch lookups, `select=`, and exponential backoff. ([OpenAlex Developers][10])

### Optional provider: Semantic Scholar

Semantic Scholar should be optional for MVP+1, not required for MVP. Use it later for enrichment, recommendations, and maybe semantic relevance.

Semantic Scholar’s API overview says the REST API exposes publication data for papers, citations, authors, venues, SPECTER2 embeddings, and recommendations. ([Semantic Scholar][11]) It recommends API keys, batch endpoints, and limiting `fields` parameters for efficiency. ([Semantic Scholar][12])

Relevant Semantic Scholar endpoints:

```text
GET  https://api.semanticscholar.org/graph/v1/paper/{paper_id}
POST https://api.semanticscholar.org/graph/v1/paper/batch
GET  https://api.semanticscholar.org/graph/v1/paper/{paper_id}/citations
GET  https://api.semanticscholar.org/graph/v1/paper/{paper_id}/references
GET  https://api.semanticscholar.org/recommendations/v1/papers/forpaper/{paper_id}
POST https://api.semanticscholar.org/recommendations/v1/papers
```

Semantic Scholar’s tutorial shows the base Academic Graph API URL, the `/paper/{paper_id}` details endpoint, `fields=title,year,abstract,citationCount`, and the recommendation API base. It also says bulk search should usually be preferred over relevance search, and that batch endpoints should be used where possible. ([Semantic Scholar][12])

## 5. Functional MVP scope

### Include

The MVP should:

1. Install cleanly as an `.xpi`.
2. Register Zotero context menu items.
3. Read selected Zotero items and/or selected collection items.
4. Extract seed identifiers: DOI first, then title/year fallback.
5. Resolve seeds in OpenAlex.
6. Fetch backward references using `referenced_works`.
7. Fetch forward citations using `filter=cites:{openalexID}`.
8. Hydrate candidate metadata.
9. Deduplicate candidates.
10. Score candidates by fast local similarity.
11. Show a dialog with checkboxes.
12. Import selected candidates into the same library and collection.
13. Tag imported items with `snowballed`, `snowball:openalex`, and either `snowball:forward` or `snowball:backward`.
14. Avoid adding duplicates already in the current library.

### Exclude from MVP

Do not include in the first build:

1. automatic PDF download,
2. automatic full-text similarity,
3. recursive snowballing beyond one hop,
4. local embedding models,
5. standalone toolbar button,
6. Semantic Scholar recommendations,
7. background/daemon jobs,
8. Zotero Web API sync operations.

## 6. Proposed project structure

Use this exact structure first. Avoid Vite/Webpack/TypeScript until after the plugin installs and runs.

```text
zotero-snowball-sources/
  README.md
  scripts/
    build.sh
    validate-xpi.sh
  src/
    manifest.json
    bootstrap.js
    prefs.js
    locale/
      en-US/
        snowball-sources.ftl
    icons/
      icon-48.png
      icon-96.png
    chrome/
      content/
        snowball.js
        snowballDialog.xhtml
        snowballDialog.js
        snowballDialog.css
    modules/
      openalex.js
      zoteroItems.js
      ranking.js
      util.js
  build/
```

## 7. `manifest.json`

Zotero’s docs say `applications.zotero` must be present for Zotero to install a plugin, and `strict_max_version` should be the latest minor version actually tested. ([Zotero][2])

For Zotero 9-first:

```json
{
  "manifest_version": 2,
  "name": "Snowball Sources",
  "version": "0.1.0",
  "description": "Find forward and backward citations for selected Zotero items and collections.",
  "author": "Your Name",
  "homepage_url": "https://github.com/YOURNAME/zotero-snowball-sources",
  "icons": {
    "48": "icons/icon-48.png",
    "96": "icons/icon-96.png"
  },
  "applications": {
    "zotero": {
      "id": "snowball-sources@example.com",
      "strict_min_version": "9.0",
      "strict_max_version": "9.0.*"
    }
  }
}
```

Do not add `update_url` until there is a real release pipeline. Zotero replaced legacy RDF update manifests with JSON update manifests. ([Zotero][2])

## 8. `prefs.js`

Zotero 7+ default preferences should be placed in root-level `prefs.js`, not only in `defaults/preferences/`, because bootstrapped plugins can be installed or enabled without restart. ([Zotero][2])

```js
pref("extensions.snowballSources.openAlexAPIKey", "");
pref("extensions.snowballSources.semanticScholarAPIKey", "");
pref("extensions.snowballSources.maxSeeds", 50);
pref("extensions.snowballSources.maxForwardPerSeed", 100);
pref("extensions.snowballSources.maxBackwardPerSeed", 100);
pref("extensions.snowballSources.maxCandidatesTotal", 500);
pref("extensions.snowballSources.includeForward", true);
pref("extensions.snowballSources.includeBackward", true);
pref("extensions.snowballSources.defaultSort", "relevance");
pref("extensions.snowballSources.skipAlreadyInLibrary", true);
```

## 9. `bootstrap.js`

Keep `bootstrap.js` small. Zotero’s lifecycle hooks are `startup`, `shutdown`, `install`, and `uninstall`, and window hooks are `onMainWindowLoad` and `onMainWindowUnload`. Zotero passes `id`, `version`, and `rootURI` into lifecycle hooks; `rootURI` points to the plugin’s bundled files. ([Zotero][2])

```js
/* global Zotero, Services */

var SnowballSources;

function log(message) {
  Zotero.debug(`Snowball Sources: ${message}`);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log(`Starting ${version}`);

  Services.scriptloader.loadSubScript(rootURI + "modules/util.js");
  Services.scriptloader.loadSubScript(rootURI + "modules/ranking.js");
  Services.scriptloader.loadSubScript(rootURI + "modules/openalex.js");
  Services.scriptloader.loadSubScript(rootURI + "modules/zoteroItems.js");
  Services.scriptloader.loadSubScript(rootURI + "chrome/content/snowball.js");

  SnowballSources = new SnowballSourcesPlugin({
    id,
    version,
    rootURI
  });

  await SnowballSources.startup();
}

function onMainWindowLoad({ window }) {
  if (SnowballSources) {
    SnowballSources.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (SnowballSources) {
    SnowballSources.removeFromWindow(window);
  }
}

function shutdown() {
  log("Shutting down");

  if (SnowballSources) {
    SnowballSources.shutdown();
    SnowballSources = null;
  }
}

function uninstall() {
  log("Uninstalled");
}
```

## 10. Localization file

Zotero recommends Fluent `.ftl` files, and says `.ftl` files in locale subfolders are automatically registered. It also warns to prefix Fluent identifiers to avoid conflicts in shared Zotero windows. ([Zotero][2])

`src/locale/en-US/snowball-sources.ftl`

```text
snowball-sources-menu-selected =
    .label = Snowball Sources for Selected Item(s)

snowball-sources-menu-collection =
    .label = Snowball Sources for Collection

snowball-sources-menu-tools =
    .label = Snowball Sources…

snowball-sources-dialog-title = Snowball Sources

snowball-sources-button-add-selected =
    .label = Add Selected to Zotero

snowball-sources-button-cancel =
    .label = Cancel
```

## 11. Main plugin controller

`src/chrome/content/snowball.js`

Use `Zotero.MenuManager.registerMenu()` for official menu registration. Zotero says custom menus with the matching `pluginID` are automatically removed when a plugin is disabled or uninstalled. ([Zotero][3])

```js
/* global Zotero, OpenAlexProvider, SnowballZoteroItems, SnowballRanking */

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
          }
        ]
      })
    );
  }

  addToWindow(window) {
    this.windows.add(window);
    window.MozXULElement.insertFTLIfNeeded("snowball-sources.ftl");
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
    const items = pane.getSelectedItems().filter(item => item.isRegularItem());
    if (items.length) {
      await this.runForItems(items);
      return;
    }

    const collection = pane.getSelectedCollection();
    if (collection) {
      await this.runForCollection(collection);
    }
  }

  async runForCollection(collection) {
    const items = collection.getChildItems().filter(item => item.isRegularItem());
    await this.runForItems(items, collection);
  }

  async runForItems(items, explicitCollection = null) {
    const regularItems = items.filter(item => item.isRegularItem());

    if (!regularItems.length) {
      this.alert("No regular Zotero items selected.");
      return;
    }

    const maxSeeds = Zotero.Prefs.get("extensions.snowballSources.maxSeeds", true) || 50;
    const seeds = regularItems.slice(0, maxSeeds);

    const target = SnowballZoteroItems.getTargetContext(seeds, explicitCollection);
    const seedRecords = SnowballZoteroItems.extractSeedRecords(seeds);

    const provider = new OpenAlexProvider({
      apiKey: Zotero.Prefs.get("extensions.snowballSources.openAlexAPIKey", true),
      maxForwardPerSeed: Zotero.Prefs.get("extensions.snowballSources.maxForwardPerSeed", true) || 100,
      maxBackwardPerSeed: Zotero.Prefs.get("extensions.snowballSources.maxBackwardPerSeed", true) || 100
    });

    const candidates = await provider.snowball(seedRecords);
    const existing = await SnowballZoteroItems.markExistingCandidates(candidates, target.libraryID);
    const scored = SnowballRanking.scoreCandidates(existing, seedRecords);

    await this.openReviewDialog(scored, target);
  }

  async openReviewDialog(candidates, target) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.openDialog(
      this.rootURI + "chrome/content/snowballDialog.xhtml",
      "snowball-sources-dialog",
      "chrome,centerscreen,resizable,modal",
      {
        plugin: this,
        candidates,
        target
      }
    );
  }

  async addCandidatesToZotero(candidates, target) {
    return SnowballZoteroItems.addCandidates(candidates, target);
  }

  alert(message) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.alert(message);
  }
};
```

## 12. Zotero item extraction and import

Zotero’s JavaScript API docs show how to get selected collection items with `ZoteroPane.getSelectedCollection().getChildItems()`, how to search, how to retrieve items, and how to read an item abstract via `item.getField('abstractNote')`. ([Zotero][13]) The docs also show `setField`, `setCreators`, and `save()` inside transactions for batch edits. ([Zotero][13])

For adding items to collections, prefer `item.addToCollection(collectionIDOrKey); item.saveTx()`. A Zotero team forum answer says collection membership is a property of items and that this approach is easier than `collection.addItem()` for this case. ([Zotero Forums][14])

`src/modules/zoteroItems.js`

```js
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
    return String(doi)
      .trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .toLowerCase();
  },

  extractYear(dateString) {
    const match = String(dateString).match(/\b(18|19|20|21)\d{2}\b/);
    return match ? Number(match[0]) : null;
  },

  async markExistingCandidates(candidates, libraryID) {
    for (const candidate of candidates) {
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
          continue;
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
    }

    return candidates;
  },

  async addCandidates(candidates, target) {
    const added = [];
    const skipped = [];

    await Zotero.DB.executeTransaction(async () => {
      for (const candidate of candidates) {
        if (candidate.alreadyInLibrary && candidate.existingItemID) {
          const existing = await Zotero.Items.getAsync(candidate.existingItemID);

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
        item.addTag(candidate.direction === "forward" ? "snowball:forward" : "snowball:backward");

        await item.save();
        added.push(candidate);
      }
    });

    return { added, skipped };
  },

  createZoteroItemFromCandidate(candidate, libraryID) {
    const itemType = this.mapItemType(candidate.type);
    const item = new Zotero.Item(itemType);
    item.libraryID = libraryID;

    item.setField("title", candidate.title || "");
    item.setField("date", candidate.publicationDate || (candidate.year ? String(candidate.year) : ""));
    item.setField("DOI", this.normalizeDOI(candidate.doi || ""));
    item.setField("url", candidate.url || "");
    item.setField("abstractNote", candidate.abstract || "");

    if (candidate.venue) {
      item.setField("publicationTitle", candidate.venue);
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

  mapItemType(openAlexType) {
    const type = String(openAlexType || "").toLowerCase();

    if (type.includes("book")) return "book";
    if (type.includes("chapter")) return "bookSection";
    if (type.includes("preprint")) return "preprint";
    if (type.includes("dataset")) return "dataset";
    if (type.includes("thesis") || type.includes("dissertation")) return "thesis";

    return "journalArticle";
  }
};
```

## 13. OpenAlex provider

Use DOI resolution first:

```text
GET https://api.openalex.org/works/doi:{DOI}
```

Use title search fallback:

```text
GET https://api.openalex.org/works?search={TITLE}&filter=publication_year:{YEAR}
```

Use backward references from a seed:

```text
GET https://api.openalex.org/works/{OPENALEX_ID}
```

Read `referenced_works`.

Use forward citations:

```text
GET https://api.openalex.org/works?filter=cites:{OPENALEX_ID}
```

Use batch hydration for references:

```text
GET https://api.openalex.org/works?filter=openalex:{ID1|ID2|ID3}&per_page=100
```

OpenAlex supports OR filters with `|`, up to 100 values in a single filter, and recommends `per_page=100` to get all results in the same call. ([OpenAlex Developers][15])

`src/modules/openalex.js`

```js
/* global Zotero, SnowballUtil */

var OpenAlexProvider = class {
  constructor({ apiKey = "", maxForwardPerSeed = 100, maxBackwardPerSeed = 100 }) {
    this.baseURL = "https://api.openalex.org";
    this.apiKey = apiKey || "";
    this.maxForwardPerSeed = maxForwardPerSeed;
    this.maxBackwardPerSeed = maxBackwardPerSeed;

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
      const resolved = await this.resolveSeed(seed);
      if (resolved) {
        resolvedSeeds.push({ seed, work: resolved });
      }
    }

    for (const { seed, work } of resolvedSeeds) {
      const backward = await this.getBackwardReferences(seed, work);
      const forward = await this.getForwardCitations(seed, work);

      allCandidates.push(...backward);
      allCandidates.push(...forward);
    }

    return this.deduplicateCandidates(allCandidates);
  }

  async resolveSeed(seed) {
    if (seed.doi) {
      const work = await this.getWorkByDOI(seed.doi);
      if (work) return work;
    }

    if (seed.title) {
      return this.searchWorkByTitle(seed.title, seed.year);
    }

    return null;
  }

  async getWorkByDOI(doi) {
    const url = new URL(`${this.baseURL}/works/doi:${encodeURIComponent(doi)}`);
    url.searchParams.set("select", this.fields);
    this.addAuth(url);

    try {
      return await this.fetchJSON(url);
    } catch (error) {
      Zotero.debug(`Snowball Sources: DOI lookup failed for ${doi}: ${error}`);
      return null;
    }
  }

  async searchWorkByTitle(title, year) {
    const url = new URL(`${this.baseURL}/works`);
    url.searchParams.set("search", title);
    url.searchParams.set("per_page", "5");
    url.searchParams.set("select", this.fields);

    if (year) {
      url.searchParams.set("filter", `publication_year:${year}`);
    }

    this.addAuth(url);

    const response = await this.fetchJSON(url);
    return response.results?.[0] || null;
  }

  async getBackwardReferences(seed, work) {
    const ids = (work.referenced_works || []).slice(0, this.maxBackwardPerSeed);
    const works = await this.batchGetWorksByOpenAlexIDs(ids);

    return works.map(candidate => this.normalizeCandidate(candidate, {
      direction: "backward",
      seed
    }));
  }

  async getForwardCitations(seed, work) {
    const openAlexID = this.shortOpenAlexID(work.id);

    const url = new URL(`${this.baseURL}/works`);
    url.searchParams.set("filter", `cites:${openAlexID}`);
    url.searchParams.set("per_page", String(Math.min(this.maxForwardPerSeed, 100)));
    url.searchParams.set("select", this.fields);
    this.addAuth(url);

    const response = await this.fetchJSON(url);
    const results = response.results || [];

    return results.map(candidate => this.normalizeCandidate(candidate, {
      direction: "forward",
      seed
    }));
  }

  async batchGetWorksByOpenAlexIDs(ids) {
    const cleanIDs = ids
      .map(id => this.shortOpenAlexID(id))
      .filter(Boolean);

    const chunks = SnowballUtil.chunk(cleanIDs, 100);
    const all = [];

    for (const chunk of chunks) {
      const url = new URL(`${this.baseURL}/works`);
      url.searchParams.set("filter", `openalex:${chunk.join("|")}`);
      url.searchParams.set("per_page", String(chunk.length));
      url.searchParams.set("select", this.fields);
      this.addAuth(url);

      const response = await this.fetchJSON(url);
      all.push(...(response.results || []));
    }

    return all;
  }

  normalizeCandidate(work, { direction, seed }) {
    const location =
      work.primary_location ||
      work.best_oa_location ||
      {};

    const source = location.source || {};
    const doi = work.doi || work.ids?.doi || "";

    return {
      provider: "openalex",
      providerID: work.id,
      openAlexID: work.id,
      doi,
      title: work.display_name || work.title || "",
      year: work.publication_year || null,
      publicationDate: work.publication_date || "",
      type: work.type || "",
      venue: source.display_name || "",
      url: location.landing_page_url || doi || work.id || "",
      pdfURL: location.pdf_url || "",
      citedByCount: work.cited_by_count || 0,
      abstract: this.reconstructAbstract(work.abstract_inverted_index),
      authors: this.extractAuthors(work.authorships || []),
      direction,
      seedTitle: seed.title,
      seedZoteroItemID: seed.zoteroItemID,
      relevanceScore: 0,
      alreadyInLibrary: false
    };
  }

  reconstructAbstract(index) {
    if (!index) return "";

    const words = [];
    for (const [word, positions] of Object.entries(index)) {
      for (const position of positions) {
        words[position] = word;
      }
    }

    return words.filter(Boolean).join(" ");
  }

  extractAuthors(authorships) {
    return authorships.map(authorship => {
      const display = authorship.author?.display_name || "";
      const parts = display.trim().split(/\s+/);
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

  async fetchJSON(url, attempt = 1) {
    const response = await fetch(url.toString(), {
      headers: {
        "Accept": "application/json"
      }
    });

    if (response.status === 429 && attempt <= 4) {
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return this.fetchJSON(url, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`OpenAlex HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  deduplicateCandidates(candidates) {
    const seen = new Map();

    for (const candidate of candidates) {
      const key = this.dedupeKey(candidate);
      if (!key) continue;

      if (!seen.has(key)) {
        seen.set(key, candidate);
        continue;
      }

      const existing = seen.get(key);

      existing.direction =
        existing.direction === candidate.direction
          ? existing.direction
          : "both";

      existing.citedByCount = Math.max(existing.citedByCount || 0, candidate.citedByCount || 0);

      if (!existing.abstract && candidate.abstract) {
        existing.abstract = candidate.abstract;
      }
    }

    return Array.from(seen.values());
  }

  dedupeKey(candidate) {
    if (candidate.doi) {
      return `doi:${String(candidate.doi).toLowerCase()}`;
    }

    if (candidate.openAlexID) {
      return `openalex:${candidate.openAlexID}`;
    }

    const title = SnowballUtil.normalizeText(candidate.title || "");
    return title ? `title:${title}:${candidate.year || ""}` : "";
  }
};
```

## 14. Ranking module

MVP ranking should be fast and local. Use title + abstract token overlap against the combined seed profile. Do not use local embeddings in MVP.

`src/modules/ranking.js`

```js
var SnowballRanking = {
  scoreCandidates(candidates, seedRecords) {
    const seedText = seedRecords
      .map(seed => `${seed.title || ""} ${seed.abstract || ""}`)
      .join(" ");

    const seedVector = this.termVector(seedText);

    for (const candidate of candidates) {
      const candidateText = `${candidate.title || ""} ${candidate.abstract || ""}`;
      const candidateVector = this.termVector(candidateText);

      const similarity = this.cosine(seedVector, candidateVector);
      const citationBoost = Math.log10((candidate.citedByCount || 0) + 1) / 10;
      const abstractPenalty = candidate.abstract ? 0 : -0.05;
      const duplicatePenalty = candidate.alreadyInLibrary ? -0.25 : 0;
      const directionBoost = candidate.direction === "both" ? 0.1 : 0;

      candidate.relevanceScore = Math.max(
        0,
        similarity + citationBoost + abstractPenalty + duplicatePenalty + directionBoost
      );
    }

    return candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
  },

  termVector(text) {
    const vector = new Map();

    for (const token of this.tokenize(text)) {
      vector.set(token, (vector.get(token) || 0) + 1);
    }

    return vector;
  },

  tokenize(text) {
    const stop = new Set([
      "the", "and", "for", "with", "that", "this", "from", "are", "was",
      "were", "have", "has", "had", "not", "but", "can", "may", "using",
      "use", "used", "into", "their", "there", "these", "those", "than"
    ]);

    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(token => token.length > 2 && !stop.has(token));
  },

  cosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const value of a.values()) {
      normA += value * value;
    }

    for (const value of b.values()) {
      normB += value * value;
    }

    for (const [key, value] of a.entries()) {
      dot += value * (b.get(key) || 0);
    }

    if (!normA || !normB) return 0;

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
};
```

## 15. Utility module

`src/modules/util.js`

```js
var SnowballUtil = {
  chunk(items, size) {
    const chunks = [];

    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }

    return chunks;
  },

  normalizeText(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  },

  formatScore(score) {
    return Math.round((score || 0) * 100);
  }
};
```

## 16. Review dialog

Use a modal dialog for MVP. The dialog should show:

```text
Add? | Score | Direction | Already in Library | Year | Title | Authors | Venue | Cited By
```

Clicking a row should show the abstract and metadata. The MVP can be a simple table.

`src/chrome/content/snowballDialog.xhtml`

```xml
<?xml version="1.0"?>
<window
  xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
  xmlns:html="http://www.w3.org/1999/xhtml"
  title="Snowball Sources"
  width="1100"
  height="720"
  onload="SnowballDialog.init(window.arguments[0])">

  <linkset>
    <html:link rel="localization" href="snowball-sources.ftl"/>
    <html:link rel="stylesheet" href="snowballDialog.css"/>
  </linkset>

  <script src="snowballDialog.js"/>

  <vbox flex="1" class="snowball-dialog">
    <hbox align="center" class="snowball-toolbar">
      <label id="snowball-summary" value="Loading candidates…"/>
      <spacer flex="1"/>
      <button id="snowball-add-selected"
              data-l10n-id="snowball-sources-button-add-selected"
              oncommand="SnowballDialog.addSelected()"/>
      <button id="snowball-cancel"
              data-l10n-id="snowball-sources-button-cancel"
              oncommand="window.close()"/>
    </hbox>

    <splitter/>

    <hbox flex="1">
      <html:div id="snowball-table-container">
        <html:table id="snowball-table">
          <html:thead>
            <html:tr>
              <html:th>Add</html:th>
              <html:th>Score</html:th>
              <html:th>Direction</html:th>
              <html:th>Status</html:th>
              <html:th>Year</html:th>
              <html:th>Title</html:th>
              <html:th>Venue</html:th>
              <html:th>Cited By</html:th>
            </html:tr>
          </html:thead>
          <html:tbody id="snowball-tbody"/>
        </html:table>
      </html:div>

      <html:aside id="snowball-details">
        <html:h2 id="snowball-detail-title">Select a candidate</html:h2>
        <html:p id="snowball-detail-meta"/>
        <html:p id="snowball-detail-abstract"/>
      </html:aside>
    </hbox>
  </vbox>
</window>
```

`src/chrome/content/snowballDialog.js`

```js
/* global SnowballUtil */

var SnowballDialog = {
  args: null,
  candidates: [],

  init(args) {
    this.args = args;
    this.candidates = args.candidates || [];

    document.getElementById("snowball-summary").setAttribute(
      "value",
      `${this.candidates.length} candidate sources found`
    );

    this.renderTable();
  },

  renderTable() {
    const tbody = document.getElementById("snowball-tbody");
    tbody.replaceChildren();

    for (let i = 0; i < this.candidates.length; i++) {
      const candidate = this.candidates[i];

      const tr = document.createElementNS("http://www.w3.org/1999/xhtml", "tr");
      tr.dataset.index = String(i);
      tr.addEventListener("click", () => this.showDetails(i));

      tr.innerHTML = `
        <td><input type="checkbox" ${candidate.alreadyInLibrary ? "" : "checked"} /></td>
        <td>${SnowballUtil.formatScore(candidate.relevanceScore)}</td>
        <td>${this.escape(candidate.direction || "")}</td>
        <td>${candidate.alreadyInLibrary ? "Already in library" : "New"}</td>
        <td>${candidate.year || ""}</td>
        <td>${this.escape(candidate.title || "")}</td>
        <td>${this.escape(candidate.venue || "")}</td>
        <td>${candidate.citedByCount || 0}</td>
      `;

      tbody.appendChild(tr);
    }
  },

  showDetails(index) {
    const candidate = this.candidates[index];

    document.getElementById("snowball-detail-title").textContent = candidate.title || "";
    document.getElementById("snowball-detail-meta").textContent =
      `${candidate.year || ""} · ${candidate.venue || ""} · ${candidate.doi || ""}`;
    document.getElementById("snowball-detail-abstract").textContent =
      candidate.abstract || "No abstract available.";
  },

  async addSelected() {
    const rows = Array.from(document.querySelectorAll("#snowball-tbody tr"));
    const selected = [];

    for (const row of rows) {
      const checkbox = row.querySelector("input[type='checkbox']");
      if (checkbox?.checked) {
        selected.push(this.candidates[Number(row.dataset.index)]);
      }
    }

    const result = await this.args.plugin.addCandidatesToZotero(selected, this.args.target);
    window.alert(`Added ${result.added.length}; updated/skipped ${result.skipped.length}.`);
    window.close();
  },

  escape(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
};
```

`src/chrome/content/snowballDialog.css`

```css
.snowball-dialog {
  padding: 10px;
}

.snowball-toolbar {
  margin-bottom: 8px;
}

#snowball-table-container {
  width: 72%;
  overflow: auto;
}

#snowball-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

#snowball-table th,
#snowball-table td {
  border-bottom: 1px solid #ccc;
  padding: 4px 6px;
  vertical-align: top;
}

#snowball-table tr:hover {
  background: rgba(0, 0, 0, 0.06);
}

#snowball-details {
  width: 28%;
  padding: 12px;
  overflow: auto;
  border-left: 1px solid #ccc;
}

#snowball-detail-title {
  font-size: 16px;
  margin: 0 0 8px 0;
}

#snowball-detail-meta {
  font-size: 12px;
}

#snowball-detail-abstract {
  white-space: pre-wrap;
  line-height: 1.35;
}
```

## 17. Build script

`scripts/build.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
BUILD="$ROOT/build"
VERSION="0.1.0"
XPI="$BUILD/snowball-sources-$VERSION.xpi"

rm -rf "$BUILD"
mkdir -p "$BUILD"

python3 -m json.tool "$SRC/manifest.json" > /dev/null

cd "$SRC"

zip -r "$XPI" \
  manifest.json \
  bootstrap.js \
  prefs.js \
  chrome \
  locale \
  modules \
  icons \
  -x "*.DS_Store" \
  -x "__MACOSX/*"

cd "$ROOT"

echo "Built $XPI"
echo
echo "Archive contents:"
unzip -l "$XPI" | sed -n '1,40p'

echo
echo "Checking root files..."
unzip -l "$XPI" | grep -q " manifest.json$"
unzip -l "$XPI" | grep -q " bootstrap.js$"

echo "OK: manifest.json and bootstrap.js are at archive root."
```

`scripts/validate-xpi.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

XPI="${1:-build/snowball-sources-0.1.0.xpi}"

test -f "$XPI"

echo "Validating $XPI"

unzip -t "$XPI" > /dev/null

if ! unzip -l "$XPI" | grep -q " manifest.json$"; then
  echo "ERROR: manifest.json is missing from archive root"
  exit 1
fi

if ! unzip -l "$XPI" | grep -q " bootstrap.js$"; then
  echo "ERROR: bootstrap.js is missing from archive root"
  exit 1
fi

if unzip -l "$XPI" | grep -q "^[^ ]*  [^ ]*  [^ ]*  snowball-sources/manifest.json$"; then
  echo "ERROR: manifest.json appears inside a nested folder"
  exit 1
fi

echo "XPI structure looks valid."
```

## 18. Development install workflow

For development, Zotero’s plugin development docs recommend loading a plugin directly from source with an extension proxy file in the Zotero profile’s `extensions` directory. The file should be named after the extension id and contain the absolute path to the plugin source root where `bootstrap.js` is located. ([Zotero][4])

Development steps:

```text
1. Create a separate Zotero development profile.
2. In that profile’s extensions directory, create a file named:
   snowball-sources@example.com

3. Put this absolute path inside the file:
   /absolute/path/to/zotero-snowball-sources/src

4. Launch Zotero with debug logging.
```

On macOS, an example launch command:

```bash
/Applications/Zotero.app/Contents/MacOS/zotero \
  -P "Snowball Dev" \
  -ZoteroDebugText \
  -jsconsole
```

## 19. Duplicate detection

Use this duplicate key order:

```text
1. DOI
2. OpenAlex ID
3. Semantic Scholar paperId, when available later
4. normalized title + year
```

Before adding a candidate, search Zotero by DOI. If not found, search exact title. If found, do not create a duplicate item. Instead, optionally add the existing item to the target collection and add `snowball:existing`.

## 20. Candidate object schema

Use one normalized object shape internally regardless of provider:

```js
{
  provider: "openalex",
  providerID: "https://openalex.org/W...",
  openAlexID: "https://openalex.org/W...",
  semanticScholarID: "",
  doi: "",
  title: "",
  year: 2024,
  publicationDate: "2024-05-01",
  type: "article",
  venue: "",
  url: "",
  pdfURL: "",
  citedByCount: 0,
  abstract: "",
  authors: [
    {
      name: "Jane Smith",
      firstName: "Jane",
      lastName: "Smith"
    }
  ],
  direction: "forward
```

[1]: https://www.zotero.org/support/changelog "changelog [Zotero Documentation]"
[2]: https://www.zotero.org/support/dev/zotero_7_for_developers "dev:zotero_7_for_developers [Zotero Documentation]"
[3]: https://www.zotero.org/support/dev/zotero_8_for_developers "dev:zotero_8_for_developers [Zotero Documentation]"
[4]: https://www.zotero.org/support/dev/client_coding/plugin_development "dev:client_coding:plugin_development [Zotero Documentation]"
[5]: https://raw.githubusercontent.com/zotero/make-it-red/main/make-zips "raw.githubusercontent.com"
[6]: https://developers.openalex.org/api-reference/works "Works Overview - OpenAlex Developers"
[7]: https://developers.openalex.org/api-reference/works/get-a-single-work "Get a single work - OpenAlex Developers"
[8]: https://developers.openalex.org/guides/selecting-fields "Select Fields - OpenAlex Developers"
[9]: https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication "Authentication & Pricing - OpenAlex Developers"
[10]: https://developers.openalex.org/api-reference/authentication "Authentication & Pricing - OpenAlex Developers"
[11]: https://www.semanticscholar.org/product/api "Semantic Scholar Academic Graph API | Semantic Scholar"
[12]: https://www.semanticscholar.org/product/api%2Ftutorial "Tutorial | Semantic Scholar Academic Graph API"
[13]: https://www.zotero.org/support/dev/client_coding/javascript_api "dev:client_coding:javascript_api [Zotero Documentation]"
[14]: https://forums.zotero.org/discussion/115073/adding-an-item-to-a-collection-with-zotero-dev-in-javascript "Adding an item to a collection with Zotero dev in JavaScript - Zotero Forums"
[15]: https://developers.openalex.org/guides/filtering "Filter - OpenAlex Developers"
