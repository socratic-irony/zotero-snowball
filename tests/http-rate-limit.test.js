const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

class FakeClock {
  constructor(now = 0) {
    this.now = now;
    this.waits = [];
  }

  delay = (ms, signal) =>
    new Promise((resolve, reject) => {
      const wait = {
        due: this.now + ms,
        ms,
        resolve,
        reject,
        signal,
        settled: false,
        onAbort: null
      };
      const settle = (callback, value) => {
        if (wait.settled) return;
        wait.settled = true;
        if (wait.onAbort && wait.signal) {
          wait.signal.removeEventListener("abort", wait.onAbort);
        }
        callback(value);
      };
      wait.onAbort = () => settle(reject, new DOMException("aborted", "AbortError"));
      if (signal?.aborted) {
        wait.onAbort();
        return;
      }
      signal?.addEventListener("abort", wait.onAbort, { once: true });
      wait.settle = () => settle(resolve);
      this.waits.push(wait);
    });

  advance(ms) {
    this.now += ms;
    for (const wait of this.waits) {
      if (!wait.settled && wait.due <= this.now) wait.settle();
    }
    this.waits = this.waits.filter((wait) => !wait.settled);
  }
}

function response(status, body = {}, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
  );
  const textBody = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return normalized.get(String(name).toLowerCase()) ?? null;
      }
    },
    async text() {
      return textBody;
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    }
  };
}

function loadHTTP(fetchImpl, clock) {
  const context = vm.createContext({
    console,
    URL,
    fetch: fetchImpl,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    Zotero: { debug() {} }
  });

  for (const name of ["log.js", "errors.js", "http.js"]) {
    const file = path.join(ROOT, "src", "chrome", "content", "modules", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }

  context.SnowballHTTP._now = () => clock.now;
  context.SnowballHTTP._delay = clock.delay;
  context.SnowballHTTP._backoff = (attempt) => attempt * 100;
  return context;
}

async function settle() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function openAlexURL(pathname) {
  return `https://api.openalex.org${pathname}`;
}

test("OpenAlex request starts stay under the shared rolling-window ceiling", async () => {
  const clock = new FakeClock();
  const starts = [];
  const ctx = loadHTTP(async () => {
    starts.push(clock.now);
    return response(200, { ok: true });
  }, clock);
  assert.ok(ctx.SnowballHTTP.HOST_POLICIES.get("api.openalex.org").maxStarts < 100);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 2, windowMs: 1000 }]
  ]);

  const requests = Array.from({ length: 5 }, (_, index) =>
    ctx.SnowballHTTP.fetchJSON(openAlexURL(`/works/${index}`), { maxRetries: 0 })
  );
  await settle();
  assert.deepEqual(starts, [0, 0]);

  clock.advance(999);
  await settle();
  assert.deepEqual(starts, [0, 0]);

  clock.advance(1);
  await settle();
  assert.deepEqual(starts, [0, 0, 1000, 1000]);

  clock.advance(1000);
  await settle();
  assert.deepEqual(starts, [0, 0, 1000, 1000, 2000]);
  await Promise.all(requests);
});

test("twenty simultaneous OpenAlex callers share one host gate", async () => {
  const clock = new FakeClock();
  const starts = [];
  const ctx = loadHTTP(async () => {
    starts.push(clock.now);
    return response(200, { ok: true });
  }, clock);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 5, windowMs: 1000 }]
  ]);

  const requests = Array.from({ length: 20 }, (_, index) =>
    ctx.SnowballHTTP.fetchJSON(openAlexURL(`/works/${index}`), { maxRetries: 0 })
  );

  for (let batch = 0; batch < 4; batch++) {
    await settle();
    assert.equal(starts.length, (batch + 1) * 5);
    assert.ok(starts.slice(batch * 5).every((startedAt) => startedAt === batch * 1000));
    if (batch < 3) clock.advance(1000);
  }
  await Promise.all(requests);
});

