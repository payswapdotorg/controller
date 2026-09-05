/**
 * The Controller-to-extension typed message boundary (CTRL-012 + CTRL-013).
 *
 * This is the closed request/response vocabulary every extension surface
 * speaks. Requests are JSON objects with a `kind` discriminator and
 * exactly the fields that kind declares; responses are typed values:
 * `{ ok: true, ...payload }` or `{ ok: false, error: { code, message } }`
 * with a code from the frozen ERROR_CODES set.
 *
 * Fail-closed rules (acceptance criterion 7):
 *   - an unknown `kind` is UNKNOWN_MESSAGE;
 *   - a malformed shape (missing fields, wrong types, EXTRA fields) is
 *     MALFORMED_MESSAGE — unknown fields are refused, never ignored,
 *     so no surface can smuggle state through an undeclared field;
 *   - a refused request never mutates extension configuration or any
 *     authoritative repository state.
 *
 * Message vocabulary (frozen for CTRL-012):
 *
 *   GetConfiguration      {}                          -> configuration view
 *   RegisterWorker        { name, providerKind, providerUrl }
 *   RegisterArchitect     { name, providerKind, providerUrl }
 *   SelectRepository      { repository }
 *   GetAuthorityState     {}                          -> authority projection
 *   OpenProviderTab       { role, name }              -> opened tab
 *   DiscoverProviderTabs  { role, name }              -> matching tabs
 *
 * Message vocabulary (added by CTRL-013 — the GitHub app integration):
 *
 *   ConnectGitHub             {}                          -> connection view
 *   DisconnectGitHub          {}                          -> cleared connection
 *   GetGitHubConnection       {}                          -> connection metadata
 *   DiscoverRepositories      {}                          -> accessible repos
 *   VerifyRepositoryAccess    { repository }              -> accessibility
 *   ObserveRepository         { repository }              -> repo/default-branch/head
 *   ObservePullRequests       { repository, state, headBranch }
 *   ObservePullRequest        { repository, prNumber }    -> typed PR view
 *   ObserveReviews            { repository, prNumber }    -> typed reviews
 *   ObserveComments           { repository, prNumber }    -> typed comments
 *   ObserveCommitStatus       { repository, sha }         -> combined status
 *   CorrelateWorkPullRequest  { repository, branch, baseSha, headSha }
 *                                                           -> typed correlation
 *
 *   Mutations (transport surface ONLY — no popup control invokes these;
 *   each requires the exact closed form the Controller's accepted
 *   mutation surface defines; the merge form carries the runtime-issued
 *   authorization identity and is NOT a policy the extension evaluates):
 *
 *   CreateBranch          { repository, branch, fromSha }
 *   OpenPullRequest       { repository, branch, baseBranch, baseSha, title, body }
 *   MergePullRequest      { repository, prNumber, workItem, baseRef, baseSha, headSha }
 *
 * The mutation vocabulary deliberately mirrors the three (and only
 * three) mutations controller/github.py (CTRL-003, AC6) exposes, with
 * the same closed field grammar. No message kind exists for approving,
 * commenting, completing, advancing, or any other governance action.
 */

import { failure } from "./errors.js";
import { requireExactFields } from "./forms.js";
import { ROLES } from "./providers.js";

/** The closed request vocabulary. */
export const REQUEST_KINDS = Object.freeze([
  "GetConfiguration",
  "RegisterWorker",
  "RegisterArchitect",
  "SelectRepository",
  "GetAuthorityState",
  "OpenProviderTab",
  "DiscoverProviderTabs",
  // CTRL-013 — GitHub app integration.
  "ConnectGitHub",
  "DisconnectGitHub",
  "GetGitHubConnection",
  "DiscoverRepositories",
  "VerifyRepositoryAccess",
  "ObserveRepository",
  "ObservePullRequests",
  "ObservePullRequest",
  "ObserveReviews",
  "ObserveComments",
  "ObserveCommitStatus",
  "CorrelateWorkPullRequest",
  "CreateBranch",
  "OpenPullRequest",
  "MergePullRequest",
]);

