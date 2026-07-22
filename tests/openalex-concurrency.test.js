const assert = require("node:assert/strict");
const { setMaxListeners } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadOpenAlex(fetchJSON) {
  const context = vm.createContext({
    console,
    URL,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    Promise,
    Map,
    Set,
    SnowballHTTP: { fetchJSON },
    SnowballLog: { debug() {} },
    SnowballError: class SnowballError extends Error {
      constructor(code, message, details = {}) {
        super(message);
        this.name = "SnowballError";
        this.code = code;
        Object.assign(this, details);
      }
    },
    Zotero: { debug() {} }
  });

  for (const name of ["util.js", "openalex.js"]) {
    const file = path.join(ROOT, "src", "chrome", "content", "modules", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  }

  return context;
}

function makeWork(id, referencedWorks = []) {
  const openAlexID = String(id).startsWith("https://") ? String(id) : `https://openalex.org/${id}`;
  return {
    id: openAlexID,
    display_name: String(id),
    publication_year: 2024,
    referenced_works: referencedWorks,
    primary_location: {
      landing_page_url: `https://example.test/${encodeURIComponent(String(id))}`
    }
  };
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function collectEvents(provider, seeds, signal = null) {
  const events = [];
  for await (const event of provider.streamSnowball(seeds, signal)) {
    events.push(event);
  }
  return events;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function candidateEvents(events) {
  return events.filter((event) => event.type === "candidate");
}

function seedIndexFromDOI(url) {
  const pathname = new URL(String(url)).pathname;
  const doi = decodeURIComponent(
    pathname.slice(pathname.indexOf("/works/doi:") + "/works/doi:".length)
  );
  return Number(doi.split("-").at(-1));
}

const TERMINAL_OPENALEX_ERROR_CODES = [
  "OPENALEX_CREDENTIALS",
  "OPENALEX_BUDGET_EXHAUSTED",
  "OPENALEX_THROTTLED"
];

test("starts at most twenty seed requests and reports bounded work progress", async () => {
  const seeds = Array.from({ length: 25 }, (_, index) => ({
    doi: `10.1000/seed-${index}`,
    title: `Seed ${index}`
  }));

  let inFlight = 0;
  let peakInFlight = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve();
  });

  const fetchJSON = async (url) => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await gate;
    inFlight--;
    return makeWork(`SEED-${seedIndexFromDOI(url)}`);
  };

  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({
    maxWorkers: 200,
    includeForward: false,
    includeBackward: false
  });
  const eventsPromise = collectEvents(provider, seeds);

  try {
    await flushMicrotasks();
    assert.ok(peakInFlight <= 20, `peak request count was ${peakInFlight}`);
    assert.equal(peakInFlight, 20);

    release();
    const events = await eventsPromise;
    assert.ok(events.some((event) => event.type === "seed-resolved"));
    assert.ok(events.some((event) => event.type === "work-progress"));
  } finally {
    release();
    await eventsPromise;
  }
});

test("defaults the legacy provider candidate cap to 1,000", () => {
  const context = loadOpenAlex(async () => ({ results: [] }));
  assert.equal(new context.OpenAlexProvider().maxCandidatesTotal, 1000);
  assert.equal(
    new context.OpenAlexProvider({ maxCandidatesTotal: "not-a-number" }).maxCandidatesTotal,
    1000
  );
});

test("hydrates every backward reference in exhaustive 100-ID chunks", async () => {
  const referencedWorks = Array.from({ length: 205 }, (_, index) => `W${index + 1}`);
  const requests = [];
  const fetchJSON = async (url) => {
    const requestURL = new URL(String(url));
    requests.push(requestURL);
    const filter = requestURL.searchParams.get("filter");
    const ids = filter.slice("openalex:".length).split("|");
    return { results: ids.map((id) => makeWork(id)) };
  };

  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({
    maxWorkers: 20,
    maxBackwardPerSeed: 1,
    maxCandidatesTotal: 1,
    includeForward: false,
    includeBackward: true
  });
  provider.resolveSeed = async () => makeWork("SEED", referencedWorks);

  const events = await collectEvents(provider, [{ title: "Seed" }]);
  const candidates = candidateEvents(events);

  assert.equal(requests.length, 3);
  assert.deepEqual(
    requests.map((requestURL) => requestURL.searchParams.get("per_page")),
    ["100", "100", "100"]
  );
  assert.deepEqual(
    requests.map(
      (requestURL) => requestURL.searchParams.get("filter").split(":")[1].split("|").length
    ),
    [100, 100, 5]
  );
  assert.deepEqual(
    new Set(candidates.map((event) => event.candidate.openAlexID)),
    new Set(referencedWorks.map((id) => `https://openalex.org/${id}`))
  );
});

