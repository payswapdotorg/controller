/**
 * The runtime-issued merge-authorization binding (CTRL-013, review
 * iteration 1 — the ARCHITECT REQUEST_CHANGES correction).
 *
 * `MergePullRequest` is a TRANSPORT of the existing Controller runtime
 * merge authorization, never an authorization substitute. A message
 * payload alone (plus a live GitHub session) can never make a merge
 * happen: before any merge POST, the service binds the presented
 * authorization identity to what the extension ITSELF observes from
 * sources the message caller cannot write:
 *
 *   1. **The repository authority binding.** The authorization's work
 *      item must equal the repository authority projection's CURRENT
 *      active work item. The projection is GET-only at one pinned
 *      default-branch SHA (authority.js) — the machine state the
 *      runtime's governance merges write — so the merge is bound to
 *      the runtime's governed present, not to a caller's claim.
 *
 *   2. **The Architect authorization binding.** The PR must carry an
 *      APPROVED review by the frozen architect reviewer identity
 *      whose `commit_id` is exactly the authorization's head SHA (an
 *      approval of an older commit does not survive a head change —
 *      the accepted controller/github.py predicate's own identity
 *      rule, mirrored verbatim). This is the unforgeable
 *      authorization root on GitHub: only the Architect's account
 *      produces it, exactly the evidence the Python boundary calls
 *      "evidence the worker cannot produce for its own PR". A caller
 *      with a session and fully fabricated identity fields cannot
 *      manufacture it.
 *
 * Division of authority (unchanged, non-duplicative by design): the
 * COMPLETE frozen merge predicate — the eligibility basis, required
 * CI checks, mergeability, draft state, the one-PR rule, and the
 * CHANGES_REQUESTED-after-approval resolution — remains the
 * Controller runtime's. Nothing here re-evaluates any of it; this
 * module binds identities only. The runtime composes this transport
 * (CTRL-016) after IT has evaluated the predicate and issued the
 * authorization; when an operator drives the transport directly, the
 * two bindings above still have to hold live.
 *
 * The complete closed authorization identity mirrors the Python
 * `MergeAuthorization` field-for-field: `pr_number`, `work_item`,
 * `base_ref`, `base_sha`, `head_sha`, and the frozen merge method —
 * which is NOT message-carried (a message carrying a merge method is
 * malformed at the boundary; the method is the frozen transport
 * constant, the same discipline as `_POLICY_MERGE_METHOD`).
 *
 * The architect reviewer identity is frozen here for the same reason
 * the merge method is: it is an execution-time input in the Python
 * boundary (supplied by the runtime, "never guessed"), and the
 * extension has no runtime channel yet (CTRL-016 will compose one) —
 * so it cannot be accepted from a message caller, who would then
 * approve with its own account. The value is the GitHub account that
 * posts the Architect's review decisions and merges governance PRs
 * in the controlled repository (observed on every governance PR:
 * reviews and merges by `pectoraux`); changing it is a reviewed code
 * change, exactly like the frozen merge method.
 */

import { failure } from "./errors.js";
import { POLICY_MERGE_METHOD } from "./githubClient.js";

/**
 * The frozen architect reviewer identity (see module doctrine). The
 * GitHub login whose APPROVED reviews are the Architect's
 * authority-recorded decisions on the merge surface.
 */
export const ARCHITECT_REVIEWER = "pectoraux";

