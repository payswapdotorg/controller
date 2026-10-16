/**
 * GitHub app API client tests (CTRL-013).
 *
 * Pins the typed observation surface (normalization, sorting, malformed
 * refusal), the fail-closed error mapping (401 invalidation, 403/404
 * accessibility, rate limits, transport), the correlation outcomes, and
 * the three gated mutations — including the review-iteration-2 proofs
 * that the merge transport performs NO governance evaluation (it reads
 * nothing: no PR, no reviews, no checks; its only request is the single
 * merge POST with the frozen method and the exact-head pin) and that
 * observations are GET-only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGitHubClient, POLICY_MERGE_METHOD } from "../src/githubClient.js";
import { fakeIdentity, jsonResponse, fakeRepositoryPayload, fakePullRequestPayload } from "./fixtures.js";

function buildClient(handler, identity = fakeIdentity({ token: null })) {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) },
      body: options.body ?? null,
    });
    return handler(String(url), options);
  };
  const client = createGitHubClient({ fetchImpl, identity });
  return { client, requests, identity };
}

// -- observation ---------------------------------------------------------------

test("getAuthenticatedUser normalizes the account view", async () => {
  const { client } = buildClient((url) => {
    assert.equal(url, "https://api.github.com/user");
    return jsonResponse(200, { login: "pectoraux", name: "Pectoraux", avatar_url: null });
  });
  const result = await client.getAuthenticatedUser();
  assert.equal(result.ok, true);
  assert.deepEqual(result.user, { login: "pectoraux", name: "Pectoraux", avatarUrl: null });
});

test("listAccessibleRepositories normalizes, sorts, and paginates with an explicit truncation marker", async () => {
  const pages = [
    Array.from({ length: 100 }, (_, index) => fakeRepositoryPayload(`zzzz/repo-${String(999 - index).padStart(4, "0")}`)),
    Array.from({ length: 100 }, (_, index) => fakeRepositoryPayload(`mmmm/repo-${String(999 - index).padStart(4, "0")}`)),
    [fakeRepositoryPayload("aaaa/first")],
  ];
  let page = 0;
  const { client, requests } = buildClient((url) => {
    if (url.startsWith("https://api.github.com/user/repos")) {
      const current = pages[Math.min(page, pages.length - 1)];
      const isLast = page >= pages.length - 1;
      page += 1;
      return jsonResponse(200, current, isLast ? {} : { Link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` });
    }
    return jsonResponse(404, {});
  });
  const result = await client.listAccessibleRepositories();
  assert.equal(result.ok, true);
  assert.equal(result.repositories.length, 201);
  assert.equal(result.repositories[0].repository, "aaaa/first");
  assert.equal(result.truncated, false);
  assert.equal(requests.filter((request) => request.url.startsWith("https://api.github.com/user/repos")).length, 3);
});

test("a bounded walk that ends with more pages reports truncated: true (never silent)", async () => {
  let page = 0;
  const { client } = buildClient((url) => {
    if (url.startsWith("https://api.github.com/user/repos")) {
      page += 1;
      const many = Array.from({ length: 100 }, (_, index) => fakeRepositoryPayload(`owner${page}/repo${String(index).padStart(3, "0")}`));
      return jsonResponse(200, many, { Link: '<https://api.github.com/user/repos?page=999>; rel="next"' });
    }
    return jsonResponse(404, {});
  });
  const result = await client.listAccessibleRepositories();
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.repositories.length, 1000);
  void page;
});

test("pull request lists are typed and sorted by number", async () => {
  const { client, requests } = buildClient((url) => {
    if (url.startsWith("https://api.github.com/repos/pectoraux/controller/pulls")) {
      return jsonResponse(200, [fakePullRequestPayload(12), fakePullRequestPayload(3)]);
    }
    return jsonResponse(404, {});
  });
  const result = await client.listPullRequests("pectoraux", "controller", { state: "open", headBranch: null });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pullRequests.map((pr) => pr.number), [3, 12]);
  assert.match(requests[0].url, /state=open/);
});

test("head-branch correlation list requests use the owner-qualified head filter", async () => {
  const { client, requests } = buildClient((url) => {
    if (url.startsWith("https://api.github.com/repos/pectoraux/controller/pulls")) {
      return jsonResponse(200, []);
    }
    return jsonResponse(404, {});
  });
  await client.listPullRequests("pectoraux", "controller", { state: "open", headBranch: "ctrl-013-x" });
  assert.match(requests[0].url, /head=pectoraux%3Actrl-013-x/);
});

test("a malformed PR entry (missing base) is GITHUB_MALFORMED, never a guess", async () => {
  const { client } = buildClient(() =>
    jsonResponse(200, [{ number: 1, state: "open", title: "t", head: { ref: "b", sha: "a".repeat(40) } }])
  );
  const result = await client.getPullRequest("pectoraux", "controller", 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GITHUB_MALFORMED");
});

test("a PR whose full_name disagrees with owner/name is refused, never guessed", async () => {
  const { client } = buildClient(() => jsonResponse(200, fakeRepositoryPayload("other/repo")));
  const result = await client.getRepository("pectoraux", "controller");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GITHUB_MALFORMED");
  assert.match(result.error.message, /other\/repo/);
});

test("combined commit status normalizes to sorted context/state pairs", async () => {
  const { client } = buildClient(() =>
    jsonResponse(200, {
      state: "failure",
      total_count: 2,
      statuses: [
        { context: "zzz-check", state: "success" },
        { context: "aaa-check", state: "failure" },
      ],
    })
  );
  const result = await client.getCommitStatus("pectoraux", "controller", "a".repeat(40));
  assert.equal(result.ok, true);
  assert.deepEqual(result.status.statuses, [["aaa-check", "failure"], ["zzz-check", "success"]]);
});

test("observations are GET-only — no mutation verb exists on the observation paths", async () => {
  const { client, requests } = buildClient((url) => {
    if (url.startsWith("https://api.github.com/repos/")) {
      return jsonResponse(200, fakeRepositoryPayload("pectoraux/controller"));
    }
    return jsonResponse(200, []);
  });
  await client.getRepository("pectoraux", "controller");
  await client.listPullRequests("pectoraux", "controller", { state: "open", headBranch: null });
  await client.getReviews("pectoraux", "controller", 1);
  await client.getComments("pectoraux", "controller", 1);
  await client.getCommitStatus("pectoraux", "controller", "a".repeat(40));
  assert.equal(requests.every((request) => request.method === "GET"), true);
});

// -- authorization / error mapping ----------------------------------------------

test("401 invalidates the session token and fails closed as AUTHORIZATION_REQUIRED", async () => {
  const identity = fakeIdentity({ token: "gho_session" });
  const { client } = buildClient(() => jsonResponse(401, { message: "Bad credentials" }), identity);
  const result = await client.getAuthenticatedUser();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORIZATION_REQUIRED");
  assert.equal(identity.currentToken(), null);
});

test("repository-scoped 403/404 map to REPOSITORY_INACCESSIBLE", async () => {
  for (const status of [403, 404]) {
    const { client } = buildClient(() => jsonResponse(status, {}));
    const result = await client.getRepository("pectoraux", "private-repo");
    assert.equal(result.ok, false, String(status));
    assert.equal(result.error.code, "REPOSITORY_INACCESSIBLE", String(status));
  }
});

test("403 with an exhausted quota maps to RATE_LIMITED with the reset epoch", async () => {
  const { client } = buildClient(() =>
    jsonResponse(403, {}, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790000000" })
  );
  const result = await client.getRepository("pectoraux", "controller");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RATE_LIMITED");
  assert.match(result.error.message, /1790000000/);
});

test("429 maps to RATE_LIMITED", async () => {
  const { client } = buildClient(() => jsonResponse(429, {}, { "Retry-After": "30" }));
  const result = await client.getRepository("pectoraux", "controller");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RATE_LIMITED");
});

test("5xx and transport failures map to GITHUB_UNAVAILABLE (class name only)", async () => {
  const { client } = buildClient(() => jsonResponse(503, {}));
  const fiveHundred = await client.getRepository("pectoraux", "controller");
  assert.equal(fiveHundred.error.code, "GITHUB_UNAVAILABLE");
  const { client: transportClient } = buildClient(async () => {
    throw new TypeError("fetch failed");
  });
  const transport = await transportClient.getRepository("pectoraux", "controller");
  assert.equal(transport.error.code, "GITHUB_UNAVAILABLE");
  assert.doesNotMatch(transport.error.message, /fetch failed/);
});

test("the session token is attached as a transient header only", async () => {
  const identity = fakeIdentity({ token: "gho_session_token" });
  const { client, requests } = buildClient(() => jsonResponse(200, fakeRepositoryPayload("pectoraux/controller")), identity);
  await client.getRepository("pectoraux", "controller");
  assert.equal(requests[0].headers.Authorization, "Bearer gho_session_token");
});

test("unauthenticated calls carry no Authorization header at all", async () => {
  const { client, requests } = buildClient(() => jsonResponse(200, fakeRepositoryPayload("pectoraux/controller")));
  await client.getRepository("pectoraux", "controller");
  assert.equal("Authorization" in requests[0].headers, false);
});

// -- correlation ------------------------------------------------------------------

test("correlation: zero open PRs is the no-open-pr outcome", async () => {
  const { client } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, []);
    }
    return jsonResponse(404, {});
  });
  const result = await client.correlateWorkPullRequest("pectoraux", "controller", { branch: "ctrl-013-x", baseSha: "b".repeat(40) });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "no-open-pr");
});

test("correlation: multiple open PRs is the ambiguous outcome with candidates", async () => {
  const { client } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, [fakePullRequestPayload(7), fakePullRequestPayload(9)]);
    }
    return jsonResponse(404, {});
  });
  const result = await client.correlateWorkPullRequest("pectoraux", "controller", { branch: "ctrl-013-x", baseSha: "b".repeat(40) });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ambiguous");
  assert.deepEqual(result.candidates, [7, 9]);
});

test("correlation: base drift and head drift are typed outcomes", async () => {
  const driftPr = fakePullRequestPayload(5, { base: { ref: "main", sha: "c".repeat(40) } });
  const { client } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, [driftPr]);
    }
    return jsonResponse(404, {});
  });
  const baseDrift = await client.correlateWorkPullRequest("pectoraux", "controller", { branch: "ctrl-013-x", baseSha: "b".repeat(40) });
  assert.equal(baseDrift.outcome, "base-drift");
  assert.equal(baseDrift.observedBaseSha, "c".repeat(40));
  const matched = fakePullRequestPayload(5);
  const headDriftClient = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, [matched]);
    }
    return jsonResponse(404, {});
  });
  const headDrift = await headDriftClient.client.correlateWorkPullRequest("pectoraux", "controller", {
    branch: "ctrl-013-x",
    baseSha: "b".repeat(40),
    headSha: "d".repeat(40),
  });
  assert.equal(headDrift.outcome, "head-drift");
  // Without an expected head the same PR correlates on base alone.
  const correlated = await headDriftClient.client.correlateWorkPullRequest("pectoraux", "controller", {
    branch: "ctrl-013-x",
    baseSha: "b".repeat(40),
  });
  assert.equal(correlated.outcome, "correlated");
});

// -- mutations ---------------------------------------------------------------------

test("createBranch requires an explicit from SHA and posts exactly the ref form", async () => {
  const { client, requests } = buildClient((url) => {
    if (url.endsWith("/git/refs")) {
      return jsonResponse(201, { ref: "refs/heads/ctrl-013-x", object: { sha: "a".repeat(40) } });
    }
    return jsonResponse(404, {});
  });
  const result = await client.createBranch("pectoraux", "controller", "ctrl-013-x", "a".repeat(40));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ref, { ref: "ctrl-013-x", sha: "a".repeat(40) });
  const post = requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(post.body), { ref: "refs/heads/ctrl-013-x", sha: "a".repeat(40) });
});

test("createBranch refuses forbidden ref names before any transport", async () => {
  const { client, requests } = buildClient(() => jsonResponse(201, {}));
  for (const branch of ["bad branch", "a..b", ".lock", "a/b/", "bad~name", "x^", "control\u0001"]) {
    const result = await client.createBranch("pectoraux", "controller", branch, "a".repeat(40));
    assert.equal(result.ok, false, branch);
    assert.equal(result.error.code, "MUTATION_REFUSED", branch);
  }
  assert.equal(requests.length, 0);
});

test("openPullRequest enforces the one-PR rule before any POST", async () => {
  const { client, requests } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, [fakePullRequestPayload(11)]);
    }
    return jsonResponse(404, {});
  });
  const result = await client.openPullRequest("pectoraux", "controller", {
    branch: "ctrl-013-x",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    title: "CTRL-013 — test",
    body: "body",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MUTATION_REFUSED");
  assert.match(result.error.message, /#11/);
  assert.equal(requests.some((request) => request.method === "POST"), false);
});

test("openPullRequest refuses base drift as STALE_REFERENCE (never auto-rebases)", async () => {
  const { client } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, []);
    }
    if (url.includes("/branches/main")) {
      return jsonResponse(200, { name: "main", commit: { sha: "c".repeat(40) } });
    }
    return jsonResponse(404, {});
  });
  const result = await client.openPullRequest("pectoraux", "controller", {
    branch: "ctrl-013-x",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    title: "t",
    body: "b",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_REFERENCE");
});

test("openPullRequest posts the exact PR form after the gates pass", async () => {
  const { client, requests } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, []);
    }
    if (url.includes("/branches/main")) {
      return jsonResponse(200, { name: "main", commit: { sha: "b".repeat(40) } });
    }
    if (url.endsWith("/pulls")) {
      return jsonResponse(201, fakePullRequestPayload(12));
    }
    return jsonResponse(404, {});
  });
  const result = await client.openPullRequest("pectoraux", "controller", {
    branch: "ctrl-013-x",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    title: "CTRL-013 — GitHub Browser-App Integration",
    body: "the body",
  });
  assert.equal(result.ok, true);
  const post = requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(post.body), {
    title: "CTRL-013 — GitHub Browser-App Integration",
    head: "ctrl-013-x",
    base: "main",
    body: "the body",
  });
});

test("mergePullRequest is a pure transport: exactly one POST, zero reads of any kind", async () => {
  // The review-iteration-2 regression (Architect requirement 6): the
  // transport itself performs NO governance evaluation — no PR
  // observation, no review list, no commit status, no branch list.
  // The ONLY request it makes is the single merge POST, carrying the
  // frozen merge method and the exact-head `sha` pin; the complete
  // merge predicate is the Controller runtime's
  // (controller/github.py, _require_merge_policy).
  const { client, requests } = buildClient((url) => {
    if (url.endsWith("/merge")) {
      return jsonResponse(200, { merged: true, merge_commit_sha: "m".repeat(40), message: "Pull Request successfully merged" });
    }
    return jsonResponse(404, {});
  });
  const result = await client.mergePullRequest("pectoraux", "controller", {
    prNumber: 38,
    workItem: "CTRL-013",
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mergeCommitSha, "m".repeat(40));
  // The executed mutation is returned bound to the authorization
  // identity the runtime presented (work item carried through).
  assert.equal(result.prNumber, 38);
  assert.equal(result.workItem, "CTRL-013");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].url, "https://api.github.com/repos/pectoraux/controller/pulls/38/merge");
  assert.deepEqual(JSON.parse(requests[0].body), { merge_method: POLICY_MERGE_METHOD, sha: "a".repeat(40) });
  // Zero reads of any governance surface.
  assert.equal(requests.filter((request) => request.method === "GET").length, 0);
  assert.equal(requests.some((request) => request.url.includes("/reviews")), false);
  assert.equal(requests.some((request) => request.url.includes("/statuses")), false);
  assert.equal(requests.some((request) => request.url.endsWith("/pulls/38")), false);
  assert.equal(requests.some((request) => request.url.includes("/pulls?")), false);
});

test("a moved head or an unmergeable PR is GitHub's own refusal — surfaced typed, never re-decided locally", async () => {
  // The exact-head safety is GitHub's own `sha` parameter (409 on a
  // moved head) and the merge endpoint's own lifecycle refusal (405
  // for closed/merged/non-mergeable): the transport does NOT pre-read
  // the PR to compare SHAs or state — that comparison is the runtime
  // predicate's. GitHub's refusal surfaces as the typed
  // MUTATION_REFUSED with the bounded message.
  const { client, requests } = buildClient((url) => {
    if (url.endsWith("/merge")) {
      return jsonResponse(405, { message: "Pull Request is not mergeable" });
    }
    return jsonResponse(404, {});
  });
  const result = await client.mergePullRequest("pectoraux", "controller", {
    prNumber: 38,
    workItem: "CTRL-013",
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MUTATION_REFUSED");
  assert.match(result.error.message, /not mergeable/);
  // The single bounded attempt — and still zero reads.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
});

test("mergePullRequest refuses an incomplete authorization identity before any network", async () => {
  // Mirrors the Python boundary's `_as_merge_request` normalization:
  // structural completeness grants NO trust, but a missing or
  // degenerate field is an invocation error — INTERNAL_ERROR with
  // zero requests, never a guessed default.
  for (const [label, fields] of [
    ["missing workItem", { prNumber: 38, baseRef: "main", baseSha: "b".repeat(40), headSha: "a".repeat(40) }],
    ["empty workItem", { prNumber: 38, workItem: "", baseRef: "main", baseSha: "b".repeat(40), headSha: "a".repeat(40) }],
    ["missing headSha", { prNumber: 38, workItem: "CTRL-013", baseRef: "main", baseSha: "b".repeat(40) }],
    ["empty baseRef", { prNumber: 38, workItem: "CTRL-013", baseRef: "", baseSha: "b".repeat(40), headSha: "a".repeat(40) }],
    ["missing baseSha", { prNumber: 38, workItem: "CTRL-013", baseRef: "main", headSha: "a".repeat(40) }],
  ]) {
    const { client, requests } = buildClient(() => jsonResponse(200, { merged: true }));
    const result = await client.mergePullRequest("pectoraux", "controller", fields);
    assert.equal(result.ok, false, label);
    assert.equal(result.error.code, "INTERNAL_ERROR", label);
    assert.match(result.error.message, /structurally complete/, label);
    assert.equal(requests.length, 0, label);
  }
});

test("a merge response that does not report merged is MUTATION_REFUSED", async () => {
  const { client } = buildClient((url) => {
    if (url.endsWith("/merge")) {
      return jsonResponse(200, { merged: false, message: "Pull Request is not mergeable" });
    }
    return jsonResponse(404, {});
  });
  const result = await client.mergePullRequest("pectoraux", "controller", {
    prNumber: 38,
    workItem: "CTRL-013",
    baseRef: "main",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MUTATION_REFUSED");
});

test("GitHub's 422 refusal of a mutation surfaces as MUTATION_REFUSED with the bounded message", async () => {
  const { client } = buildClient(() =>
    jsonResponse(422, { message: "Reference already exists" })
  );
  const result = await client.createBranch("pectoraux", "controller", "ctrl-013-x", "a".repeat(40));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MUTATION_REFUSED");
  assert.match(result.error.message, /Reference already exists/);
});

test("the merged flag tolerates GitHub's documented LIST shape (merged_at), never guesses", async () => {
  // LIST items omit the `merged` boolean and report `merged_at`.
  const { client } = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, [
        fakePullRequestPayload(40, { merged: undefined, merged_at: "2026-09-05T10:03:33Z" }),
        fakePullRequestPayload(41, { merged: undefined, merged_at: null }),
      ]);
    }
    return jsonResponse(404, {});
  });
  const result = await client.listPullRequests("pectoraux", "controller", { state: "closed", headBranch: null });
  assert.equal(result.ok, true);
  assert.deepEqual(result.pullRequests.map((pr) => [pr.number, pr.merged]), [[40, true], [41, false]]);

  // Neither the boolean nor the timestamp: fail closed, never a guess.
  const neither = buildClient((url) => {
    if (url.includes("/pulls?")) {
      return jsonResponse(200, [fakePullRequestPayload(42, { merged: undefined })]);
    }
    return jsonResponse(404, {});
  });
  const refused = await neither.client.listPullRequests("pectoraux", "controller", { state: "closed", headBranch: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GITHUB_MALFORMED");
  assert.match(refused.error.message, /merged_at/);
});
