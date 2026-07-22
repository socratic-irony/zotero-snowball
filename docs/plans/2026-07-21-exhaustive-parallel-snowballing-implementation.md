# Exhaustive Parallel Snowballing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make exhaustive OpenAlex snowballing the default, retain an opt-in 1,000-paper early-stop mode, safely run 20 concurrent crawl workers, require user-supplied OpenAlex credentials, and verify that public Git history contains no exposed key.

**Architecture:** The dialog remains the serialization point for deduplication and unique-paper counting. `OpenAlexProvider` becomes a 20-worker queued crawler that emits out-of-order stream events, while `SnowballHTTP` supplies a shared per-host request gate and coordinated retry pause. Search-mode and credential behavior stays in preferences/controller/dialog code; the public-history audit remains read-only and produces a sanitized report.

**Tech Stack:** Zotero 9 bootstrapped plugin, plain JavaScript, XUL/XHTML, Node.js built-in test runner, ESLint, TypeScript check mode, shell build/XPI validation.

---

### Task 1: Search mode, 1,000-paper default, and user-supplied credentials

**Owner:** Luna/max thread `search-mode-credentials`

**Files:**

- Modify: `src/prefs.js:1-11`
- Modify: `src/chrome/content/snowball.js:330-404`
- Modify: `src/chrome/content/snowballPrefs.js:6-30`
- Modify: `src/chrome/content/snowballPrefs.xhtml:25-120`
- Modify: `src/chrome/content/snowballDialog.js:117-236`
- Modify: `src/locale/en-US/snowball-sources.ftl`
- Modify: `README.md:84-110`
- Create: `tests/search-mode-credentials.test.js`

**Step 1: Write failing default/configuration tests**

Add tests that evaluate `src/prefs.js`, load `SnowballPrefs`, and inspect controller/dialog source. Assert this contract:

```js
assert.equal(defaults.get("extensions.snowballSources.limitResults"), false);
assert.equal(defaults.get("extensions.snowballSources.maxCandidatesTotal"), 1000);
assert.equal(ctx.SnowballPrefs.schema.limitResults.default, false);
assert.equal(ctx.SnowballPrefs.schema.maxCandidatesTotal.default, 1000);
assert.match(controller, /if\s*\(!apiKey\)/);
assert.match(dialog, /limitResults\s*===\s*true/);
```

Inspect every text-like file under `src/` and reject a non-empty install default or obvious literal assignment for an OpenAlex API key. Exclude field names and explicit test placeholders; never print a suspected value in assertion output.

**Step 2: Run the focused test and verify failure**

Run: `node --test tests/search-mode-credentials.test.js`

Expected: FAIL because `limitResults` does not exist, the cap is 500, and searches do not require a key.

**Step 3: Implement preference defaults and UI**

Add:

```js
pref("extensions.snowballSources.limitResults", false);
pref("extensions.snowballSources.maxCandidatesTotal", 1000);
```

Add `limitResults` to `SnowballPrefs.schema`, change the cap default to 1,000, and remove the forward/backward per-seed fields from the visible preferences UI so they cannot silently contradict exhaustive mode. Keep legacy install prefs only if compatibility requires them, but stop passing them into new provider configuration.

The preferences panel must label the modes plainly: exhaustive is the default; limiting stops early and does not guarantee the global top N. Disable the numeric limit control when the checkbox is off. Keep the OpenAlex key input `type="password"` with `autocomplete="off"`.

**Step 4: Implement controller validation and dialog termination**

Build provider configuration as:

```js
const apiKey = this.prefStr("openAlexAPIKey", "").trim();
if (!apiKey) {
  this.alert("Enter your OpenAlex API key in Snowball Sources Preferences before searching.");
  return;
}

const providerConfig = {
  apiKey,
  semanticScholarAPIKey: this.prefStr("semanticScholarAPIKey", ""),
  limitResults: this.prefBool("limitResults", false),
  maxCandidatesTotal: this.prefInt("maxCandidatesTotal", 1000, 1, 10000),
  maxWorkers: 20,
  timeoutMs: this.prefInt("requestTimeoutMs", 30000, 1000, 120000),
  includeForward: this.prefBool("includeForward", true),
  includeBackward: this.prefBool("includeBackward", true)
};
```

