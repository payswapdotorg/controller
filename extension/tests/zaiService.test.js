/**
 * Z.ai adapter service-routing tests (CTRL-014): the message router's
 * Worker-registration gate, the zai provider/origin gate, and the
 * closed-form delegation to the adapter — with the adapter itself
 * faked (its deep matrix lives in zaiAdapter.test.js) and, for the
 * end-to-end path, the REAL adapter over the deterministic page
 * simulator. CONTINUATION 26 adds the resident-supervision routing
 * (continuation 24's five kinds — SendZaiTurn / RelaunchZaiSession /
 * the keepalive arm/disarm/observe over an injected fake watchdog)
 * and the startup alarm-schedule restore over the service surface.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createControllerService } from "../src/service.js";
import { fakeAuthorityFetch, fakeStorage } from "./fixtures.js";
import { fakeZaiPage, fakeMessagingTabsApi, fakePageBridge } from "./fixtures.js";
import { createZaiAdapter } from "../src/zaiAdapter.js";
import { KEEPALIVE_ALARM_PREFIX, KEEPALIVE_STORE_KEY } from "../src/keepalive.js";

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
    sendTurn: respond("sendTurn"),
    relaunchSession: respond("relaunchSession"),
    calls,
  };
}

/**
 * A fake keepalive watchdog recording arm/disarm/observe calls (the
 * router's supervision kinds route here exactly as the Zai kinds
 * route to the adapter). It deliberately carries NO restoreAlarms —
 * the restore-wrapper tests inject that capability explicitly.
 */
function spyWatchdog(overrides = {}) {
  const calls = [];
  const respond = (name) => (arg) => {
    calls.push({ name, arg });
    return overrides[name] ? overrides[name](arg) : { ok: true };
  };
  return {
    arm: respond("arm"),
    disarm: respond("disarm"),
    observe: respond("observe"),
    calls,
  };
}

/**
 * A fake chrome.alarms surface for the built-in keepalive: create
 * registers into the live schedule, get looks it up — a FRESH
 * instance models the schedule a service-worker restart left empty
 * while the armed records persisted.
 */
function fakeAlarmsSurface() {
  const created = [];
  const scheduled = new Map();
  return {
    created,
    create: async (name, info) => {
      created.push({ name, info });
      scheduled.set(name, info);
    },
    clear: async (name) => {
      scheduled.delete(name);
    },
    get: async (name) => (scheduled.has(name) ? { name, info: scheduled.get(name) } : undefined),
  };
}

