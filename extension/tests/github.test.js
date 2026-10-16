/**
 * GitHub client tests over a scripted fetch: snapshot roll-up, merge, typed
 * error classes (auth / rate-limit / not-found).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as github from "../src/github.js";
import { fakeGithub } from "./fixtures.js";

function okResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("getSnapshot rolls up check conclusions", async () => {
  const { fetchImpl } = fakeGithub([
    { method: "GET", path: /^\/repos\/o\/r$/, body: { default_branch: "main" } },
    { method: "GET", path: /^\/repos\/o\/r\/branches\/main$/, body: { commit: { sha: "mainsha" } } },
    { method: "GET", path: /^\/repos\/o\/r\/pulls$/, body: [{ number: 5, title: "t", head: { ref: "work/a", sha: "prsha" }, draft: false, mergeable: true, user: { login: "w" }, created_at: "" }] },
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, body: [{ number: 6, title: "issue", state: "open", labels: [] }] },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/prsha\/check-runs$/, body: { total_count: 2, check_runs: [{ conclusion: "success" }, { conclusion: "success" }] } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const snapshot = await github.getSnapshot("tok", "o", "r");
    assert.equal(snapshot.mainHead, "mainsha");
    assert.equal(snapshot.openPullRequests.length, 1);
    assert.equal(snapshot.openPullRequests[0].checkState, "green");
    assert.equal(snapshot.openIssues.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getSnapshot: PR issues list excludes pull requests", async () => {
  const { fetchImpl } = fakeGithub([
    { method: "GET", path: /^\/repos\/o\/r$/, body: { default_branch: "main" } },
    { method: "GET", path: /^\/repos\/o\/r\/branches\/main$/, body: { commit: { sha: "s" } } },
    { method: "GET", path: /^\/repos\/o\/r\/pulls$/, body: [] },
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, body: [{ number: 1, title: "a", state: "open", labels: [] }, { number: 2, title: "pr-shaped issue", state: "open", labels: [], pull_request: { url: "x" } }] },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const snapshot = await github.getSnapshot("tok", "o", "r");
    assert.equal(snapshot.openIssues.length, 1);
    assert.equal(snapshot.openIssues[0].number, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("401 surfaces as a typed auth error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => okResponse({ message: "Bad credentials" }, 401);
  try {
    await assert.rejects(
      () => github.whoAmI("bad"),
      (error) => error instanceof github.GithubError && error.kind === "auth",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("403 with rate-limit headers surfaces as rate-limit", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    okResponse({ message: "rate limited" }, 403, { "x-ratelimit-reset": "1760000000" });
  try {
    await assert.rejects(
      () => github.whoAmI("tok"),
      (error) => error instanceof github.GithubError && error.kind === "rate-limit" && error.message.includes("resets"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("404 surfaces as not-found (check-runs tolerated by the caller)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => okResponse({ message: "Not Found" }, 404);
  try {
    await assert.rejects(
      () => github.whoAmI("tok"),
      (error) => error instanceof github.GithubError && error.kind === "not-found",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mergePullRequest sends the configured merge method", async () => {
  const { fetchImpl, calls } = fakeGithub([
    { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, body: { sha: "m" } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await github.mergePullRequest("tok", "o", "r", 9, "squash", { title: "T", body: "B" });
    assert.equal(calls[0].body.merge_method, "squash");
    assert.equal(calls[0].body.commit_title, "T");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
