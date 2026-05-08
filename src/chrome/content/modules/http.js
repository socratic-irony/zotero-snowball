/* global fetch, AbortController, DOMException, SnowballLog, SnowballError */

/**
 * Hardened HTTP client.
 *
 * - Enforces an HTTPS-only host allowlist so a compromised or rogue
 *   candidate URL can never become an SSRF vector.
 * - Wraps every request in a per-request timeout that composes with the
 *   caller's AbortSignal (whichever fires first wins).
 * - Retries 429/502/503/504 and transient network errors with exponential
 *   backoff + jitter, honoring `Retry-After` when present.
 * - Logs only scrubbed URLs / messages via SnowballLog.
 * - Returns parsed JSON; throws SnowballError with a code on failure.
 *
 * Usage:
 *   const json = await SnowballHTTP.fetchJSON(url, { signal, timeoutMs: 30000 });
 */
var SnowballHTTP = {
  // Hosts we are willing to talk to. Anything else throws before we even
  // open a socket. This is the single source of truth — adding a provider
  // means adding its host here.
  ALLOWED_HOSTS: new Set([
    "api.openalex.org",
    "api.semanticscholar.org"
  ]),

  // Defaults. Callers can override per-request.
  DEFAULT_TIMEOUT_MS: 30_000,
  DEFAULT_MAX_RETRIES: 4,
  RETRYABLE_STATUS: new Set([408, 425, 429, 500, 502, 503, 504]),

  /**
   * Validate a URL before letting it near `fetch()`. Throws SnowballError on
   * anything other than https:// to an allowed host.
   */
  assertSafeURL(url) {
    let u;
    try {
      u = url instanceof URL ? url : new URL(String(url));
    } catch (error) {
      throw new SnowballError("BAD_URL", "Invalid request URL.", { cause: error });
    }
    if (u.protocol !== "https:") {
      throw new SnowballError("BAD_SCHEME",
        "Refusing non-HTTPS request.", { context: { protocol: u.protocol } });
    }
    if (!this.ALLOWED_HOSTS.has(u.hostname)) {
      throw new SnowballError("HOST_NOT_ALLOWED",
        "Refusing request to non-allowlisted host.",
        { context: { host: u.hostname } });
    }
    return u;
  },

  /**
   * Compose two AbortSignals so the resulting controller aborts when
   * EITHER source aborts. Returns { signal, dispose } — call dispose() to
   * detach listeners after the request settles.
   */
  composeSignals(signals) {
    const controller = new AbortController();
    const cleanups = [];
    const trip = (reason) => {
      try { controller.abort(reason); } catch (_) { /* ignore */ }
    };
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) {
        trip(signal.reason);
        break;
      }
      const handler = () => trip(signal.reason);
      signal.addEventListener("abort", handler, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", handler));
    }
    return {
      signal: controller.signal,
      dispose: () => { for (const fn of cleanups) try { fn(); } catch (_) { /* ignore */ } }
    };
  },

  /**
   * Issue a JSON request with retries, timeout, and abort plumbing.
   *
   * Defaults to GET. Pass `method: "POST"` + `body` for POSTs. Retries
   * apply to POSTs the same as GETs — only call this for idempotent POST
   * endpoints (e.g. read-only batch lookups like Semantic Scholar's
   * /paper/batch).
   *
   * @param {URL|string} url
   * @param {object} [opts]
   * @param {string}      [opts.method="GET"]
   * @param {string|null} [opts.body]   raw request body (already serialized)
   * @param {AbortSignal} [opts.signal]
   * @param {object}      [opts.headers]
   * @param {number}      [opts.timeoutMs]
   * @param {number}      [opts.maxRetries]
   */
  async fetchJSON(url, opts = {}) {
    const safeURL = this.assertSafeURL(url);
    const {
      method = "GET",
      body = null,
      signal = null,
      headers = {},
      timeoutMs = this.DEFAULT_TIMEOUT_MS,
      maxRetries = this.DEFAULT_MAX_RETRIES
    } = opts;

    let attempt = 0;
    while (true) {
      attempt++;

      // Per-attempt timeout, composed with the caller's signal.
      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort("timeout"), timeoutMs);
      const composed = this.composeSignals([signal, timeoutCtl.signal]);

      let response;
      try {
        response = await fetch(safeURL.toString(), {
          method,
          headers: Object.assign(
            { "Accept": "application/json" },
            headers
          ),
          body: (body !== null && body !== undefined) ? body : undefined,
          credentials: "omit",
          redirect: "follow",
          signal: composed.signal
        });
      } catch (error) {
        composed.dispose();
        clearTimeout(timer);

        // Caller-initiated abort: re-throw as-is so callers can detect it.
        if (signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        // Timeout: retry if we have budget.
        if (timeoutCtl.signal.aborted) {
          if (attempt <= maxRetries) {
            await this._delay(this._backoff(attempt), signal);
            continue;
          }
          throw new SnowballError("HTTP_TIMEOUT",
            "The request timed out. Check your network and try again.",
            { cause: error, context: { url: SnowballLog.scrub(safeURL.toString()), attempt } });
        }
        // Generic network error: retry.
        if (attempt <= maxRetries) {
          await this._delay(this._backoff(attempt), signal);
          continue;
        }
        throw new SnowballError("NETWORK_ERROR",
          "Network error. Check your connection and try again.",
          { cause: error, context: { url: SnowballLog.scrub(safeURL.toString()), attempt } });
      } finally {
        composed.dispose();
        clearTimeout(timer);
      }

      // Response received — decide whether to retry on status.
      if (this.RETRYABLE_STATUS.has(response.status) && attempt <= maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : this._backoff(attempt);
        SnowballLog.warn("HTTP retry", {
          status: response.status,
          attempt,
          delayMs,
          url: SnowballLog.scrub(safeURL.toString())
        });
        await this._delay(delayMs, signal);
        continue;
      }

      if (!response.ok) {
        // Read body but cap to avoid logging megabytes of HTML.
        let body = "";
        try {
          const text = await response.text();
          body = text.slice(0, 500);
        } catch (_) { /* ignore */ }
        throw new SnowballError("HTTP_ERROR",
          `Request failed (${response.status}). The provider may be down or rate-limiting.`,
          { context: {
              status: response.status,
              url: SnowballLog.scrub(safeURL.toString()),
              body: SnowballLog.scrub(body)
            } });
      }

      try {
        return await response.json();
      } catch (error) {
        throw new SnowballError("BAD_RESPONSE",
          "The provider returned an invalid response.",
          { cause: error, context: { url: SnowballLog.scrub(safeURL.toString()) } });
      }
    }
  },

  _backoff(attempt) {
    // Exponential backoff with jitter, capped.
    const base = Math.min(1000 * Math.pow(2, attempt - 1), 16_000);
    const jitter = Math.floor(Math.random() * 250);
    return base + jitter;
  },

  _delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
};