test("follows every forward cursor through the final empty page", async () => {
  const cursors = [];
  const fetchJSON = async (url) => {
    const requestURL = new URL(String(url));
    const cursor = requestURL.searchParams.get("cursor");
    cursors.push(cursor);

    if (cursor === "*") {
      return { results: [makeWork("F1")], meta: { next_cursor: "cursor-1" } };
    }
    if (cursor === "cursor-1") {
      return { results: [makeWork("F2")], meta: { next_cursor: "cursor-2" } };
    }
    assert.equal(cursor, "cursor-2");
    return { results: [], meta: { next_cursor: null } };
  };

  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({
    maxForwardPerSeed: 1,
    includeForward: true,
    includeBackward: false
  });
  provider.resolveSeed = async () => makeWork("SEED");

  const events = await collectEvents(provider, [{ title: "Seed" }]);
  const candidates = candidateEvents(events);

  assert.deepEqual(cursors, ["*", "cursor-1", "cursor-2"]);
  assert.deepEqual(
    candidates.map((event) => event.candidate.openAlexID),
    ["https://openalex.org/F1", "https://openalex.org/F2"]
  );
});

test("requeues multiple forward cursors fairly", async () => {
  const requestOrder = [];
  const fetchJSON = async (url) => {
    const requestURL = new URL(String(url));
    const seedID = requestURL.searchParams.get("filter").slice("cites:".length);
    const cursor = requestURL.searchParams.get("cursor");
    requestOrder.push(`${seedID}:${cursor}`);

    const page = cursor === "*" ? "page-1" : "page-2";
    return {
      results: [makeWork(`${seedID}-${page}`)],
      meta: { next_cursor: cursor === "*" ? `${seedID}-next` : null }
    };
  };

  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({
    maxWorkers: 1,
    maxForwardPerSeed: 1,
    includeForward: true,
    includeBackward: false
  });
  provider.resolveSeed = async (seed) => makeWork(seed.id);

  const seeds = [
    { id: "S1", title: "Seed 1" },
    { id: "S2", title: "Seed 2" }
  ];
  const events = await collectEvents(provider, seeds);

  assert.deepEqual(requestOrder, ["S1:*", "S2:*", "S1:S1-next", "S2:S2-next"]);
  assert.equal(candidateEvents(events).length, 4);
});

for (const mode of ["streamSnowball", "streamForward"]) {
  /** @type {Array<[string, Record<string, string>, string[]]>} */
  const cursorCases = [
    ["a repeated cursor", { "*": "A", A: "A" }, ["*", "A"]],
    ["an A-to-B-to-A cursor cycle", { "*": "A", A: "B", B: "A" }, ["*", "A", "B"]]
  ];
  for (const [description, nextCursorByCursor, expectedCursors] of cursorCases) {
    test(`${mode} stops on ${description}`, async () => {
      const requests = [];
      const context = loadOpenAlex(async () => ({ results: [] }));
      const provider = new context.OpenAlexProvider({
        maxWorkers: 1,
        includeForward: true,
        includeBackward: false
      });
      provider.fetchForwardPage = async (_openAlexID, cursor) => {
        requests.push(cursor);
        if (requests.length > expectedCursors.length + 2) {
          throw new Error("cursor cycle was not stopped");
        }
        return {
          results: [makeWork(`F${requests.length}`)],
          meta: { next_cursor: nextCursorByCursor[cursor] || null }
        };
      };

      let candidates;
      if (mode === "streamSnowball") {
        provider.resolveSeed = async () => makeWork("SEED");
        const events = await collectEvents(provider, [{ title: "Seed" }]);
        candidates = candidateEvents(events).map((event) => event.candidate);
      } else {
        candidates = [];
        for await (const candidate of provider.streamForward({ title: "Seed" }, makeWork("SEED"))) {
          candidates.push(candidate);
        }
      }

      assert.deepEqual(requests, expectedCursors);
      assert.deepEqual(
        candidates.map((candidate) => candidate.openAlexID),
        expectedCursors.map((_, index) => `https://openalex.org/F${index + 1}`)
      );
    });
  }
}

