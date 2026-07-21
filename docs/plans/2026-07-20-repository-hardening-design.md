# Repository Hardening Design

**Date:** 2026-07-20

## Goal

Bring the Zotero Snowball Sources add-on to a production-ready baseline by fixing the toolbar artwork, hardening network and imported-data boundaries, correcting provider behavior, improving candidate matching and rendering performance, and closing the most visible accessibility, localization, documentation, and test gaps identified in the repository review.

## Constraints

- Preserve the existing zero-runtime-dependency architecture.
- Remain compatible with Zotero 7 through 9 and the current privileged chrome/XUL environment.
- Do not change the user's existing untracked security report.
- Treat network responses and PDF locations as untrusted input.
- Make all behavior changes test-first.
- Keep the installed add-on's defaults privacy-preserving: provider calls require the relevant configuration and automatic PDF downloads are opt-in.

## Design

### 1. Native toolbar icon system

Replace the opaque 16 px raster toolbar asset with a hand-redrawn 20×20 monochrome SVG. The icon will use `context-fill` so Zotero can apply native light, dark, hover, and disabled colors, with a transparent canvas and geometry weighted similarly to Zotero's adjacent toolbar icons. CSS will use the native 20 px size and expose the SVG context properties.

The same canonical vector will produce transparent 48 px and 96 px add-on artwork for the manifest. Obsolete duplicate toolbar rasters will be removed. Asset tests will verify dimensions, transparency, SVG paint behavior, and that runtime references resolve.

### 2. Bounded and revalidated network boundary

`SnowballHTTP` will handle redirects manually. Every redirect target must independently pass the HTTPS provider-host allowlist, and redirect chains will have a small fixed limit. Provider response bodies will be read through a byte-limited path, JSON structures will have depth/node limits, and abort listeners will be cleaned up.

Automatic PDF attachment retrieval will default to off. When enabled, candidate PDF URLs must be public HTTPS destinations; loopback, link-local, private, and other non-public literal IP ranges will be rejected before Zotero is asked to download them. Documentation will explicitly distinguish provider metadata traffic from opt-in publisher PDF traffic.

### 3. Provider correctness and bounded normalization

Semantic Scholar requests will explicitly ask for SPECTER2 embeddings. A single-provider request queue will serialize authenticated requests and enforce the documented minimum interval, including concurrent callers. Embeddings must contain a bounded number of finite values.

OpenAlex normalization will cap author counts, string lengths, abstract positions, and reconstructed output. Location merging will retain the best usable public metadata and open-access PDF rather than losing one when the preferred location lacks it.

### 4. Candidate data pipeline

Extract candidate storage/deduplication from the dialog controller so merge and scoring behavior can be unit-tested independently. Duplicate merges will combine richer metadata and immediately recompute ranking. Existing-library detection will require corroborating year or creator metadata for title-only matches, will cache repeated lookups, and will apply provider/direction tags consistently.

Seed resolution and citation retrieval will be pipelined with a small bounded worker pool so the first results can appear before every seed resolves. Fuzzy-duplicate work will use bounded, indexed buckets rather than an unbounded same-year scan.

### 5. Dialog rendering, accessibility, and localization

Extract table rendering from the controller and keep a keyed row cache so streaming updates reuse DOM nodes. Render a bounded visible window with progressive expansion instead of recreating thousands of rows on each refresh. Sorting/filtering changes may rebuild the visible window, while ordinary streaming updates remain batched.

Remove inline XUL event handlers in favor of explicit listeners. Make sortable headers keyboard-operable with `aria-sort`, rows keyboard-selectable, the splitter adjustable by keyboard with value semantics, and the progress overlay modal and labelled. Move user-visible dialog and preference strings to Fluent. API-key fields will use password semantics with autocomplete disabled.

### 6. Documentation and verification

Update the README and project notes to match current behavior: Semantic Scholar support, OpenAlex's current key/budget model, the actual add-on ID used for proxy authorization, Node 20+, opt-in PDF privacy implications, and the current roadmap. Add focused regression tests for every bug and behavior above, then run the complete lint/format/type/test/manifest/build/XPI validation suite.

## Error handling

Rejected redirects, oversized responses, excessively nested JSON, invalid embeddings, and unsafe PDF URLs will fail with stable `SnowballError` codes or safe null results as appropriate. Provider failures remain non-fatal to the overall review flow when the existing controller already supports partial results.

## Compatibility and rollout

No migration is required. Existing users retain their configured keys and ranking weights. The only default behavior change is safer: automatic PDF downloads become disabled until the user explicitly enables them. The implementation remains a single XPI with no added runtime packages.
