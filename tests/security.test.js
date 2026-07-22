const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadScripts(names, extraContext = {}) {
  const context = vm.createContext({
    console,
    URL,
    fetch,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    Promise,
    Error,
    Zotero: { debug() {} },
    ...extraContext
  });
  for (const name of names) {
    const file = path.join(ROOT, "src", "chrome", "content", "modules", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }
  return context;
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("SnowballLog.scrub redacts api_key query parameters", () => {
  const ctx = loadScripts(["log.js"]);
  const url = "https://api.openalex.org/works?filter=cites:W123&api_key=SECRET_TOKEN_123";
  const scrubbed = ctx.SnowballLog.scrub(url);
  assert.ok(!scrubbed.includes("SECRET_TOKEN_123"), "API key must be redacted");
  assert.ok(scrubbed.includes("api_key=<redacted>"), "Replacement marker must be present");
});

test("SnowballLog.scrub redacts multiple secret-bearing query params", () => {
  const ctx = loadScripts(["log.js"]);
  const url = "https://x.example/?key=ABC&token=DEF&apikey=GHI&filter=ok";
  const scrubbed = ctx.SnowballLog.scrub(url);
  for (const leak of ["ABC", "DEF", "GHI"]) {
    assert.ok(!scrubbed.includes(leak), `${leak} must be redacted`);
  }
  // Non-secret param survives.
  assert.ok(scrubbed.includes("filter=ok"), "Non-secret params must survive scrubbing");
});

test("SnowballLog.scrub redacts Authorization bearer tokens in messages", () => {
  const ctx = loadScripts(["log.js"]);
  const msg = "request failed with Authorization: Bearer eyJhbGciOiJI";
  const scrubbed = ctx.SnowballLog.scrub(msg);
  assert.ok(!scrubbed.includes("eyJhbGciOiJI"), "Bearer token must be redacted");
});

test("SnowballLog.formatError preserves error name and stack but scrubs secrets", () => {
  const ctx = loadScripts(["log.js"]);
  const err = new Error("fetch https://x.example/?api_key=LEAKED failed");
  const out = ctx.SnowballLog.formatError(err);
  assert.ok(out.includes("Error:"), "name preserved");
  assert.ok(!out.includes("LEAKED"), "secret stripped");
});

test("SnowballLog.format recursively redacts nested objects and arrays", () => {
  const ctx = loadScripts(["log.js"]);
  const context = {
    request: {
      headers: {
        Authorization: "Bearer HEADER_SECRET",
        "X-API-Key": "HEADER_KEY_SECRET"
      },
      query: { API_KEY: "QUERY_SECRET", status: "ok" },
      values: [{ token: "ARRAY_SECRET" }, "https://x.example/?api_key=STRING_SECRET"]
    }
  };

  const out = ctx.SnowballLog.format("error", "request failed", context);

  for (const leak of [
    "HEADER_SECRET",
    "HEADER_KEY_SECRET",
    "QUERY_SECRET",
    "ARRAY_SECRET",
    "STRING_SECRET"
  ]) {
    assert.ok(!out.includes(leak), `${leak} must be redacted`);
  }
  assert.ok(out.includes('"status":"ok"'), "non-secret nested values must survive");
  assert.ok(out.includes("<redacted>"), "redaction marker must be present");
});

test("SnowballLog.format recursively guards cyclic and excessively deep context", () => {
  const ctx = loadScripts(["log.js"]);
  const context = { cycle: { token: "CYCLE_SECRET" } };
  context.cycle.self = context.cycle;
  let cursor = context;
  for (let index = 0; index < 20; index++) {
    cursor.next = {};
    cursor = cursor.next;
  }
  cursor.value = "api_key=DEEP_SECRET";

  let out = "";
  assert.doesNotThrow(() => {
    out = ctx.SnowballLog.format("error", "request failed", context);
  });
  assert.ok(!out.includes("CYCLE_SECRET"), "cyclic secret must be redacted");
  assert.ok(!out.includes("DEEP_SECRET"), "deep secret must not leak");
  assert.ok(out.includes("<circular>"), "cycles must use a safe marker");
  assert.ok(out.includes("<max-depth>"), "deep values must use a safe marker");
});

test("SnowballHTTP.assertSafeURL rejects non-https URLs", () => {
  const ctx = loadScripts(["log.js", "errors.js", "http.js"]);
  assert.throws(
    () => ctx.SnowballHTTP.assertSafeURL("http://api.openalex.org/works"),
    /BAD_SCHEME|non-HTTPS/i
  );
});

test("SnowballHTTP.assertSafeURL rejects javascript: and file: schemes", () => {
  const ctx = loadScripts(["log.js", "errors.js", "http.js"]);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<x>"]) {
    assert.throws(() => ctx.SnowballHTTP.assertSafeURL(url));
  }
});

test("SnowballHTTP.assertSafeURL rejects hosts outside the allowlist", () => {
  const ctx = loadScripts(["log.js", "errors.js", "http.js"]);
  assert.throws(
    () => ctx.SnowballHTTP.assertSafeURL("https://evil.example/works"),
    /HOST_NOT_ALLOWED|allowlist/i
  );
});

test("SnowballHTTP.assertSafeURL accepts allowlisted hosts", () => {
  const ctx = loadScripts(["log.js", "errors.js", "http.js"]);
  for (const host of ["api.openalex.org", "api.semanticscholar.org"]) {
    const url = ctx.SnowballHTTP.assertSafeURL(`https://${host}/works`);
    assert.equal(url.hostname, host);
  }
});

test("SnowballHTTP.fetchJSON rejects provider redirects at the HTTP boundary", async () => {
  const calls = [];
  const ctx = loadScripts(["log.js", "errors.js", "http.js"], {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 302,
        ok: false,
        headers: { get: () => "https://evil.example/" }
      };
    }
  });

  let error;
  try {
    await ctx.SnowballHTTP.fetchJSON("https://api.openalex.org/works", { maxRetries: 4 });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "redirect response must reject");
  assert.equal(error.code, "HTTP_REDIRECT");
  assert.equal(error.context.origin, "https://api.openalex.org");
  assert.equal(error.context.status, 302);
  assert.equal(Object.keys(error.context).length, 2, "redirect context must stay minimal");
  assert.equal(calls.length, 1, "redirects must not be retried or followed");
  assert.equal(calls[0].options.redirect, "manual");
  assert.ok(!JSON.stringify(error).includes("evil.example"), "redirect target must not leak");
});