async function startedService({ adapter = spyAdapter(), tabsApi = fakeMessagingTabsApi({ tabs: [] }), watchdog } = {}) {
  const storage = fakeStorage();
  const fake = fakeAuthorityFetch();
  const service = createControllerService({
    storage,
    fetchImpl: fake.fetchImpl,
    tabsApi,
    zaiAdapter: adapter,
    ...(watchdog ? { keepaliveWatchdog: watchdog } : {}),
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
      // CONTINUATION 22: the frozen FOUR-FIELD submitted record (attempts,
      // popupDismissals, composeReestablishments, generation — the pre-c13
      // invariant restored with the known-popup recovery).
      submitted: { attempts: 1, popupDismissals: 0, composeReestablishments: 0, generation: "working" },
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
  assert.deepEqual(result.submitted, { attempts: 1, popupDismissals: 0, composeReestablishments: 0, generation: "working" });
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

// --------------------------------------------------------------------
// CTRL-014 continuation 24/26: the resident-supervision routing —
// SendZaiTurn / RelaunchZaiSession to the adapter, the keepalive
// kinds to the watchdog, the Worker gate BEFORE any call, and the
// boundary's malformed refusal BEFORE the gate.
// --------------------------------------------------------------------

test("SendZaiTurn routes to the adapter's sendTurn with the exact validated fields, result verbatim", async () => {
  const turn = {
    ok: true,
    worker: "Z.ai",
    tabId: 7,
    attempts: 1,
    popupDismissals: 0,
    composeReestablishments: 0,
    generation: "working",
  };
  const adapter = spyAdapter({ sendTurn: () => turn });
  const { service } = await startedService({ adapter });
  const result = await service.handleMessage({
    kind: "SendZaiTurn",
    worker: "Z.ai",
    tabId: 7,
    prompt: "the exact governed turn text",
  });
  assert.deepEqual(result, turn); // verbatim — the router maps nothing on this kind
  assert.deepEqual(adapter.calls, [
    { name: "sendTurn", arg: { worker: "Z.ai", tabId: 7, prompt: "the exact governed turn text" } },
  ]);
});

test("SendZaiTurn refusals pass through the router verbatim (no repair)", async () => {
  const refusal = { ok: false, error: { code: "AMBIGUOUS_STATE", message: "a generation is in flight — a second turn is never submitted" } };
  const adapter = spyAdapter({ sendTurn: () => refusal });
  const { service } = await startedService({ adapter });
  const result = await service.handleMessage({ kind: "SendZaiTurn", worker: "Z.ai", tabId: 7, prompt: "p" });
  assert.deepEqual(result, refusal);
});

test("RelaunchZaiSession routes to relaunchSession with the session URL and the null home pass-through", async () => {
  const relaunched = {
    ok: true,
    session: { worker: "Z.ai", tabId: 9 },
    reused: false,
    popupDismissals: 1,
    observation: { state: "ready-for-input" },
  };
  const adapter = spyAdapter({ relaunchSession: () => relaunched });
  const { service } = await startedService({ adapter });
  const atUrl = await service.handleMessage({
    kind: "RelaunchZaiSession",
    worker: "Z.ai",
    sessionUrl: "https://chat.z.ai/c/abc",
  });
  assert.deepEqual(atUrl, relaunched);
  const atHome = await service.handleMessage({ kind: "RelaunchZaiSession", worker: "Z.ai", sessionUrl: null });
  assert.deepEqual(atHome, relaunched);
  assert.deepEqual(adapter.calls.map((c) => c.name), ["relaunchSession", "relaunchSession"]);
  assert.deepEqual(adapter.calls[0].arg, { worker: "Z.ai", sessionUrl: "https://chat.z.ai/c/abc" });
  assert.deepEqual(adapter.calls[1].arg, { worker: "Z.ai", sessionUrl: null }); // the null home passes through untouched
});

test("RelaunchZaiSession refusals pass through the router verbatim", async () => {
  const refusal = { ok: false, error: { code: "AMBIGUOUS_STATE", message: "more than one tab matches the session URL — never a guess" } };
  const adapter = spyAdapter({ relaunchSession: () => refusal });
  const { service } = await startedService({ adapter });
  const result = await service.handleMessage({ kind: "RelaunchZaiSession", worker: "Z.ai", sessionUrl: "https://chat.z.ai/c/abc" });
  assert.deepEqual(result, refusal);
});

test("ArmZaiKeepalive routes to the watchdog with the exact validated fields", async () => {
  const armed = {
    ok: true,
    keepalive: { worker: "Z.ai", tabId: 7, sessionUrl: null, periodMinutes: 2, armedAt: 1, consecutiveUnreachable: 0, lastCheck: null, lastState: null, checks: 0 },
  };
  const watchdog = spyWatchdog({ arm: () => armed });
  const { service } = await startedService({ watchdog });
  const result = await service.handleMessage({
    kind: "ArmZaiKeepalive",
    worker: "Z.ai",
    tabId: 7,
    sessionUrl: null,
    periodMinutes: 2,
  });
  assert.deepEqual(result, armed);
  assert.deepEqual(watchdog.calls, [
    { name: "arm", arg: { worker: "Z.ai", tabId: 7, sessionUrl: null, periodMinutes: 2 } },
  ]);
});

test("DisarmZaiKeepalive routes to the watchdog's disarm", async () => {
  const disarmed = { ok: true, disarmed: true };
  const watchdog = spyWatchdog({ disarm: () => disarmed });
  const { service } = await startedService({ watchdog });
  const result = await service.handleMessage({ kind: "DisarmZaiKeepalive", worker: "Z.ai" });
  assert.deepEqual(result, disarmed);
  assert.deepEqual(watchdog.calls, [{ name: "disarm", arg: { worker: "Z.ai" } }]);
});

test("ObserveZaiKeepalive routes to the watchdog's observe", async () => {
  const state = { ok: true, keepalive: { worker: "Z.ai", checks: 3, lastState: "working", events: [] } };
  const watchdog = spyWatchdog({ observe: () => state });
  const { service } = await startedService({ watchdog });
  const result = await service.handleMessage({ kind: "ObserveZaiKeepalive", worker: "Z.ai" });
  assert.deepEqual(result, state);
  assert.deepEqual(watchdog.calls, [{ name: "observe", arg: { worker: "Z.ai" } }]);
});

test("the five supervision kinds refuse REGISTRATION_NOT_FOUND before any adapter or watchdog call", async () => {
  const adapter = spyAdapter();
  const watchdog = spyWatchdog();
  const { service } = await startedService({ adapter, watchdog });
  const kinds = [
    { kind: "SendZaiTurn", tabId: 7, prompt: "p" },
    { kind: "RelaunchZaiSession", sessionUrl: null },
    { kind: "ArmZaiKeepalive", tabId: 7, sessionUrl: null, periodMinutes: null },
    { kind: "DisarmZaiKeepalive" },
    { kind: "ObserveZaiKeepalive" },
  ];
  for (const base of kinds) {
    const result = await service.handleMessage({ ...base, worker: "nobody" });
    assert.equal(result.ok, false, `${base.kind} must refuse`);
    assert.equal(result.error.code, "REGISTRATION_NOT_FOUND");
  }
  assert.deepEqual(adapter.calls, []); // the gate fired BEFORE any adapter call
  assert.deepEqual(watchdog.calls, []); // ...and before any watchdog call
});

test("a malformed SendZaiTurn never reaches the adapter (the boundary refuses first)", async () => {
  const { service, adapter } = await startedService();
  const missingTab = await service.handleMessage({ kind: "SendZaiTurn", worker: "Z.ai", prompt: "p" });
  assert.equal(missingTab.ok, false);
  assert.equal(missingTab.error.code, "MALFORMED_MESSAGE");
  const badTab = await service.handleMessage({ kind: "SendZaiTurn", worker: "Z.ai", tabId: 0, prompt: "p" });
  assert.equal(badTab.ok, false);
  assert.equal(badTab.error.code, "MALFORMED_MESSAGE");
  assert.deepEqual(adapter.calls, []);
});

test("a malformed ArmZaiKeepalive never reaches the watchdog", async () => {
  const watchdog = spyWatchdog();
  const { service } = await startedService({ watchdog });
  const badPeriod = await service.handleMessage({
    kind: "ArmZaiKeepalive",
    worker: "Z.ai",
    tabId: 7,
    sessionUrl: null,
    periodMinutes: 31, // outside the bounded 1–30 window
  });
  assert.equal(badPeriod.ok, false);
  assert.equal(badPeriod.error.code, "MALFORMED_MESSAGE");
  assert.deepEqual(watchdog.calls, []);
});

// --------------------------------------------------------------------
// CTRL-014 continuation 26: the startup alarm-schedule restore over
// the service surface (the keepalive persistence).
// --------------------------------------------------------------------

test("the service exposes restoreKeepaliveAlarms over the injected watchdog", async () => {
  const watchdog = spyWatchdog();
  watchdog.restoreAlarms = async () => ({ ok: true, restored: ["Z.ai"], intact: [] });
  const { service } = await startedService({ watchdog });
  const restored = await service.restoreKeepaliveAlarms();
  assert.deepEqual(restored, { ok: true, restored: ["Z.ai"], intact: [] });
});

test("a watchdog without restoreAlarms degrades to the typed refusal — never a throw", async () => {
  const { service } = await startedService({ watchdog: spyWatchdog() });
  const refused = await service.restoreKeepaliveAlarms();
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "INTERNAL_ERROR");
});

test("the built-in keepalive restores a lost alarm from the persisted store (the service-worker restart)", async () => {
  const storage = fakeStorage();
  // The armed record PERSISTED across the restart...
  await storage.set({
    [KEEPALIVE_STORE_KEY]: {
      "Z.ai": {
        worker: "Z.ai",
        tabId: 7,
        sessionUrl: "https://chat.z.ai/c/abc",
        periodMinutes: 2,
        armedAt: 1,
        consecutiveUnreachable: 0,
        lastCheck: null,
        lastState: null,
        checks: 0,
        events: [],
      },
    },
  });
  // ...while the alarm schedule did NOT (a fresh alarms surface).
  const alarms = fakeAlarmsSurface();
  const service = createControllerService({
    storage,
    fetchImpl: fakeAuthorityFetch().fetchImpl,
    tabsApi: fakeMessagingTabsApi({ tabs: [] }),
    zaiAdapter: spyAdapter(),
    alarmsApi: alarms,
  });
  await service.start();
  const restored = await service.restoreKeepaliveAlarms();
  assert.deepEqual(restored, { ok: true, restored: ["Z.ai"], intact: [] });
  assert.deepEqual(alarms.created, [{ name: `${KEEPALIVE_ALARM_PREFIX}Z.ai`, info: { periodInMinutes: 2 } }]);
});
