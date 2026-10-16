/**
 * Supervisor FSM tests over fully injected fakes: harvest policy, review
 * verdicts, dispatch directives, fail-closed behaviors, overlap guard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSupervisor } from "../src/supervisor.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { fakeGithub, fakeIntelligence, fakeLog, prFixture, snapshotFixture } from "./fixtures.js";

function baseConfig(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    github: { ...DEFAULT_CONFIG.github, owner: "org", repo: "repo", token: "t" },
    ...overrides,
  };
}

function makeSupervisor({ snapshot, mergeResult, intelligence, config = baseConfig(), extraRoutes = [] } = {}) {
  const gh = fakeGithub([
    { method: "GET", path: /^\/repos\/org\/repo$/, body: { default_branch: "main" } },
    { method: "GET", path: /^\/repos\/org\/repo\/branches\/main$/, body: { commit: { sha: "abc1234" } } },
    { method: "GET", path: /^\/repos\/org\/repo\/pulls$/, body: snapshot?.openPullRequests ?? [] },
    { method: "GET", path: /^\/repos\/org\/repo\/issues$/, body: snapshot?.openIssues ?? [] },
    { method: "GET", path: /^\/repos\/org\/repo\/commits\/[^/]+\/check-runs$/, body: { total_count: 1, check_runs: [{ conclusion: "success" }] } },
    { method: "PUT", path: /^\/repos\/org\/repo\/pulls\/\d+\/merge$/, body: { sha: "merged99" } },
    { method: "POST", path: /^\/repos\/org\/repo\/issues$/, body: { number: 42 } },
    { method: "POST", path: /^\/repos\/org\/repo\/issues\/\d+\/comments$/, body: { id: 1 } },
    ...extraRoutes,
  ]);
  void mergeResult;
  const github = {
    getSnapshot: () => snapshotFixture(snapshot ?? {}),
    mergePullRequest: async (number, message) => {
      gh.fetchImpl(`https://api.github.com/repos/org/repo/pulls/${number}/merge`, { method: "PUT", body: JSON.stringify({}) });
      void message;
      return { sha: "merged99" };
    },
    comment: async (number, body) => {
      void body;
      return gh.fetchImpl(`https://api.github.com/repos/org/repo/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
    createIssue: async (title, body) => {
      void title;
      void body;
      return { number: 42 };
    },
  };
  const { log, entries } = fakeLog();
  const supervisor = createSupervisor({ github, intelligence, config, log });
  return { supervisor, entries, gh };
}

test("harvest: green + in-fence + mergeable PR is merged", async () => {
  const intelligence = fakeIntelligence([]);
  const { supervisor, entries } = makeSupervisor({
    snapshot: { openPullRequests: [prFixture()] },
    intelligence,
  });
  const result = await supervisor.tick();
  assert.equal(result.cycle.merged[0], 10);
  assert.ok(entries.some((e) => e.kind === "harvest" && /#10 merged/.test(e.message)));
});

test("harvest: failing checks hold the PR (requireGreenChecks)", async () => {
  const intelligence = fakeIntelligence([]);
  const { supervisor } = makeSupervisor({
    snapshot: { openPullRequests: [prFixture({ checkState: "failing" })] },
    intelligence,
  });
  const result = await supervisor.tick();
  assert.deepEqual(result.cycle.merged, []);
});

test("harvest: out-of-fence branch (no allowed prefix) is never merged", async () => {
  const intelligence = fakeIntelligence([]);
  const { supervisor } = makeSupervisor({
    snapshot: { openPullRequests: [prFixture({ headRef: "feature/rogue" })] },
    intelligence,
  });
  const result = await supervisor.tick();
  assert.deepEqual(result.cycle.merged, []);
});

test("harvest: draft PRs are skipped entirely", async () => {
  const intelligence = fakeIntelligence([]);
  const { supervisor } = makeSupervisor({
    snapshot: { openPullRequests: [prFixture({ draft: true })] },
    intelligence,
  });
  const result = await supervisor.tick();
  assert.deepEqual(result.cycle.merged, []);
});

test("review: REQUIRE-CHANGES verdict comments and holds the PR (fail-closed)", async () => {
  const intelligence = fakeIntelligence(["REQUIRE-CHANGES: needs evidence links"]);
  const config = baseConfig({ safety: { ...DEFAULT_CONFIG.safety, requireIntelligenceReview: true } });
  const { supervisor } = makeSupervisor({
    snapshot: { openPullRequests: [prFixture()] },
    intelligence,
    config,
  });
  const result = await supervisor.tick();
  assert.deepEqual(result.cycle.merged, []);
  assert.equal(result.cycle.reviewed[0].verdict, "require-changes");
  assert.equal(result.cycle.reviewed[0].reason, "needs evidence links");
});

test("review: driver failure holds the PR open (no merge on uncertainty)", async () => {
  const intelligence = fakeIntelligence([]); // script exhausted -> failure
  const config = baseConfig({ safety: { ...DEFAULT_CONFIG.safety, requireIntelligenceReview: true } });
  const { supervisor } = makeSupervisor({
    snapshot: { openPullRequests: [prFixture()] },
    intelligence,
    config,
  });
  const result = await supervisor.tick();
  assert.deepEqual(result.cycle.merged, []);
  assert.ok(result.cycle.errors.some((e) => /review driver failed/.test(e)));
});

test("dispatch: empty queue + DISPATCH directive creates the issue", async () => {
  const intelligence = fakeIntelligence([
    "DISPATCH: WO-2 — the next lane\n```\nBody of the work order.\n```",
  ]);
  const { supervisor, entries } = makeSupervisor({ snapshot: {}, intelligence });
  const result = await supervisor.tick();
  assert.equal(result.cycle.dispatched.number, 42);
  assert.equal(result.cycle.dispatched.title, "WO-2 — the next lane");
  assert.ok(entries.some((e) => e.kind === "dispatch" && /issue #42/.test(e.message)));
});

test("dispatch: WAIT directive rests honestly", async () => {
  const intelligence = fakeIntelligence(["WAIT: roadmap complete — owner decision pending"]);
  const { supervisor } = makeSupervisor({ snapshot: {}, intelligence });
  const result = await supervisor.tick();
  assert.equal(result.cycle.waited, "roadmap complete — owner decision pending");
  assert.equal(result.cycle.dispatched, null);
});

test("dispatch: unparsed replies are recorded verbatim and treated as WAIT", async () => {
  const intelligence = fakeIntelligence(["I think everything looks fine today!"]);
  const { supervisor, entries } = makeSupervisor({ snapshot: {}, intelligence });
  const result = await supervisor.tick();
  assert.match(result.cycle.waited, /unparsed/);
  assert.ok(entries.some((e) => e.level === "warn" && /unparsed intelligence reply/.test(e.message)));
});

test("dispatch: driver unavailable (deterministic-only mode) waits honestly", async () => {
  const intelligence = fakeIntelligence([]); // exhausted
  const { supervisor } = makeSupervisor({ snapshot: {}, intelligence });
  const result = await supervisor.tick();
  assert.match(result.cycle.waited, /intelligence unavailable/);
});

test("dispatch is skipped while issues are still open (queue non-empty)", async () => {
  const intelligence = fakeIntelligence(["WAIT: never asked"]);
  const { supervisor, entries } = makeSupervisor({
    snapshot: { openIssues: [{ number: 41, title: "open work order", state: "open", labels: [], createdAt: "" }] },
    intelligence,
  });
  await supervisor.tick();
  assert.ok(!entries.some((e) => e.kind === "dispatch" && /WAIT/.test(e.message)));
});

test("monitor failure returns a typed failure without crashing the loop", async () => {
  const intelligence = fakeIntelligence([]);
  const gh = fakeGithub([{ method: "GET", path: /^\/repos\/org\/repo$/, status: 500, body: "boom" }]);
  void gh;
  const github = {
    getSnapshot: async () => {
      throw new Error("HTTP 500 on /repos/org/repo: boom");
    },
    mergePullRequest: async () => ({}),
    comment: async () => ({}),
    createIssue: async () => ({}),
  };
  const { log } = fakeLog();
  const supervisor = createSupervisor({ github, intelligence, config: baseConfig(), log });
  const result = await supervisor.tick();
  assert.equal(result.ok, false);
  assert.ok(result.cycle.errors[0].includes("monitor failed"));
});