/**
 * Validate and freeze the complete closed merge-authorization
 * identity — the MergePullRequest message form plus the frozen merge
 * method (which the message never carries).
 *
 * @param {{ prNumber: unknown, workItem: unknown, baseRef: unknown,
 *           baseSha: unknown, headSha: unknown }} fields
 * @returns {{ ok: true, authorization: {
 *             prNumber: number, workItem: string, baseRef: string,
 *             baseSha: string, headSha: string,
 *             mergeMethod: string } } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function mergeAuthorizationIdentity({ prNumber, workItem, baseRef, baseSha, headSha }) {
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    return failure("MALFORMED_MESSAGE", "merge authorization: field 'prNumber' must be a positive integer");
  }
  for (const [field, value] of [["workItem", workItem], ["baseRef", baseRef]]) {
    if (typeof value !== "string" || value.length === 0) {
      return failure("MALFORMED_MESSAGE", `merge authorization: field '${field}' must be a non-empty string`);
    }
  }
  for (const [field, value] of [["baseSha", baseSha], ["headSha", headSha]]) {
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
      return failure("MALFORMED_MESSAGE", `merge authorization: field '${field}' must be a 40-character hex commit id`);
    }
  }
  return {
    ok: true,
    authorization: Object.freeze({
      prNumber,
      workItem,
      baseRef,
      baseSha,
      headSha,
      mergeMethod: POLICY_MERGE_METHOD,
    }),
  };
}

/**
 * Binding 1 — the repository authority. The authorization's work item
 * must be the authority projection's CURRENT active work item (the
 * projection is already a validated, pinned-SHA value).
 *
 * @param {{ prNumber: number, workItem: string }} authorization
 * @param {{ activeWorkItem: string }} authorityState
 * @returns {{ ok: true, activeWorkItem: string } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function bindAuthorizationToAuthority(authorization, authorityState) {
  if (
    typeof authorityState !== "object" || authorityState === null ||
    typeof authorityState.activeWorkItem !== "string" || authorityState.activeWorkItem.length === 0
  ) {
    return failure(
      "INTERNAL_ERROR",
      "merge authorization binding: the authority projection is not a validated state value"
    );
  }
  if (authorityState.activeWorkItem !== authorization.workItem) {
    return failure(
      "AUTHORITY_CONTRADICTORY",
      `repository authority identifies '${authorityState.activeWorkItem}' as the active work item; ` +
        `'${authorization.workItem}' is not the active item seeking merge authorization`
    );
  }
  return { ok: true, activeWorkItem: authorityState.activeWorkItem };
}

/**
 * Binding 2 — the Architect's exact-head APPROVE, observed live. The
 * latest APPROVED review by the frozen architect reviewer must apply
 * to exactly the authorization's head SHA (mirroring the accepted
 * Python predicate's approval-identity rule: the review's commit_id
 * must match; an approval of an older commit does not survive a head
 * change).
 *
 * Deliberately NOT evaluated here (the runtime predicate owns it):
 * CHANGES_REQUESTED reviews after the approval, required checks,
 * mergeability, draft state, the one-PR rule, and the eligibility
 * basis.
 *
 * @param {{ prNumber: number, headSha: string }} authorization
 * @param {Array<{ reviewId: number, state: string, author: string,
 *                 commitId: string | null, submittedAt: string | null }>} reviews
 *        the typed review observation (githubClient.getReviews)
 * @returns {{ ok: true, approval: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function bindAuthorizationToArchitectApproval(authorization, reviews) {
  if (!Array.isArray(reviews)) {
    return failure(
      "INTERNAL_ERROR",
      "merge authorization binding: reviews is not the typed observation list"
    );
  }
  const approvals = reviews.filter(
    (review) => review.author === ARCHITECT_REVIEWER && review.state === "APPROVED"
  );
  if (approvals.length === 0) {
    return failure(
      "AUTHORIZATION_REQUIRED",
      `no runtime merge authorization is in force: PR #${authorization.prNumber} has no APPROVED ` +
        `review by the architect reviewer '${ARCHITECT_REVIEWER}' (a session plus fabricated ` +
        `identity fields cannot manufacture one)`
    );
  }
  const latest = approvals.reduce(_laterApprovalOf);
  if (latest.commitId !== authorization.headSha) {
    const reported = latest.commitId === null ? "(unreported)" : latest.commitId.slice(0, 12);
    return failure(
      "STALE_REFERENCE",
      `the architect's latest APPROVE (review ${latest.reviewId}) applies to commit ${reported}, ` +
        `not the authorized exact head ${authorization.headSha.slice(0, 12)}; ` +
        `an approval of an older commit does not survive a head change`
    );
  }
  return { ok: true, approval: latest };
}

/** @private — the later of two approvals by (submitted_at, review_id), the Python predicate's own ordering; a null submitted_at orders earliest. */
function _laterApprovalOf(a, b) {
  const at = a.submittedAt ?? "";
  const bt = b.submittedAt ?? "";
  if (at !== bt) {
    return at > bt ? a : b;
  }
  return b.reviewId > a.reviewId ? b : a;
}