In `startStreaming()`, enforce the cap only when `limitResults === true`. Abort immediately after the Nth unique candidate is accepted, set a distinct “Limit reached” completion message, and keep manual Stop distinguishable from cap termination. In exhaustive mode, do not abort based on count.

**Step 5: Document the behavior and credential requirement**

Update the preference table, usage text, and API-key section. State that users obtain and enter their own key, no project key is bundled, exhaustive searches may consume substantial OpenAlex quota, and the limit is an early-stop sample.

**Step 6: Run focused and adjacent tests**

Run: `node --test tests/search-mode-credentials.test.js tests/plugin-controller.test.js tests/package.test.js tests/security.test.js`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/prefs.js src/chrome/content/snowball.js src/chrome/content/snowballPrefs.js src/chrome/content/snowballPrefs.xhtml src/chrome/content/snowballDialog.js src/locale/en-US/snowball-sources.ftl README.md tests/search-mode-credentials.test.js
git commit -m "feat: make exhaustive snowballing the default"
```

### Task 2: Twenty-worker exhaustive OpenAlex crawler

**Owner:** Luna/max thread `parallel-crawler`

**Files:**

- Modify: `src/chrome/content/modules/openalex.js:3-540`
- Create: `tests/openalex-concurrency.test.js`

**Step 1: Write deterministic failing crawler tests**

Use deferred promises and a stubbed `SnowballHTTP.fetchJSON()` to assert:

```js
assert.ok(peakInFlight <= 20);
assert.equal(peakInFlight, 20);
assert.deepEqual(new Set(candidateIDs), expectedIDs);
assert.ok(events.some((event) => event.type === "seed-resolved"));
assert.ok(events.some((event) => event.type === "work-progress"));
```

Cover these cases separately:

1. 25 seed resolutions start no more than 20 requests concurrently.
2. A resolved seed schedules all 100-ID backward chunks without slicing to the old per-seed cap.
3. A forward chain follows `next_cursor` through the final empty/null-cursor page.
4. Multiple forward chains requeue cursors fairly instead of one chain monopolizing the queue.
5. Aborting rejects or drains every waiter and the async generator terminates promptly.
6. Results arriving out of order still retain correct seed and direction metadata.

**Step 2: Run the focused test and verify failure**

Run: `node --test tests/openalex-concurrency.test.js`

Expected: FAIL because the provider currently resolves and crawls serially and slices at per-seed limits.

**Step 3: Add a closeable async event queue**

Implement a small queue inside `openalex.js` with this interface:

```js
class OpenAlexAsyncQueue {
  push(value) {}
  close() {}
  fail(error) {}
  async next() {}
  [Symbol.asyncIterator]() {
    return this;
  }
}
```

`close()` must settle pending readers with `{done: true}`. `fail(error)` must reject pending/future readers. Do not add a runtime dependency.

**Step 4: Add a dynamic work queue with 20 workers**

Use `maxWorkers = OpenAlexProvider.clampInt(maxWorkers, 1, 20, 20)`. Track queued and active job counts. Jobs have explicit kinds and payloads:

```js
{ kind: "resolve", seed, seedIndex }
{ kind: "backward", seed, ids }
{ kind: "forward", seed, openAlexID, cursor: "*" }
```

When a resolve job succeeds, emit `seed-resolved` immediately, enqueue every 100-ID backward chunk, and enqueue the first forward cursor job. A forward job emits its candidates, then requeues one continuation job when `next_cursor` exists. Emit bounded status/progress data containing only counts and short seed labels.

Use an explicit pending-job counter so the queue closes only after all dynamic continuations finish. Catch failures per seed/direction, emit a non-fatal status event, and continue other work. Abort remains terminal.

**Step 5: Remove acquisition slicing in exhaustive traversal**

Hydrate all `work.referenced_works` in 100-ID chunks and set `per_page=100`. Follow every forward cursor. The provider should not own unique-candidate cap logic; the dialog aborts the shared signal after it serially deduplicates the Nth paper.

Retain the non-streaming methods only if tests or callers use them; make them share exhaustive helpers or clearly mark them legacy so their limits cannot accidentally affect the streaming path.

**Step 6: Run provider tests**

Run: `node --test tests/openalex-concurrency.test.js tests/snowball-modules.test.js tests/ranking-signals.test.js`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/chrome/content/modules/openalex.js tests/openalex-concurrency.test.js
git commit -m "feat: crawl OpenAlex with twenty workers"
```

