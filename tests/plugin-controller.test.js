const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadController(extraZotero = {}) {
  const registered = [];
  const unregistered = [];
  const openedDialogs = [];
  const context = vm.createContext({
    Services: {
      wm: {
        getMostRecentWindow() {
          return {
            alert() {},
            openDialog(...args) {
              openedDialogs.push(args);
            }
          };
        }
      }
    },
    Zotero: {
      debug() {},
      getMainWindows() {
        return [];
      },
      MenuManager: {
        registerMenu(options) {
          registered.push(options);
          return options.menuID;
        },
        unregisterMenu(menuID) {
          unregistered.push(menuID);
          return true;
        }
      },
      ...extraZotero
    }
  });

  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "src/chrome/content/snowball.js"), "utf8"),
    context,
    { filename: "snowball.js" }
  );

  return { context, registered, unregistered, openedDialogs };
}

function fakeWindow() {
  const inserted = [];
  const removed = [];

  return {
    inserted,
    removed,
    MozXULElement: {
      insertFTLIfNeeded(href) {
        inserted.push(href);
      }
    },
    document: {
      querySelector(selector) {
        return {
          remove() {
            removed.push(selector);
          }
        };
      }
    }
  };
}

test("startup registers menus and loads localization into already-open main windows", async () => {
  const win = fakeWindow();
  const { context, registered } = loadController({
    getMainWindows() {
      return [win];
    }
  });

  const plugin = new context.SnowballSourcesPlugin({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.1.0",
    rootURI: "jar:file:///snowball.xpi!/"
  });

  await plugin.startup();

  assert.deepEqual(registered.map(menu => menu.target), [
    "main/library/item",
    "main/library/collection",
    "main/menubar/tools"
  ]);
  assert.deepEqual(win.inserted, ["snowball-sources.ftl"]);
});

test("all registered menu l10n IDs exist in the Fluent file", async () => {
  const { context, registered } = loadController();
  const plugin = new context.SnowballSourcesPlugin({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.1.2",
    rootURI: "jar:file:///snowball.xpi!/"
  });

  await plugin.startup();

  const ftl = fs.readFileSync(
    path.join(ROOT, "src/locale/en-US/snowball-sources.ftl"),
    "utf8"
  );
  const ftlIDs = new Set(
    Array.from(ftl.matchAll(/^([a-z0-9-]+)\s*=/gm), match => match[1])
  );
  const menuIDs = registered.flatMap(menu => menu.menus.map(item => item.l10nID));

  assert.deepEqual(menuIDs.sort(), [
    "snowball-sources-menu-selected",
    "snowball-sources-menu-collection",
    "snowball-sources-menu-tools",
    "snowball-sources-menu-prefs"
  ].sort());

  for (const id of menuIDs) {
    assert.ok(ftlIDs.has(id), `Missing Fluent id: ${id}`);
  }
});

test("shutdown unregisters menus and removes localization from initialized windows", async () => {
  const win = fakeWindow();
  const { context, unregistered } = loadController({
    getMainWindows() {
      return [win];
    }
  });

  const plugin = new context.SnowballSourcesPlugin({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.1.2",
    rootURI: "jar:file:///snowball.xpi!/"
  });

  await plugin.startup();
  plugin.shutdown();

  assert.deepEqual(unregistered.sort(), [
    "snowball-sources-item-menu",
    "snowball-sources-collection-menu",
    "snowball-sources-tools-menu"
  ].sort());
  assert.deepEqual(win.removed, ['[href="snowball-sources.ftl"]']);
});

test("review dialog opens as registered chrome content with explicit dimensions", async () => {
  const { context, openedDialogs } = loadController();
  const plugin = new context.SnowballSourcesPlugin({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.1.2",
    rootURI: "jar:file:///snowball.xpi!/"
  });

  plugin.openReviewDialog({
    seeds: [{ title: "Seed", doi: "10.0/x" }],
    target: { libraryID: 1 },
    providerConfig: { apiKey: "" }
  });

  assert.equal(openedDialogs.length, 1);
  assert.equal(
    openedDialogs[0][0],
    "chrome://snowball-sources/content/snowballDialog.xhtml"
  );
  assert.equal(openedDialogs[0][1], "_blank");
  assert.match(openedDialogs[0][2], /dialog=no/);
  assert.match(openedDialogs[0][2], /width=\d+/);
  assert.match(openedDialogs[0][2], /height=\d+/);
});
