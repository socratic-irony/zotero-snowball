# Exhaustive Parallel Snowballing Design

## Goal

Make exhaustive citation snowballing the default while retaining an opt-in early-stop mode, increase the opt-in result limit to 1,000 papers, parallelize OpenAlex work safely, require users to supply their own OpenAlex credentials, and audit public repository history for accidental credential exposure.

## Product semantics

The review dialog will expose two search modes:

- **Exhaustive** is the default. It ignores the old global and per-seed acquisition caps, hydrates every backward reference returned by each resolved seed, and follows every forward-citation cursor until OpenAlex reports that no next page remains. The existing Stop control remains the manual termination mechanism.
- **Limit results** is opt-in. It stops the entire crawl as soon as the dialog accepts the configured number of unique candidates. The default limit is 1,000. This preserves the current fast, bounded behavior, but it is explicitly an early-stop sample rather than a guarantee of the globally highest-ranked papers.

Direction filters remain independent. Disabling forward or backward traversal still prevents that class of request. Existing saved per-seed limit preferences may remain readable for compatibility, but exhaustive mode must not silently honor them. The preferences UI and documentation will present one understandable total-result limit rather than competing acquisition caps.

## Concurrent crawler

`OpenAlexProvider.streamSnowball()` will become a producer/consumer pipeline backed by small in-repository async queues rather than unbounded `Promise.all()` calls.

Seed resolution, backward-reference chunks, and forward-citation cursor chains become work items. Up to 20 workers may execute request-bearing work concurrently. A resolved seed immediately emits its trimmed seed context and schedules its citation work; the crawler does not wait for every seed to resolve before displaying papers. Backward references are hydrated in OpenAlex's maximum 100-ID batches. Forward chains fetch 100 results per request and requeue their next cursor so multiple seeds make fair progress.

Workers publish status, seed, and candidate events into a single async event queue consumed by the existing dialog loop. The consumer remains the serialization point for deduplication, local-library checks, scoring, and unique-candidate counting. In capped mode, reaching the unique-paper limit aborts the shared controller. Queued work is discarded, in-flight fetches are canceled, and later results are ignored. In exhaustive mode, the queue closes only when no queued or active work remains.

Result arrival order becomes nondeterministic. That does not change ranking or selection semantics because every row is scored independently and the dialog already supports explicit sorting. Tests will use controlled deferred responses rather than timing assumptions.

## Rate limiting, retries, and failure behavior

Twenty concurrent workers will be paired with a shared OpenAlex request gate. The gate will cap request starts below OpenAlex's documented 100 requests per second, so fast responses cannot turn 20 concurrent requests into an unsafe request rate. It will also maintain a shared `blockedUntil` time for provider throttling.

Every attempt, including retries, passes through the same gate. On `Retry-After` or an unambiguous OpenAlex throttle response, all workers pause together. Retry delays use bounded exponential backoff with jitter. `Retry-After` accepts both delta-seconds and HTTP-date forms. The current timeout and abort behavior remains intact.

Authentication failures are not blindly retried. A `401`, or a `403` without rate-limit evidence, becomes a clear user-facing credential error. A `403` carrying rate-limit evidence and transient `408`, `425`, `429`, and `5xx` responses use the shared retry path. When headers show that a daily allowance is exhausted, the crawl stops with a useful message rather than repeatedly consuming retry budget.

The dialog will report found-paper count plus queued and active work while loading. Partial results remain available after a provider error or manual stop.

## Credential handling

The distributed source will contain no OpenAlex credential. `extensions.snowballSources.openAlexAPIKey` keeps an empty default and a password-style, autocomplete-disabled preference input. Starting a crawl without a configured key will be blocked before network traffic with instructions for obtaining and entering a personal key. The first provider authentication failure will point users back to Preferences.

The key remains profile-local and is added only to `api.openalex.org` requests. Existing URL/context redaction remains mandatory. Tests will verify empty distributable defaults, password input behavior, absence of credential-like literals, host scoping, and redaction.

## Public-history credential audit

A separate read-only audit will fetch the public GitHub refs and scan every reachable commit and tag, not only the current checkout. It will inspect additions and historical blobs for OpenAlex key parameters, key-like environment assignments, non-placeholder preference defaults, and high-entropy credential candidates. Any suspected match will be reported by commit and path without reproducing the secret.

The audit will not rewrite history or rotate credentials. If a real key is found, the immediate recommendation is revocation/rotation; history cleanup requires a separate explicit authorization because it is disruptive to collaborators and forks.

## Testing and verification

Focused tests will cover:

- exhaustive cursor traversal and complete backward batching;
- opt-in termination at exactly N unique candidates with a default of 1,000;
- at most 20 concurrent crawl workers and a request-start rate below the provider ceiling;
- out-of-order streaming, deduplication, direction merging, and fair cursor requeueing;
- shared `Retry-After` pauses, exponential backoff, cancellation during a pause, and terminal credential/budget errors;
- missing-key UX and distributable-source credential hygiene;
- progress and Stop behavior with queued and active work; and
- the complete existing test, lint, typecheck, build, and XPI validation suite.

The implementation will be divided into independently reviewable branches for search-mode UX and credentials, crawler concurrency, HTTP rate coordination, and the read-only public-history audit. An integration pass will combine the implementation commits, resolve any boundary mismatches, run the full verification suite, and report findings.
