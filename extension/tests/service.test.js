/**
 * End-to-end service tests (CTRL-012): the message router over fully
 * injected fakes (storage, fetch, tabs) — every request kind, every
 * refusal class, and the no-partial-write proofs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createControllerService } from "../src/service.js";
import { fakeAuthorityFetch, fakeStorage, fakeTabsApi } from "./fixtures.js";

const ZAI = { name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" };
const CHATGPT = { name: "ChatGPT", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" };

async function startedService(overrides = {}) {
  const storage = overrides.storage ?? fakeStorage();
  const fake = overrides.fake ?? fakeAuthorityFetch();
  const tabsApi = overrides.tabsApi ?? fakeTabsApi();
  const service = createControllerService({
    storage,
    fetchImpl: fake.fetchImpl,
    tabsApi,
  });
  await service.start();
  return { service, storage, fake, tabsApi };
}

test("the full operator flow: register, select, project, open, discover", async () => {
  const { service, tabsApi } = await startedService();

  const worker = await service.handleMessage({ kind: "RegisterWorker", ...ZAI });
  assert.equal(worker.ok, true);
  assert.equal(worker.configuration.workers.length, 1);

  const architect = await service.handleMessage({ kind: "RegisterArchitect", ...CHATGPT });
  assert.equal(architect.ok, true);
  assert.equal(architect.configuration.architects.length, 1);

  const selected = await service.handleMessage({
    kind: "SelectRepository",
    repository: "pectoraux/controller",
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.configuration.repository, "pectoraux/controller");

  const state = await service.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(state.ok, true);
  assert.equal(state.state.activeWorkItem, "CTRL-012");
  assert.equal(state.state.lifecycleStatus, "READY");
  assert.equal(state.state.provenance.sha, "398c0e8c06c2bae4cb4a864990b36cb0fd47b88f");

  const opened = await service.handleMessage({ kind: "OpenProviderTab", role: "worker", name: "Z.ai" });
  assert.equal(opened.ok, true);
  assert.equal(opened.opened.url, "https://chat.z.ai");
  assert.deepEqual(tabsApi._created(), [{ url: "https://chat.z.ai", active: true }]);

  const discovered = await service.handleMessage({ kind: "DiscoverProviderTabs", role: "architect", name: "ChatGPT" });
  assert.equal(discovered.ok, true);
  assert.deepEqual([...discovered.tabs], []);

  const configuration = await service.handleMessage({ kind: "GetConfiguration" });
  assert.equal(configuration.ok, true);
  assert.equal(configuration.configuration.workers.length, 1);
  assert.equal(configuration.configuration.architects.length, 1);
  assert.equal(configuration.configuration.repository, "pectoraux/controller");
});

test("GetAuthorityState without a selected repository is REPOSITORY_NOT_SELECTED", async () => {
  const { service, fake } = await startedService();
  const result = await service.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "REPOSITORY_NOT_SELECTED");
  assert.equal(fake.requested.length, 0);
});

test("a refused registration leaves storage byte-identical (zero writes)", async () => {
  const { service, storage } = await startedService();
  const before = JSON.stringify(storage._dump());
  const refusals = [
    { kind: "RegisterWorker", name: "Bad", providerKind: "zai", providerUrl: "https://evil.com" },
    { kind: "RegisterWorker", name: "Bad", providerKind: "claude", providerUrl: "https://chat.z.ai" },
    { kind: "RegisterArchitect", name: "Bad", providerKind: "zai", providerUrl: "https://chat.z.ai" },
    { kind: "SelectRepository", repository: "not a repo" },
  ];
  for (const request of refusals) {
    const result = await service.handleMessage(request);
    assert.equal(result.ok, false, JSON.stringify(request));
  }
  assert.equal(JSON.stringify(storage._dump()), before);
  assert.equal(storage._written().length, 0);
});

test("unknown and malformed messages fail closed and touch nothing", async () => {
  const { service, storage, fake } = await startedService();
  const before = JSON.stringify(storage._dump());
  for (const request of [
    { kind: "Merge" },
    { kind: "Approve" },
    "GetConfiguration",
    null,
    42,
    { kind: "RegisterWorker", name: "X", providerKind: "zai" },
    { kind: "RegisterWorker", ...ZAI, password: "nope" },
    { kind: "SelectRepository", repository: "a/b", token: "ghp_x" },
    { kind: "OpenProviderTab", role: "worker" },
  ]) {
    const result = await service.handleMessage(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(
      ["UNKNOWN_MESSAGE", "MALFORMED_MESSAGE"].includes(result.error.code),
      true,
      JSON.stringify(request)
    );
  }
  assert.equal(JSON.stringify(storage._dump()), before);
  assert.equal(fake.requested.length, 0);
});

test("the corrupt store refuses every request with CONFIGURATION_CORRUPT", async () => {
  const storage = fakeStorage({
    "pectoraux.controller.configuration": { schemaVersion: "0.1", workers: "not-a-list" },
  });
  const { service, fake } = await startedService({ storage });
  const before = JSON.stringify(storage._dump());
  for (const request of [
    { kind: "GetConfiguration" },
    { kind: "RegisterWorker", ...ZAI },
    { kind: "SelectRepository", repository: "pectoraux/controller" },
    { kind: "GetAuthorityState" },
    { kind: "OpenProviderTab", role: "worker", name: "Z.ai" },
  ]) {
    const result = await service.handleMessage(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "CONFIGURATION_CORRUPT", JSON.stringify(request));
  }
  assert.equal(fake.requested.length, 0);
  assert.equal(JSON.stringify(storage._dump()), before); // no silent self-repair
});

test("a second service instance over the same storage reconstructs state (restart-safe)", async () => {
  const storage = fakeStorage();
  const first = createControllerService({ storage, fetchImpl: fakeAuthorityFetch().fetchImpl, tabsApi: fakeTabsApi() });
  await first.start();
  await first.handleMessage({ kind: "RegisterWorker", ...ZAI });
  await first.handleMessage({ kind: "SelectRepository", repository: "pectoraux/controller" });

  const fake = fakeAuthorityFetch();
  const second = createControllerService({ storage, fetchImpl: fake.fetchImpl, tabsApi: fakeTabsApi() });
  await second.start();
  const configuration = await second.handleMessage({ kind: "GetConfiguration" });
  assert.equal(configuration.ok, true);
  assert.equal(configuration.configuration.workers.length, 1);
  assert.equal(configuration.configuration.repository, "pectoraux/controller");
  const state = await second.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(state.ok, true);
  assert.equal(state.state.activeWorkItem, "CTRL-012");
});

test("unknown registrations for provider-tab actions are REGISTRATION_NOT_FOUND", async () => {
  const { service } = await startedService();
  for (const request of [
    { kind: "OpenProviderTab", role: "worker", name: "Ghost" },
    { kind: "DiscoverProviderTabs", role: "architect", name: "Ghost" },
  ]) {
    const result = await service.handleMessage(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "REGISTRATION_NOT_FOUND");
  }
});

test("authority failures propagate typed through the boundary", async () => {
  for (const scenario of [
    { repositoryStatus: 404, code: "AUTHORITY_MISSING" },
    { repositoryStatus: 500, code: "AUTHORITY_UNAVAILABLE" },
    { stateStatus: 404, code: "AUTHORITY_MISSING" },
    { workOrderStatus: 404, code: "AUTHORITY_MISSING" },
    { transportFailures: [new Error("offline")], code: "AUTHORITY_UNAVAILABLE" },
  ]) {
    const fake = fakeAuthorityFetch(scenario);
    const { service } = await startedService({ fake });
    await service.handleMessage({ kind: "SelectRepository", repository: "pectoraux/controller" });
    const result = await service.handleMessage({ kind: "GetAuthorityState" });
    assert.equal(result.ok, false, JSON.stringify(scenario));
    assert.equal(result.error.code, scenario.code, JSON.stringify(scenario));
  }
});

test("contradictory authority surfaces surface as AUTHORITY_CONTRADICTORY", async () => {
  const fake = fakeAuthorityFetch({
    machineState: JSON.stringify({
      ...JSON.parse(fakeAuthorityFetchFetchState()),
      status: "IMPLEMENTING",
    }),
  });
  const { service } = await startedService({ fake });
  await service.handleMessage({ kind: "SelectRepository", repository: "pectoraux/controller" });
  const result = await service.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_CONTRADICTORY");
});

test("the service fails closed before start", async () => {
  const service = createControllerService({
    storage: fakeStorage(),
    fetchImpl: fakeAuthorityFetch().fetchImpl,
    tabsApi: fakeTabsApi(),
  });
  const result = await service.handleMessage({ kind: "GetConfiguration" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
});

test("a fetch throwing a NON-Error value is still typed (never an escape)", async () => {
  const explodingFetch = async () => {
    throw "not even an Error object";
  };
  const { service } = await startedService({ fake: { fetchImpl: explodingFetch, requested: [] } });
  await service.handleMessage({ kind: "SelectRepository", repository: "pectoraux/controller" });
  const result = await service.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORITY_UNAVAILABLE");
});

test("an exception escaping validation is caught as INTERNAL_ERROR (fail closed)", async () => {
  const { service } = await startedService();
  const hostile = new Proxy({}, {
    get() {
      throw new Error("hostile accessor");
    },
  });
  const result = await service.handleMessage(hostile);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INTERNAL_ERROR");
});

test("the service performs only GET requests (no mutation capability)", async () => {
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options?.method ?? "GET");
    return { status: 404, ok: false, text: async () => "" };
  };
  const { service } = await startedService({ fake: { fetchImpl, requested: [] } });
  await service.handleMessage({ kind: "SelectRepository", repository: "pectoraux/controller" });
  await service.handleMessage({ kind: "GetAuthorityState" });
  for (const method of methods) {
    assert.equal(method, "GET");
  }
});

function fakeAuthorityFetchFetchState() {
  // The base machine-state fixture text (kept import-free here).
  return JSON.stringify({
    schemaVersion: "0.1",
    repository: "pectoraux/controller",
    roadmap: "spec/roadmap/roadmap.md",
    architecture: "spec/architecture/controller-architecture.md",
    buildProcess: "spec/operations/controller-build-process.md",
    activeWorkItem: "CTRL-012",
    status: "READY",
    automationStage: "STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP",
    completed: ["CTRL-001"],
    rules: {},
    nextAction: "fixture",
  });
}
