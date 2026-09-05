/**
 * Canonical GitHub repository identity (CTRL-012).
 *
 * The extension represents a controlled repository by exactly its
 * canonical `owner/name` identity plus local display metadata. The
 * identity is validated strictly against GitHub's naming rules; an
 * invalid or ambiguous identity fails closed with INVALID_REPOSITORY
 * and nothing is persisted (acceptance criterion 5).
 *
 * Repository authority continues to come from the controlled repository
 * itself: this identity is a *reference*, never a source of truth over
 * roadmap, work-order, machine-state, lifecycle, or merge policy.
 */

import { failure } from "./errors.js";

// GitHub naming rules: owner = alphanumeric + hyphen, 1..39 chars, no
// leading/trailing hyphen; repository name = alphanumeric + `_`, `.`,
// `-`, 1..100 chars, and not "." or "..".
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const CANONICAL_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/**
 * Validate a canonical `owner/name` repository identity.
 *
 * Ambiguous forms (extra slashes, whitespace, empty owner or name,
 * leading/trailing slash, lookalike punctuation) are refused — the
 * extension never guesses which repository was meant.
 *
 * @param {unknown} value
 * @returns {{ ok: true, repository: string, owner: string, name: string } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateRepositoryIdentity(value) {
  if (typeof value !== "string") {
    return failure("INVALID_REPOSITORY", "repository identity must be a string");
  }
  const trimmed = value.trim();
  if (trimmed !== value) {
    return failure("INVALID_REPOSITORY", "repository identity has leading/trailing whitespace");
  }
  if (trimmed.length === 0) {
    return failure("INVALID_REPOSITORY", "repository identity is empty");
  }
  if (!CANONICAL_PATTERN.test(trimmed)) {
    return failure(
      "INVALID_REPOSITORY",
      "repository identity must be exactly 'owner/name' (one slash, no whitespace)"
    );
  }
  const slashIndex = trimmed.indexOf("/");
  const owner = trimmed.slice(0, slashIndex);
  const name = trimmed.slice(slashIndex + 1);
  if (!OWNER_PATTERN.test(owner)) {
    return failure(
      "INVALID_REPOSITORY",
      `repository owner '${owner}' is not a valid GitHub owner (alphanumeric + internal hyphens, max 39)`
    );
  }
  if (!REPOSITORY_NAME_PATTERN.test(name) || name === "." || name === "..") {
    return failure(
      "INVALID_REPOSITORY",
      `repository name '${name}' is not a valid GitHub repository name`
    );
  }
  return { ok: true, repository: trimmed, owner, name };
}
