# Security Audit Remediation Design

**Date:** 2026-07-21
**Target release:** 0.5.6
**Source:** Security and Improvement Review findings S1-S8

## Goal

Resolve every finding from the security review without broad refactors, preserve Zotero 9 behavior, and publish the result as eight reviewable remediation commits plus one release commit.

## Approaches considered

1. **One atomic commit per finding (selected).** This gives each security boundary its own regression test, makes review and rollback precise, and matches the requested history. Some files recur, so implementation is serialized.
2. **Severity waves.** Ship S1-S2 first and defer hardening. This would reduce immediate risk sooner but would not satisfy the request to produce all fixes.
3. **One consolidated hardening change.** This would minimize workflow overhead but make regressions, review, and rollback harder.

## Design

### Network boundaries

- S1 adds a dedicated attachment URL validator at the final Zotero import boundary. Automatic PDF retrieval becomes opt-in. Only HTTPS destinations are accepted; localhost, loopback, link-local, private IPv4, unique-local/private IPv6, and IPv4-mapped IPv6 literals are rejected. The README will distinguish allowlisted citation API traffic from optional publisher PDF traffic.
- S2 changes provider JSON requests to manual redirect handling and rejects every redirect response. This keeps credentials and requests inside the existing provider host allowlist and prevents a second fetch.

### Provider input bounds

- S3 bounds abstract reconstruction before array allocation/assignment, ignores malformed positions, clamps tokens, and stops processing after fixed budgets.
- S4 caps normalized authors at 100 and clamps every display/first/last name before candidates reach UI or Zotero item creation.

### Chrome UI and logging

- S5 renders API keys as password inputs with autocomplete disabled. This is display hardening only; profile-local storage semantics remain documented.
- S6 removes XHTML `onload`, `oncommand`, and `onclick` attributes. Existing lifecycle and button behavior moves to `addEventListener` calls in the corresponding scripts, guarded by a package-level regression test.
- S7 recursively scrubs structured log values. Secret-bearing keys are redacted regardless of value type; strings are scrubbed at every nesting level; depth and cycle guards prevent the logger becoming a denial-of-service path.

### Supply chain

- S8 pins every external action in CI and release workflows to a verified 40-character upstream commit SHA with a version comment. Dependabot will check GitHub Actions and npm weekly. Static tests reject future floating action refs.

## Error handling and compatibility

Rejected attachment URLs fail closed by skipping only that background attachment, never the parent Zotero item. Redirect responses surface as the existing structured Snowball error type. Invalid provider fields are ignored or truncated, preserving valid records. Event wiring retains XUL `command` events for XUL buttons and `click` for HTML buttons.

## Verification

Each behavioral finding follows red-green-refactor with a focused test. After all commits, run `npm run check`, build and validate the XPI, inspect the full diff against `origin/main`, and run a separate whole-series security/code review. The release commit bumps `package.json` and `src/manifest.json` to 0.5.6 and adds dated changelog notes before tagging `v0.5.6`.