test("aborting the event queue rejects pending and future readers", async () => {
  const context = loadOpenAlex(async () => ({ results: [] }));
  assert.equal(typeof context.OpenAlexAsyncQueue, "function");

  const queue = new context.OpenAlexAsyncQueue();
  const firstReader = queue.next();
  const secondReader = queue.next();
  const error = abortError();
  queue.fail(error);

  await assert.rejects(firstReader, (caught) => caught === error);
  await assert.rejects(secondReader, (caught) => caught === error);
  await assert.rejects(queue.next(), (caught) => caught === error);

  const closedQueue = new context.OpenAlexAsyncQueue();
  const closedReader = closedQueue.next();
  closedQueue.close();
  const closedResult = await closedReader;
  assert.equal(closedResult.value, undefined);
  assert.equal(closedResult.done, true);
});

test("event failure drains accepted FIFO values while job failure discards queued work", async () => {
  const context = loadOpenAlex(async () => ({ results: [] }));
  const error = abortError();

  const events = new context.OpenAlexAsyncQueue(2);
  events.push({ type: "candidate", id: "C1" });
  events.push({ type: "candidate", id: "C2" });
  const blockedEvent = events.push({ type: "candidate", id: "C3" });
  events.fail(error, { drain: true });

  assert.equal(await blockedEvent, false);
  assert.equal((await events.next()).value.id, "C1");
  assert.equal((await events.next()).value.id, "C2");
  await assert.rejects(events.next(), (caught) => caught === error);

  const jobs = new context.OpenAlexAsyncQueue(1);
  jobs.push({ id: "queued" });
  const blockedJob = jobs.push({ id: "blocked" });
  jobs.fail(error);
  assert.equal(await blockedJob, false);
  assert.equal(jobs.values.length, 0);
  await assert.rejects(jobs.next(), (caught) => caught === error);

  const waitingJobs = new context.OpenAlexAsyncQueue(1);
  const waitingReader = waitingJobs.next();
  waitingJobs.fail(error);
  await assert.rejects(waitingReader, (caught) => caught === error);
});

test("bounds candidate production at capacity and settles a blocked producer on failure", async () => {
  const context = loadOpenAlex(async () => ({ results: [] }));
  const capacity = 2;
  const queue = new context.OpenAlexAsyncQueue(capacity);
  let produced = 0;

  const producer = (async () => {
    for (let index = 0; index < 5; index++) {
      const accepted = await queue.push({ type: "candidate", id: index });
      if (!accepted) return;
      produced++;
    }
  })();

  await flushMicrotasks();
  assert.equal(produced, capacity);

  const first = await queue.next();
  assert.deepEqual(first.value, { type: "candidate", id: 0 });
  await flushMicrotasks();
  assert.equal(produced, capacity + 1);

  const error = abortError();
  queue.fail(error);
  await producer;
  assert.equal(produced, capacity + 1);
  assert.equal(queue.values.length, 0);
  assert.equal(queue.writers.length, 0);
  await assert.rejects(queue.next(), (caught) => caught === error);

  const closedQueue = new context.OpenAlexAsyncQueue(1);
  assert.equal(closedQueue.push({ type: "candidate", id: "buffered" }), true);
  const blockedPush = closedQueue.push({ type: "candidate", id: "blocked" });
  closedQueue.close();
  assert.equal(await blockedPush, false);
  const bufferedResult = await closedQueue.next();
  assert.equal(bufferedResult.value.type, "candidate");
  assert.equal(bufferedResult.value.id, "buffered");
  assert.equal(bufferedResult.done, false);
  const closedResult = await closedQueue.next();
  assert.equal(closedResult.value, undefined);
  assert.equal(closedResult.done, true);
});

test("stream candidate production waits for the configured event capacity and aborts cleanly", async () => {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  const capacity = 2;
  const context = loadOpenAlex(async () => ({ results: [] }));
  const provider = new context.OpenAlexProvider({
    maxWorkers: 1,
    eventBufferSize: capacity,
    includeForward: false,
    includeBackward: true
  });
  provider.resolveSeed = async () => makeWork("SEED", ["R1"]);

  let fetchFinished = false;
  let normalized = 0;
  const normalizeCandidate = provider.normalizeCandidate.bind(provider);
  provider.normalizeCandidate = (...args) => {
    normalized++;
    return normalizeCandidate(...args);
  };
  provider.fetchBackwardChunk = async () => {
    fetchFinished = true;
    return {
      results: Array.from({ length: 5 }, (_, index) => makeWork(`C${index + 1}`))
    };
  };

  const iterator = provider.streamSnowball([{ title: "Seed" }], controller.signal);
  let returned = false;
  try {
    const first = await iterator.next();
    assert.equal(first.value.type, "status");

    let event;
    do {
      event = await iterator.next();
    } while (event.value?.type !== "status" || event.value.phase !== "backward");

    await flushMicrotasks();
    assert.equal(fetchFinished, true);
    assert.equal(normalized, capacity + 1);

    const resumed = await iterator.next();
    assert.equal(resumed.value.type, "candidate");
    await flushMicrotasks();
    assert.equal(normalized, capacity + 2);

    controller.abort();
    const completion = await Promise.race([
      iterator.return(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("iterator did not settle")), 250)
      )
    ]);
    returned = true;
    assert.equal(completion.done, true);
  } finally {
    controller.abort();
    if (!returned) await iterator.return().catch(() => {});
  }
});