test("SnowballZoteroItems.safeAttachmentURL canonicalizes public HTTPS URLs", () => {
  const ctx = loadScripts(["zoteroItems.js"]);
  const input = "https://Publisher.Example.org:443/papers/a%20b.pdf?download=1#page=2";

  assert.equal(ctx.SnowballZoteroItems.safeAttachmentURL(input), new URL(input).href);
});

test("SnowballZoteroItems.safeAttachmentURL rejects unsafe attachment destinations", () => {
  const ctx = loadScripts(["zoteroItems.js"]);
  const unsafeURLs = [
    "http://publisher.example.org/paper.pdf",
    "not a URL",
    "https://reader:secret@publisher.example.org/paper.pdf",
    "https://localhost/paper.pdf",
    "https://localhost./paper.pdf",
    "https://pdf.localhost/paper.pdf",
    "https://pdf.localhost./paper.pdf",
    "https://publisher.example.org./paper.pdf",
    "https://8.8.8.8./paper.pdf",
    "https://127.1/paper.pdf",
    "https://0x7f000001/paper.pdf",
    "https://10.0.0.1/paper.pdf",
    "https://169.254.1.1/paper.pdf",
    "https://172.16.0.1/paper.pdf",
    "https://192.168.1.1/paper.pdf",
    "https://100.64.0.1/paper.pdf",
    "https://192.0.2.1/paper.pdf",
    "https://198.18.0.1/paper.pdf",
    "https://198.51.100.1/paper.pdf",
    "https://203.0.113.1/paper.pdf",
    "https://0.0.0.0/paper.pdf",
    "https://224.0.0.1/paper.pdf",
    "https://[::1]/paper.pdf",
    "https://[::]/paper.pdf",
    "https://[fc00::1]/paper.pdf",
    "https://[fd00::1]/paper.pdf",
    "https://[fe80::1]/paper.pdf",
    "https://[::ffff:127.0.0.1]/paper.pdf",
    "https://[::ffff:8.8.8.8]/paper.pdf"
  ];

  for (const url of unsafeURLs) {
    assert.equal(ctx.SnowballZoteroItems.safeAttachmentURL(url), "", url);
  }
});

test("automatic PDF downloads fail closed at all four default layers", () => {
  const prefDefaults = new Map();
  vm.runInNewContext(readProjectFile("src/prefs.js"), {
    pref(name, value) {
      prefDefaults.set(name, value);
    }
  });

  const prefsContext = vm.createContext({});
  vm.runInContext(readProjectFile("src/chrome/content/snowballPrefs.js"), prefsContext);

  const controllerSource = readProjectFile("src/chrome/content/snowball.js");
  const itemSource = readProjectFile("src/chrome/content/modules/zoteroItems.js");

  assert.deepEqual(
    {
      installDefault: prefDefaults.get("extensions.snowballSources.downloadPDFs"),
      schemaDefault: prefsContext.SnowballPrefs.schema.downloadPDFs.default,
      controllerRequiresExplicitTrue:
        /downloadPDFs:\s*this\.pref\("downloadPDFs",\s*false\)\s*===\s*true/.test(controllerSource),
      itemLayerRequiresExplicitTrue: /const downloadPDFs = opts\?\.downloadPDFs === true;/.test(
        itemSource
      )
    },
    {
      installDefault: false,
      schemaDefault: false,
      controllerRequiresExplicitTrue: true,
      itemLayerRequiresExplicitTrue: true
    }
  );
});

test("SnowballError.wrap preserves AbortError without rewrapping", () => {
  const ctx = loadScripts(["log.js", "errors.js"]);
  const abort = new ctx.DOMException("aborted", "AbortError");
  const out = ctx.SnowballError.wrap(abort, "X", "msg");
  assert.equal(out.name, "AbortError");
});

test("SnowballError.wrap returns existing SnowballError untouched", () => {
  const ctx = loadScripts(["log.js", "errors.js"]);
  const original = new ctx.SnowballError("CODE_A", "msg-a");
  const wrapped = ctx.SnowballError.wrap(original, "CODE_B", "msg-b");
  assert.strictEqual(wrapped, original);
});
