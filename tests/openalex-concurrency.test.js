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

test("starts at most twenty seed requests and reports bounded work progress", async () => {
  const seeds = Array.from({ length: 25 }, (_, index) => ({
    doi: `10.1000/seed-${index}`,
    title: `Seed ${index}`
  }));

  let inFlight = 0;
  let peakInFlight = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
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

  const seeds = [{ id: "S1", title: "Seed 1" }, { id: "S2", title: "Seed 2" }];
  const events = await collectEvents(provider, seeds);

  assert.deepEqual(requestOrder, ["S1:*", "S2:*", "S1:S1-next", "S2:S2-next"]);
  assert.equal(candidateEvents(events).length, 4);
});

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

test("aborting a crawl terminates pending worker requests and the async stream", async () => {
  const controller = new AbortController();
  setMaxListeners(0, controller.signal);
  let started = 0;
  const fetchJSON = (_url, { signal }) => {
    started++;
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