/** Field sets per kind (closed forms — exactly these fields). */
const KIND_FIELDS = Object.freeze({
  GetConfiguration: [],
  RegisterWorker: ["name", "providerKind", "providerUrl"],
  RegisterArchitect: ["name", "providerKind", "providerUrl"],
  SelectRepository: ["repository"],
  GetAuthorityState: [],
  OpenProviderTab: ["role", "name"],
  DiscoverProviderTabs: ["role", "name"],
  // CTRL-013 kinds.
  ConnectGitHub: [],
  DisconnectGitHub: [],
  GetGitHubConnection: [],
  DiscoverRepositories: [],
  VerifyRepositoryAccess: ["repository"],
  ObserveRepository: ["repository"],
  ObservePullRequests: ["repository", "state", "headBranch"],
  ObservePullRequest: ["repository", "prNumber"],
  ObserveReviews: ["repository", "prNumber"],
  ObserveComments: ["repository", "prNumber"],
  ObserveCommitStatus: ["repository", "sha"],
  CorrelateWorkPullRequest: ["repository", "branch", "baseSha", "headSha"],
  CreateBranch: ["repository", "branch", "fromSha"],
  OpenPullRequest: ["repository", "branch", "baseBranch", "baseSha", "title", "body"],
  MergePullRequest: ["repository", "prNumber", "workItem", "baseRef", "baseSha", "headSha"],
});

/** The closed PR list state vocabulary (GitHub's three list states). */
const PR_LIST_STATES = Object.freeze(["open", "closed", "all"]);

