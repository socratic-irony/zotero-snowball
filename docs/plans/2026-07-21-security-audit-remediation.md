# Security Audit Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Resolve audit findings S1-S8 as separate regression-tested commits and release version 0.5.6.

**Architecture:** Enforce network rules at the fetch/import boundaries, bound provider data during normalization, remove inline chrome handlers, recursively sanitize logs, and pin CI dependencies. Preserve the existing zero-runtime-dependency architecture and Zotero 9/XUL event semantics.

**Tech Stack:** JavaScript, Node.js `node:test`, Zotero 9 chrome/XHTML, GitHub Actions YAML, Bash release scripts.

---

### Task 1: S1 — Restrict provider-supplied PDF downloads

**Files:**

- Modify: `tests/security.test.js`
- Modify: `tests/snowball-modules.test.js`
- Modify: `src/chrome/content/modules/zoteroItems.js`
- Modify: `src/prefs.js`
- Modify: `src/chrome/content/snowballPrefs.js`
- Modify: `src/chrome/content/snowball.js`
- Modify: `README.md`

**Step 1: Write failing tests**

Add table-driven assertions for `SnowballZoteroItems.safeAttachmentURL()` accepting a public HTTPS publisher URL and rejecting HTTP, credentials, localhost/`.localhost`, private or special IPv4 literals, loopback/link-local/unique-local IPv6, and non-URL input. Add a test proving `addCandidates()` never calls `Zotero.Attachments.importFromURL` for a rejected URL. Add static assertions that all three download defaults are `false`.

**Step 2: Verify RED**

Run: `node --test tests/security.test.js tests/snowball-modules.test.js`

Expected: FAIL because `safeAttachmentURL` is absent and the defaults remain true.

**Step 3: Implement minimal fix**

Add the validator to `SnowballZoteroItems`, call it immediately before `importFromURL`, and skip invalid attachments without rolling back the item. Change defaults/fallbacks to false and document optional publisher egress.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/security.test.js tests/snowball-modules.test.js && npm test`

Commit: `fix(security): restrict automatic PDF downloads`

### Task 2: S2 — Reject provider redirects

**Files:**

- Modify: `tests/security.test.js`
- Modify: `src/chrome/content/modules/http.js`

**Step 1: Write failing test**

Inject a fetch stub that returns a 302 response pointing at `https://evil.example/`. Assert `fetchJSON()` rejects with a structured redirect error, the stub is called exactly once, and the request option is `redirect: "manual"`.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='redirect' tests/security.test.js`

Expected: FAIL because redirects are followed.

**Step 3: Implement minimal fix**

Use `redirect: "manual"`. Before status retries/parsing, reject 3xx responses with a `SnowballError` that contains only scrubbed origin/status context.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/security.test.js && npm test`

Commit: `fix(security): reject redirects outside API boundary`

### Task 3: S3 — Bound abstract reconstruction

**Files:**

- Modify: `tests/snowball-modules.test.js`
- Modify: `src/chrome/content/modules/openalex.js`

**Step 1: Write failing test**

Exercise `reconstructAbstract()` with position `1_000_000_000`, negative/fractional/non-finite positions, non-array positions, oversized tokens, and valid positions. Assert output remains ordered and bounded and that invalid positions do not expand the result.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='abstract' tests/snowball-modules.test.js`

Expected: FAIL on the billion-position sparse allocation/bounds assertion.

**Step 3: Implement minimal fix**

Introduce explicit maximum position/token/entry budgets. Iterate without materializing all object entries, accept only finite non-negative integer positions below the cap, clamp tokens before assignment, and stop at the processing budget.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/snowball-modules.test.js && npm test`

Commit: `fix(security): bound abstract reconstruction`

### Task 4: S4 — Bound provider author lists

**Files:**

- Modify: `tests/snowball-modules.test.js`
- Modify: `src/chrome/content/modules/openalex.js`

**Step 1: Write failing test**

Pass more than 100 authorships with oversized names and malformed entries to `extractAuthors()`. Assert at most 100 authors and fixed-length `name`, `firstName`, and `lastName` fields.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='author' tests/snowball-modules.test.js`

Expected: FAIL because the current method maps the complete unbounded array.

**Step 3: Implement minimal fix**

Cap the source array before mapping and clamp display/derived names. Preserve the existing one-name and multi-part-name behavior.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/snowball-modules.test.js && npm test`

Commit: `fix(security): bound provider author data`

### Task 5: S5 — Conceal API key fields

**Files:**

- Modify: `tests/package.test.js`
- Modify: `src/chrome/content/snowballPrefs.xhtml`

**Step 1: Write failing test**

Parse the preferences XHTML and assert both key inputs use `type="password"` and `autocomplete="off"`.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='API key' tests/package.test.js`

