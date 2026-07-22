# OpenAlex credential history audit

Audit date: 2026-07-21

Repository: `socratic-irony/zotero-snowball`

Status: **No credible OpenAlex credential exposure found in the scanned public history.**

## Coverage

The audit used the current local public refs after the already-completed fetch. No
additional fetch, history rewrite, key revocation, push, or source change was
performed.

Scanned refs:

- `refs/remotes/origin/HEAD`
- `refs/remotes/origin/main`
- `refs/remotes/origin/dependabot/github_actions/actions/checkout-7.0.1`
- `refs/remotes/origin/dependabot/github_actions/actions/setup-node-7.0.0`
- `refs/remotes/origin/dependabot/npm_and_yarn/eslint-10.7.0`
- `refs/remotes/origin/dependabot/npm_and_yarn/eslint/js-10.0.1`
- `refs/remotes/origin/dependabot/npm_and_yarn/globals-17.7.0`
- `refs/remotes/origin/dependabot/npm_and_yarn/lefthook-2.1.10`
- `refs/remotes/origin/dependabot/npm_and_yarn/prettier-3.9.6`
- Tags `v0.2.0` through `v0.5.6` (14 annotated tags)

The ref set contains 51 distinct reachable commits, 476 reachable Git objects,
425 path-bearing object entries, and 239 blobs (232 text blobs and 7 binary
blobs; 3,213,843 blob bytes).

## Methods

All methods were local and metadata-only at output time:

1. Enumerated reachable commits, trees, blobs, and paths from every listed
   `origin/*` ref and tag with Git's object database commands.
2. Scanned every reachable text blob for OpenAlex-specific key names, API-key
   assignments, query parameters, contact-mail markers, and credential-shaped
   literals.
3. Scanned all 7 binary blobs bytewise for the same OpenAlex/key markers; none
   matched.
4. Scanned all 51 commits' diffs, including the one merge commit against each
   parent, with values retained only in process memory and never emitted.
5. Ran historical `git grep -I -i -l` over each reachable commit and
   `git log -G` keyword searches. These commands emitted only commit/path
   metadata during review.
6. Ran a high-entropy token pass over all reachable blobs using a Shannon
   entropy threshold of 3.5. It examined 11,524 tokens, including 10,088 above
   the threshold and 147 hash-like tokens; none occurred as a credible OpenAlex
   credential.

## Sanitized findings

The keyword searches intentionally produced expected false positives in source
modules, preference/controller UI, README/specification documentation, and
tests. The historical grep found 613 commit/path matches across 13 paths; the
matches were field names, code expressions, empty defaults, documentation
examples, test fixtures, generic API-key test literals, or contact-mail text.

The value-aware blob and merge-aware diff classifiers found:

- 0 credible OpenAlex-key candidates;
- empty defaults and documentation/test placeholders only where a literal was
  present;
- no non-empty OpenAlex-specific literal in source/configuration history; and
- no OpenAlex-specific marker or key assignment in binary blobs.

No credential value, partial value, hash of a suspected value, or reversible
fragment is included in this report.

## Limitations

- `gitleaks` was not installed. The installed legacy Python `trufflehog`
  automatically attempted a fetch and aborted before scanning because the
  worktree metadata is restricted; it was not rerun and its output was not used
  as evidence.
- A direct `git ls-remote --heads --tags origin` cross-check could not resolve
  `github.com` in the shell sandbox. The public GitHub repository page confirms
  the repository is public and identifies `main` as the default branch, but its
  cached history count was older than the fetched local refs. Accordingly, this
  audit's exact coverage claim is limited to the current local `origin/*` refs
  and tags listed above.
- This is a static history audit. It does not inspect provider-side logs,
  workstation credential stores, unreachable Git objects, or refs that were not
  present locally at audit time.

## Result

Based on the scanned public refs, reachable commits/diffs/blobs, keyword
searches, bytewise binary scan, and high-entropy pass, no immediate OpenAlex
credential rotation is indicated by this history audit.
