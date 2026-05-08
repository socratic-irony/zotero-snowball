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