test("Retry-After delta pauses every queued OpenAlex caller", async () => {
  const clock = new FakeClock();
  const starts = [];
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    starts.push(clock.now);
    fetchCount++;
    return fetchCount === 1
      ? response(
          429,
          { error: "rate limit exceeded" },
          { "Retry-After": "2", "X-RateLimit-Remaining": "10" }
        )
      : response(200, { ok: true });
  }, clock);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 80, windowMs: 1000 }]
  ]);

  const first = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/first"), { maxRetries: 1 });
  await settle();
  assert.deepEqual(starts, [0]);

  const queued = [
    ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/second"), { maxRetries: 0 }),
    ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/third"), { maxRetries: 0 })
  ];
  await settle();
  assert.deepEqual(starts, [0]);

  clock.advance(1999);
  await settle();
  assert.deepEqual(starts, [0]);

  clock.advance(1);
  await settle();
  assert.equal(starts.length, 4);
  assert.ok(starts.slice(1).every((startedAt) => startedAt >= 2000));
  await Promise.all([first, ...queued]);
});

test("HTTP-date Retry-After is converted using the injected clock", async () => {
  const start = Date.parse("Wed, 01 Jan 2025 00:00:00 GMT");
  const clock = new FakeClock(start);
  const controller = new AbortController();
  const ctx = loadHTTP(
    async () =>
      response(
        429,
        { error: "rate limit exceeded" },
        {
          "Retry-After": new Date(start + 4_000).toUTCString(),
          "X-RateLimit-Remaining": "10"
        }
      ),
    clock
  );

  const request = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/date"), {
    signal: controller.signal,
    maxRetries: 1
  });
  await settle();
  assert.equal(clock.waits.length, 1);
  assert.equal(clock.waits[0].ms, 4_000);

  controller.abort();
  await assert.rejects(request, (error) => isRecord(error) && error.name === "AbortError");
});

test("aborting a caller during a host-gate wait removes its waiter", async () => {
  const clock = new FakeClock();
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    fetchCount++;
    return response(200, { ok: true });
  }, clock);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 1, windowMs: 1000 }]
  ]);

  await ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/first"), { maxRetries: 0 });
  const controller = new AbortController();
  const waiting = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/second"), {
    signal: controller.signal,
    maxRetries: 0
  });
  await settle();
  controller.abort();

  await assert.rejects(waiting, (error) => isRecord(error) && error.name === "AbortError");
  assert.equal(fetchCount, 1);
  assert.equal(ctx.SnowballHTTP._hostStates.get("api.openalex.org").waiters.length, 0);
  clock.advance(1000);
  await settle();
});

test("aborting the last host-gate waiter wakes the shared pump immediately", async () => {
  const clock = new FakeClock();
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    fetchCount++;
    return response(200, { ok: true });
  }, clock);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 80, windowMs: 1000 }]
  ]);

  ctx.SnowballHTTP._blockHost("api.openalex.org", 30_000);
  const controller = new AbortController();
  const waiting = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/blocked"), {
    signal: controller.signal,
    maxRetries: 0
  });
  await settle();

  const state = ctx.SnowballHTTP._hostStates.get("api.openalex.org");
  assert.equal(state.waiters.length, 1);
  assert.equal(clock.waits.length, 1);
  assert.equal(clock.waits[0].ms, 30_000);
  assert.equal(clock.waits[0].settled, false);

  controller.abort();
  await assert.rejects(waiting, (error) => isRecord(error) && error.name === "AbortError");
  await settle();

  assert.equal(fetchCount, 0);
  assert.equal(state.waiters.length, 0);
  assert.equal(state.pumping, false);
  assert.equal(clock.waits[0].settled, true);
});

test("a new host-gate waiter arriving during an empty-queue wake is not stranded", async () => {
  const clock = new FakeClock();
  const starts = [];
  const ctx = loadHTTP(async () => {
    starts.push(clock.now);
    return response(200, { ok: true });
  }, clock);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 1, windowMs: 1000 }]
  ]);

  await ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/first"), { maxRetries: 0 });
  const controller = new AbortController();
  const canceled = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/canceled"), {
    signal: controller.signal,
    maxRetries: 0
  });
  await settle();

  controller.abort();
  const replacement = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/replacement"), {
    maxRetries: 0
  });
  await assert.rejects(canceled, (error) => isRecord(error) && error.name === "AbortError");
  await settle();

  const state = ctx.SnowballHTTP._hostStates.get("api.openalex.org");
  assert.equal(state.waiters.length, 1);
  assert.equal(state.pumping, true);
  assert.equal(clock.waits.length, 2);
  assert.equal(clock.waits[0].settled, true);
  assert.equal(clock.waits[1].settled, false);

  clock.advance(999);
  await settle();
  assert.deepEqual(starts, [0]);

  clock.advance(1);
  await settle();
  await replacement;
  assert.deepEqual(starts, [0, 1000]);
});

