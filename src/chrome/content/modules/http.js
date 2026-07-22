/* global fetch, AbortController, DOMException, SnowballLog, SnowballError */

/**
 * Hardened HTTP client.
 *
 * - Enforces an HTTPS-only host allowlist so a compromised or rogue
 *   candidate URL can never become an SSRF vector.
 * - Wraps every request in a per-request timeout that composes with the
 *   caller's AbortSignal (whichever fires first wins).
 * - Retries transient provider/network errors with exponential backoff +
 *   jitter, honoring `Retry-After` when present.
 * - Coordinates OpenAlex request starts and provider pauses per host.
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
  ALLOWED_HOSTS: new Set(["api.openalex.org", "api.semanticscholar.org"]),

  // Defaults. Callers can override per-request.
  DEFAULT_TIMEOUT_MS: 30_000,
  DEFAULT_MAX_RETRIES: 4,
  RETRYABLE_STATUS: new Set([408, 425, 429, 500, 502, 503, 504]),
  MAX_RETRY_AFTER_MS: 30_000,

  // OpenAlex documents a public ceiling of 100 requests per second. Keep a
  // safety margin so concurrent workers cannot crowd that boundary.
  HOST_POLICIES: new Map([["api.openalex.org", { maxStarts: 80, windowMs: 1000 }]]),

  // One state object per host lets all callers, including retry attempts,
  // participate in the same FIFO gate and provider pause.
  _hostStates: new Map(),

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
      throw new SnowballError("BAD_SCHEME", "Refusing non-HTTPS request.", {
        context: { protocol: u.protocol }
      });
    }
    if (!this.ALLOWED_HOSTS.has(u.hostname)) {
      throw new SnowballError("HOST_NOT_ALLOWED", "Refusing request to non-allowlisted host.", {
        context: { host: u.hostname }
      });
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
      try {
        controller.abort(reason);
      } catch (_) {
        /* ignore */
      }
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
      dispose: () => {
        for (const fn of cleanups)
          try {
            fn();
          } catch (_) {
            /* ignore */
          }
      }
    };
  },

  _now() {
    return Date.now();
  },

  _getHostState(hostname) {
    let state = this._hostStates.get(hostname);
    if (!state) {
      state = {
        recentStarts: [],
        waiters: [],
        blockedUntil: 0,
        pumping: false,
        pumpPromise: null
      };
      this._hostStates.set(hostname, state);
    }
    return state;
  },

  _acquireHostGate(hostname, signal) {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }

    const policy = this.HOST_POLICIES.get(hostname);
    if (!policy) return Promise.resolve();

    const state = this._getHostState(hostname);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: null,
        done: false
      };
      const cleanup = () => {
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
      };
      waiter.onAbort = () => {
        if (waiter.done) return;
        waiter.done = true;
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        cleanup();
        reject(new DOMException("aborted", "AbortError"));
      };

      if (signal) {
        if (signal.aborted) {
          waiter.onAbort();
          return;
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      state.waiters.push(waiter);
      this._pumpHostGate(hostname);
    });
  },

  _pumpHostGate(hostname) {
    const state = this._getHostState(hostname);
    if (state.pumping) return;

    state.pumping = true;
    state.pumpPromise = (async () => {
      try {
        while (state.waiters.length > 0) {
          const policy = this.HOST_POLICIES.get(hostname);
          if (!policy) {
            while (state.waiters.length > 0) {
              const waiter = state.waiters.shift();
              this._resolveHostWaiter(waiter);
            }
            break;
          }

          const maxStarts = Math.max(1, Math.floor(Number(policy.maxStarts) || 1));
          const windowMs = Math.max(1, Number(policy.windowMs) || 1000);
          const now = this._now();
          state.recentStarts = state.recentStarts.filter((startedAt) => now - startedAt < windowMs);

          let waitMs = Math.max(0, state.blockedUntil - now);
          if (state.recentStarts.length >= maxStarts) {
            waitMs = Math.max(waitMs, state.recentStarts[0] + windowMs - now);
          }
          if (waitMs > 0) {
            // This delay is shared by the pump. Individual waiter aborts are
            // handled by their own listeners and remove themselves from the
            // queue without canceling other callers' wait.
            await this._delay(waitMs);
            continue;
          }

          const waiter = state.waiters.shift();
          if (!waiter || waiter.done) continue;
          state.recentStarts.push(now);
          this._resolveHostWaiter(waiter);
        }
      } catch (error) {
        while (state.waiters.length > 0) {
          const waiter = state.waiters.shift();
          if (!waiter || waiter.done) continue;
          waiter.done = true;
          if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
          }
          waiter.reject(error);
        }
      } finally {
        state.pumping = false;
        state.pumpPromise = null;
        if (state.waiters.length > 0) this._pumpHostGate(hostname);
      }
    })();
  },

  _resolveHostWaiter(waiter) {
    if (!waiter || waiter.done) return;
    waiter.done = true;
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve();
  },

  _blockHost(hostname, delayMs) {
    const duration = Number(delayMs);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const state = this._getHostState(hostname);
    state.blockedUntil = Math.max(state.blockedUntil, this._now() + duration);
  },

  _getHeader(headers, name) {
    if (!headers) return null;
    try {
      const value = headers.get?.(name);
      if (value !== undefined && value !== null) return String(value);
    } catch (_) {
      /* ignore malformed test/provider headers */
    }
    try {
      for (const [key, value] of headers.entries?.() || []) {
        if (String(key).toLowerCase() === name.toLowerCase()) return String(value);
      }
    } catch (_) {
      /* ignore malformed test/provider headers */
    }
    try {
      for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === name.toLowerCase()) return String(value);
      }
    } catch (_) {
      /* ignore malformed test/provider headers */
    }
    return null;
  },

  _retryAfterMs(response) {
    const raw = this._getHeader(response?.headers, "retry-after");
    if (raw === null || raw.trim() === "") return null;

    const seconds = Number(raw.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, this.MAX_RETRY_AFTER_MS);
    }

    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) return null;
    return Math.min(Math.max(0, timestamp - this._now()), this.MAX_RETRY_AFTER_MS);
  },

  _hasRateLimitEvidence(response, bodySnippet) {
    if (Number(response?.status) === 429) return true;
    if (this._retryAfterMs(response) !== null) return true;
    for (const name of [
      "x-ratelimit-remaining",
      "x-rate-limit-remaining",
      "x-ratelimit-remaining-usd",
      "x-ratelimit-daily-remaining",
      "x-ratelimit-daily-remaining-usd",
      "x-rate-limit-remaining-usd",
      "x-rate-limit-daily-remaining",
      "x-rate-limit-daily-remaining-usd",
      "x-openalex-daily-remaining"
    ]) {
      const raw = this._getHeader(response?.headers, name);
      if (raw === null || raw.trim() === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value <= 0) return true;
    }
    return /rate[\s-]?limit|throttl|too many requests|(?:quota|allowance)[^\n]{0,80}(?:exceed|exhaust|deplet|limit)/i.test(
      bodySnippet || ""
    );
  },

  _isDailyBudgetExhausted(response, bodySnippet) {
    for (const name of [
      "x-ratelimit-remaining",
      "x-ratelimit-remaining-usd",
      "x-ratelimit-daily-remaining",
      "x-ratelimit-daily-remaining-usd",
      "x-rate-limit-remaining",
      "x-rate-limit-remaining-usd",
      "x-rate-limit-daily-remaining",
      "x-rate-limit-daily-remaining-usd",
      "x-openalex-daily-remaining"
    ]) {
      const raw = this._getHeader(response?.headers, name);
      if (raw === null || raw.trim() === "") continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value <= 0) return true;
    }

    const body = bodySnippet || "";
    if (
      /(?:daily[\s_-]*remaining(?:[\s_-]*usd)?|credits[\s_-]*remaining)\s*["']?\s*[:=]\s*["']?0(?:\.0+)?\b/i.test(
        body
      )
    ) {
      return true;
    }
    return /(?:daily[\s_-]*(?:allowance|budget|remaining)|quota)[^\n]{0,80}(?:\b0(?:\D|$)|exhaust|deplet)/i.test(
      body
    );
  },

  _isRetryableResponse(response, bodySnippet) {
    const status = Number(response?.status);
    if (status === 403) return this._hasRateLimitEvidence(response, bodySnippet);
    if (this.RETRYABLE_STATUS.has(status)) return true;
    return status >= 500 && status < 600;
  },

  _openAlexErrorContext(safeURL, response, bodySnippet, attempt) {
    return {
      status: response.status,
      attempt,
      url: SnowballLog.scrub(safeURL.toString()),
      body: SnowballLog.scrub(bodySnippet || "")
    };
  },

  async _readBodySnippet(response) {
    try {
      const text = await response.text();
      return String(text || "").slice(0, 500);
    } catch (_) {
      return "";
    }
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

      // Every initial attempt and retry must pass the same host gate.
      await this._acquireHostGate(safeURL.hostname, signal);

      // Per-attempt timeout, composed with the caller's signal.
      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort("timeout"), timeoutMs);
      const composed = this.composeSignals([signal, timeoutCtl.signal]);

      let response;
      try {
        response = await fetch(safeURL.toString(), {
          method,
          headers: Object.assign({ Accept: "application/json" }, headers),
          body: body !== null && body !== undefined ? body : undefined,
          credentials: "omit",
          redirect: "manual",
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
          throw new SnowballError(
            "HTTP_TIMEOUT",
            "The request timed out. Check your network and try again.",
            { cause: error, context: { url: SnowballLog.scrub(safeURL.toString()), attempt } }
          );
        }
        // Generic network error: retry.
        if (attempt <= maxRetries) {
          await this._delay(this._backoff(attempt), signal);
          continue;
        }
        throw new SnowballError(
          "NETWORK_ERROR",
          "Network error. Check your connection and try again.",
          { cause: error, context: { url: SnowballLog.scrub(safeURL.toString()), attempt } }
        );
      } finally {
        composed.dispose();
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        throw new SnowballError("HTTP_REDIRECT", "The provider returned a redirect.", {
          context: {
            origin: SnowballLog.scrub(safeURL.origin),
            status: response.status
          }
        });
      }

      if (!response.ok) {
        // Read body but cap to avoid logging megabytes of HTML. The bounded
        // snippet is also used to distinguish a rate-evidenced 403.
        const bodySnippet = await this._readBodySnippet(response);
        const isOpenAlex = safeURL.hostname === "api.openalex.org";
        const retryAfter = this._retryAfterMs(response);
        const errorContext = this._openAlexErrorContext(safeURL, response, bodySnippet, attempt);

        if (isOpenAlex && this._isDailyBudgetExhausted(response, bodySnippet)) {
          throw SnowballError.openAlexBudgetExhausted(errorContext);
        }

        if (isOpenAlex && response.status === 401) {
          throw SnowballError.openAlexCredentials(errorContext);
        }

        const retryable = this._isRetryableResponse(response, bodySnippet);
        if (retryable) {
          const delayMs = retryAfter === null ? this._backoff(attempt) : retryAfter;
          if (isOpenAlex) this._blockHost(safeURL.hostname, delayMs);

          if (attempt <= maxRetries) {
            SnowballLog.warn("HTTP retry", {
              status: response.status,
              attempt,
              delayMs,
              url: SnowballLog.scrub(safeURL.toString())
            });
            await this._delay(delayMs, signal);
            continue;
          }

          if (isOpenAlex && this._hasRateLimitEvidence(response, bodySnippet)) {
            throw SnowballError.openAlexThrottled(errorContext);
          }
        }

        if (isOpenAlex && response.status === 403) {
          throw SnowballError.openAlexCredentials(errorContext);
        }

        throw new SnowballError(
          "HTTP_ERROR",
          `Request failed (${response.status}). The provider may be down or rate-limiting.`,
          {
            context: {
              status: response.status,
              url: SnowballLog.scrub(safeURL.toString()),
              body: SnowballLog.scrub(bodySnippet)
            }
          }
        );
      }

      try {
        return await response.json();
      } catch (error) {
        throw new SnowballError("BAD_RESPONSE", "The provider returned an invalid response.", {
          cause: error,
          context: { url: SnowballLog.scrub(safeURL.toString()) }
        });
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
      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const onResolve = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException("aborted", "AbortError"));
      };

      const timer = setTimeout(onResolve, ms);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
};
