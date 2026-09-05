/**
 * Typed message-boundary validation tests (CTRL-012 + CTRL-013).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRequest, REQUEST_KINDS } from "../src/messages.js";

test("the request vocabulary is the frozen CTRL-012 + CTRL-013 set", () => {
  assert.deepEqual([...REQUEST_KINDS], [
    "GetConfiguration",
    "RegisterWorker",
    "RegisterArchitect",
    "SelectRepository",
    "GetAuthorityState",
    "OpenProviderTab",
    "DiscoverProviderTabs",
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
  // The mutation vocabulary is exactly the three Controller-authorized
  // mutations — nothing else. No approval, completion, comment, or
  // roadmap mutation kind exists.
  assert.deepEqual(
    REQUEST_KINDS.filter((kind) => ["CreateBranch", "OpenPullRequest", "MergePullRequest"].includes(kind)),
    ["CreateBranch", "OpenPullRequest", "MergePullRequest"]
  );
  for (const absent of ["Approve", "Comment", "CompleteWorkItem", "AdvanceRoadmap", "SetToken", "PastePAT", "ClosePR", "DeleteBranch", "ForcePush", "DismissReview", "RequestChanges"]) {
    assert.equal(REQUEST_KINDS.includes(absent), false, absent);
  }
});

test("each happy request form validates", () => {
  const sha = "a".repeat(40);
  const happy = [
    { kind: "GetConfiguration" },
    { kind: "RegisterWorker", name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" },
    { kind: "RegisterArchitect", name: "ChatGPT", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" },
    { kind: "SelectRepository", repository: "pectoraux/controller" },
    { kind: "GetAuthorityState" },
    { kind: "OpenProviderTab", role: "worker", name: "Z.ai" },
    { kind: "DiscoverProviderTabs", role: "architect", name: "ChatGPT" },
    { kind: "ConnectGitHub" },
    { kind: "DisconnectGitHub" },
    { kind: "GetGitHubConnection" },
    { kind: "DiscoverRepositories" },
    { kind: "VerifyRepositoryAccess", repository: "pectoraux/smallapp" },
    { kind: "ObserveRepository", repository: "pectoraux/smallapp" },
    { kind: "ObservePullRequests", repository: "pectoraux/controller", state: "open", headBranch: null },
    { kind: "ObservePullRequests", repository: "pectoraux/controller", state: "all", headBranch: "ctrl-013-x" },
    { kind: "ObservePullRequest", repository: "pectoraux/controller", prNumber: 38 },
    { kind: "ObserveReviews", repository: "pectoraux/controller", prNumber: 38 },
    { kind: "ObserveComments", repository: "pectoraux/controller", prNumber: 38 },
    { kind: "ObserveCommitStatus", repository: "pectoraux/controller", sha },
    { kind: "CorrelateWorkPullRequest", repository: "pectoraux/controller", branch: "ctrl-013-x", baseSha: "b".repeat(40), headSha: null },
    { kind: "CorrelateWorkPullRequest", repository: "pectoraux/controller", branch: "ctrl-013-x", baseSha: "b".repeat(40), headSha: sha },
    { kind: "CreateBranch", repository: "pectoraux/controller", branch: "ctrl-013-x", fromSha: sha },
    { kind: "OpenPullRequest", repository: "pectoraux/controller", branch: "ctrl-013-x", baseBranch: "main", baseSha: "b".repeat(40), title: "CTRL-013", body: "the body" },
    { kind: "MergePullRequest", repository: "pectoraux/controller", prNumber: 38, workItem: "CTRL-013", baseRef: "main", baseSha: "b".repeat(40), headSha: sha },
  ];
  for (const request of happy) {
    const result = validateRequest(request);
    assert.equal(result.ok, true, JSON.stringify(request));
    assert.equal(result.request.kind, request.kind);
  }
});

test("non-objects and arrays are MALFORMED_MESSAGE", () => {
  for (const bad of [null, undefined, 42, "GetConfiguration", [], [{}], true]) {
    const result = validateRequest(bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MALFORMED_MESSAGE");
  }
});

test("unknown kinds are UNKNOWN_MESSAGE, never guessed", () => {
  for (const kind of ["Merge", "Approve", "CompleteWorkItem", "setRepository", "", "getconfiguration"]) {
    const result = validateRequest({ kind });
    assert.equal(result.ok, false, kind);
    assert.equal(result.error.code, "UNKNOWN_MESSAGE", kind);
  }
  // No merge/approval/completion vocabulary exists at all.
  assert.equal(REQUEST_KINDS.includes("Merge"), false);
  assert.equal(REQUEST_KINDS.includes("Approve"), false);
});

test("missing fields are MALFORMED_MESSAGE", () => {
  const result = validateRequest({ kind: "RegisterWorker", name: "Z.ai" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MALFORMED_MESSAGE");
  const result2 = validateRequest({ kind: "SelectRepository" });
  assert.equal(result2.error.code, "MALFORMED_MESSAGE");
});

test("extra fields are refused — the closed form tolerates nothing undeclared", () => {
  const smuggled = validateRequest({
    kind: "RegisterWorker",
    name: "Z.ai",
    providerKind: "zai",
    providerUrl: "https://chat.z.ai",
    password: "hunter2",
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.error.code, "MALFORMED_MESSAGE");
  assert.match(smuggled.error.message, /password/);

  const token = validateRequest({
    kind: "SelectRepository",
    repository: "pectoraux/controller",
    token: "ghp_xxxxxxxxxxxx",
  });
  assert.equal(token.ok, false);
  assert.equal(token.error.code, "MALFORMED_MESSAGE");

  const cookie = validateRequest({ kind: "GetConfiguration", cookie: "session=..." });
  assert.equal(cookie.ok, false);
  assert.equal(cookie.error.code, "MALFORMED_MESSAGE");
});

test("wrongly-typed fields are MALFORMED_MESSAGE", () => {
  const cases = [
    { kind: "RegisterWorker", name: 42, providerKind: "zai", providerUrl: "https://chat.z.ai" },
    { kind: "RegisterWorker", name: "Z.ai", providerKind: null, providerUrl: "https://chat.z.ai" },
    { kind: "RegisterArchitect", name: "ChatGPT", providerKind: "chatgpt", providerUrl: [] },
    { kind: "SelectRepository", repository: 7 },
    { kind: "OpenProviderTab", role: "supervisor", name: "Z.ai" },
    { kind: "DiscoverProviderTabs", role: "worker", name: "" },
  ];
  for (const request of cases) {
    const result = validateRequest(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "MALFORMED_MESSAGE", JSON.stringify(request));
  }
});

test("empty strings are refused for string fields", () => {
  const result = validateRequest({ kind: "RegisterWorker", name: "", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MALFORMED_MESSAGE");
});

test("CTRL-013 kinds validate their typed fields strictly", () => {
  const sha = "a".repeat(40);
  const cases = [
    // prNumber must be a positive integer (not a string, float, or bool).
    { kind: "ObservePullRequest", repository: "pectoraux/controller", prNumber: "38" },
    { kind: "ObserveReviews", repository: "pectoraux/controller", prNumber: 0 },
    { kind: "ObserveReviews", repository: "pectoraux/controller", prNumber: 2.5 },
    { kind: "ObserveComments", repository: "pectoraux/controller", prNumber: true },
    // Commit SHAs must be exactly 40 hex characters.
    { kind: "ObserveCommitStatus", repository: "pectoraux/controller", sha: "short" },
    { kind: "CreateBranch", repository: "pectoraux/controller", branch: "x", fromSha: "g".repeat(40) },
    { kind: "OpenPullRequest", repository: "pectoraux/controller", branch: "b", baseBranch: "main", baseSha: sha.slice(0, 39), title: "t", body: "b" },
    { kind: "MergePullRequest", repository: "pectoraux/controller", prNumber: 1, workItem: "X", baseRef: "main", baseSha: sha, headSha: "a".repeat(41) },
    // PR list state is a closed vocabulary.
    { kind: "ObservePullRequests", repository: "pectoraux/controller", state: "merged", headBranch: null },
    // headBranch is a nullable field: wrong types are refused.
    { kind: "ObservePullRequests", repository: "pectoraux/controller", state: "open", headBranch: 42 },
    { kind: "ObservePullRequests", repository: "pectoraux/controller", state: "open", headBranch: "" },
    // Correlate's optional headSha is also a nullable.
    { kind: "CorrelateWorkPullRequest", repository: "pectoraux/controller", branch: "x", baseSha: sha, headSha: "nope" },
    // Merge's authorization identity fields are required strings.
    { kind: "MergePullRequest", repository: "pectoraux/controller", prNumber: 1, workItem: "", baseRef: "main", baseSha: sha, headSha: sha },
  ];
  for (const request of cases) {
    const result = validateRequest(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "MALFORMED_MESSAGE", JSON.stringify(request));
  }
});

test("CTRL-013 kinds refuse smuggled fields exactly like CTRL-012 kinds", () => {
  const smuggled = validateRequest({
    kind: "ConnectGitHub",
    token: "ghp_xxxxxxxxxxxx",
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.error.code, "MALFORMED_MESSAGE");

  const asPassword = validateRequest({
    kind: "MergePullRequest",
    repository: "pectoraux/controller",
    prNumber: 38,
    workItem: "CTRL-013",
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
    password: "hunter2",
  });
  assert.equal(asPassword.ok, false);
  assert.equal(asPassword.error.code, "MALFORMED_MESSAGE");
  assert.match(asPassword.error.message, /password/);

  const asCookie = validateRequest({ kind: "DiscoverRepositories", cookie: "session=..." });
  assert.equal(asCookie.ok, false);
  assert.equal(asCookie.error.code, "MALFORMED_MESSAGE");
});
