# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.3] – 2026-05-10

### Changed
- `applications.zotero.update_url` now includes `?v=%ITEM_VERSION%` so
  the URL Zotero polls is unique per installed version. This means
  every version upgrade naturally bypasses Firefox's and
  raw.githubusercontent.com's HTTP caches — users won't be told "no
  new updates found" for up to 5 minutes after each release any
  longer. (Existing 0.5.2-and-earlier installs will pick up the new
  URL after they upgrade once.)

## [0.5.2] – 2026-05-10

### Fixed
- Toolbar button now lands in the **action-button group** (next to Add
  Item / Lookup / Add Attachment / Add Note) instead of being appended
  past the spacer-and-search-box and getting clipped at the right
  edge. We now `insertBefore` the first `<spacer>` inside
  `zotero-items-toolbar`; if no spacer is present we fall back to
  appending.

## [0.5.1] – 2026-05-10

### Fixed
- **Toolbar button now actually appears.** In 0.5.0 the button targeted
  ids that don't exist in Zotero 9's chrome (`zotero-tb`,
  `zotero-toolbar`, `main-toolbar`). The correct container is
  `zotero-items-toolbar` (the hbox inside `zotero-toolbar-item-tree`
  that holds Add Item / Lookup / Add Note). Updated the candidate list
  to look there first.
- **Icon now renders.** Zotero's `.zotero-tb-button` styling ignores
  the legacy `image=` attribute and keys its icons to CSS rules
  selected on the button's `id`. We now inject a one-rule stylesheet
  that points the new button at
  `chrome://snowball-sources/content/icons/toolbar-16.png`. The icon
  was also mirrored under `chrome/content/icons/` so it's reachable
  via the registered chrome content URL. The injected stylesheet is
  cleaned up alongside the button on plugin shutdown.

## [0.5.0] – 2026-05-10

### Added
- **Auto PDF retrieval on add.** When OpenAlex returns a
  `best_oa_location.pdf_url` for a candidate (open-access works), the
  plugin now kicks off `Zotero.Attachments.importFromURL` for each new
  item right after the bulk-add transaction commits. Downloads run in
  the background — the dialog closes immediately and Zotero's own
  notifier shows progress. Failures are logged via SnowballLog but
  don't roll back the item. New pref
  `extensions.snowballSources.downloadPDFs` (default `true`) toggles
  the behavior. The completion toast reports the count:
  "Added 5 items; downloading 3 PDFs in the background."
- **Column visibility prefs.** Show or hide any of the six
  non-essential columns (Score / Direction / Status / Year / Authors /
  Venue / Cited By) — Title is always shown. Configured in the new
  "Columns" section of `Tools → Snowball Sources Preferences…` and
  applied on next dialog open. Backed by individual prefs under
  `extensions.snowballSources.columns.*` so they sync per-profile.
- **Toolbar button + keyboard shortcut.** Snowball now lives on
  Zotero's main toolbar (using the project icon, scaled to 16/32 px
  for HiDPI) with a `⌘⇧S` / `Ctrl+Shift+S` keyboard shortcut. The
  button and shortcut run "Snowball Sources for Selected Item(s)"
  exactly as the right-click and Tools menu items do. Both are
  cleaned up on plugin shutdown. Falls back silently if Zotero's
  expected toolbar/keyset ids aren't present in this version.

### Changed
- `SnowballZoteroItems.addCandidates()` signature gained an optional
  `opts` object (`{ downloadPDFs }`); the return value gained a
  `downloadsStarted` count. Tests still cover the prior shape.

## [0.4.2] – 2026-05-08

### Changed
- Score breakdown moved from a floating tooltip to an inline **"Why
  this score?"** section at the bottom of the details pane. The
  tooltip approach rendered unreliably in Zotero's chrome window
  (positioned in the wrong place, sometimes outside the dialog).
  The inline panel is always visible, fits the existing layout, is
  keyboard-friendly without any extra wiring, and styles negative
  contributions in red so penalties are obvious.

## [0.4.1] – 2026-05-08

### Removed
- Year-range histogram. The brushable mini-chart felt visually noisy and
  wasn't pulling its weight in the toolbar; the year filter sub-toolbar
  is gone with it. Sort-by-year and the existing text filter cover the
  same intent without the extra UI surface.

### Changed
- **Min cited-by** input moved up into the main toolbar row alongside
  the other filters and made narrower (56 px). Same behavior as before.
