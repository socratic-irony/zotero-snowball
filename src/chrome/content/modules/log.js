/* global Zotero */

/**
 * Centralized logger with secret-scrubbing.
 *
 * All Snowball Sources code routes debug/info/warn/error messages through
 * this module rather than calling Zotero.debug directly so we can:
 *   1. Strip API keys (and other secrets) from any logged URL or string
 *      before it reaches the debug log, JS console, or stderr;
 *   2. Tag every line with a consistent prefix for triage;
 *   3. No-op gracefully if Zotero isn't available (e.g. in unit tests).
 *
 * Never log raw response bodies, raw headers, or full URLs without first
 * funneling them through `scrub()` — OpenAlex and Semantic Scholar both
 * accept api keys via query-string, which means a logged URL is a leaked
 * credential.
 */
var SnowballLog = {
  TAG: "Snowball Sources",

  // Query parameters whose values should be redacted in logged URLs/strings.
  SECRET_PARAMS: ["api_key", "apikey", "x-api-key", "key", "token"],

  // Header names that should never be echoed back into logs.
  SECRET_HEADERS: ["authorization", "x-api-key", "api-key"],

  /**
   * Replace any secret-bearing query params or `key=value` substrings with
   * a placeholder. Conservative: prefers false positives (over-redaction)
   * to false negatives.
   */
  scrub(value) {
    if (value == null) return value;
    let s = String(value);

    // URL query parameters. Match `param=value` up to the next & or whitespace.
    for (const name of this.SECRET_PARAMS) {
      const re = new RegExp(`(${name}=)[^&\\s"']+`, "gi");
      s = s.replace(re, "$1<redacted>");
    }

    // Bearer tokens in any logged Authorization header.
    s = s.replace(/(authorization:\s*bearer\s+)[A-Za-z0-9._\-]+/gi, "$1<redacted>");

    return s;
  },

  /**
   * Build a clean string from a message + structured context object.
   * Context keys are scrubbed; non-serializable values are coerced to
   * String() so we never throw inside the logger itself.
   */
  format(level, message, context) {
    const parts = [`[${this.TAG}] ${level.toUpperCase()} ${this.scrub(message)}`];
    if (context && typeof context === "object") {
      const safe = {};
      for (const [k, v] of Object.entries(context)) {
        try {
          safe[k] = typeof v === "string" ? this.scrub(v) : v;
        } catch (_) {
          safe[k] = "<unserializable>";
        }
      }
      try {
        parts.push(JSON.stringify(safe));
      } catch (_) {
        // Cyclic structure → fall back to key list only.
        parts.push(`{keys: ${Object.keys(safe).join(",")}}`);
      }
    }
    return parts.join(" ");
  },

  _emit(level, message, context) {
    const line = this.format(level, message, context);
    try {
      if (typeof Zotero !== "undefined" && Zotero?.debug) {
        Zotero.debug(line);
        return;
      }
    } catch (_) { /* ignore */ }
    try {
      // eslint-disable-next-line no-console
      console?.[level === "error" ? "error" : level === "warn" ? "warn" : "log"]?.(line);
    } catch (_) { /* ignore */ }
  },

  debug(message, context) { this._emit("debug", message, context); },
  info(message, context)  { this._emit("info",  message, context); },
  warn(message, context)  { this._emit("warn",  message, context); },
  error(message, context) { this._emit("error", message, context); },

  /**
   * Format an Error for logging with stack but stripped of any secrets that
   * could appear in error messages (e.g. failing URLs that included a key).
   */
  formatError(error) {
    if (!error) return "";
    if (error instanceof Error) {
      return this.scrub(`${error.name}: ${error.message}\n${error.stack || ""}`);
    }
    return this.scrub(String(error));
  }
};