### Task 3: Shared OpenAlex request gate and coordinated backoff

**Owner:** Luna/max thread `rate-limit-retries`

**Files:**

- Modify: `src/chrome/content/modules/http.js:18-250`
- Modify: `src/chrome/content/modules/errors.js:1-140`
- Create: `tests/http-rate-limit.test.js`

**Step 1: Write failing rate-gate tests with a fake clock**

Inject or override `_now`, `_delay`, and `fetch` so tests do not sleep. Assert:

- OpenAlex request starts stay below a configured test ceiling in a rolling one-second window.
- 20 simultaneous callers share one host gate.
- `Retry-After: 2` blocks every OpenAlex caller until the shared pause expires.
- an HTTP-date `Retry-After` is parsed correctly;
- aborting during a gate wait throws `AbortError` and removes the waiter;
- `401` and ordinary `403` are terminal credential errors;
- rate-evidenced `403`, `408`, `425`, `429`, and `5xx` use bounded retry/backoff; and
- a response showing zero daily allowance raises `OPENALEX_BUDGET_EXHAUSTED` without retrying indefinitely.

**Step 2: Run the focused test and verify failure**

Run: `node --test tests/http-rate-limit.test.js`

Expected: FAIL because retries currently wait independently and request starts have no shared rate bound.

**Step 3: Add a per-host gate**

Add an OpenAlex policy below the public ceiling, for example:

```js
HOST_POLICIES: new Map([
  ["api.openalex.org", { maxStarts: 80, windowMs: 1000 }]
]),
```

Maintain private host state with recent start timestamps, a FIFO waiter chain, and `blockedUntil`. Before every fetch attempt, call `_acquireHostGate(hostname, signal)`. Serialize state updates so bursts cannot race past the ceiling. Prune timestamps older than the rolling window and delay until the earliest slot opens.

**Step 4: Coordinate throttle responses and retries**

Parse both forms of `Retry-After`. When a response is retryable, update the host's shared `blockedUntil` before retrying. Preserve jittered exponential backoff when no provider delay exists. Inspect OpenAlex rate-limit headers without logging secrets.

Return precise `SnowballError` codes/messages for missing/invalid credentials, throttling exhaustion, and daily-budget exhaustion. Do not classify every `403` as retryable: require a retry header, rate-limit header, or provider body evidence.

**Step 5: Preserve existing security boundaries**

Keep HTTPS and host allowlisting, manual redirect rejection, credential omission, timeout composition, body-snippet bounds, URL scrubbing, and caller abort semantics unchanged. All retries must pass through the gate.

**Step 6: Run HTTP and security tests**

