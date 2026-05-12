const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadBootstrap() {
  const loadedScripts = [];
  const registeredChrome = [];
  const destructed = [];
  const chromeHandle = {
    destruct() {
      destructed.push(true);
    }
  };
  const context = vm.createContext({
    Cc: {
      "@mozilla.org/addons/addon-manager-startup;1": {
        getService() {
          return {
            registerChrome(manifestURI, entries) {
              registeredChrome.push({ manifestURI, entries });
              return chromeHandle;
            }
          };
        }
      }
    },
    Ci: {
      amIAddonManagerStartup: {}
    },
    Services: {
      io: {
        newURI(spec) {
          return { spec };
        }
      },
      scriptloader: {
        loadSubScript(url) {
          loadedScripts.push(url);
        }
      }
    },
    Zotero: {
      debug() {}
    },
    SnowballSourcesPlugin: class {
      constructor(options) {
        this.options = options;
      }

      async startup() {}
      shutdown() {}
      addToWindow() {}
      removeFromWindow() {}
    }
  });

  vm.runInContext(fs.readFileSync(path.join(ROOT, "src/bootstrap.js"), "utf8"), context, {
    filename: "bootstrap.js"
  });

  return { context, loadedScripts, registeredChrome, destructed };
}

test("startup registers plugin content as a chrome URL before loading scripts", async () => {
  const { context, registeredChrome } = loadBootstrap();

  await context.startup({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.1.2",
    rootURI: "jar:file:///snowball.xpi!/"
  });

  assert.equal(registeredChrome.length, 1);
  assert.equal(registeredChrome[0].manifestURI.spec, "jar:file:///snowball.xpi!/manifest.json");
  assert.deepEqual(JSON.parse(JSON.stringify(registeredChrome[0].entries)), [
    ["content", "snowball-sources", "chrome/content/"]
  ]);
});

test("shutdown deregisters plugin chrome content", async () => {
  const { context, destructed } = loadBootstrap();

  await context.startup({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.1.2",
    rootURI: "jar:file:///snowball.xpi!/"
  });
  context.shutdown();

  assert.deepEqual(destructed, [true]);
});