test("bounds queued frontier while one seed still uses twenty backward workers", async () => {
  const maxWorkers = 20;
  const referencedWorks = Array.from({ length: 5000 }, (_, index) => `R${index + 1}`);
  let inFlight = 0;
  let peakInFlight = 0;
  let requests = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve();
  });
  let resolvePeak;
  const peakReached = new Promise((resolve) => {
    resolvePeak = resolve;
  });

  const context = loadOpenAlex(async () => ({ results: [] }));
  const provider = new context.OpenAlexProvider({
    maxWorkers,
    eventBufferSize: 1000,
    includeForward: false,
    includeBackward: true
  });
  provider.resolveSeed = async () => makeWork("SEED", referencedWorks);
  provider.fetchBackwardChunk = async () => {
    requests++;
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (peakInFlight === maxWorkers) resolvePeak();
    await gate;
    inFlight--;
    return { results: [] };
  };

  const iterator = provider.streamSnowball([{ title: "Seed" }]);
  let returned = false;
  try {
    assert.equal((await iterator.next()).value.type, "status");
    assert.ok((await iterator.next()).value);

    await Promise.race([
      peakReached,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("twenty backward workers did not start")), 250)
      )
    ]);
    await flushMicrotasks();

    release();
    const events = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      events.push(result.value);
    }
    returned = true;

    const progress = events.filter((event) => event.type === "work-progress");
    const maxQueued = Math.max(0, ...progress.map((event) => event.queued));
    const maxCentralQueued = Math.max(0, ...progress.map((event) => event.centralQueued));
    const maxInlineQueued = Math.max(0, ...progress.map((event) => event.inlineQueued));
    assert.equal(peakInFlight, maxWorkers);
    assert.equal(requests, referencedWorks.length / 100);
    assert.ok(progress.every((event) => event.queued === event.centralQueued + event.inlineQueued));
    assert.ok(maxCentralQueued <= maxWorkers + 1);
    assert.equal(maxInlineQueued, 0);
    assert.ok(maxQueued <= (maxWorkers + 1) ** 2, `queued frontier reached ${maxQueued}`);
  } finally {
    release();
    if (!returned) await iterator.return().catch(() => {});
  }
});

test("counts bounded worker-local frontier while many seeds are stalled", async () => {
  const maxWorkers = 20;
  const chunksPerSeed = 25;
  const seeds = Array.from({ length: maxWorkers }, (_, index) => ({
    id: `SEED-${index + 1}`,
    title: `Seed ${index + 1}`
  }));
  const referencedWorks = Array.from(
    { length: chunksPerSeed * 100 },
    (_, index) => `R${index + 1}`
  );
  let inFlight = 0;
  let peakInFlight = 0;
  let requests = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve();
  });
  let resolvePeak;
  const peakReached = new Promise((resolve) => {
    resolvePeak = resolve;
  });

  const context = loadOpenAlex(async () => ({ results: [] }));
  const provider = new context.OpenAlexProvider({
    maxWorkers,
    eventBufferSize: 2000,
    includeForward: false,
    includeBackward: true
  });
  provider.resolveSeed = async () => makeWork("SEED", referencedWorks);
  provider.fetchBackwardChunk = async () => {
    requests++;
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (peakInFlight === maxWorkers) resolvePeak();
    await gate;
    inFlight--;
    return { results: [] };
  };

  const iterator = provider.streamSnowball(seeds);
  let returned = false;
  try {
    assert.equal((await iterator.next()).value.type, "status");
    assert.ok((await iterator.next()).value);

    await Promise.race([
      peakReached,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("twenty stalled workers did not start")), 250)
      )
    ]);

    release();
    const events = [];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      events.push(result.value);
    }
    returned = true;

    const progress = events.filter((event) => event.type === "work-progress");
    const maxQueued = Math.max(0, ...progress.map((event) => event.queued));
    assert.equal(peakInFlight, maxWorkers);
    assert.equal(requests, seeds.length * chunksPerSeed);
    assert.ok(progress.some((event) => event.inlineQueued > 0));
    assert.ok(progress.every((event) => event.queued === event.centralQueued + event.inlineQueued));
    assert.ok(maxQueued <= (maxWorkers + 1) ** 2);
  } finally {
    release();
    if (!returned) await iterator.return().catch(() => {});
  }
});

