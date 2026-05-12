# Code-Quality & Security Roadmap

Living document. Order is the recommended landing order; each item is a
standalone PR. Strike items as they ship.

## ✅ Done (Wave 1 — local + CI gates)

- ESLint flat config ([eslint.config.mjs](../eslint.config.mjs)) with browser /
  XPCOM globals, promise hygiene rules, security nudges (`no-eval`,
  `no-implied-eval`, `no-new-func`, `no-script-url`).
- Prettier ([.prettierrc.json](../.prettierrc.json)) — one-shot format applied;
  XHTML excluded because XUL is whitespace-sensitive.
- `tsc --checkJs` ([tsconfig.json](../tsconfig.json)) with a partial ambient
  Zotero declaration ([types/zotero.d.ts](../types/zotero.d.ts)). Strict mode
  is OFF — see the ratchet plan below.
- Lefthook ([lefthook.yml](../lefthook.yml)): pre-commit (eslint + prettier
  on staged files), pre-push (full `lint + typecheck + test + validate`).
- CI workflow ([../.github/workflows/ci.yml](../.github/workflows/ci.yml))
  adds a `static` job (lint, format, typecheck) that gates the `test` job.

## Wave 2 — Tighten the CI gates

### Build / CI hygiene

- [ ] **Node test matrix**: run tests on `node-version: [20, 22, 24]` to
      match `engines.node: ">=20"`. Cheap.
- [ ] **OS matrix**: add `macos-latest` to catch path-case bugs.
- [ ] **Pin third-party actions to commit SHAs** (with tag in comment).
      `actions/*` are fine on major; `softprops/action-gh-release` etc.
      should be SHA-pinned.
- [ ] **Drop `persist-credentials: true`** in the release workflow unless
      strictly needed; prefer a fine-scoped `GITHUB_TOKEN` or deploy key.
- [ ] **Branch protection on `main`**: require PR, require status checks
      (`Lint, format, typecheck` + `Test & build`), require linear history,
      require signed commits, disallow force-push.

### Supply chain

- [ ] **Dependabot** (`.github/dependabot.yml`) — weekly bumps for
      `github-actions` and `npm` (devDeps only — runtime deps stay at 0).
- [ ] **`actions/dependency-review-action`** on `pull_request` — fails the
      PR if a new dep introduces a CVE.
- [ ] **CodeQL** workflow (free, JS analysis).
- [ ] **OpenSSF Scorecard** workflow — publishes a badge, nudges best
      practices.
- [ ] **`osv-scanner`** or `trivy` filesystem mode on every PR.
- [ ] **"Zero runtime deps" invariant test** — `node:test` assertion that
      `package.json` has no `dependencies` field. Tripwire for future
      contributors.

### Release integrity

- [ ] **SLSA build provenance** via `actions/attest-build-provenance` —
      signed attestation per XPI release.
- [ ] **Reproducible XPI**: set `SOURCE_DATE_EPOCH`, use `zip -X` (no extra
      fields), verify identical SHA-256 across two CI builds.
- [ ] **Cosign-sign the XPI** as defense-in-depth (Zotero doesn't verify
      today, but free to add).
- [ ] **JSON schema for `updates.json`** validated in CI — this file is
      critical infra; if it ever ships malformed, every user's Zotero
      stops updating silently.
- [ ] **Post-release smoke job**: download the just-published XPI from the
      GH Release URL, recompute SHA-256, compare to `updates.json`.
- [ ] **`updates.json` monotonic-version check** — sort + assert
      strictly increasing so a downgrade can't ship.
- [ ] **Verify signed tag** in the release workflow (`git verify-tag`).
- [ ] **Beta channel** via `updates-beta.json` so the update pipeline can
      be tested end-to-end before promoting a build.

### Static / asset linting

- [ ] **`web-ext lint`** against the unpacked source — catches missing
      locale entries, broken chrome.manifest paths.
- [ ] **`stylelint`** for [snowballDialog.css](../src/chrome/content/snowballDialog.css)
      and [snowballPrefs.css](../src/chrome/content/snowballPrefs.css). The
      dark-mode audit work is exactly what stylelint would have caught.
