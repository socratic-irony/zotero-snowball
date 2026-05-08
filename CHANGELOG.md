# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/socratic-irony/zotero-snowball/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/socratic-irony/zotero-snowball/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/socratic-irony/zotero-snowball/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/socratic-irony/zotero-snowball/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/socratic-irony/zotero-snowball/compare/v0.1.3...v0.1.6
[0.1.3]: https://github.com/socratic-irony/zotero-snowball/compare/v0.1.0...v0.1.3
[0.1.0]: https://github.com/socratic-irony/zotero-snowball/releases/tag/v0.1.0