test("aborting one host-gate waiter preserves the remaining waiter's gate time", async () => {
  const clock = new FakeClock();
  const starts = [];
  const ctx = loadHTTP(async () => {
    starts.push(clock.now);
    return response(200, { ok: true });
  }, clock);
  ctx.SnowballHTTP.HOST_POLICIES = new Map([
    ["api.openalex.org", { maxStarts: 1, windowMs: 1000 }]
  ]);

  await ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/first"), { maxRetries: 0 });
  const controller = new AbortController();
  const canceled = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/canceled"), {
    signal: controller.signal,
    maxRetries: 0
  });
  const remaining = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/remaining"), {
    maxRetries: 0
  });
  await settle();

  const state = ctx.SnowballHTTP._hostStates.get("api.openalex.org");
  assert.equal(state.waiters.length, 2);
  assert.equal(clock.waits.length, 1);

  controller.abort();
  await assert.rejects(canceled, (error) => isRecord(error) && error.name === "AbortError");
  await settle();
  assert.equal(state.waiters.length, 1);
  assert.equal(clock.waits[0].settled, false);

  clock.advance(999);
  await settle();
  assert.deepEqual(starts, [0]);

  clock.advance(1);
  await settle();
  await remaining;
  assert.deepEqual(starts, [0, 1000]);
});

test("OpenAlex 401 and ordinary 403 are terminal credential errors", async () => {
  for (const status of [401, 403]) {
    const clock = new FakeClock();
    let fetchCount = 0;
    const ctx = loadHTTP(async () => {
      fetchCount++;
      return response(status, { error: "invalid credentials" });
    }, clock);

    await assert.rejects(
      ctx.SnowballHTTP.fetchJSON(openAlexURL(`/works/auth-${status}`), { maxRetries: 4 }),
      (error) =>
        isRecord(error) &&
        error.code === "OPENALEX_CREDENTIALS" &&
        typeof error.userMessage === "string" &&
        /Preferences/.test(error.userMessage) &&
        isRecord(error.context) &&
        error.context.status === status
    );
    assert.equal(fetchCount, 1);
    assert.equal(clock.waits.length, 0);
  }
});

test("OpenAlex credential errors scrub secret-bearing URLs and bodies", async () => {
  const clock = new FakeClock();
  const ctx = loadHTTP(async () => response(403, "api_key=BODY_SECRET is invalid"), clock);

  let error;
  try {
    await ctx.SnowballHTTP.fetchJSON(`${openAlexURL("/works")}?api_key=URL_SECRET`, {
      maxRetries: 0
    });
  } catch (caught) {
    error = caught;
  }

  assert.equal(error.code, "OPENALEX_CREDENTIALS");
  assert.ok(!JSON.stringify(error.context).includes("URL_SECRET"));
  assert.ok(!JSON.stringify(error.context).includes("BODY_SECRET"));
});

test("positive OpenAlex daily allowance headers do not turn 403 into throttling", async () => {
  const clock = new FakeClock();
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    fetchCount++;
    return response(
      403,
      { error: "invalid credentials" },
      {
        "X-RateLimit-Limit": "10000",
        "X-RateLimit-Remaining": "10",
        "X-RateLimit-Reset": "3600"
      }
    );
  }, clock);

  await assert.rejects(
    ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/positive-daily-headers"), { maxRetries: 0 }),
    (error) =>
      isRecord(error) &&
      error.code === "OPENALEX_CREDENTIALS" &&
      isRecord(error.context) &&
      error.context.status === 403
  );
  assert.equal(fetchCount, 1);
  assert.equal(clock.waits.length, 0);
});

