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
};

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
