/**
 * Intelligence layer tests: directive parsing, briefs, local-http driver,
 * driver selection, and the honest none-driver.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDispatchBrief,
  buildReviewBrief,
  createDriverFromConfig,
  createLocalHttpDriver,
  createNoneDriver,
  parseDirective,
} from "../src/intelligence.js";
import { DEFAULT_CONFIG } from "../src/config.js";

test("parseDirective: DISPATCH with fenced body", () => {
  const directive = parseDirective("here is the plan\nDISPATCH: WO-9 — the lane\n```\nBody text\nline 2\n```\ntail");
  assert.equal(directive.action, "dispatch");
  assert.equal(directive.title, "WO-9 — the lane");
  assert.equal(directive.body, "Body text\nline 2");
});

test("parseDirective: WAIT with reason", () => {
  const directive = parseDirective("DISPATCH considered but no.\nWAIT: owner decision pending");
  assert.equal(directive.action, "wait");
  assert.equal(directive.reason, "owner decision pending");
});

test("parseDirective: review verdicts", () => {
  assert.equal(parseDirective("everything verified\nAPPROVE").action, "approve");
  const rc = parseDirective("REQUIRE-CHANGES: missing tests");
  assert.equal(rc.action, "require-changes");
  assert.equal(rc.reason, "missing tests");
  assert.equal(parseDirective("DEFER").action, "defer");
});

test("parseDirective: unparsed -> honest unparsed action", () => {
  const directive = parseDirective("sounds good to me!");
  assert.equal(directive.action, "unparsed");
});

test("buildDispatchBrief embeds the repository state", () => {
  const brief = buildDispatchBrief(
    { mainHead: "deadbeef", openPullRequests: [], openIssues: [] },
    { github: { owner: "payswapdotorg", repo: "arena-2.0" } },
  );
  assert.match(brief, /payswapdotorg\/arena-2.0/);
  assert.match(brief, /deadbeef/);
  assert.match(brief, /DISPATCH:/);
});

test("buildReviewBrief embeds the PR facts", () => {
  const brief = buildReviewBrief(
    { mainHead: "deadbeef" },
    { number: 7, title: "the lane", headRef: "work/x", headSha: "abc", checkState: "green", mergeable: true, draft: false },
    { github: { owner: "o", repo: "r" } },
  );
  assert.match(brief, /#7/);
  assert.match(brief, /work\/x/);
  assert.match(brief, /APPROVE/);
});

test("local-http driver: happy path maps .reply", async () => {
  const driver = createLocalHttpDriver("http://127.0.0.1:9000/ask", async () =>
    new Response(JSON.stringify({ reply: "WAIT: acknowledged" }), { status: 200 }),
  );
  const result = await driver.ask({ kind: "dispatch", brief: "b" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "WAIT: acknowledged");
});

test("local-http driver: .text field also accepted", async () => {
  const driver = createLocalHttpDriver("http://127.0.0.1:9000/ask", async () =>
    new Response(JSON.stringify({ text: "APPROVE" }), { status: 200 }),
  );
  const result = await driver.ask({ kind: "review", brief: "b" });
  assert.equal(result.text, "APPROVE");
});

test("local-http driver: unreachable endpoint is a typed failure", async () => {
  const driver = createLocalHttpDriver("http://127.0.0.1:1/ask", async () => {
    throw new Error("refused");
  });
  const result = await driver.ask({ kind: "review", brief: "b" });
  assert.equal(result.ok, false);
  assert.match(result.error, /unreachable/);
});

test("local-http driver: HTTP error status is a typed failure", async () => {
  const driver = createLocalHttpDriver("http://127.0.0.1:9000/ask", async () => new Response("nope", { status: 503 }));
  const result = await driver.ask({ kind: "review", brief: "b" });
  assert.equal(result.ok, false);
  assert.match(result.error, /503/);
});

test("driver selection from config", async () => {
  const local = createDriverFromConfig(
    { intelligence: { driver: "local-http", localEndpoint: "http://127.0.0.1:2/ask" } },
    null,
    async () => {
      throw new Error("refused");
    },
  );
  assert.equal(local.kind, "local-http");
  const none = createDriverFromConfig({ intelligence: { driver: "none", localEndpoint: "" } }, null);
  assert.equal(none.kind, "none");
  const noneResult = await none.ask({ kind: "review", brief: "b" });
  assert.equal(noneResult.ok, false);
});

test("chatzai-web selection falls back to none when no chat driver is supplied", async () => {
  const driver = createDriverFromConfig({ intelligence: { driver: "chatzai-web", localEndpoint: "" } }, null);
  const result = await driver.ask({ kind: "review", brief: "b" });
  assert.equal(result.ok, false);
});

void DEFAULT_CONFIG;