/**
 * Validate an inbound request against the closed vocabulary.
 *
 * @param {unknown} value - the raw message object
 * @returns {{ ok: true, request: { kind: string } & Record<string, unknown> } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateRequest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("MALFORMED_MESSAGE", "request must be a JSON object");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !REQUEST_KINDS.includes(kind)) {
    return failure(
      "UNKNOWN_MESSAGE",
      `unknown request kind ${JSON.stringify(kind)} (vocabulary: ${REQUEST_KINDS.join(", ")})`
    );
  }
  const shape = requireExactFields(value, ["kind", ...KIND_FIELDS[kind]], `request ${kind}`);
  if (!shape.ok) {
    // Distinguish "malformed field shape" from unknown-kind: the forms
    // layer reports under MALFORMED_MESSAGE, which is what this is.
    return shape;
  }
  if (kind === "RegisterWorker" || kind === "RegisterArchitect") {
    for (const field of KIND_FIELDS[kind]) {
      if (typeof value[field] !== "string" || value[field].length === 0) {
        return failure(
          "MALFORMED_MESSAGE",
          `request ${kind}: field '${field}' must be a non-empty string`
        );
      }
    }
  }
  if (kind === "SelectRepository" || kind === "VerifyRepositoryAccess" ||
      kind === "ObserveRepository" || kind === "ObservePullRequests" ||
      kind === "ObservePullRequest" || kind === "ObserveReviews" ||
      kind === "ObserveComments" || kind === "ObserveCommitStatus" ||
      kind === "CorrelateWorkPullRequest" || kind === "CreateBranch" ||
      kind === "OpenPullRequest" || kind === "MergePullRequest") {
    const repository = value.repository;
    if (typeof repository !== "string" || repository.length === 0) {
      return failure("MALFORMED_MESSAGE", `request ${kind}: field 'repository' must be a non-empty string`);
    }
  }
  if (kind === "OpenProviderTab" || kind === "DiscoverProviderTabs") {
    if (typeof value.role !== "string" || !ROLES.includes(value.role)) {
      return failure(
        "MALFORMED_MESSAGE",
        `request ${kind}: field 'role' must be one of ${ROLES.join(", ")}`
      );
    }
    if (typeof value.name !== "string" || value.name.length === 0) {
      return failure("MALFORMED_MESSAGE", `request ${kind}: field 'name' must be a non-empty string`);
    }
  }
  if (kind === "ObservePullRequests") {
    if (typeof value.state !== "string" || !PR_LIST_STATES.includes(value.state)) {
      return failure(
        "MALFORMED_MESSAGE",
        `request ObservePullRequests: field 'state' must be one of ${PR_LIST_STATES.join(", ")}`
      );
    }
    // headBranch is a declared nullable: a string filter or null (no filter).
    if (value.headBranch !== null && (typeof value.headBranch !== "string" || value.headBranch.length === 0)) {
      return failure(
        "MALFORMED_MESSAGE",
        "request ObservePullRequests: field 'headBranch' must be a non-empty string or null"
      );
    }
  }
  if (kind === "ObservePullRequest" || kind === "ObserveReviews" ||
      kind === "ObserveComments" || kind === "MergePullRequest") {
    if (!isPositiveInteger(value.prNumber)) {
      return failure(
        "MALFORMED_MESSAGE",
        `request ${kind}: field 'prNumber' must be a positive integer`
      );
    }
  }
  if (kind === "ObserveCommitStatus" && !isCommitSha(value.sha)) {
    return failure("MALFORMED_MESSAGE", "request ObserveCommitStatus: field 'sha' must be a 40-character hex commit id");
  }
  if (kind === "CorrelateWorkPullRequest" || kind === "CreateBranch" ||
      kind === "OpenPullRequest" || kind === "MergePullRequest") {
    if (kind === "CorrelateWorkPullRequest" && !isCommitSha(value.baseSha)) {
      return failure("MALFORMED_MESSAGE", "request CorrelateWorkPullRequest: field 'baseSha' must be a 40-character hex commit id");
    }
    if (kind === "CorrelateWorkPullRequest") {
      // headSha is a declared nullable: an optional exact-head expectation.
      if (value.headSha !== null && !isCommitSha(value.headSha)) {
        return failure(
          "MALFORMED_MESSAGE",
          "request CorrelateWorkPullRequest: field 'headSha' must be a 40-character hex commit id or null"
        );
      }
    }
    if (kind === "CreateBranch" && !isCommitSha(value.fromSha)) {
      return failure("MALFORMED_MESSAGE", "request CreateBranch: field 'fromSha' must be a 40-character hex commit id (never defaulted)");
    }
    if (kind === "OpenPullRequest" && !isCommitSha(value.baseSha)) {
      return failure("MALFORMED_MESSAGE", "request OpenPullRequest: field 'baseSha' must be a 40-character hex commit id");
    }
    if (kind === "MergePullRequest") {
      if (!isCommitSha(value.baseSha) || !isCommitSha(value.headSha)) {
        return failure("MALFORMED_MESSAGE", "request MergePullRequest: fields 'baseSha' and 'headSha' must be 40-character hex commit ids");
      }
      for (const field of ["workItem", "baseRef"]) {
        if (typeof value[field] !== "string" || value[field].length === 0) {
          return failure("MALFORMED_MESSAGE", `request MergePullRequest: field '${field}' must be a non-empty string`);
        }
      }
    }
  }
  if (kind === "CorrelateWorkPullRequest" || kind === "CreateBranch") {
    if (typeof value.branch !== "string" || value.branch.length === 0) {
      return failure("MALFORMED_MESSAGE", `request ${kind}: field 'branch' must be a non-empty string`);
    }
  }
  if (kind === "OpenPullRequest") {
    for (const field of ["branch", "baseBranch", "title", "body"]) {
      if (typeof value[field] !== "string" || value[field].length === 0) {
        return failure("MALFORMED_MESSAGE", `request OpenPullRequest: field '${field}' must be a non-empty string`);
      }
    }
  }
  return { ok: true, request: value };
}

/** @private */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @private */
function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
