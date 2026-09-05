/**
 * The closed error-code vocabulary of the extension's typed message
 * boundary.
 *
 * Every refusal at every layer of the Browser Control Surface (CTRL-012,
 * CTRL-013) is a typed value drawn from this frozen set. Nothing is
 * guessed, defaulted, or silently repaired: an operator sees exactly
 * which class of failure occurred, and a caller can branch on the code
 * alone.
 *
 * Doctrine (spec/work-items/CTRL-012.md, "State display"):
 * a missing, malformed, stale, or contradictory authority result is an
 * explicit fail-closed UI state, never an inferred fallback.
 *
 * CTRL-013 additions (spec/work-items/CTRL-013.md): the GitHub
 * app-integration refusals — authorization state, repository
 * accessibility, rate limiting, stale references, mutation gating, and
 * the GitHub API transport/normalization classes. Access tokens and
 * authorization codes NEVER appear in any message string (work order,
 * security requirements: "do not log access tokens or authorization
 * codes").
 *
 * CTRL-014 additions (spec/work-items/CTRL-014.md): the Z.ai browser
 * Worker adapter refusals — provider-page channel failures, unknown
 * dialogs, ambiguous provider state, authentication interruption
 * mid-sequence, exhausted bounded retry budgets, unknown worker
 * sessions, and provider-side error surfaces. Provider page content
 * is never echoed into error messages beyond the typed facts needed
 * to act (no conversation text, no credentials, no cookies).
 */

/**
 * The frozen error-code set. The extension never invents codes at
 * runtime; a code outside this set is itself a programming error and
 * surfaces as INTERNAL_ERROR.
 */
export const ERROR_CODES = Object.freeze([
  // Message-boundary refusals (the typed request/response forms).
  "UNKNOWN_MESSAGE",
  "MALFORMED_MESSAGE",
  // Registration/config refusals.
  "INVALID_REGISTRATION",
  "INVALID_REPOSITORY",
  "REGISTRATION_NOT_FOUND",
  "REPOSITORY_NOT_SELECTED",
  "CONFIGURATION_CORRUPT",
  // Authority-surface refusals (the fail-closed state display).
  "AUTHORITY_UNAVAILABLE",
  "AUTHORITY_MISSING",
  "AUTHORITY_MALFORMED",
  "AUTHORITY_CONTRADICTORY",
  // Browser/tab surface refusals.
  "TABS_UNAVAILABLE",
  // GitHub app-integration refusals (CTRL-013).
  "AUTHORIZATION_REQUIRED", // no/invalid session authorization where one is needed
  "AUTHORIZATION_FAILED", // the authorization flow itself failed (denied/expired/transport)
  "AUTHORIZATION_NOT_CONFIGURED", // deployment lacks the OAuth client id
  "REPOSITORY_INACCESSIBLE", // 403/404 on a repository-scoped access
  "RATE_LIMITED", // GitHub primary/secondary rate limit
  "STALE_REFERENCE", // observed SHA/ref drifted from the expected authority-derived value
  "MUTATION_REFUSED", // a mutation was refused by its in-transport gate
  "RUNTIME_AUTHORIZATION_UNAVAILABLE", // the runtime-issued authorization channel is not composed (CTRL-016); the merge transport cannot accept an authorization from the message surface
  "GITHUB_UNAVAILABLE", // GitHub API transport failure (5xx/timeout/network)
  "GITHUB_MALFORMED", // a GitHub API response is structurally unusable
  "GITHUB_NOT_FOUND", // a GitHub resource 404 that is not repository-scoped
  // Z.ai browser Worker adapter refusals (CTRL-014).
  "PAGE_UNAVAILABLE", // the provider page channel failed (no content script / tab gone / timeout)
  "PAGE_MALFORMED", // the provider page surface returned an unusable/contradictory response
  "AUTHENTICATION_INTERRUPTED", // authentication was required/lost mid-sequence
  "UNKNOWN_DIALOG", // an unrecognized/differently-shaped dialog is present
  "AMBIGUOUS_STATE", // contradictory or insufficient provider facts (incl. multi-tab ambiguity)
  "RETRY_EXHAUSTED", // a bounded retry/recovery budget was exhausted without confirmation
  "SESSION_UNKNOWN", // no active adapter session for the referenced worker/work item
  "PROVIDER_ERROR", // an observed provider-side error surface
  // The closed fallback for unexpected internal failures.
  "INTERNAL_ERROR",
]);

/**
 * Build a typed refusal value.
 *
 * @param {string} code - one of ERROR_CODES
 * @param {string} message - operator-readable explanation (never a secret)
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
export function failure(code, message) {
  if (!ERROR_CODES.includes(code)) {
    // Fail closed even on our own mistakes: an unknown code degrades to
    // the typed internal error rather than passing an untyped value.
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: `untyped failure surfaced as ${code}: ${message}` },
    };
  }
  return { ok: false, error: { code, message } };
}
