/**
 * Authority-surface projection tests (CTRL-012): structural validation,
 * the two-surface agreement checks, the pinned-SHA read discipline,
 * and the typed fail-closed error classes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LIFECYCLE_STATES,
  STATE_FILE_PATH,
  SUPPORTED_SCHEMA_VERSION,
  parseMachineState,
  parseWorkOrderStatus,
  projectAuthorityState,
} from "../src/authority.js";
import { ControllerContentClient } from "../src/controllerClient.js";
import {
  FIXTURE_REPOSITORY,
  FIXTURE_SHA,
  fixtureMachineState,
  fixtureWorkOrder,
  fakeAuthorityFetch,
} from "./fixtures.js";

test("the frozen lifecycle vocabulary matches the architecture's state machine", () => {
  assert.deepEqual([...LIFECYCLE_STATES], [
    "READY", "DISPATCHED", "IMPLEMENTING", "PR_OPEN", "CI_PENDING",
    "REVIEW_PENDING", "CHANGES_REQUESTED", "APPROVED", "MERGING",
    "MERGED", "RECONCILING", "COMPLETE", "NEXT_READY",
    "BLOCKED", "ESCALATED", "CANCELLED",
  ]);
  assert.equal(STATE_FILE_PATH, "spec/state/controller-program-state.json");
  assert.equal(SUPPORTED_SCHEMA_VERSION, "0.1");
});

test("the fixture machine state parses (shape-faithful to the live surface)", () => {
  const parsed = parseMachineState(fixtureMachineState());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.machineState.activeWorkItem, "CTRL-012");
  assert.equal(parsed.machineState.status, "READY");
  assert.equal(parsed.machineState.repository, FIXTURE_REPOSITORY);
});

test("malformed machine states fail closed as AUTHORITY_MALFORMED", () => {
  const bad = [
    "not json {",
    "42",
    "null",
    "[]",
    JSON.stringify({}), // empty object: missing every field
    JSON.stringify({ schemaVersion: "0.2", repository: "a/b" }), // unsupported schema
    JSON.stringify({ ...JSON.parse(fixtureMachineState()), status: "HAPPY" }), // unknown state
    JSON.stringify({ ...JSON.parse(fixtureMachineState()), completed: "CTRL-001" }), // not a list
    JSON.stringify({ ...JSON.parse(fixtureMachineState()), completed: [1] }), // not string items
    JSON.stringify({ ...JSON.parse(fixtureMachineState()), rules: [] }), // rules not an object
    JSON.stringify({ ...JSON.parse(fixtureMachineState()), nextAction: "" }), // empty string field
    JSON.stringify({ ...JSON.parse(fixtureMachineState()), activeWorkItem: 12 }),
  ];
  for (const text of bad) {
    const parsed = parseMachineState(text);
    assert.equal(parsed.ok, false, text.slice(0, 60));
    assert.equal(parsed.error.code, "AUTHORITY_MALFORMED", text.slice(0, 60));
  }
});

test("the machine state rules VALUES are not evaluated here (no predicate duplication)", () => {
  // A rules object with 'wrong' values still parses structurally: the
  // governance rules predicate belongs to the Controller core, and the
  // extension must not re-implement it.
  const withOddRules = JSON.stringify({
    ...JSON.parse(fixtureMachineState()),
    rules: { repositoryIsSourceOfTruth: false },
  });
  const parsed = parseMachineState(withOddRules);
  assert.equal(parsed.ok, true);
});

test("work-order status parsing follows the frozen grammar", () => {
  const ok = parseWorkOrderStatus(fixtureWorkOrder(), "CTRL-012");
  assert.equal(ok.ok, true);
  assert.equal(ok.status, "READY");

  const noHeading = parseWorkOrderStatus("Status: `READY`\n", "CTRL-012");
  assert.equal(noHeading.error.code, "AUTHORITY_MALFORMED");

  const wrongHeading = parseWorkOrderStatus("# CTRL-013 — Title\n\nStatus: `READY`\n", "CTRL-012");
  assert.equal(wrongHeading.error.code, "AUTHORITY_CONTRADICTORY");

  const noStatus = parseWorkOrderStatus("# CTRL-012 — Title\n", "CTRL-012");
  assert.equal(noStatus.error.code, "AUTHORITY_MALFORMED");

  const ungrammatical = parseWorkOrderStatus("# CTRL-012 — Title\n\nStatus: READY\n", "CTRL-012");
  assert.equal(ungrammatical.error.code, "AUTHORITY_MALFORMED");

  const unknownState = parseWorkOrderStatus("# CTRL-012 — Title\n\nStatus: `HAPPY`\n", "CTRL-012");
  assert.equal(unknownState.error.code, "AUTHORITY_MALFORMED");
});

test("projectAuthorityState reads BOTH surfaces at ONE observed SHA (no mixed-commit read)", async () => {
  const fake = fakeAuthorityFetch();
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, true);
  assert.equal(result.state.activeWorkItem, "CTRL-012");
  assert.equal(result.state.lifecycleStatus, "READY");
  assert.equal(result.state.automationStage, "STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP");
  assert.equal(result.state.completed.length, 11);
  assert.equal(result.state.provenance.sha, FIXTURE_SHA);
  assert.equal(result.state.provenance.ref, "main");
  const rawReads = fake.requested.filter((url) => url.includes("raw.githubusercontent.com"));
  assert.equal(rawReads.length, 2);
  for (const url of rawReads) {
    assert.match(url, new RegExp(`/${FIXTURE_SHA}/`), url);
  }
});

test("the projection is deterministic (two equal runs, equal states)", async () => {
  const run = async () => {
    const fake = fakeAuthorityFetch();
    const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
    return projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  };
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b);
});

test("a 404 repository fails closed as AUTHORITY_MISSING", async () => {
  const fake = fakeAuthorityFetch({ repositoryStatus: 404 });
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: "ghost/none" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_MISSING");
});

test("a repository without the machine state fails closed as AUTHORITY_MISSING", async () => {
  const fake = fakeAuthorityFetch({ stateStatus: 404 });
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_MISSING");
  assert.match(result.error.message, /Controller repository/);
});

test("a missing work order for the declared active item fails closed", async () => {
  const fake = fakeAuthorityFetch({ workOrderStatus: 404 });
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_MISSING");
  assert.match(result.error.message, /CTRL-012/);
});

test("transport failures fail closed as AUTHORITY_UNAVAILABLE (never guessed)", async () => {
  for (const transportFailures of [[new Error("network down")], [new Error("DNS failure")]]) {
    const fake = fakeAuthorityFetch({ transportFailures });
    const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
    const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "AUTHORITY_UNAVAILABLE");
  }
});

test("HTTP 500 surfaces fail closed as AUTHORITY_UNAVAILABLE", async () => {
  const fake = fakeAuthorityFetch({ repositoryStatus: 500 });
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_UNAVAILABLE");
});

test("surface disagreement fails closed as AUTHORITY_CONTRADICTORY", async () => {
  const machineState = fixtureMachineState({ status: "IMPLEMENTING" });
  const fake = fakeAuthorityFetch({ machineState }); // work order still says READY
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_CONTRADICTORY");
  assert.match(result.error.message, /IMPLEMENTING/);
  assert.match(result.error.message, /READY/);
});

test("repository identity disagreement fails closed as AUTHORITY_CONTRADICTORY", async () => {
  const fake = fakeAuthorityFetch({
    machineState: fixtureMachineState({ repository: "other/repository" }),
  });
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_CONTRADICTORY");
  assert.match(result.error.message, /other\/repository/);
});

test("malformed machine state content fails closed as AUTHORITY_MALFORMED", async () => {
  const fake = fakeAuthorityFetch({ machineState: "{ not json" });
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: FIXTURE_REPOSITORY });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_MALFORMED");
});

test("an invalid selected repository is refused before any network read", async () => {
  const fake = fakeAuthorityFetch();
  const client = new ControllerContentClient({ fetchImpl: fake.fetchImpl });
  const result = await projectAuthorityState({ client, repository: "not a repo" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_REPOSITORY");
  assert.equal(fake.requested.length, 0);
});

test("GET-only client: no request carries a mutation method", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), method: options?.method });
    return {
      status: 404,
      ok: false,
      text: async () => "",
    };
  };
  const client = new ControllerContentClient({ fetchImpl });
  await client.rawFile("o", "n", "deadbeef", "x");
  for (const request of seen) {
    assert.equal(request.method, "GET");
  }
});
