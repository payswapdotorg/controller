/**
 * Z.ai keepalive watchdog tests (CTRL-014 continuation 24 — the
 * resident supervision surface): the offline/injected matrix over
 * the alarm/storage/tabs fakes. The pinned laws:
 *
 *   - the closed arm form (worker/tabId/sessionUrl/periodMinutes,
 *     the bounded period window, the null session URL);
 *   - re-arming replaces the record (never an implicit merge);
 *   - disarm is honest and idempotent (disarmed: false when nothing
 *     was armed) and clears the alarm;
 *   - observe reports the full record (event ring included);
 *   - the alarm-name grammar: unknown names and unarmed names are
 *     no-ops (other alarms are never consumed);
 *   - THE TAB-GONE PATH: the supervised tab that no longer exists
 *     triggers the relaunch recovery, the new tab correlation
 *     replaces the stale one, and the event ring records it;
 *   - THE UNREACHABLE PATH: consecutive page-channel failures are
 *     counted; at the threshold the tab is reloaded and the counter
 *     resets; below the threshold the check is recorded only;
 *   - THE HONEST-STATE PATH: a healthy tab records its classified
 *     state; an authentication-required surface is RECORDED, never
 *     acted on;
 *   - THE DIALOG PATH: a dialog-bearing surface hands the recovery
 *     to the relaunch capability (which owns the popup key law);
 *   - the event ring is bounded (the oldest events are dropped);
 *   - the storage write happens after every handled check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createZaiKeepalive,
  KEEPALIVE_ALARM_PREFIX,
  KEEPALIVE_STORE_KEY,
} from "../src/keepalive.js";

/** A fake alarm scheduler recording create/clear calls. */
function fakeAlarms() {
  const created = [];
  const cleared = [];
  return {
    created,
    cleared,
    create: async (name, info) => {
      created.push({ name, info });
    },
    clear: async (name) => {
      cleared.push(name);
    },
  };
}

/** A fake chrome.storage.local over an in-memory map. */
function fakeStorage() {
  const map = new Map();
  return {
    get: async (key) => {
      const out = {};
      if (map.has(key)) {
        out[key] = structuredClone(map.get(key));
      }
      return out;
    },
    set: async (values) => {
      for (const [key, value] of Object.entries(values)) {
        map.set(key, structuredClone(value));
      }
    },
    dump: () => map,
  };
}

/**
 * The fake supervision wiring: the tabs the watchdog can see, the
 * typed probe/relaunch results it receives, and the reload calls it
 * issues. Every capability records its invocations. Each world gets
 * FRESH alarm/storage fakes (full test isolation).
 */
function fakeWorld({ tabs = [], probeResults = [], relaunchResults = [] } = {}) {
  const probes = [];
  const relaunches = [];
  const reloads = [];
  const alarms = fakeAlarms();
  const storage = fakeStorage();
  const tabsApi = {
    get: async (tabId) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) {
        throw new Error(`no tab ${tabId}`);
      }
      return tab;
    },
    reload: async (tabId) => {
      reloads.push(tabId);
    },
  };
  let probeCursor = 0;
  let relaunchCursor = 0;
  const keepalive = createZaiKeepalive({
    alarmsApi: alarms,
    storageApi: storage,
    tabsApi,
    probe: async (tabId) => {
      probes.push(tabId);
      const result = probeResults[probeCursor] ?? { ok: true, observation: { state: "ready-for-input" } };
      probeCursor += 1;
      return result;
    },
    relaunch: async (args) => {
      relaunches.push(args);
      const result = relaunchResults[relaunchCursor] ?? {
        ok: true,
        session: { worker: args.worker, tabId: 99 },
        reused: false,
        popupDismissals: 0,
        observation: { state: "ready-for-input" },
      };
      relaunchCursor += 1;
      return result;
    },
    reloadTab: async (tabId) => {
      reloads.push(tabId);
    },
    now: () => 1725600000000,
    maxEvents: 5,
    reloadThreshold: 3,
  });
  return { keepalive, probes, relaunches, reloads, alarms, storage };
}