test("rate-evidenced 403 and transient statuses use bounded shared retry backoff", async () => {
  const cases = [
    { status: 403, body: "rate limit exceeded" },
    { status: 408 },
    { status: 425 },
    { status: 429 },
    { status: 500 },
    { status: 503 },
    { status: 599 }
  ];

  for (const currentCase of cases) {
    const clock = new FakeClock();
    const starts = [];
    let fetchCount = 0;
    const ctx = loadHTTP(async () => {
      starts.push(clock.now);
      fetchCount++;
      return fetchCount === 1
        ? response(
            currentCase.status,
            currentCase.body || { error: "temporary failure" },
            currentCase.headers
          )
        : response(200, { ok: true });
    }, clock);

    const request = ctx.SnowballHTTP.fetchJSON(openAlexURL(`/works/retry-${currentCase.status}`), {
      maxRetries: 1
    });
    await settle();
    assert.equal(fetchCount, 1, `status ${currentCase.status} should wait before retrying`);
    assert.equal(clock.waits[0].ms, 100, `status ${currentCase.status} should use backoff`);

    clock.advance(100);
    await settle();
    await request;
    assert.equal(fetchCount, 2, `status ${currentCase.status} should retry once`);
    assert.deepEqual(starts, [0, 100]);
  }
});

test("generic retryable OpenAlex responses use HTTP_ERROR after retry exhaustion", async () => {
  for (const status of [408, 425, 500, 503, 599]) {
    const clock = new FakeClock();
    let fetchCount = 0;
    const ctx = loadHTTP(async () => {
      fetchCount++;
      return response(status, { error: "temporary provider failure" });
    }, clock);

    const request = ctx.SnowballHTTP.fetchJSON(openAlexURL(`/works/exhausted-${status}`), {
      maxRetries: 1
    });
    await settle();
    assert.equal(fetchCount, 1);
    assert.equal(clock.waits[0].ms, 100);

    clock.advance(100);
    await settle();
    await assert.rejects(
      request,
      (error) =>
        isRecord(error) &&
        error.code === "HTTP_ERROR" &&
        isRecord(error.context) &&
        error.context.status === status
    );
    assert.equal(fetchCount, 2);
  }
});

test("zero OpenAlex daily allowance is terminal and is not retried", async () => {
  const clock = new FakeClock();
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    fetchCount++;
    return response(
      429,
      { error: "daily allowance exhausted" },
      {
        "X-RateLimit-Limit": "10000",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "3600",
        "Retry-After": "2"
      }
    );
  }, clock);

  await assert.rejects(
    ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/budget"), { maxRetries: 4 }),
    (error) =>
      isRecord(error) &&
      error.code === "OPENALEX_BUDGET_EXHAUSTED" &&
      typeof error.userMessage === "string" &&
      /daily allowance/i.test(error.userMessage) &&
      isRecord(error.context) &&
      error.context.status === 429
  );
  assert.equal(fetchCount, 1);
  assert.equal(clock.waits.length, 0);
});

test("zero daily allowance in an OpenAlex response body is terminal", async () => {
  const clock = new FakeClock();
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    fetchCount++;
    return response(429, { rate_limit: { daily_remaining_usd: 0 } }, { "Retry-After": "2" });
  }, clock);

  await assert.rejects(
    ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/body-budget"), { maxRetries: 4 }),
    (error) => isRecord(error) && error.code === "OPENALEX_BUDGET_EXHAUSTED"
  );
  assert.equal(fetchCount, 1);
  assert.equal(clock.waits.length, 0);
});

test("retry exhaustion reports a distinct OpenAlex throttling error", async () => {
  const clock = new FakeClock();
  let fetchCount = 0;
  const ctx = loadHTTP(async () => {
    fetchCount++;
    return response(429, { error: "rate limit exceeded" }, { "X-RateLimit-Remaining": "10" });
  }, clock);

  const request = ctx.SnowballHTTP.fetchJSON(openAlexURL("/works/exhausted"), {
    maxRetries: 1
  });
  await settle();
  clock.advance(100);
  await settle();

  await assert.rejects(
    request,
    (error) =>
      isRecord(error) &&
      error.code === "OPENALEX_THROTTLED" &&
      isRecord(error.context) &&
      error.context.status === 429
  );
  assert.equal(fetchCount, 2);
});
