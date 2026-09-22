const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function runtimeTextFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...runtimeTextFiles(entryPath));
    } else if (/\.(?:css|ftl|js|json|xhtml|xml)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function loadPreferences() {
  const defaults = new Map();
  vm.runInNewContext(readProjectFile("src/prefs.js"), {
    pref(name, value) {
      defaults.set(name, value);
    }
  });

  const context = vm.createContext({});
  vm.runInContext(readProjectFile("src/chrome/content/snowballPrefs.js"), context);
  return { defaults, schema: context.SnowballPrefs.schema };
}

function loadController(prefValues = {}) {
  const alerts = [];
  const openedDialogs = [];
  const prefs = new Map(Object.entries(prefValues));
  const context = vm.createContext({
    Services: {
      wm: {
        getMostRecentWindow() {
          return {
            alert(message) {
              alerts.push(message);
            },
            openDialog(...args) {
              openedDialogs.push(args);
              return null;
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
      Prefs: {
        get(name) {
          return prefs.get(name);
        }
      },
      MenuManager: {
        registerMenu(options) {
          return options.menuID;
        },
        unregisterMenu() {}
      }
    },
    SnowballZoteroItems: {
      getTargetContext() {
        return { libraryID: 1 };
      },
      extractSeedRecords(seeds) {
        return seeds.map((item) => ({ title: item.title || "Seed" }));
      }
    }
  });

  vm.runInContext(readProjectFile("src/chrome/content/snowball.js"), context, {
    filename: "snowball.js"
  });

  const plugin = new context.SnowballSourcesPlugin({
    id: "snowball-sources@socratic-irony.github.io",
    version: "0.5.6",
    rootURI: "jar:file:///snowball.xpi!/"
  });

  return { context, plugin, alerts, openedDialogs };
}

function loadDialog({ formatUserError = null, snowballLog = null } = {}) {
  const globals = {
    AbortController,
    DOMException,
    Error,
    Promise,
    Zotero: { debug() {} }
  };
  if (formatUserError) globals.formatUserError = formatUserError;
  if (snowballLog) globals.SnowballLog = snowballLog;
  return vm.createContext(globals);
}

async function runDialog(providerConfig, events, streamError = null, options = {}) {
  const context = loadDialog(options);
  // Same load order as snowballDialog.xhtml: the dialog uses the store and
  // view modules, which depend on util.js.
  for (const dependency of [
    "src/chrome/content/modules/util.js",
    "src/chrome/content/modules/candidateStore.js",
    "src/chrome/content/modules/candidateView.js"
  ]) {
    vm.runInContext(readProjectFile(dependency), context, { filename: dependency });
  }
  vm.runInContext(readProjectFile("src/chrome/content/snowballDialog.js"), context, {
    filename: "snowballDialog.js"
  });

  const consumed = [];
  const ingested = [];
  const progress = [];
  const statuses = [];
  const loadingStates = [];
  context.OpenAlexProvider = class {
    constructor(config) {
      this.config = config;
    }

    async *streamSnowball() {
      for (const event of events) {
        consumed.push(event);
        yield event;
      }
      if (streamError) throw streamError;
    }
  };

  const dialog = context.SnowballDialog;
  dialog.args = {
    providerConfig,
    seeds: [{ title: "Seed" }],
    target: { libraryID: 1 },
    flags: { skipAlreadyInLibrary: false }
  };
  // Candidates live in the store; the getter returns its array.
  dialog.store = new context.SnowballCandidateStore();
  dialog.loadingWasCanceled = false;
  dialog.limitWasReached = false;
  dialog.setLoading = (isLoading) => {
    loadingStates.push(isLoading);
    dialog.loading = isLoading;
  };
  dialog.setStatus = (message) => statuses.push(String(message));
  dialog.setProgress = (message) => progress.push(String(message));
  dialog.flushRefresh = () => {};
  dialog.scheduleRefresh = () => {};
  dialog.refineWithSemanticScholar = async () => {};
  dialog.getVisibleCandidates = () => [];
  dialog.showDetails = () => {};
  const seen = new Set();
  dialog.ingestCandidate = async (candidate) => {
    const key = candidate.openAlexID || candidate.doi || candidate.title;
    if (seen.has(key)) return false;
    seen.add(key);
    ingested.push(candidate);
    dialog.candidates.push(candidate);
    return true;
  };

  await dialog.startStreaming();
  return { dialog, consumed, ingested, progress, statuses, loadingStates };
}

test("exhaustive search is the default and the opt-in cap defaults to 1,000", () => {
  const { defaults, schema } = loadPreferences();

  assert.equal(defaults.get("extensions.snowballSources.limitResults"), false);
  assert.equal(defaults.get("extensions.snowballSources.maxCandidatesTotal"), 1000);
  assert.equal(schema.limitResults.default, false);
  assert.equal(schema.maxCandidatesTotal.default, 1000);
  assert.equal("maxForwardPerSeed" in schema, false);
  assert.equal("maxBackwardPerSeed" in schema, false);
});

test("the controller blocks missing credentials and passes the new provider mode", async () => {
  const controllerSource = readProjectFile("src/chrome/content/snowball.js");
  const dialogSource = readProjectFile("src/chrome/content/snowballDialog.js");
  assert.match(controllerSource, /if\s*\(!apiKey\)/);
  assert.match(dialogSource, /limitResults\s*===\s*true/);

  const item = { title: "Seed", isRegularItem: () => true };
  const missing = loadController({
    "extensions.snowballSources.openAlexAPIKey": "   "
  });

  await missing.plugin.runForItems([item]);

  assert.deepEqual(missing.alerts, [
    "Enter your OpenAlex API key in Snowball Sources Preferences before searching."
  ]);
  assert.equal(missing.openedDialogs.length, 0);

  const configured = loadController({
    "extensions.snowballSources.openAlexAPIKey": "  user-supplied-key  ",
    "extensions.snowballSources.limitResults": true,
    "extensions.snowballSources.maxCandidatesTotal": 123
  });

  await configured.plugin.runForItems([item]);

  assert.equal(configured.openedDialogs.length, 1);
  const providerConfig = configured.openedDialogs[0][3].providerConfig;
  assert.equal(providerConfig.apiKey, "user-supplied-key");
  assert.equal(providerConfig.limitResults, true);
  assert.equal(providerConfig.maxCandidatesTotal, 123);
  assert.equal(providerConfig.maxWorkers, 20);
  assert.equal("maxForwardPerSeed" in providerConfig, false);
  assert.equal("maxBackwardPerSeed" in providerConfig, false);
});

test("preferences present one opt-in total limit and conceal API keys", () => {
  const source = readProjectFile("src/chrome/content/snowballPrefs.xhtml");

  assert.match(source, /id="pref-limitResults"[^>]*type="checkbox"/);
  assert.match(source, /id="pref-maxCandidatesTotal"[^>]*disabled="disabled"/);
  assert.doesNotMatch(source, /id="pref-maxForwardPerSeed"/);
  assert.doesNotMatch(source, /id="pref-maxBackwardPerSeed"/);
  assert.match(source, /exhaustive/i);
  assert.match(source, /early-stop sample/i);

  for (const id of ["pref-openAlexAPIKey", "pref-semanticScholarAPIKey"]) {
    const input = source.match(new RegExp('<html:input\\b[^>]*\\bid="' + id + '"[^>]*/>'))?.[0];
    assert.ok(input, id + " must be present");
    assert.match(input, /\btype="password"(?:\s|\/?>)/);
    assert.match(input, /\bautocomplete="off"(?:\s|\/?>)/);
  }
});

test("the limit checkbox enables and disables its numeric control", () => {
  const checkbox = { checked: false };
  const limitInput = { disabled: false };
  /** @type {Map<string, { checked?: boolean, disabled?: boolean }>} */
  const controls = new Map();
  controls.set("pref-limitResults", checkbox);
  controls.set("pref-maxCandidatesTotal", limitInput);
  const context = vm.createContext({
    document: {
      getElementById(id) {
        return controls.get(id) || null;
      }
    }
  });
  vm.runInContext(readProjectFile("src/chrome/content/snowballPrefs.js"), context);

  context.SnowballPrefs.updateLimitResultsControl();
  assert.equal(limitInput.disabled, true);

  checkbox.checked = true;
  context.SnowballPrefs.updateLimitResultsControl();
  assert.equal(limitInput.disabled, false);
});

test("runtime source contains no bundled OpenAlex credential", () => {
  const { defaults } = loadPreferences();
  assert.equal(defaults.get("extensions.snowballSources.openAlexAPIKey"), "");

  const suspiciousAssignments = [
    /pref\(\s*["']extensions\.snowballSources\.openAlexAPIKey["']\s*,\s*["'][^"']*\S[^"']*["']\s*\)/,
    /\b(?:openAlexAPIKey|OPENALEX_API_KEY)\s*[:=]\s*["'\x60][^"'\x60]*\S[^"'\x60]*["'\x60]/
  ];

  for (const filePath of runtimeTextFiles(path.join(ROOT, "src"))) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const pattern of suspiciousAssignments) {
      assert.doesNotMatch(source, pattern, "credential-like assignment in " + filePath);
    }
  }
});

test("limit mode stops immediately at the Nth unique candidate", async () => {
  const events = [
    { type: "candidate", candidate: { openAlexID: "W1" } },
    { type: "candidate", candidate: { openAlexID: "W2" } },
    { type: "candidate", candidate: { openAlexID: "W3" } }
  ];
  const result = await runDialog(
    { apiKey: "user-key", limitResults: true, maxCandidatesTotal: 2 },
    events
  );

  assert.equal(result.ingested.length, 2);
  assert.equal(result.consumed.length, 2);
  assert.equal(result.dialog.abortController.signal.aborted, true);
  assert.match(result.progress.at(-1), /^Limit reached — 2 candidates loaded$/);
});

test("exhaustive mode ignores the numeric cap and remains distinguishable from Stop", async () => {
  const events = [
    { type: "candidate", candidate: { openAlexID: "W1" } },
    { type: "candidate", candidate: { openAlexID: "W2" } },
    { type: "candidate", candidate: { openAlexID: "W3" } }
  ];
  const result = await runDialog(
    { apiKey: "user-key", limitResults: false, maxCandidatesTotal: 2 },
    events
  );

  assert.equal(result.ingested.length, 3);
  assert.equal(result.consumed.length, 3);
  assert.equal(result.dialog.abortController.signal.aborted, false);
  assert.match(result.progress.at(-1), /^Done — 3 candidates loaded$/);
});

test("stream progress reports unique candidates plus active and queued counts", async () => {
  const result = await runDialog({ apiKey: "user-key", limitResults: false }, [
    { type: "candidate", candidate: { openAlexID: "W1" } },
    { type: "candidate", candidate: { openAlexID: "W1" } },
    {
      type: "work-progress",
      queued: 4,
      active: 2,
      pending: 6,
      completed: 1,
      seed: "seed label must not be displayed"
    }
  ]);

  assert.equal(result.loadingStates[0], true);
  assert.ok(result.progress.includes("1 unique candidate found — 2 active, 4 queued"));
  assert.ok(!result.progress.some((message) => message.includes("seed label")));
  assert.equal(result.progress.at(-1), "Done — 1 candidate loaded");
});

function typedOpenAlexError(code, userMessage) {
  const error = Object.assign(new Error(userMessage), { code, userMessage });
  error.name = "SnowballError";
  return error;
}

test("OpenAlex credential stream errors preserve partial results and formatted message", async () => {
  const error = typedOpenAlexError(
    "OPENALEX_CREDENTIALS",
    "OpenAlex credentials were rejected. Check your API key in Preferences."
  );
  const result = await runDialog(
    { apiKey: "user-key", limitResults: false },
    [{ type: "candidate", candidate: { openAlexID: "W1" } }],
    error,
    { formatUserError: (received) => `formatted ${received.code}` }
  );

  assert.equal(result.ingested.length, 1);
  assert.equal(result.statuses.at(-1), "Search failed");
  assert.equal(
    result.progress.at(-1),
    "Search failed — formatted OPENALEX_CREDENTIALS — 1 candidate loaded"
  );
  assert.doesNotMatch(result.progress.at(-1), /Done|Stopped|Limit reached/);
  assert.equal(result.dialog.loading, false);
});

test("OpenAlex budget stream errors preserve partial results and formatted message", async () => {
  const error = typedOpenAlexError(
    "OPENALEX_BUDGET_EXHAUSTED",
    "Your OpenAlex daily allowance is exhausted."
  );
  const result = await runDialog(
    { apiKey: "user-key", limitResults: false },
    [{ type: "candidate", candidate: { openAlexID: "W1" } }],
    error,
    { formatUserError: (received) => `formatted ${received.code}` }
  );

  assert.equal(result.ingested.length, 1);
  assert.equal(result.statuses.at(-1), "Search failed");
  assert.equal(
    result.progress.at(-1),
    "Search failed — formatted OPENALEX_BUDGET_EXHAUSTED — 1 candidate loaded"
  );
  assert.doesNotMatch(result.progress.at(-1), /Done|Stopped|Limit reached/);
  assert.equal(result.dialog.loading, false);
});

test("stream error fallback scrubs raw provider messages when no formatter is available", async () => {
  const secret = "OPENALEX_SECRET_VALUE";
  const error = typedOpenAlexError("OPENALEX_CREDENTIALS", `Provider leaked ${secret}`);
  const result = await runDialog(
    { apiKey: "user-key", limitResults: false },
    [{ type: "candidate", candidate: { openAlexID: "W1" } }],
    error,
    {
      snowballLog: {
        scrub(value) {
          return String(value).replaceAll(secret, "[redacted]");
        },
        error() {},
        formatError() {
          return "scrubbed log error";
        }
      }
    }
  );

  assert.equal(
    result.progress.at(-1),
    "Search failed — Provider leaked [redacted] — 1 candidate loaded"
  );
  assert.doesNotMatch(result.progress.at(-1), new RegExp(secret));
});

test("stream error fallback uses a generic message without a scrubber", async () => {
  const secret = "OPENALEX_SECRET_VALUE";
  const error = typedOpenAlexError("OPENALEX_BUDGET_EXHAUSTED", `Provider leaked ${secret}`);
  const result = await runDialog(
    { apiKey: "user-key", limitResults: false },
    [{ type: "candidate", candidate: { openAlexID: "W1" } }],
    error
  );

  assert.equal(
    result.progress.at(-1),
    "Search failed — Unable to complete the search. Please try again. — 1 candidate loaded"
  );
  assert.doesNotMatch(result.progress.at(-1), new RegExp(secret));
});
