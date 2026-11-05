/* global SnowballLog */

/**
 * Domain-specific error classes used by Snowball Sources.
 *
 * Each error carries:
 *   - `code`: stable machine-readable identifier ("HTTP_TIMEOUT", "BAD_RESPONSE", …)
 *   - `userMessage`: short string we are happy to surface to the end user
 *   - `cause`: original underlying error if any
 *   - `context`: structured details for the debug log (already scrubbed by SnowballLog)
 *
 * The user-facing string never includes URLs, stack traces, or any value
 * that could carry an API key.
 */
var SnowballError = class extends Error {
  constructor(code, userMessage, { cause = null, context = null } = {}) {
    super(userMessage);
    this.name = "SnowballError";
    this.code = code;
    this.userMessage = userMessage;
    this.cause = cause;
    this.context = context;
  }

  /**
   * Wrap a thrown value so any unexpected error is still typed and safe to
   * show to the user. AbortError is preserved (callers want to detect it).
   */
  static wrap(error, code, userMessage, context) {
    if (error?.name === "AbortError") return error;
    if (error instanceof SnowballError) return error;
    return new SnowballError(code, userMessage, { cause: error, context });
  }

  /**
   * Check the configured OpenAlex key before any request is made. Returns a
   * user-facing message when the key is missing or is obviously not a key
   * (an email address, which OpenAlex used to accept as `mailto` but always
   * rejects as `api_key`), or "" when it is worth sending.
   */
  static openAlexKeyProblem(rawKey) {
    const key = String(rawKey || "").trim();
    if (!key) {
      return (
        "Enter your OpenAlex API key in " +
        SnowballError.OPENALEX_KEY_LOCATION +
        " before searching. Get a free key at " +
        SnowballError.OPENALEX_KEY_URL +
        "."
      );
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) {
      return (
        "The OpenAlex API key setting contains an email address, not an API key. " +
        "OpenAlex no longer accepts an email in place of a key. Get a free key at " +
        SnowballError.OPENALEX_KEY_URL +
        " and paste it in " +
        SnowballError.OPENALEX_KEY_LOCATION +
        "."
      );
    }
    return "";
  }

  static openAlexCredentials(context) {
    return new SnowballError(
      SnowballError.CODES.OPENALEX_CREDENTIALS,
      "OpenAlex did not recognize your API key. Copy your key from " +
        SnowballError.OPENALEX_KEY_URL +
        " and paste it in " +
        SnowballError.OPENALEX_KEY_LOCATION +
        ".",
      { context }
    );
  }

  static openAlexThrottled(context) {
    return new SnowballError(
      SnowballError.CODES.OPENALEX_THROTTLED,
      "OpenAlex is still rate-limiting requests. Please try again later.",
      { context }
    );
  }

  static openAlexBudgetExhausted(context) {
    return new SnowballError(
      SnowballError.CODES.OPENALEX_BUDGET_EXHAUSTED,
      "Your OpenAlex daily allowance is exhausted. Try again after it resets or use a different key.",
      { context }
    );
  }
};

SnowballError.OPENALEX_KEY_URL = "https://openalex.org/settings/api-key";
SnowballError.OPENALEX_KEY_LOCATION =
  "Zotero Settings → Snowball Sources (or Tools → Snowball Sources Preferences…)";

SnowballError.CODES = Object.freeze({
  OPENALEX_CREDENTIALS: "OPENALEX_CREDENTIALS",
  OPENALEX_THROTTLED: "OPENALEX_THROTTLED",
  OPENALEX_BUDGET_EXHAUSTED: "OPENALEX_BUDGET_EXHAUSTED"
});

/**
 * Render an error for end-user display. Strips internals and scrubs secrets
 * from any free-form message that wasn't sent through SnowballError.
 */
function formatUserError(error) {
  if (!error) return "An unknown error occurred.";
  if (error.name === "AbortError") return "Canceled.";
  if (error.userMessage) return error.userMessage;
  // Best-effort: if we ended up with a raw Error, scrub its message.
  const scrub =
    typeof SnowballLog !== "undefined" && SnowballLog.scrub
      ? SnowballLog.scrub.bind(SnowballLog)
      : (s) => s;
  return scrub(String(error.message || error));
}