// --------------------------------------------------------------------
// The closed arm form.
// --------------------------------------------------------------------

test("arm requires the worker, the tab, and the bounded period", async () => {
  const { keepalive } = fakeWorld();
  const noWorker = await keepalive.arm({ worker: "", tabId: 7, sessionUrl: null, periodMinutes: null });
  assert.equal(noWorker.ok, false);
  assert.equal(noWorker.error.code, "MALFORMED_MESSAGE");

  const noTab = await keepalive.arm({ worker: "w1", tabId: 0, sessionUrl: null, periodMinutes: null });
  assert.equal(noTab.ok, false);
  assert.equal(noTab.error.code, "MALFORMED_MESSAGE");

  const badPeriod = await keepalive.arm({ worker: "w1", tabId: 7, sessionUrl: null, periodMinutes: 0 });
  assert.equal(badPeriod.ok, false);
  assert.equal(badPeriod.error.code, "MALFORMED_MESSAGE");
  const highPeriod = await keepalive.arm({ worker: "w1", tabId: 7, sessionUrl: null, periodMinutes: 31 });
  assert.equal(highPeriod.ok, false);
  assert.equal(highPeriod.error.code, "MALFORMED_MESSAGE");

  const badUrl = await keepalive.arm({ worker: "w1", tabId: 7, sessionUrl: 42, periodMinutes: null });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.error.code, "MALFORMED_MESSAGE");
});

test("arm persists the record and schedules the named alarm", async () => {
  const world = fakeWorld();
  const armed = await world.keepalive.arm({
    worker: "w1",
    tabId: 7,
    sessionUrl: "https://chat.z.ai/c/abc",
    periodMinutes: 2,
  });
  assert.equal(armed.ok, true);
  assert.equal(armed.keepalive.worker, "w1");
  assert.equal(armed.keepalive.tabId, 7);
  assert.equal(armed.keepalive.sessionUrl, "https://chat.z.ai/c/abc");
  assert.equal(armed.keepalive.periodMinutes, 2);
  assert.equal(armed.keepalive.events, undefined); // the event ring never crosses the typed result
  assert.deepEqual(
    world.alarms.created.map((entry) => entry.name),
    [`${KEEPALIVE_ALARM_PREFIX}w1`]
  );
  const stored = (await world.storage.get(KEEPALIVE_STORE_KEY))[KEEPALIVE_STORE_KEY];
  assert.equal(stored.w1.tabId, 7);
});

test("arm defaults the period to one minute and the session URL to null", async () => {
  const world = fakeWorld();
  const armed = await world.keepalive.arm({ worker: "w2", tabId: 8, sessionUrl: null, periodMinutes: null });
  assert.equal(armed.ok, true);
  assert.equal(armed.keepalive.periodMinutes, 1);
  assert.equal(armed.keepalive.sessionUrl, null);
});

test("re-arming replaces the record (never an implicit merge)", async () => {
  const world = fakeWorld();
  await world.keepalive.arm({ worker: "w3", tabId: 10, sessionUrl: null, periodMinutes: null });
  const rearmed = await world.keepalive.arm({
    worker: "w3",
    tabId: 11,
    sessionUrl: "https://chat.z.ai/c/xyz",
    periodMinutes: 5,
  });
  assert.equal(rearmed.ok, true);
  assert.equal(rearmed.keepalive.tabId, 11);
  const stored = (await world.storage.get(KEEPALIVE_STORE_KEY))[KEEPALIVE_STORE_KEY];
  assert.equal(stored.w3.tabId, 11);
  assert.equal(stored.w3.sessionUrl, "https://chat.z.ai/c/xyz");
});

// --------------------------------------------------------------------
// Disarm and observe.
// --------------------------------------------------------------------