- [ ] **`actionlint`** for workflow YAML.
- [ ] **`shellcheck`** for [build.sh](../scripts/build.sh) /
      [bump-version.sh](../scripts/bump-version.sh) /
      [validate-xpi.sh](../scripts/validate-xpi.sh).
- [ ] **`yamllint`** for `.yml` consistency.
- [ ] **`markdownlint-cli2`** for README/CHANGELOG.

### Release-touchpoint sync

The lesson from "we landed CQ tooling but no release fired": every version
bump touches a constellation of files (manifest, package.json, CHANGELOG,
sometimes README badges or screenshots) and missing one is a silent bug.
These items make that constellation mechanically enforced.

- [ ] **Teach `scripts/bump-version.sh` to also touch README + CHANGELOG**
      so the bump is a one-shot atomic operation. Two sub-tasks: rewrite any
      `Current version: vX.Y.Z` / shields.io badge line in README, and
      prepend a dated `## [X.Y.Z] - YYYY-MM-DD` stub to CHANGELOG so the
      author can't forget the entry.
- [ ] **CI tripwire on missing release-doc updates** — when a PR changes
      `src/manifest.json`'s `version`, fail if `CHANGELOG.md` and `README.md`
      haven't also changed in the same PR. Cheap `git diff --name-only`
      check inside the existing `static` job.
- [ ] **AGENTS.md** (and a matching `CLAUDE.md` symlink) documenting the
      release checklist for both human contributors and AI agents
      (Claude Code, Copilot, Cursor, etc.). Should explicitly list:
      bump → README/CHANGELOG → commit → tag → push tag, plus the fact
      that the release workflow does the actual publishing. AI agents
      read these files first, so this is where to put "do not forget
      step X" guidance.
- [ ] **`updates.json` JSON schema** validated in CI (also listed under
      Release integrity above — cross-link). Critical infra.

## Wave 3 — Code-level hardening

### HTTP / network

- [ ] **Bounded response size** in [http.js](../src/chrome/content/modules/http.js):
      stream the response with a max byte budget (4 MB) so a hostile or
      proxied response can't stream forever.
