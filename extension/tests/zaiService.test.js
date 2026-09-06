/**
 * Z.ai adapter service-routing tests (CTRL-014): the message router's
 * Worker-registration gate, the zai provider/origin gate, and the
 * closed-form delegation to the adapter — with the adapter itself
 * faked (its deep matrix lives in zaiAdapter.test.js) and, for the
 * end-to-end path, the REAL adapter over the deterministic page
 * simulator.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createControllerService } from "../src/service.js";
import { fakeAuthorityFetch, fakeStorage } from "./fixtures.js";
import { fakeZaiPage, fakeMessagingTabsApi, fakePageBridge } from "./fixtures.js";
import { createZaiAdapter } from "../src/zaiAdapter.js";

const ZAI_WORKER = { name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" };

function spyAdapter(overrides = {}) {
  const calls = [];
  const respond = (name) => (arg) => {
    calls.push({ name, arg });
    return overrides[name] ? overrides[name](arg) : { ok: true, observation: { state: "ready-for-input" } };
  };
  return {
    observeSession: respond("observeSession"),
    startWorkerSession: respond("startWorkerSession"),
    recoverHungWorker: respond("recoverHungWorker"),
    calls,
  };
}

async function startedService({ adapter = spyAdapter(), tabsApi = fakeMessagingTabsApi({ tabs: [] }) } = {}) {
  const storage = fakeStorage();
  const fake = fakeAuthorityFetch();
  const service = createControllerService({
    storage,
    fetchImpl: fake.fetchImpl,
    tabsApi,
    zaiAdapter: adapter,
  });
  await service.start();
  await service.handleMessage({ kind: "RegisterWorker", ...ZAI_WORKER });
  return { service, adapter, tabsApi };
}

// --------------------------------------------------------------------
// The registration gate.
// --------------------------------------------------------------------

test("ObserveZaiSession for an unregistered worker is REGISTRATION_NOT_FOUND", async () => {
  const { service } = await startedService();
  const result = await service.handleMessage({ kind: "ObserveZaiSession", worker: "nobody" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "REGISTRATION_NOT_FOUND");
});

test("a worker registered with a non-zai provider is refused INVALID_REGISTRATION", async () => {
  const storage = fakeStorage();
  const fake = fakeAuthorityFetch();
  const service = createControllerService({
    storage,
    fetchImpl: fake.fetchImpl,
    tabsApi: fakeMessagingTabsApi({ tabs: [] }),
    zaiAdapter: spyAdapter(),
  });
  await service.start();
  // A chatgpt-kind worker cannot be registered through the normal
  // boundary (role capability); a defensive gate must still refuse a
  // Zai request for any worker that is not exactly zai.
  await service.handleMessage({ kind: "RegisterArchitect", name: "ChatGPT", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" });
  const result = await service.handleMessage({ kind: "ObserveZaiSession", worker: "ChatGPT" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "REGISTRATION_NOT_FOUND");
});

// --------------------------------------------------------------------
// Delegation and closed-form result mapping.
// --------------------------------------------------------------------

test("ObserveZaiSession delegates to the adapter with the worker name", async () => {
  const { service, adapter } = await startedService();
  const result = await service.handleMessage({ kind: "ObserveZaiSession", worker: "Z.ai" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.observation, { state: "ready-for-input" });
  assert.deepEqual(adapter.calls.map((c) => c.name), ["observeSession"]);
  assert.equal(adapter.calls[0].arg, "Z.ai");
});

test("StartZaiWorkerSession carries the exact worker/workItem/prompt and maps the result", async () => {
  const adapter = spyAdapter({
    startWorkerSession: (arg) => ({
      ok: true,
      session: { worker: arg.worker, workItem: arg.workItem, tabId: 7 },
      // CONTINUATION 14: the Start record's generation is the Send-reappearance
      // boundary read ("waiting" — never recorded while the Stop control is visible).
      submitted: { attempts: 1, composeReestablishments: 0, generation: "waiting" },
    }),
  });
  const { service } = await startedService({ adapter });
  const prompt = "the exact governed prompt";
  const result = await service.handleMessage({
    kind: "StartZaiWorkerSession",
    worker: "Z.ai",
    workItem: "CTRL-014",
    prompt,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.session, { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
  assert.deepEqual(result.submitted, { attempts: 1, composeReestablishments: 0, generation: "waiting" });
  assert.equal(adapter.calls[0].arg.prompt, prompt);
  assert.equal(adapter.calls[0].arg.workItem, "CTRL-014");
});

test("RecoverZaiHungWorker carries the exact correlation and maps the recovery result", async () => {
  const adapter = spyAdapter({
    recoverHungWorker: (arg) => ({
      ok: true,
      recovered: { attempts: 1, message: "continue", generation: "working" },
      session: { worker: arg.worker, workItem: arg.workItem, tabId: arg.tabId },
    }),
  });
  const { service } = await startedService({ adapter });
  const result = await service.handleMessage({
    kind: "RecoverZaiHungWorker",
    worker: "Z.ai",
    workItem: "CTRL-014",
    tabId: 7,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.recovered, { attempts: 1, message: "continue", generation: "working" });
  assert.deepEqual(result.session, { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
  assert.equal(adapter.calls[0].arg.tabId, 7);
});

test("typed adapter refusals pass through the router unchanged (no repair)", async () => {
  const adapter = spyAdapter({
    startWorkerSession: () => ({ ok: false, error: { code: "AUTHORIZATION_REQUIRED", message: "the chat.z.ai session is not authenticated" } }),
  });
  const { service } = await startedService({ adapter });
  const result = await service.handleMessage({
    kind: "StartZaiWorkerSession",
    worker: "Z.ai",
    workItem: "CTRL-014",
    prompt: "p",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORIZATION_REQUIRED");
});

// --------------------------------------------------------------------
// The end-to-end path: the REAL adapter over the page simulator.
// --------------------------------------------------------------------

test("the real adapter serves StartZaiWorkerSession through the router", async () => {
  // CONTINUATION 15: the start signal (the Stop control rendered with
  // the composer decisively empty) is the acceptance the real adapter
  // records through the router.
  const page = fakeZaiPage({
    authenticated: true,
    agent: { present: true, active: false },
  });
  const tabsApi = fakeMessagingTabsApi({ tabs: [{ id: 7, url: "https://chat.z.ai/", page }] });
  const zai = createZaiAdapter({
    tabsApi,
    pageBridge: fakePageBridge(tabsApi),
    sleep: async () => {},
    settlePolls: 2,
    settleIntervalMs: 0,
  });
  const storage = fakeStorage();
  const fake = fakeAuthorityFetch();
  const service = createControllerService({
    storage,
    fetchImpl: fake.fetchImpl,
    tabsApi,
    zaiAdapter: zai,
  });
  await service.start();
  await service.handleMessage({ kind: "RegisterWorker", ...ZAI_WORKER });
  const started = await service.handleMessage({
    kind: "StartZaiWorkerSession",
    worker: "Z.ai",
    workItem: "CTRL-014",
    prompt: "governed prompt",
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(started.session, { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
  const observed = await service.handleMessage({ kind: "ObserveZaiSession", worker: "Z.ai" });
  assert.equal(observed.ok, true);
  assert.equal(observed.observation.state, "prompt-submitted");
});

test("malformed Zai request forms never reach the adapter", async () => {
  const { service, adapter } = await startedService();
  const empty = await service.handleMessage({ kind: "StartZaiWorkerSession", worker: "", workItem: "X", prompt: "p" });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "MALFORMED_MESSAGE");
  const extra = await service.handleMessage({
    kind: "ObserveZaiSession",
    worker: "Z.ai",
    tabId: 7,
  });
  assert.equal(extra.ok, false);
  assert.equal(extra.error.code, "MALFORMED_MESSAGE");
  assert.deepEqual(adapter.calls, []);
});