Expected: FAIL because both inputs are plain text.

**Step 3: Implement minimal fix**

Change only the two input attributes; do not change key persistence.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/package.test.js && npm run validate:manifest`

Commit: `fix(security): conceal API keys in preferences`

### Task 6: S6 — Remove inline chrome event handlers

**Files:**

- Modify: `tests/package.test.js`
- Modify: `src/chrome/content/snowballDialog.xhtml`
- Modify: `src/chrome/content/snowballDialog.js`
- Modify: `src/chrome/content/snowballPrefs.xhtml`
- Modify: `src/chrome/content/snowballPrefs.js`

**Step 1: Write failing test**

Scan runtime XHTML for attributes matching `on[a-z]+=` and assert none exist. Assert both scripts register a one-shot window load listener and wire their button actions with `addEventListener`.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='inline event' tests/package.test.js`

Expected: FAIL on the current `onload`, `oncommand`, and `onclick` attributes.

**Step 3: Implement minimal fix**

Remove inline attributes. Register lifecycle listeners at script scope; wire XUL buttons using `command` and HTML reset using `click` from the existing initialization paths.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/package.test.js && npm run validate:manifest && npm test`

Commit: `fix(security): remove inline chrome handlers`

### Task 7: S7 — Recursively redact structured logs

**Files:**

- Modify: `tests/security.test.js`
- Modify: `src/chrome/content/modules/log.js`

**Step 1: Write failing tests**

Assert `SnowballLog.format()` redacts secrets nested in objects and arrays when keys match secret parameters/headers case-insensitively, scrubs secret-bearing strings at depth, and handles cyclic/deep structures without throwing or leaking.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='nested|recursive' tests/security.test.js`

Expected: FAIL because nested objects are serialized unchanged.

**Step 3: Implement minimal fix**

Add `scrubValue()` with secret-key matching, recursive array/object handling, a `WeakSet` cycle guard, and a fixed maximum depth. Have `format()` serialize only the scrubbed copy.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/security.test.js && npm test`

Commit: `fix(security): recursively redact log context`

### Task 8: S8 — Pin GitHub Actions dependencies

**Files:**

- Modify: `tests/release.test.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Create: `.github/dependabot.yml`

**Step 1: Write failing static tests**

Assert every external `uses:` reference is a 40-character lowercase SHA followed by a version comment, and Dependabot contains weekly `github-actions` and `npm` update entries.

**Step 2: Verify RED**

Run: `node --test --test-name-pattern='actions|Dependabot' tests/release.test.js`

Expected: FAIL on floating major tags and missing Dependabot config.

**Step 3: Implement minimal fix**

Pin official current commits verified on 2026-07-21:

- `actions/checkout` v6.1.0: `d23441a48e516b6c34aea4fa41551a30e30af803`
- `actions/setup-node` v6.5.0: `249970729cb0ef3589644e2896645e5dc5ba9c38`
- `actions/upload-artifact` v7.0.0: `bbbca2ddaa5d8feaa63e36b76fdaad77386f024f`
- `softprops/action-gh-release` v3.0.2: `3d0d9888cb7fd7b750713d6e236d1fcb99157228`

Add weekly Dependabot entries for `github-actions` and `npm` at `/`.

**Step 4: Verify GREEN and commit**

Run: `node --test tests/release.test.js && npm test`

Commit: `fix(security): pin GitHub Actions dependencies`

### Task 9: Release 0.5.6

**Files:**

- Modify: `package.json`
- Modify: `src/manifest.json`
- Modify: `CHANGELOG.md`

**Step 1: Run pre-release verification**

Run: `npm run check && npm run build && npm run validate:xpi`

Expected: all checks pass and `build/snowball-sources-0.5.5.xpi` validates before the bump.

**Step 2: Bump and document**

Run: `./scripts/bump-version.sh 0.5.6`

Move the security remediation summary from Unreleased into `## [0.5.6] – 2026-07-21`, covering S1-S8 without exposing exploit detail beyond the existing report.

**Step 3: Verify release artifact**

Run: `npm run check && npm run build && npm run validate:xpi`

Expected: all checks pass and `build/snowball-sources-0.5.6.xpi` validates.

**Step 4: Commit, tag, and publish**

Commit: `chore(release): prepare v0.5.6`

Create annotated tag `v0.5.6`, fast-forward `origin/main` to the reviewed release commit, push the tag, and verify the remote refs plus GitHub Actions release run.