- [ ] **JSON parse hardening**: try/catch + soft max-depth check on
      provider payloads (don't trust unbounded nesting).
- [ ] **Per-host rate limiter** that respects OpenAlex / S2 documented
      RPS caps in addition to `Retry-After`.
- [ ] **Polite-pool `User-Agent` / `From:`** header pointing at the repo URL
      (OpenAlex documents this; gets us into the polite pool).
- [ ] **Test the host allowlist**: craft a fake OpenAlex response whose
      embedded URLs point at `evil.example` and assert the follow-up
      `fetchJSON` is rejected with `HOST_NOT_ALLOWED`.

### CSP / chrome surface

- [ ] **Grep gate in CI** for `innerHTML`, `eval`, `new Function`,
      `setTimeout("…")`, `onclick=` in source files. ESLint already bans
      eval/new-Function; extend to a custom rule for inline event handlers
      in XHTML.
- [ ] **Audit `Zotero.launchURL` / `window.open` call sites** — every URL
      must go through a validator.

### File-level

- [ ] **Split [snowballDialog.js](../src/chrome/content/snowballDialog.js)**
      (1322 LOC) into state / render / event-handlers / provider-glue.
      Reduces both cognitive load and AI-review window pressure.
- [ ] **Remove the `// @ts-nocheck`** from
      [snowballDialog.js](../src/chrome/content/snowballDialog.js) and
      [snowballPrefs.js](../src/chrome/content/snowballPrefs.js) by adding
      JSDoc casts (`/** @type {HTMLInputElement} */`) at each
      `document.getElementById(...)` site. Probably 30–50 sites total.
- [ ] **Centralize the error taxonomy** in
      [errors.js](../src/chrome/content/modules/errors.js): every throw from
      network code is one of NetworkError, TimeoutError, RateLimitedError,
      or UpstreamShapeError — never a bare `Error`. Test asserts this.

### Size & complexity budgets

Long files and high-complexity functions are where vibe-coded bugs hide
and where AI review windows clip context. Two ESLint rules turn this into
a hard gate; both need a ratchet because today's baseline is over budget
in a couple of places.

- [ ] **`max-lines` rule** in [eslint.config.mjs](../eslint.config.mjs).
      Baseline today: `snowballDialog.js` 1322, `snowball.js` 513,
      `openalex.js` 544; every other source file is ≤ 360. Ratchet in
      three phases — first `["warn", { max: 600 }]` (flags only the
      one true outlier), then `["error", { max: 500 }]` after the dialog
      split, then `["error", { max: 400 }]` as the steady state.
      Exemptions live as per-file overrides in the config, not inline
      disables, so the budget stays visible.
- [ ] **`complexity` rule** for cyclomatic complexity. Most healthy JS
      code lives under 10; over 15 is a smell, over 20 is almost always
      rewrite territory. Ratchet: `complexity: ["warn", 20]` first
      (surfaces the worst offenders — likely some dialog event handlers
      and `ranking.scoreCandidate`), then `["error", 15]` after the
      dialog split, then `["error", 10]` as the steady state. Pair with
      `max-depth: ["error", 4]` and `max-params: ["warn", 5]` for the
      related smells.
- [ ] **`max-lines-per-function`** as a secondary gate:
      `["warn", { max: 80, skipComments: true, skipBlankLines: true, IIFEs: true }]`.
      Catches the "one big render function" pattern that big files
      usually grow.
- [ ] **Track the baseline** in CI by emitting a tiny report each run
      (`eslint --format=json | jq` summary of max line/complexity per
      file) so the ratchet is data-driven, not vibes.

### Tests

- [ ] **Coverage gate**: `node --test --experimental-test-coverage` and
      fail CI under `line: 80% / branch: 70%`. Report uploaded as
      artifact.
- [ ] **Fuzz-style tests** — garbage JSON, malformed DOIs, unicode-bomb
      strings into ranking + parsing, assert no throw.
- [ ] **Snapshot test** for the rendered XHTML tree after a typical
      OpenAlex response.
- [ ] **Golden-XPI test**: build twice, diff file lists + per-file
      hashes, fail on drift not explained by a version bump.

## Wave 4 — Quality of life

- [ ] **Conventional Commits + commitlint** in `commit-msg` hook so
      CHANGELOG generation becomes automatic.
- [ ] **`eslint-plugin-security` + `eslint-plugin-unicorn`** — cherry-pick
      rules; start with `unicorn/prefer-node-protocol`,
      `security/detect-non-literal-fs-filename`. Both will produce a flood
      on first run; land in a "lint:security" job that's warn-only first.
- [ ] **`npm run dev`** that builds + symlinks the unpacked plugin into
      Zotero's profile so the iteration loop is "edit → reload" instead of
      "edit → build → install".
- [ ] **Issue / PR templates** in `.github/ISSUE_TEMPLATE/` requiring
      Zotero version, OS, plugin version, debug log excerpt.
- [ ] **`CODEOWNERS`** locking down release-critical files (`updates.json`,
      `scripts/`, `.github/workflows/`).

## TypeScript ratchet (sub-roadmap)

Currently the [tsconfig.json](../tsconfig.json) is loose. Tighten one knob
at a time, fix fallout, commit:

1. `noImplicitReturns: true`
2. `noUnusedParameters: true` (already partially via ESLint)
3. `noImplicitThis: true`
4. `strictNullChecks: true` — biggest win, biggest fallout. Most real bugs
   here.
5. `noImplicitAny: true` — usually paired with adding JSDoc on public
   helpers.
6. `strict: true` — final form.

Replace ambient `any` placeholders in [types/zotero.d.ts](../types/zotero.d.ts)
with real shapes as each level is enabled. Aim for a handful of accurately
typed Zotero APIs we actually call, not a comprehensive Zotero typings
project.