test("disarm is honest and idempotent, and clears the alarm", async () => {
  const world = fakeWorld();
  await world.keepalive.arm({ worker: "w4", tabId: 12, sessionUrl: null, periodMinutes: null });
  const first = await world.keepalive.disarm({ worker: "w4" });
  assert.equal(first.ok, true);
  assert.equal(first.disarmed, true);
  const second = await world.keepalive.disarm({ worker: "w4" });
  assert.equal(second.ok, true);
  assert.equal(second.disarmed, false);
  assert.deepEqual(
    world.alarms.cleared.filter((name) => name === `${KEEPALIVE_ALARM_PREFIX}w4`).length,
    1
  );
  const observed = await world.keepalive.observe({ worker: "w4" });
  assert.equal(observed.ok, true);
  assert.equal(observed.keepalive, null);
});

test("observe reports the full record including the event ring", async () => {
  const world = fakeWorld({ tabs: [{ id: 12, url: "https://chat.z.ai/" }] });
  await world.keepalive.arm({ worker: "w5", tabId: 12, sessionUrl: null, periodMinutes: null });
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w5`);
  const observed = await world.keepalive.observe({ worker: "w5" });
  assert.equal(observed.ok, true);
  assert.equal(observed.keepalive.checks, 1);
  assert.equal(observed.keepalive.lastState, "ready-for-input");
  assert.equal(Array.isArray(observed.keepalive.events), true);
  assert.equal(observed.keepalive.events.length, 1);
  assert.equal(observed.keepalive.events[0].kind, "checked");
});

// --------------------------------------------------------------------
// The alarm-name grammar.
// --------------------------------------------------------------------

test("unknown alarm names and unarmed names are no-ops", async () => {
  const world = fakeWorld();
  const foreign = await world.keepalive.handleAlarm("someone-elses-alarm");
  assert.deepEqual(foreign, { ok: true, handled: false });
  const unarmed = await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}nobody`);
  assert.equal(unarmed.ok, true);
  assert.equal(unarmed.handled, false);
  assert.equal(world.probes.length, 0);
});

// --------------------------------------------------------------------
// THE TAB-GONE PATH (the watcher-died relaunch).
// --------------------------------------------------------------------

test("a gone supervised tab triggers the relaunch and adopts the new correlation", async () => {
  const world = fakeWorld({ tabs: [] });
  await world.keepalive.arm({
    worker: "w6",
    tabId: 55,
    sessionUrl: "https://chat.z.ai/c/abc",
    periodMinutes: null,
  });
  const handled = await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w6`);
  assert.equal(handled.ok, true);
  assert.equal(handled.handled, true);
  assert.equal(world.relaunches.length, 1);
  assert.equal(world.relaunches[0].worker, "w6");
  assert.equal(world.relaunches[0].sessionUrl, "https://chat.z.ai/c/abc");
  const observed = await world.keepalive.observe({ worker: "w6" });
  assert.equal(observed.keepalive.tabId, 99); // the relaunch result's new correlation
  assert.equal(observed.keepalive.events[0].kind, "relaunched");
  assert.equal(observed.keepalive.lastState, "ready-for-input");
});

test("a refused relaunch is recorded, never thrown", async () => {
  const world = fakeWorld({ tabs: [], relaunchResults: [{ ok: false, error: { code: "TABS_UNAVAILABLE", message: "no" } }] });
  await world.keepalive.arm({ worker: "w7", tabId: 56, sessionUrl: null, periodMinutes: null });
  const handled = await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w7`);
  assert.equal(handled.ok, true);
  const observed = await world.keepalive.observe({ worker: "w7" });
  assert.equal(observed.keepalive.events[0].kind, "relaunch-refused");
  assert.equal(observed.keepalive.tabId, 56); // the stale correlation is never silently replaced
});

// --------------------------------------------------------------------
// THE UNREACHABLE PATH (the hung page).
// --------------------------------------------------------------------