- **Score breakdown tooltip** now renders as a styled definition list
  instead of relying on the native `title` attribute (which wasn't
  showing reliably in Zotero 9's chrome window). Keyboard-reachable —
  focus a score badge and the tooltip appears, blur dismisses.
  Positioned relative to the dialog body and clamped inside it so it
  never overflows the window.

## [0.4.0] – 2026-05-08

### Added — review dialog
- **Year-range histogram** in a new sub-toolbar below the main filter row.
  Inline SVG bar chart of candidates-per-year with two draggable handles
  for brushing a range. The histogram self-hides until at least two
  distinct years are present, re-renders on every refresh, and a Reset
  button restores the full range.
- **Min cited-by filter** in the sub-toolbar — runtime numeric input
  that hides candidates below the threshold. Default seeded from a new
  `extensions.snowballSources.minCitedBy` pref (also bounded in the
  prefs UI).
- **Score-cell tooltip**: hovering any score badge now shows a
  per-signal breakdown (text, bib coupling with raw count, co-citation
  with seed-hit count, author overlap, title fuzzy, citation, S2
  embedding, plus any active penalties/bonuses). Pulled from the
  `_scoreBreakdown` already stored on each candidate.
- **Clickable DOI / OpenAlex link** in the details pane. Uses
  `Zotero.launchURL` so the link opens in the user's external browser
  (per Zotero's UX rules) rather than inside the chrome dialog.
- **Window-state persistence**: window size + splitter offset are saved
  to `extensions.snowballSources.uiState` (debounced on resize, written
  on splitter drag-end and on dialog unload) and restored next time the
  dialog opens.

### Added — preferences
- **Score weight sliders** for all 7 signals (text, bibliographic
  coupling, co-citation, author overlap, title fuzzy match, citation,
  Semantic Scholar embedding). Range 0.00–2.00, step 0.05. Defaults
  shown in the label; live numeric readout to the right; "Reset to
  defaults" button.
- **Default min cited-by** pref input (0–100000).

### Changed
- `SnowballRanking.buildSeedContext()` now accepts an `{weights}` option
  bag. The dialog reads the user's per-signal weight prefs and threads
  them through the seed context so re-runs after changing weights take
  effect immediately on the next snowball.
- Preferences dialog grew from 520×520 to 600×720 to fit the new
  sliders.

### Tests
- Added a test covering custom weight overrides through `buildSeedContext`.
  47/47 passing.

## [0.3.1] – 2026-05-08

### Changed
- Replaced every `window.alert` / `window.confirm` call (which rendered
  with the ugly "[JavaScript Application]" window header) with in-dialog
  UI:
  - Review dialog: a styled toast at the top of the body area —
    success / warning / error variants, optional action button, auto-
    dismiss for the happy path. The successful "Added N items" message
    now closes the dialog cleanly after a 2.2-second confirmation
    instead of popping a modal alert.
  - Partial-failure flow: toast with a **View details** button that
    opens an in-dialog overlay listing every failed item with its
    reason. Esc or click-outside dismisses.
  - Prefs dialog: when input is clamped on save, the diff appears as
    an inline panel and the primary button switches to **Save anyway**
    instead of popping a confirm dialog. Editing any input resets the
    flow.
- Full dark-mode audit. Every hardcoded "always light" hex color in the
  pills, score badges, dividers, and prefs surfaces is now driven by
  `light-dark()` pairs (with Zotero's `--material-*` / `--fill-*`
  tokens taking precedence when they're defined). `color-scheme: light
  dark` is declared on both dialog roots so native form controls follow
  the active theme. Direction / status / score pills picked dark-mode
  variants tuned for AA contrast on a dark surface.

### Added
- `tests/package.test.js` now guards against future regressions of
  `window.alert/confirm/prompt` in the dialog or prefs scripts.

### Verified
- 46/46 tests pass (was 45).

## [0.3.0] – 2026-05-08

### Added — relevance ranking overhaul
- **Bibliographic coupling** signal: each candidate's score now includes the
  multiplicity-weighted size of its reference-list intersection with the
  combined references of the seed pool. Saturated at 20 shared refs to
  keep survey papers from dominating.
- **Co-citation** signal: scores reflect how many of the seeds reference
  the candidate (`coCitationRaw / seedCount`), so a candidate cited by 4
  of 5 seeds outranks one cited by 1 of 5.
- **Author overlap** signal: fraction of the candidate's authors who also
  appear in the seed pool (normalized: case + diacritic-folded).
- **Title trigram Jaccard** signal: best similarity vs. any seed title
  using length-3 character n-grams. Catches paraphrased titles in the
  ranking.
- **Fuzzy title dedupe**: same trigram-Jaccard mechanism, with a 0.85
  threshold and a year-bucket index, now catches paraphrased duplicates
  during ingest that exact DOI/title dedupe missed.
- **Semantic Scholar SPECTER2 enrichment**: when (and only when) the user
  has set `extensions.snowballSources.semanticScholarAPIKey`, the dialog
  fetches embeddings for seeds + candidates after streaming completes,
  computes the seed centroid, and mixes per-candidate cosine similarity
  into the composite score (weight 0.40 — the highest single signal).
- **Score breakdown** is persisted on each candidate (`_scoreBreakdown`)
  for a future "explain why this scored high" tooltip and for tuning.

### Added — infrastructure
- New `modules/semanticscholar.js` with batch endpoint client, key gating,
  and partial-success tolerance (a failed chunk doesn't kill the run).
- New `SnowballUtil` helpers: `trigrams`, `jaccardSets`, `cosineDense`,
  `normalizeAuthorName`, `shortOpenAlexID`.
- HTTP wrapper now supports `POST` + body for the S2 batch endpoint.
- `OpenAlexProvider.streamSnowball` now emits `seed-resolved` events
  carrying the resolved Work's `referenced_works` so the dialog can
  build the seed signature incrementally.
- 14 new tests covering the new ranking signals, the trigram/Jaccard
  utilities, and the S2 gating contract (no key → no traffic, verified
  with a fetch-call counter).

### Changed
- Composite ranking: text cosine baseline (weight 1.0) is preserved; new
  signals add up to ~0.63 in additional weight, with the optional
  embedding signal adding another 0.40 when available. Penalties
  (abstract / duplicate-in-library / direction-both) unchanged.

### Privacy
- Semantic Scholar is contacted **only** when an API key is configured.
  No background calls, no anonymous use. The key travels in the
  `x-api-key` header (never in the URL) so it never appears in any log
  even before the scrubber runs.

## [0.2.1] – 2026-05-08

### Changed
- Bumped CI/release GitHub Actions to current majors so the workflows stop
  running on the deprecated Node 20 runtime:
  `actions/checkout@v6`, `actions/setup-node@v6`, `actions/upload-artifact@v7`,
  `softprops/action-gh-release@v3`.
- Workflows now use Node 22 (current LTS) for tests and the build step;
  `engines.node` raised to `>=20`.

### Verified
- End-to-end auto-update path: install 0.2.0, push v0.2.1 tag, confirm Zotero
  picks up the upgrade through its own update mechanism (no manual XPI
  download).

## [0.2.0] – 2026-05-07

### Added
- Hardened HTTP client (`SnowballHTTP`): HTTPS-only host allowlist, per-request
  timeout, exponential backoff with jitter on retryable status codes and
  network errors, `Retry-After` honored, body capped in error context.
- Centralized logger (`SnowballLog`) that scrubs API keys, bearer tokens, and
  known secret-bearing query parameters from every line before they reach
  `Zotero.debug`.
- Typed error class (`SnowballError`) with `{code, userMessage, cause, context}`
  and a `formatUserError()` helper for safe end-user messages.
- Per-candidate add isolation: a single bad item no longer rolls back the whole
  bulk-add transaction. Returns `{added, skipped, failed}` with reasons.
- Bounds-validated preferences UI: clamps numbers, truncates over-long strings,
  strips newlines from API keys, and confirms adjustments before saving.
- New pref `extensions.snowballSources.requestTimeoutMs` (default 30000).
- Test suite for security-critical behavior (URL/scheme/host validation, log
  scrubbing, error wrapping).

### Changed
- Dialog drives the OpenAlex stream itself instead of receiving pre-computed
  candidates, so the UI opens immediately, populates progressively, and
  supports a Stop button.
- Modules moved to `chrome/content/modules/` so they're loadable from both
  bootstrap and the dialog window via `chrome://` URLs.
- `OpenAlexProvider` clamps every limit at construction; trims whitespace from
  the API key; validates response shape; truncates user-controlled strings;
  drops non-`http(s)` URLs returned by the provider.
- Bulk-add now logs each per-candidate failure via `SnowballLog.warn` with
  scrubbed context.

### Security
- Outbound requests are now restricted to an allowlist of hosts at the HTTP
  layer (`api.openalex.org`, `api.semanticscholar.org`); any other URL throws
  before a socket is opened.
- All requests use `credentials: "omit"` so cookies are never sent.
- Candidate URLs from the provider are dropped unless they begin with
  `http(s)://`.
- API keys are never logged.

## [0.1.6] – 2026-05-07

### Added
- Sortable column headers with arrow indicators.
- Tri-state header checkbox for select-all-visible.
- Live filter (text, direction dropdown, hide-already-in-library).
- Draggable splitter between table and details pane (double-click to reset).
- Visual pills for direction and status; color-coded score badges.
- Bottom footer with selection count and primary "Add Selected to Zotero" button.
- Alternating row colors.

### Fixed
- `'publicationTitle' is not a valid field for type 'book'` — venue field is now
  mapped per Zotero item type, with `safeSetField()` swallowing
  field-validity errors.

## [0.1.3] – 2026-05-07

### Fixed
- Blank-window bug: removed `style="display: flex"` and `data-l10n-id` from the
  XUL window root, switched to absolute `chrome://` asset URLs, added a
  try/catch around the dialog's `onload` handler.

## [0.1.0] – 2026-05-07

Initial MVP per [`spec.md`](spec.md).

[Unreleased]: https://github.com/socratic-irony/zotero-snowball/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/socratic-irony/zotero-snowball/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/socratic-irony/zotero-snowball/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/socratic-irony/zotero-snowball/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/socratic-irony/zotero-snowball/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/socratic-irony/zotero-snowball/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/socratic-irony/zotero-snowball/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/socratic-irony/zotero-snowball/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/socratic-irony/zotero-snowball/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/socratic-irony/zotero-snowball/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/socratic-irony/zotero-snowball/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/socratic-irony/zotero-snowball/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/socratic-irony/zotero-snowball/compare/v0.1.3...v0.1.6
[0.1.3]: https://github.com/socratic-irony/zotero-snowball/compare/v0.1.0...v0.1.3
[0.1.0]: https://github.com/socratic-irony/zotero-snowball/releases/tag/v0.1.0
