/**
 * Merge-authorization binding tests (CTRL-013 review iteration 1).
 *
 * Pins the runtime-authorized merge path's pure logic: the complete
 * closed authorization identity (including the frozen, non-carried
 * merge method), the repository-authority binding (the work item must
 * be the authority's CURRENT active item), and the Architect
 * exact-head APPROVE binding (the unforgeable authorization root the
 * message caller cannot fabricate), with the accepted Python
 * predicate's own approval-identity rules mirrored verbatim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARCHITECT_REVIEWER,
  bindAuthorizationToArchitectApproval,
  bindAuthorizationToAuthority,
  mergeAuthorizationIdentity,
} from "../src/mergeAuthorization.js";
import { POLICY_MERGE_METHOD } from "../src/githubClient.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const OLDER = "c".repeat(40);

function identity(overrides = {}) {
  const result = mergeAuthorizationIdentity({
    prNumber: 38,
    workItem: "CTRL-013",
    baseRef: "main",
    baseSha: BASE,
    headSha: HEAD,
    ...overrides,
  });
  assert.equal(result.ok, true);
  return result.authorization;
}

function review(id, { author = ARCHITECT_REVIEWER, state = "APPROVED", commitId = HEAD, submittedAt = "2026-09-05T00:00:00Z" } = {}) {
  return { reviewId: id, state, author, commitId, submittedAt };
}

test("the frozen architect reviewer and merge method are the reviewable constants", () => {
  // The architect reviewer identity and the merge method are frozen
  // extension-side exactly like the Python boundary's _POLICY_MERGE_METHOD:
  // execution-time inputs there, frozen here because the extension has no
  // runtime channel yet — and never acceptable from a message caller.
  assert.equal(ARCHITECT_REVIEWER, "pectoraux");
  assert.equal(POLICY_MERGE_METHOD, "merge");
});

test("the authorization identity is the complete closed form with the frozen merge method", () => {
  const authorization = identity();
  assert.deepEqual(
    { ...authorization },
    {
      prNumber: 38,
      workItem: "CTRL-013",
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      mergeMethod: POLICY_MERGE_METHOD,
    }
  );
  assert.ok(Object.isFrozen(authorization));
});

test("malformed authorization identities fail closed", () => {
  for (const [label, fields] of [
    ["prNumber not an integer", { prNumber: 1.5 }],
    ["prNumber zero", { prNumber: 0 }],
    ["workItem empty", { workItem: "" }],
    ["workItem not a string", { workItem: 7 }],
    ["baseRef empty", { baseRef: "" }],
    ["baseSha not hex", { baseSha: "not-a-sha" }],
    ["headSha short", { headSha: "a".repeat(39) }],
  ]) {
    const result = mergeAuthorizationIdentity({
      prNumber: 38,
      workItem: "CTRL-013",
      baseRef: "main",
      baseSha: BASE,
      headSha: HEAD,
      ...fields,
    });
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, "MALFORMED_MESSAGE", label);
  }
});

test("the authority binding requires the CURRENT active work item", () => {
  const authorization = identity();
  const bound = bindAuthorizationToAuthority(authorization, { activeWorkItem: "CTRL-013" });
  assert.equal(bound.ok, true);
  assert.equal(bound.activeWorkItem, "CTRL-013");
});

test("a work item that is not the authority's active item is a contradiction, never a merge", () => {
  const authorization = identity({ workItem: "CTRL-999" });
  const refused = bindAuthorizationToAuthority(authorization, { activeWorkItem: "CTRL-013" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "AUTHORITY_CONTRADICTORY");
  assert.match(refused.error.message, /repository authority identifies 'CTRL-013' as the active work item/);
  assert.match(refused.error.message, /'CTRL-999' is not the active item/);
});

test("a non-validated authority state is an internal error, never a guess", () => {
  const authorization = identity();
  for (const bad of [null, {}, { activeWorkItem: "" }, { activeWorkItem: 3 }, "state"]) {
    const result = bindAuthorizationToAuthority(authorization, bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INTERNAL_ERROR");
  }
});

test("the architect binding accepts the latest APPROVE at the exact head", () => {
  const authorization = identity();
  const bound = bindAuthorizationToArchitectApproval(authorization, [
    review(101, { commitId: OLDER, submittedAt: "2026-09-04T00:00:00Z" }),
    review(202, { commitId: HEAD, submittedAt: "2026-09-05T00:00:00Z" }),
  ]);
  assert.equal(bound.ok, true);
  assert.equal(bound.approval.reviewId, 202);
});

test("no reviews at all means no runtime authorization (fail closed)", () => {
  const authorization = identity();
  const refused = bindAuthorizationToArchitectApproval(authorization, []);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "AUTHORIZATION_REQUIRED");
  assert.match(refused.error.message, /no APPROVED review by the architect reviewer 'pectoraux'/);
});

test("reviews by other accounts or non-approval states are not the Architect's authorization", () => {
  const authorization = identity();
  for (const [label, reviews] of [
    ["another account's approval", [review(1, { author: "worker-bot" })]],
    ["architect comment only", [review(1, { state: "COMMENTED" })]],
    ["architect changes requested", [review(1, { state: "CHANGES_REQUESTED" })]],
  ]) {
    const refused = bindAuthorizationToArchitectApproval(authorization, reviews);
    assert.equal(refused.ok, false, label);
    assert.equal(refused.error.code, "AUTHORIZATION_REQUIRED", label);
  }
});

test("an approval of an older commit does not survive a head change", () => {
  const authorization = identity();
  const refused = bindAuthorizationToArchitectApproval(authorization, [
    review(101, { commitId: OLDER }),
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "STALE_REFERENCE");
  assert.match(refused.error.message, /applies to commit cccccccccccc, not the authorized exact head aaaaaaaaaaaa/);
  assert.match(refused.error.message, /does not survive a head change/);
});

test("an approval with an unreported commit is not an exact-head binding", () => {
  const authorization = identity();
  const refused = bindAuthorizationToArchitectApproval(authorization, [
    review(101, { commitId: null }),
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "STALE_REFERENCE");
  assert.match(refused.error.message, /unreported/);
});

test("the LATEST approval governs the binding (the Python predicate's ordering)", () => {
  const authorization = identity();
  // An older approval at the exact head is superseded by a later
  // approval of a different commit: the latest governs, and it does
  // not apply to the authorized head.
  const refused = bindAuthorizationToArchitectApproval(authorization, [
    review(101, { commitId: HEAD, submittedAt: "2026-09-04T00:00:00Z" }),
    review(202, { commitId: OLDER, submittedAt: "2026-09-05T00:00:00Z" }),
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "STALE_REFERENCE");
  assert.match(refused.error.message, /review 202/);
});

test("approval ordering falls back to review id when timestamps tie or are absent", () => {
  const authorization = identity();
  const bound = bindAuthorizationToArchitectApproval(authorization, [
    review(101, { commitId: OLDER, submittedAt: null }),
    review(202, { commitId: HEAD, submittedAt: null }),
  ]);
  assert.equal(bound.ok, true);
  assert.equal(bound.approval.reviewId, 202);
  const superseded = bindAuthorizationToArchitectApproval(authorization, [
    review(101, { commitId: HEAD, submittedAt: "2026-09-05T00:00:00Z" }),
    review(202, { commitId: OLDER, submittedAt: "2026-09-05T00:00:00Z" }),
  ]);
  assert.equal(superseded.ok, false);
  assert.equal(superseded.error.code, "STALE_REFERENCE");
});

test("a non-list review input is an internal error, never a guess", () => {
  const authorization = identity();
  const result = bindAuthorizationToArchitectApproval(authorization, "reviews");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
});