test("ordinary backward failures release every lazy source lane", async () => {
  const maxWorkers = 20;
  const chunks = maxWorkers + 3;
  let requests = 0;
  const context = loadOpenAlex(async () => ({ results: [] }));
  const provider = new context.OpenAlexProvider({
    maxWorkers,
    eventBufferSize: 1000,
    includeForward: false,
    includeBackward: true
  });
  provider.resolveSeed = async () =>
    makeWork(
      "SEED",
      Array.from({ length: chunks * 100 }, (_, index) => `R${index + 1}`)
    );
  provider.fetchBackwardChunk = async () => {
    requests++;
    throw new Error(`ordinary backward failure ${requests}`);
  };

  const events = await collectEvents(provider, [{ title: "Seed" }]);
  assert.equal(requests, chunks);
  assert.equal(
    events.filter((event) => event.type === "status" && event.phase === "error").length,
    chunks
  );
  assert.ok(events.some((event) => event.type === "status" && event.phase === "done"));
});

test("terminal stream errors drain buffered candidates in FIFO order before throwing", async () => {
  const terminalError = Object.assign(new Error("credentials rejected"), {
    code: "OPENALEX_CREDENTIALS"
  });
  const context = loadOpenAlex(async () => ({ results: [] }));
  const provider = new context.OpenAlexProvider({
    maxWorkers: 2,
    eventBufferSize: 20,
    includeForward: false,
    includeBackward: true
  });

  let resolveCandidatesReady;
  const candidatesReady = new Promise((resolve) => {
    resolveCandidatesReady = resolve;
  });
  let resolveTerminalStarted;
  const terminalStarted = new Promise((resolve) => {
    resolveTerminalStarted = resolve;
  });
  let normalizedCandidates = 0;
  const normalizeCandidate = provider.normalizeCandidate.bind(provider);
  provider.normalizeCandidate = (...args) => {
    normalizedCandidates++;
    const candidate = normalizeCandidate(...args);
    if (normalizedCandidates === 2) resolveCandidatesReady();
    return candidate;
  };
  provider.resolveSeed = async (seed) => {
    if (seed.id === "terminal") {
      await candidatesReady;
      resolveTerminalStarted();
      throw terminalError;
    }
    return makeWork("SEED", ["R1"]);
  };
  provider.fetchBackwardChunk = async () => ({
    results: [makeWork("C1"), makeWork("C2")]
  });

  const iterator = provider.streamSnowball([
    { id: "candidate", title: "Candidate seed" },
    { id: "terminal", title: "Terminal seed" }
  ]);
  const seen = [];
  seen.push((await iterator.next()).value);
  seen.push((await iterator.next()).value);

  await Promise.race([
    terminalStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("terminal did not start")), 250))
  ]);

  let caught;
  try {
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      seen.push(result.value);
    }
  } catch (error) {
    caught = error;
  }

  assert.equal(normalizedCandidates, 2);
  assert.equal(caught, terminalError);
  assert.deepEqual(
    candidateEvents(seen).map((event) => event.candidate.openAlexID),
    ["https://openalex.org/C1", "https://openalex.org/C2"]
  );
});

for (const method of ["getWorkByDOI", "searchWorkByTitle"]) {
  for (const code of TERMINAL_OPENALEX_ERROR_CODES) {
    test(`${method} preserves ${code}`, async () => {
      const error = Object.assign(new Error(code), { code });
      const context = loadOpenAlex(async () => {
        throw error;
      });
      const provider = new context.OpenAlexProvider();
      const lookup =
        method === "getWorkByDOI"
          ? provider.getWorkByDOI("10.1000/terminal")
          : provider.searchWorkByTitle("Terminal error", 2024);

      await assert.rejects(lookup, (caught) => caught === error);
    });
  }
}