test("consecutive unreachable checks are counted and the threshold reloads the tab", async () => {
  const unreachable = { ok: false, error: { code: "PAGE_UNAVAILABLE", message: "no answer" } };
  const world = fakeWorld({ tabs: [{ id: 60, url: "https://chat.z.ai/" }], probeResults: [unreachable, unreachable, unreachable] });
  await world.keepalive.arm({ worker: "w8", tabId: 60, sessionUrl: null, periodMinutes: null });
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w8`);
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w8`);
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w8`);
  const observed = await world.keepalive.observe({ worker: "w8" });
  assert.deepEqual(world.reloads, [60]);
  assert.equal(observed.keepalive.consecutiveUnreachable, 0); // reset after the reload
  assert.equal(observed.keepalive.events.at(-1).kind, "reloaded");
});

test("below the threshold the unreachable check is recorded only (no reload)", async () => {
  const unreachable = { ok: false, error: { code: "PAGE_UNAVAILABLE", message: "no answer" } };
  const world = fakeWorld({ tabs: [{ id: 61, url: "https://chat.z.ai/" }], probeResults: [unreachable] });
  await world.keepalive.arm({ worker: "w9", tabId: 61, sessionUrl: null, periodMinutes: null });
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w9`);
  assert.deepEqual(world.reloads, []);
  const observed = await world.keepalive.observe({ worker: "w9" });
  assert.equal(observed.keepalive.consecutiveUnreachable, 1);
  assert.equal(observed.keepalive.events[0].kind, "unreachable");
});

// --------------------------------------------------------------------
// THE HONEST-STATE PATH.
// --------------------------------------------------------------------

test("an authentication-required surface is recorded, never acted on", async () => {
  const world = fakeWorld({
    tabs: [{ id: 62, url: "https://chat.z.ai/" }],
    probeResults: [{ ok: true, observation: { state: "authentication-required" } }],
  });
  await world.keepalive.arm({ worker: "w10", tabId: 62, sessionUrl: null, periodMinutes: null });
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w10`);
  assert.equal(world.relaunches.length, 0); // never a recovery action on the operator's gate
  const observed = await world.keepalive.observe({ worker: "w10" });
  assert.equal(observed.keepalive.events[0].kind, "operator-gate");
  assert.equal(observed.keepalive.lastState, "authentication-required");
});

test("a dialog-bearing surface hands the recovery to the relaunch capability", async () => {
  const world = fakeWorld({
    tabs: [{ id: 63, url: "https://chat.z.ai/" }],
    probeResults: [{ ok: true, observation: { state: "unexpected-dialog" } }],
    relaunchResults: [
      { ok: true, session: { worker: "w11", tabId: 63 }, reused: true, popupDismissals: 1, observation: { state: "ready-for-input" } },
    ],
  });
  await world.keepalive.arm({ worker: "w11", tabId: 63, sessionUrl: null, periodMinutes: null });
  await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w11`);
  assert.equal(world.relaunches.length, 1);
  const observed = await world.keepalive.observe({ worker: "w11" });
  assert.equal(observed.keepalive.events[0].kind, "popup-recovered");
  assert.equal(observed.keepalive.lastState, "ready-for-input");
});

// --------------------------------------------------------------------
// The bounded event ring.
// --------------------------------------------------------------------

test("the event ring is bounded — the oldest events are dropped", async () => {
  const world = fakeWorld({ tabs: [{ id: 64, url: "https://chat.z.ai/" }] });
  await world.keepalive.arm({ worker: "w12", tabId: 64, sessionUrl: null, periodMinutes: null });
  for (let i = 0; i < 8; i += 1) {
    await world.keepalive.handleAlarm(`${KEEPALIVE_ALARM_PREFIX}w12`);
  }
  const observed = await world.keepalive.observe({ worker: "w12" });
  assert.equal(observed.keepalive.events.length, 5); // maxEvents: 5
  assert.equal(observed.keepalive.checks, 8);
});
