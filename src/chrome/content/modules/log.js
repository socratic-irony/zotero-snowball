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

  // Keep structured logging bounded even when provider data is unexpectedly deep.
  MAX_SCRUB_DEPTH: 8,

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
    s = s.replace(/(authorization:\s*bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>");

    return s;
  },

  _isSecretKey(key) {
    const normalized = String(key).toLowerCase();
    return this.SECRET_PARAMS.includes(normalized) || this.SECRET_HEADERS.includes(normalized);
  },

  /**
   * Return a bounded, scrubbed copy of structured log data.
   * Cycles are replaced with a marker and deep values are not traversed.
   */
  scrubValue(value, depth = 0, seen = new WeakSet()) {
    if (depth >= this.MAX_SCRUB_DEPTH) return "<max-depth>";
    if (typeof value === "string") return this.scrub(value);
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;

    if (typeof value === "object") {
      if (seen.has(value)) return "<circular>";
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((item) => this.scrubValue(item, depth + 1, seen));
        }

        const safe = {};
        for (const [key, child] of Object.entries(value)) {
          if (this._isSecretKey(key)) safe[key] = "<redacted>";
          else {
            try {
              safe[key] = this.scrubValue(child, depth + 1, seen);
            } catch (_) {
              safe[key] = "<unserializable>";
            }
          }
        }
        return safe;
      } finally {
        seen.delete(value);
      }
    }

    try {
      return this.scrub(String(value));
    } catch (_) {
      return "<unserializable>";
    }
  },

  /**
   * Build a clean string from a message + structured context object.
   * Context values are recursively scrubbed; non-serializable values are
   * coerced to String() so we never throw inside the logger itself.
   */
  format(level, message, context) {
    const parts = [`[${this.TAG}] ${level.toUpperCase()} ${this.scrub(message)}`];
    if (context && typeof context === "object") {
      const safe = this.scrubValue(context);
      try {
        parts.push(JSON.stringify(safe));
      } catch (_) {
        parts.push("{context: <unserializable>}");
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
    } catch (_) {
      /* ignore */
    }
    try {
      console?.[level === "error" ? "error" : level === "warn" ? "warn" : "log"]?.(line);
    } catch (_) {
      /* ignore */
    }
  },

  debug(message, context) {
    this._emit("debug", message, context);
  },
  info(message, context) {
    this._emit("info", message, context);
  },
  warn(message, context) {
    this._emit("warn", message, context);
  },
  error(message, context) {
    this._emit("error", message, context);
  },

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