Run: `node --test tests/http-rate-limit.test.js tests/security.test.js tests/ranking-signals.test.js`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/chrome/content/modules/http.js src/chrome/content/modules/errors.js tests/http-rate-limit.test.js
git commit -m "feat: coordinate OpenAlex rate limiting"
```

### Task 4: Audit every public commit for exposed OpenAlex credentials

**Owner:** Luna/max thread `credential-history-audit`

**Files:**

- Create when clean: `docs/security/openalex-credential-history-audit-2026-07-21.md`

**Step 1: Refresh public refs read-only**

Run: `git remote -v`

Run: `git fetch --all --tags --prune`

Confirm the GitHub repository is `socratic-irony/zotero-snowball`. Record the scanned remote refs and commit count. Do not push, rewrite, delete, or rotate anything.

**Step 2: Scan reachable commit diffs and blobs**

Use more than one method:

```bash
git log --all -p -G 'openAlexAPIKey|OPENALEX_API_KEY|api_key|mailto' -- .
git rev-list --objects --all
git grep -I -n -E 'openAlexAPIKey.{0,80}[^"[:space:]]|OPENALEX_API_KEY|api_key=' $(git rev-list --all)
```

Also run an available secret scanner such as `gitleaks git --redact` or `trufflehog git --no-update` against the repository history. If neither is installed, document that limitation and perform a scripted high-entropy scan over `git rev-list --all` blobs. Do not install or upload repository contents to a third-party service.

Classify placeholders, empty preference defaults, documentation examples, test fixtures, hashes, and actual credential candidates separately. Never echo a suspected credential into the report or thread response.

**Step 3: Cross-check GitHub-visible refs**

Use `gh api` or GitHub's repository/commit endpoints to confirm the default branch and public branches/tags included by the local fetch. If authentication prevents an API call, compare `git ls-remote --heads --tags origin` with the scanned refs and document the evidence.

**Step 4: Report safely**

If clean, create the audit document with date, repository, commit/ref coverage, tools/commands in generalized form, false-positive classes, result, and limitations. If a credible key is found, do not commit its value or a reversible fragment; report only commit hash/path and recommend immediate revocation/rotation. Do not rewrite public history without separate approval.

**Step 5: Commit a clean audit report**

```bash
git add docs/security/openalex-credential-history-audit-2026-07-21.md
git commit -m "docs: record OpenAlex credential history audit"
```

### Task 5: Integrate, review, and verify

**Owner:** Primary thread after the four Luna/max reports

**Files:**

- Modify as required by integration findings
- Modify: `CHANGELOG.md`
- Verify: all files changed by Tasks 1-4

**Step 1: Review each report before integrating**

For every implementation branch, inspect `git status`, `git log -1 --stat`, and the complete diff from the shared planning commit. Confirm the thread ran its focused tests and did not include unrelated changes or credentials.

**Step 2: Integrate commits one at a time**

Cherry-pick the search-mode, crawler, rate-gate, and clean audit commits onto `feature/exhaustive-parallel-snowballing`. Resolve only boundary conflicts. After each pick, run the focused tests owned by that commit.

**Step 3: Add integration tests for cross-boundary behavior**

Add or extend a test to prove that the Nth unique candidate aborts all 20 workers, while duplicate arrivals do not consume the cap. Prove exhaustive mode does not pass legacy per-seed caps. Verify shared throttle waits still respond to the same abort signal used by Stop.

**Step 4: Review correctness and maintainability**

Check queue closure, pending-job accounting, listener cleanup, race-free limit enforcement, fair cursor scheduling, deterministic tests, error classification, secret redaction, and user-facing text. Send concrete follow-up requests to the originating thread for any defect, then re-review its patch.

**Step 5: Update the changelog**

Document exhaustive-by-default behavior, the opt-in 1,000-paper limit, 20-worker crawler, coordinated OpenAlex throttling, and required user-supplied API key. Do not claim the history audit is clean until its report is reviewed.

**Step 6: Run the full verification suite**

Run:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run validate:manifest
npm run build
npm run validate:xpi
```

Expected: every command exits 0, all Node tests pass, both XHTML files validate, and the XPI validation reports success.

**Step 7: Inspect final scope and commit integration fixes**

Run: `git diff origin/main...HEAD --check`

Run: `git status --short`

If integration fixes or changelog edits are pending:

```bash
git add CHANGELOG.md tests src docs
git commit -m "feat: add exhaustive parallel snowballing"
```

The branch is ready for user review only after the final status is clean and the verification evidence has been recorded.
