# Snowball Sources for Zotero

[![CI](https://github.com/socratic-irony/zotero-snowball/actions/workflows/ci.yml/badge.svg)](https://github.com/socratic-irony/zotero-snowball/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/socratic-irony/zotero-snowball?sort=semver)](https://github.com/socratic-irony/zotero-snowball/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Find one-hop **backward references** and **forward citations** for the items already in your Zotero library, review them in a sortable/filterable dialog, and add the ones you want with a click. All citation data comes from [OpenAlex](https://openalex.org); a [Semantic Scholar](https://www.semanticscholar.org/product/api) API key can be configured for future enrichment.

> Replace `socratic-irony/zotero-snowball` and `snowball-sources@example.com` (in `src/manifest.json`) with your own GitHub slug and add-on ID before publishing.

---

## Features

- **One-click snowballing** from the Zotero item or collection context menu — or from `Tools → Snowball Sources…`.
- **Streaming review dialog** opens immediately with a spinner and populates rows as candidates arrive. **Stop** any time without losing what's already loaded.
- **Sortable, filterable table** with sticky headers, alternating row colors, and a draggable splitter between the candidate list and the per-row details/abstract pane.
- **Filters**: live text search across title/authors/venue, direction (backward/forward/both), and "hide items already in library."
- **Bulk select / deselect visible**, indeterminate header checkbox, live selection count, primary "Add Selected to Zotero" button.
- **Per-candidate add isolation** — a single bad item never rolls back the whole batch; partial-success counts (added / skipped / failed) are surfaced to the user with up to 3 reasons.
- **Resilient HTTP**: per-request timeout, exponential backoff with jitter on `408/425/429/500/502/503/504` and transient network errors, `Retry-After` honored.
- **Cybersecurity hardened**: HTTPS-only host allowlist enforced before any socket opens, `javascript:` / `data:` / `file:` URLs from API responses dropped, API keys redacted from every log line, no `innerHTML` anywhere.
- **No telemetry, no third-party SDKs, no remote logging.** The plugin only contacts the citation provider hosts you configure.

---

## Install

### From a Release (recommended)

1. Download `snowball-sources-X.Y.Z.xpi` from the [latest release](https://github.com/socratic-irony/zotero-snowball/releases/latest).
2. In Zotero, open `Tools → Add-ons`.
3. Drag the downloaded `.xpi` onto the Add-ons window (or use the gear menu → "Install Add-on From File…").
4. Restart Zotero if prompted.

Once installed and configured to point at the repo's `updates.json`, Zotero will offer updates automatically when you publish a new release.

### From source (developers)

See [Development](#development).

---

## Usage

### Snowball selected items

1. In Zotero, select one or more regular items (with DOIs ideally — items resolve more reliably with one).
2. Right-click → **Snowball Sources for Selected Item(s)**.
3. The review dialog opens immediately. You'll see "Searching…" while seeds are being resolved on OpenAlex; rows start streaming in once the first reference list comes back.
4. Sort, filter, and check/uncheck rows. Click any row to see its abstract.
5. Click **Add Selected to Zotero** when you're done.

### Snowball a whole collection

Right-click a collection → **Snowball Sources for Collection**. Same dialog; the collection's regular items become seeds.

### Tools menu

- `Tools → Snowball Sources…` — snowballs the current selection (or the active collection if no items are selected).
- `Tools → Snowball Sources Preferences…` — opens the preferences dialog.

### The review dialog

| Element                              | Behavior                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Filter box                           | Live substring filter on title / authors / venue. `⌘F` / `Ctrl+F` focuses it.             |
| Direction dropdown                   | All / Backward only / Forward only.                                                       |
| "Hide items already in library"      | Filters out candidates already present in your library.                                   |
| Column headers                       | Click to sort. Click again to flip direction. Numeric columns default to descending.      |
| Header checkbox                      | Tri-state: select/deselect every *visible* row.                                           |
| Splitter (vertical bar)              | Drag to resize the details pane. Double-click to reset.                                   |
| Stop button (during loading)         | Aborts the in-flight fetch and keeps everything that's already arrived.                   |
| Selection count (bottom-left)        | Live count of checked candidates across all filters.                                      |
| Add Selected to Zotero               | Adds + tags the checked candidates. Reports added / skipped / failed counts when done.    |

Added items are tagged automatically:
- `snowballed`
- `snowball:openalex`
- `snowball:forward` / `snowball:backward` (or both)
- `snowball:existing` for items that were already in your library and only had the new tags + collection added.

---

## Preferences

`Tools → Snowball Sources Preferences…`

| Pref name                                          | Default | Range / notes                                                |
| -------------------------------------------------- | ------- | ------------------------------------------------------------ |
| `extensions.snowballSources.openAlexAPIKey`        | `""`    | Optional. Joins OpenAlex's polite pool for higher reliability. |
| `extensions.snowballSources.semanticScholarAPIKey` | `""`    | Optional. Reserved for future enrichment; not yet called.    |
| `extensions.snowballSources.includeForward`        | `true`  | Fetch papers that **cite** each seed.                        |
| `extensions.snowballSources.includeBackward`       | `true`  | Fetch papers each seed **references**.                       |
| `extensions.snowballSources.skipAlreadyInLibrary`  | `true`  | Uncheck candidates already in library by default.            |
| `extensions.snowballSources.maxSeeds`              | `50`    | 1–500.                                                       |
| `extensions.snowballSources.maxForwardPerSeed`     | `100`   | 0–1000.                                                      |
| `extensions.snowballSources.maxBackwardPerSeed`    | `100`   | 0–1000.                                                      |
| `extensions.snowballSources.maxCandidatesTotal`    | `500`   | 1–10000. Hard cap across all seeds combined.                 |
| `extensions.snowballSources.requestTimeoutMs`      | `30000` | 1000–120000. Per-request timeout (ms).                       |

Out-of-range values are clamped on save and you'll be shown a confirmation dialog listing what was adjusted.

### API keys

API keys are stored in Zotero's prefs file like any other Zotero pref (plain text, profile-local). They are sent **only** to the host that owns them (`api.openalex.org` / `api.semanticscholar.org`) and are scrubbed from every debug-log line by the [`SnowballLog`](src/chrome/content/modules/log.js) module. The list of secret-bearing parameter names is `api_key`, `apikey`, `key`, `token`, `x-api-key`, plus any `Authorization: Bearer …` header.

---

## Privacy & security posture

This is meant to ship to scientists' machines. The plugin's posture:

- **Outbound network egress is allowlisted at the HTTP layer.** Only `api.openalex.org` and (when a key is set) `api.semanticscholar.org` can be contacted. Any other URL — including ones that arrive in API responses — throws `HOST_NOT_ALLOWED` before a socket is opened. Source: [`modules/http.js`](src/chrome/content/modules/http.js).
- **HTTPS-only.** `http://`, `javascript:`, `data:`, `file:`, and any other scheme are rejected by the same wrapper.
- **Cookies are never sent.** All requests use `credentials: "omit"`.
- **No telemetry.** No analytics, no crash reporting, no usage pings, no remote configuration. The only outbound traffic is the citation queries you initiate.
- **No third-party SDKs.** Zero npm runtime dependencies.
- **No `innerHTML`.** Every DOM node is built with `createElementNS` + `textContent`. A test guards against regressions: [`tests/package.test.js`](tests/package.test.js).
- **Provider URLs sanitized before render.** Candidate URLs from OpenAlex are dropped unless they begin with `http(s)://`, so a `javascript:` URL coming back from the API can't be saved into a Zotero item or rendered as a clickable link.
- **Per-request timeout** prevents hung connections from blocking the dialog forever.
- **Per-request retries** with exponential backoff + jitter on transient failures; honored `Retry-After`; capped retries.
- **Input limits.** Title / abstract / venue / URL strings from the API are length-clamped before they enter the candidate model so an adversarial provider can't run the UI out of memory.
- **Logs scrubbed.** API keys, bearer tokens, and known secret-bearing query params are stripped before any string reaches `Zotero.debug` or stderr.

If you find a security issue, please [open a private security advisory](https://github.com/socratic-irony/zotero-snowball/security/advisories/new) instead of a public issue.

---

## How it works

```
User → Right-click → Snowball Sources
       │
       ▼
  SnowballSourcesPlugin.runForItems() ── builds seedRecords + providerConfig
       │
       ▼
  openReviewDialog() ── opens chrome dialog non-modally, injects Zotero global
       │
       ▼
  SnowballDialog.startStreaming()
       │
       ▼
  OpenAlexProvider.streamSnowball(seeds, abortSignal)
   ├── resolves each seed (DOI lookup, then title fallback)
   ├── for each resolved seed:
   │     ├── streamBackward()  → SnowballHTTP.fetchJSON()
   │     └── streamForward()   → SnowballHTTP.fetchJSON()
   └── yields {type: "candidate", candidate} | {type: "status", message}
       │
       ▼
  SnowballDialog.ingestCandidate()
   ├── deduplicates by DOI / OpenAlex ID / title+year
   ├── runs SnowballZoteroItems.markExistingCandidate() (DOI + title search)
   ├── runs SnowballRanking.scoreCandidate()
   └── pushes into the candidates array, scheduleRefresh()
       │
       ▼
  User clicks Add Selected
       │
       ▼
  SnowballZoteroItems.addCandidates() ─ per-item try/catch inside one Zotero.DB transaction
       │
       ▼
  Reports {added, skipped, failed} back to the dialog, which alerts the user.
```

### Module map

| File                                                            | Responsibility                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`bootstrap.js`](src/bootstrap.js)                              | Zotero plugin lifecycle. Loads modules in dependency order.                 |
| [`chrome/content/snowball.js`](src/chrome/content/snowball.js)  | Top-level controller: menus, prefs, opens review/prefs dialogs.             |
| [`chrome/content/snowballDialog.{xhtml,js,css}`](src/chrome/content/) | Streaming review dialog.                                                    |
| [`chrome/content/snowballPrefs.{xhtml,js,css}`](src/chrome/content/)  | Preferences dialog with bounds-validated inputs.                            |
| [`modules/log.js`](src/chrome/content/modules/log.js)           | Centralized logger with secret-scrubbing.                                   |
| [`modules/errors.js`](src/chrome/content/modules/errors.js)     | `SnowballError` class + `formatUserError`.                                  |
| [`modules/http.js`](src/chrome/content/modules/http.js)         | Hardened fetch wrapper: timeouts, retries, host allowlist, scheme guard.    |
| [`modules/openalex.js`](src/chrome/content/modules/openalex.js) | OpenAlex provider with streaming `streamSnowball` async generator.          |
| [`modules/ranking.js`](src/chrome/content/modules/ranking.js)   | Per-candidate relevance scoring (cosine over title+abstract terms).         |
| [`modules/zoteroItems.js`](src/chrome/content/modules/zoteroItems.js) | Seed extraction, library-existence check, item creation per Zotero type.   |
| [`modules/util.js`](src/chrome/content/modules/util.js)         | Small helpers (`chunk`, `normalizeText`, `formatScore`).                    |

---

## Development

### Prerequisites

- Node.js 18+ (only used by the test runner and build script — no runtime deps).
- macOS / Linux — the build script uses `bash` and `zip`.
- A Zotero 9.0+ install. On macOS that's `/Applications/Zotero.app`.

### Quick start

```bash
git clone https://github.com/socratic-irony/zotero-snowball zotero-snowball
cd zotero-snowball
npm test                # runs the test suite (no install needed)
npm run build           # produces build/snowball-sources-X.Y.Z.xpi
npm run validate:xpi
```

### Live dev install (proxy file)

For source-edit-reload cycles without rebuilding the XPI:

1. Quit Zotero.
2. Create a development profile (Zotero `-P "Snowball Dev"`) so you don't risk your main library.
3. In that profile's `extensions/` directory, create a file named **exactly** `snowball-sources@example.com` (no extension), containing the absolute path to this repo's `src` directory:
   ```
   /Users/you/code/zotero-snowball/src/
   ```
4. Launch Zotero with debug logging on:
   ```bash
   /Applications/Zotero.app/Contents/MacOS/zotero \
     -P "Snowball Dev" -ZoteroDebugText -jsconsole
   ```

Zotero will load the plugin straight from `src/` on each startup. After most code changes you only need to restart Zotero — no rebuild step.

### Testing

```bash
npm test
```

The test suite uses Node's built-in test runner (`node --test`). It covers:

- **Bootstrap & lifecycle** — chrome registration, module load order, menu registration / unregistration.
- **Manifest & XPI shape** — required Zotero metadata, asset references resolve, no `innerHTML`, no off-chrome assets.
- **Plugin controller** — menu wiring, l10n IDs match Fluent file, dialog opens with chrome URL.
- **Provider** — candidate normalization, abstract reconstruction, deduplication, direction merging.
- **Ranking** — overlap preference, duplicate penalty, abstract penalty.
- **Item helpers** — seed extraction, OpenAlex → Zotero type mapping.
- **Security & robustness** — log scrubbing (URLs, bearer tokens, error stacks), HTTPS-only enforcement, host allowlist, error-class wrap behavior.

Add new tests in `tests/*.test.js`.

### Linting / static checks

The build script runs `python3 -m json.tool` on `manifest.json` and `xmllint` on the dialog XHTML. Run them ad-hoc:

```bash
python3 -m json.tool src/manifest.json
xmllint --noout src/chrome/content/snowballDialog.xhtml
xmllint --noout src/chrome/content/snowballPrefs.xhtml
```

---

## Releasing

The release pipeline is automated via GitHub Actions. **Maintainer flow:**

1. Make sure `main` is green:
   ```bash
   npm test && npm run build && npm run validate:xpi
   ```
2. Bump the version everywhere (this also enforces the semver shape):
   ```bash
   ./scripts/bump-version.sh 0.2.1
   ```
3. Update [`CHANGELOG.md`](CHANGELOG.md) under a new heading.
4. Commit and tag:
   ```bash
   git add -A
   git commit -m "Release 0.2.1"
   git tag v0.2.1
   git push --follow-tags
   ```
5. The [`release.yml`](.github/workflows/release.yml) workflow will:
   - Run tests.
   - Build the XPI.
   - Create a GitHub Release for the tag.
   - Upload `snowball-sources-X.Y.Z.xpi` as a release asset.
   - Regenerate `updates.json` and commit it back to `main`.

Zotero clients will pick up the new version automatically because `src/manifest.json#applications.zotero.update_url` points at the repo's raw `updates.json`.

### One-time setup before your first release

1. **Set the real add-on ID** in [`src/manifest.json`](src/manifest.json) (`applications.zotero.id`) — pick something stable like `snowball-sources@yourname.org`. The pref branch (`extensions.snowballSources.*`) does not need to change.
2. **Set the real update URL** in `src/manifest.json#applications.zotero.update_url` to:
   ```
   https://raw.githubusercontent.com/socratic-irony/zotero-snowball/main/updates.json
   ```
3. **Replace `socratic-irony/zotero-snowball`** in this README's badges and links.
4. **Allow Actions to commit back to the repo**: `Settings → Actions → General → Workflow permissions → "Read and write permissions"`. Required for `release.yml` to update `updates.json`.

---

## Contributing

Issues and PRs welcome. Before opening a PR:

- Run `npm test`.
- Add a test for any behavior change in `src/chrome/content/modules/*.js`.
- Don't introduce runtime dependencies — this plugin is intentionally zero-dep.
- Don't introduce `innerHTML` — the security test will fail and so will review.
- If you add a new outbound host, add it to `SnowballHTTP.ALLOWED_HOSTS` and to this README's privacy section.

For larger changes (new providers, ranking models, UI restructures), please open an issue first to discuss.

---

## License

[MIT](LICENSE) © contributors. OpenAlex data is provided under [CC0](https://docs.openalex.org/additional-help/faq#how-is-the-data-licensed). This plugin's source is independent of OpenAlex and Zotero.

---

## Acknowledgements

- [OpenAlex](https://openalex.org) for the open scholarly graph that makes this whole thing possible.
- [Semantic Scholar](https://www.semanticscholar.org) for the future-enrichment endpoint.
- The [Zotero plugin developer docs](https://www.zotero.org/support/dev/zotero_7_for_developers) and the official [`make-it-red`](https://github.com/zotero/make-it-red) sample.