for (const code of TERMINAL_OPENALEX_ERROR_CODES) {
  test(`stream aborts remaining workers and preserves first ${code}`, async () => {
    const controller = new AbortController();
    setMaxListeners(0, controller.signal);
    const terminalError = Object.assign(new Error(code), { code });
    let started = 0;
    let aborted = 0;
    let rejectFirst;
    const firstResponse = new Promise((_, reject) => {
      rejectFirst = reject;
    });

    const fetchJSON = (_url, { signal }) => {
      started++;
      setMaxListeners(0, signal);
      if (started === 1) return firstResponse;

      const request = new Promise((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          aborted++;
          reject(abortError());
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      });
      if (started === 20) rejectFirst(terminalError);
      return request;
    };

    const context = loadOpenAlex(fetchJSON);
    const provider = new context.OpenAlexProvider({ maxWorkers: 20 });
    const eventsPromise = collectEvents(
      provider,
      Array.from({ length: 25 }, (_, index) => ({ doi: `10.1000/terminal-${index}` })),
      controller.signal
    );
    const timeout = setTimeout(() => controller.abort(), 250);

    try {
      await assert.rejects(eventsPromise, (caught) => caught === terminalError);
      assert.equal(started, 20);
      assert.equal(aborted, started - 1);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await eventsPromise.catch(() => {});
    }
  });
}

test("ordinary seed lookup failures remain nonfatal per seed", async () => {
  const fetchJSON = async (url) => {
    if (String(url).includes("ordinary-failure")) {
      throw new Error("ordinary lookup failed");
    }
    return makeWork("GOOD");
  };
  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({
    maxWorkers: 2,
    includeForward: false,
    includeBackward: false
  });

  const events = await collectEvents(provider, [
    { doi: "10.1000/ordinary-failure" },
    { doi: "10.1000/ordinary-success" }
  ]);

  assert.ok(events.some((event) => event.type === "status" && event.phase === "resolve-error"));
  assert.ok(events.some((event) => event.type === "seed-resolved"));
});

test("aborting a crawl terminates pending worker requests and the async stream", async () => {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  let started = 0;
  const fetchJSON = (_url, { signal }) => {
    started++;
    setMaxListeners(0, signal);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort);
      }
    });
  };

  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({ maxWorkers: 20 });
  const eventsPromise = collectEvents(
    provider,
    Array.from({ length: 25 }, (_, index) => ({ doi: `10.1000/abort-${index}` })),
    controller.signal
  );

  await flushMicrotasks();
  assert.ok(started > 0);
  controller.abort();

  const events = await eventsPromise;
  assert.ok(events.some((event) => event.type === "status"));
  assert.ok(events.every((event) => event.type !== "candidate"));
});

test("out-of-order results retain seed and direction metadata", async () => {
  const pendingRequests = new Map();
  let requestCount = 0;
  const fetchJSON = async (url) => {
    requestCount++;
    const requestURL = new URL(String(url));
    const filter = requestURL.searchParams.get("filter");
    const direction = filter.startsWith("cites:") ? "forward" : "backward";
    if (requestCount > 2) return { results: [] };
    return new Promise((resolve) => {
      pendingRequests.set(direction, { resolve });
    });
  };

  const context = loadOpenAlex(fetchJSON);
  const provider = new context.OpenAlexProvider({
    maxWorkers: 2,
    includeForward: true,
    includeBackward: true
  });
  provider.resolveSeed = async () => makeWork("SEED", ["BACKWARD"]);

  const eventsPromise = collectEvents(provider, [{ title: "Original seed" }]);
  try {
    await flushMicrotasks();
    assert.equal(pendingRequests.size, 2);

    const forward = pendingRequests.get("forward");
    pendingRequests.delete("forward");
    forward.resolve({ results: [makeWork("FORWARD")] });

    const backward = pendingRequests.get("backward");
    pendingRequests.delete("backward");
    backward.resolve({ results: [makeWork("BACKWARD")] });

    const events = await eventsPromise;
    const candidates = candidateEvents(events);
    assert.deepEqual(
      candidates.map((event) => [event.candidate.openAlexID, event.candidate.direction]),
      [
        ["https://openalex.org/FORWARD", "forward"],
        ["https://openalex.org/BACKWARD", "backward"]
      ]
    );
    assert.ok(candidates.every((event) => event.candidate.seedTitle === "Original seed"));
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      await flushMicrotasks();
      for (const [direction, request] of pendingRequests) {
        pendingRequests.delete(direction);
        request.resolve({ results: [] });
      }
    }
    await eventsPromise;
  }
});
