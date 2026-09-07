/**
 * The Z.ai session keepalive watchdog (CTRL-014 continuation 24 —
 * the resident supervision surface).
 *
 * The operator's overnight directive (2026-09-07 ~02:00): "it should
 * be able to relaunch z.ai when the watcher dies — I'll be using it
 * to relaunch the watcher of this session when it dies like it has
 * already happened twice. I'll be going to sleep soon and I'd like
 * to be sure development keep happening."
 *
 * This module owns the EXTENSION-SIDE supervision: once a Worker's
 * provider session is ARMED, a chrome.alarms period wakes the
 * service worker and runs one honest check —
 *
 *   1. the supervised tab is gone            -> RELAUNCH (the
 *      adapter's find-or-open recovery at the armed session URL);
 *      the new tab correlation replaces the stale one;
 *   2. the tab exists but the page channel is
 *      unreachable (no content script answer) -> count the
 *      consecutive failure; at the threshold RELOAD the tab (the
 *      observed hung-page modality: the page alive but frozen), and
 *      the next check re-verifies the fresh load;
 *   3. the page answers                       -> the honest classified
 *      state is recorded; an authentication-required or
 *      human-verification-required surface is RECORDED, never
 *      acted on (the operator's out-of-band actions); a
 *      dialog-bearing surface is handed to the relaunch recovery
 *      (which owns the bounded popup-dismissal key law).
 *
 * Every check outcome lands in a bounded event ring (persisted in
 * chrome.storage.local with the arm record — the service worker
 * restarts freely, the supervision state survives) so the operator
 * and the Architect read exactly what happened overnight, typed and
 * timestamped, newest last.
 *
 * CTRL-014 continuation 26 (the keepalive persistence): because a
 * service-worker restart (or an extension reload) can lose the
 * SCHEDULED chrome.alarms alarm while the armed records persist,
 * `restoreAlarms` re-creates every lost alarm from the persisted
 * store (intact alarms are never reset) — the wiring runs it once
 * at startup, so the supervision never dies silently with the
 * storage still saying "armed".
 *
 * Doctrine (the frozen boundary law): this module carries NO
 * provider knowledge — no locators, no dialog classification, no
 * page interpretation. It is the honest state machine over the
 * injected `relaunch` and `probe` capabilities (the adapter's own
 * typed results); the alarm name grammar and the storage shape are
 * its only own facts.
 */

import { failure } from "./errors.js";

/** The alarm-name prefix (the grammar: `${PREFIX}${worker}`). */
export const KEEPALIVE_ALARM_PREFIX = "zai-keepalive:";

/** The single storage key holding every armed keepalive record. */
export const KEEPALIVE_STORE_KEY = "zaiKeepalives";

/** The bounded event-ring size per armed keepalive. */
export const KEEPALIVE_MAX_EVENTS = 50;

/** The consecutive unreachable checks before a hung-page reload. */
export const KEEPALIVE_RELOAD_THRESHOLD = 3;

/** The allowed alarm period bounds (minutes). */
export const KEEPALIVE_PERIOD_MIN = 1;
export const KEEPALIVE_PERIOD_MAX = 30;

/**
 * Create the keepalive watchdog over injectable surfaces.
 *
 * @param {{ alarmsApi: object, storageApi: object, tabsApi: object,
 *           relaunch: Function, probe: Function, reloadTab?: Function,
 *           now?: Function, maxEvents?: number,
 *           reloadThreshold?: number }} wiring
 *        `relaunch` is the adapter's relaunchSession (typed); `probe`
 *        is the adapter's observeTab (typed); `reloadTab` reloads a
 *        tab id (chrome.tabs.reload). Tests inject fakes for all.
 *        The alarmsApi must carry create/clear (the arm/disarm
 *        schedule); `get` (or `getAll`) is OPTIONAL and enables
 *        `restoreAlarms`' existence verification — without either,
 *        restore degrades to the typed refusal (documented there).
 */
export function createZaiKeepalive({
  alarmsApi,
  storageApi,
  tabsApi,
  relaunch,
  probe,
  reloadTab,
  now = () => Date.now(),
  maxEvents = KEEPALIVE_MAX_EVENTS,
  reloadThreshold = KEEPALIVE_RELOAD_THRESHOLD,
} = {}) {
  if (typeof alarmsApi?.create !== "function" || typeof alarmsApi?.clear !== "function") {
    throw new Error("createZaiKeepalive requires an alarmsApi with create/clear");
  }
  if (typeof storageApi?.get !== "function" || typeof storageApi?.set !== "function") {
    throw new Error("createZaiKeepalive requires a storageApi with get/set");
  }
  if (typeof tabsApi?.get !== "function") {
    throw new Error("createZaiKeepalive requires a tabsApi with get");
  }
  if (typeof relaunch !== "function" || typeof probe !== "function") {
    throw new Error("createZaiKeepalive requires the relaunch and probe capabilities");
  }

  /** @private — read the whole keepalive store ({} when empty). */
  async function readStore() {
    const got = await storageApi.get(KEEPALIVE_STORE_KEY);
    const value = got?.[KEEPALIVE_STORE_KEY];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  /** @private — write the whole keepalive store. */
  async function writeStore(store) {
    await storageApi.set({ [KEEPALIVE_STORE_KEY]: store });
  }

  /** @private — append one event to a record's bounded ring. */
  function appendEvent(record, kind, detail) {
    const events = Array.isArray(record.events) ? record.events : [];
    events.push({
      ts: now(),
      kind,
      ...(typeof detail === "string" && detail.length > 0 ? { detail } : {}),
    });
    while (events.length > maxEvents) {
      events.shift();
    }
    return events;
  }

  /**
   * Arm the keepalive for a Worker's supervised session tab.
   * Re-arming an armed worker REPLACES the record (the new
   * correlation is the operator's explicit instruction — never an
   * implicit merge). The period is bounded to the declared window.
   *
   * @param {{ worker: unknown, tabId: unknown, sessionUrl: unknown,
   *           periodMinutes: unknown }} input
   */
  async function arm({ worker, tabId, sessionUrl, periodMinutes }) {
    if (typeof worker !== "string" || worker.length === 0) {
      return failure("MALFORMED_MESSAGE", "keepalive arm: worker must be a non-empty string");
    }
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return failure("MALFORMED_MESSAGE", "keepalive arm: tabId must be a positive integer (the supervised provider tab)");
    }
    if (sessionUrl !== null && sessionUrl !== undefined && (typeof sessionUrl !== "string" || sessionUrl.length === 0)) {
      return failure("MALFORMED_MESSAGE", "keepalive arm: sessionUrl must be a non-empty string or null (the relaunch target when the tab dies)");
    }
    let period = 1;
    if (periodMinutes !== null && periodMinutes !== undefined) {
      if (!Number.isInteger(periodMinutes) || periodMinutes < KEEPALIVE_PERIOD_MIN || periodMinutes > KEEPALIVE_PERIOD_MAX) {
        return failure(
          "MALFORMED_MESSAGE",
          `keepalive arm: periodMinutes must be an integer between ${KEEPALIVE_PERIOD_MIN} and ${KEEPALIVE_PERIOD_MAX} (received ${JSON.stringify(periodMinutes)})`
        );
      }
      period = periodMinutes;
    }
    const store = await readStore();
    const record = {
      worker,
      tabId,
      sessionUrl: sessionUrl ?? null,
      periodMinutes: period,
      armedAt: now(),
      consecutiveUnreachable: 0,
      lastCheck: null,
      lastState: null,
      checks: 0,
      events: [],
    };
    store[worker] = record;
    await writeStore(store);
    try {
      await alarmsApi.create(`${KEEPALIVE_ALARM_PREFIX}${worker}`, { periodInMinutes: period });
    } catch (err) {
      // The record is armed but the alarm could not be scheduled —
      // fail closed with the typed refusal (never a silent disarm).
      delete store[worker];
      await writeStore(store);
      return failure("INTERNAL_ERROR", `keepalive arm: the alarm could not be scheduled: ${err}`);
    }
    const { events, ...reported } = record;
    return { ok: true, keepalive: reported };
  }

  /**
   * Disarm a Worker's keepalive (the honest idempotent truth:
   * `disarmed: false` when nothing was armed).
   */
  async function disarm({ worker }) {
    if (typeof worker !== "string" || worker.length === 0) {
      return failure("MALFORMED_MESSAGE", "keepalive disarm: worker must be a non-empty string");
    }
    const store = await readStore();
    const existed = Object.prototype.hasOwnProperty.call(store, worker);
    if (existed) {
      delete store[worker];
      await writeStore(store);
      try {
        await alarmsApi.clear(`${KEEPALIVE_ALARM_PREFIX}${worker}`);
      } catch (err) {
        return failure("INTERNAL_ERROR", `keepalive disarm: the alarm could not be cleared: ${err}`);
      }
    }
    return { ok: true, disarmed: existed };
  }

  /**
   * Observe a Worker's keepalive state (the full record including the
   * event ring; null when not armed).
   */
  async function observe({ worker }) {
    if (typeof worker !== "string" || worker.length === 0) {
      return failure("MALFORMED_MESSAGE", "keepalive observe: worker must be a non-empty string");
    }
    const store = await readStore();
    const record = store[worker] ?? null;
    return { ok: true, keepalive: record };
  }

  /**
   * Run one supervision check for an alarm name (the chrome.alarms
   * handler's single call). Unknown names are a no-op (other
   * extensions' alarms are never consumed); an unarmed name is a
   * no-op (a stale alarm after a disarm). Every outcome is recorded
   * in the event ring; a check never throws.
   */
  async function handleAlarm(name) {
    if (typeof name !== "string" || !name.startsWith(KEEPALIVE_ALARM_PREFIX)) {
      return { ok: true, handled: false };
    }
    const worker = name.slice(KEEPALIVE_ALARM_PREFIX.length);
    const store = await readStore();
    const record = store[worker];
    if (!record || typeof record !== "object") {
      return { ok: true, handled: false, reason: "no armed keepalive for the alarm" };
    }
    record.checks = (typeof record.checks === "number" ? record.checks : 0) + 1;
    record.lastCheck = now();
    let alive = false;
    try {
      const tab = await tabsApi.get(record.tabId);
      alive = typeof tab?.id === "number";
    } catch {
      alive = false;
    }
    if (!alive) {
      // The supervised tab is GONE: the relaunch recovery at the
      // armed session URL (the watcher-died path).
      const relaunched = await relaunch({ worker, sessionUrl: record.sessionUrl ?? null });
      if (relaunched.ok) {
        record.tabId = relaunched.session?.tabId ?? record.tabId;
        record.events = appendEvent(
          record,
          "relaunched",
          `the supervised tab was gone; ${relaunched.reused ? "reused" : "opened"} tab ${relaunched.session?.tabId} (${relaunched.observation?.state ?? "unknown"}${relaunched.popupDismissals > 0 ? `, ${relaunched.popupDismissals} popup dismissal(s)` : ""})`
        );
        record.lastState = relaunched.observation?.state ?? null;
        record.consecutiveUnreachable = 0;
      } else {
        record.events = appendEvent(
          record,
          "relaunch-refused",
          `${relaunched.error?.code ?? "INTERNAL_ERROR"}: ${(relaunched.error?.message ?? "").slice(0, 160)}`
        );
      }
    } else {
      // The tab exists: the honest page probe.
      const observed = await probe(record.tabId);
      if (observed.ok) {
        record.consecutiveUnreachable = 0;
        const state = observed.observation?.state ?? "unknown";
        record.lastState = state;
        if (state === "expected-blocking-dialog" || state === "unexpected-dialog") {
          // A dialog-bearing surface: the relaunch recovery owns the
          // bounded popup-dismissal key law (and reports honestly).
          const recovered = await relaunch({ worker, sessionUrl: record.sessionUrl ?? null });
          if (recovered.ok) {
            record.tabId = recovered.session?.tabId ?? record.tabId;
            record.events = appendEvent(
              record,
              "popup-recovered",
              `a dialog surface was observed; the relaunch recovery ran (${recovered.popupDismissals} dismissal(s), now ${recovered.observation?.state ?? "unknown"})`
            );
            record.lastState = recovered.observation?.state ?? state;
          } else {
            record.events = appendEvent(
              record,
              "popup-recovery-refused",
              `${recovered.error?.code ?? "INTERNAL_ERROR"}: ${(recovered.error?.message ?? "").slice(0, 160)}`
            );
          }
        } else if (state === "authentication-required" || state === "human-verification-required") {
          record.events = appendEvent(
            record,
            "operator-gate",
            `the session surface is ${state} — the operator's out-of-band action; never acted on`
          );
        } else {
          record.events = appendEvent(record, "checked", `the supervised tab is ${state}`);
        }
      } else {
        record.consecutiveUnreachable = (record.consecutiveUnreachable ?? 0) + 1;
        const code = observed.error?.code ?? "INTERNAL_ERROR";
        if (
          record.consecutiveUnreachable >= reloadThreshold &&
          typeof reloadTab === "function" &&
          code !== "STALE_REFERENCE"
        ) {
          try {
            await reloadTab(record.tabId);
            record.events = appendEvent(
              record,
              "reloaded",
              `the page channel was unreachable ${record.consecutiveUnreachable} consecutive check(s) (${code}); the tab was reloaded — the next check verifies the fresh load`
            );
            record.consecutiveUnreachable = 0;
          } catch (err) {
            record.events = appendEvent(record, "reload-refused", `the tab reload failed: ${err}`);
          }
        } else {
          record.events = appendEvent(
            record,
            "unreachable",
            `the page channel was unreachable (${code}); consecutive: ${record.consecutiveUnreachable}`
          );
        }
      }
    }
    store[worker] = record;
    try {
      await writeStore(store);
    } catch {
      // The persistence failed — the supervision continues in memory
      // this wake; the next alarm re-reads what persisted. Never a
      // crash from a storage refusal.
    }
    return { ok: true, handled: true, worker };
  }

  /**
   * RESTORE the alarm schedule from the persisted store — the
   * service-worker-restart / extension-reload recovery (CTRL-014
   * continuation 26, the keepalive persistence).
   *
   * THE OBSERVED FAILURE MODE: the armed records persist in
   * chrome.storage.local across a service-worker restart (or an
   * extension reload), but the scheduled chrome.alarms alarm can be
   * LOST — the storage then says "armed" while the watchdog never
   * fires again (a silent supervision death, the exact opposite of
   * what the keepalive exists for). This method reads the persisted
   * store and, for every armed record whose named alarm
   * (`KEEPALIVE_ALARM_PREFIX + worker`) no longer exists, re-creates
   * it with the PERSISTED period. An alarm that still exists is left
   * UNTOUCHED — re-creating an intact alarm would restart its period
   * cadence (a silent reschedule), which is exactly what the restore
   * must never do.
   *
   * Honest degradation: alarm existence is verified through
   * `alarmsApi.get` when the surface has it, else `alarmsApi.getAll`;
   * with NEITHER the restore refuses typed `INTERNAL_ERROR` (a blind
   * re-create would reschedule intact alarms — never a guess). A
   * refused alarm creation, a failed lookup, or a malformed persisted
   * record surfaces the FIRST typed refusal; the remaining records
   * are still processed (one corrupt record never silently disarms
   * the others — the alarms it already re-created are real and the
   * next restore observes them intact). The persisted records
   * themselves are never mutated. Never throws.
   *
   * @returns {Promise<{ ok: true, restored: string[], intact: string[] } |
   *           { ok: false, error: { code: string, message: string } }>}
   */
  async function restoreAlarms() {
    if (typeof alarmsApi.get !== "function" && typeof alarmsApi.getAll !== "function") {
      return failure(
        "INTERNAL_ERROR",
        "keepalive restore: the alarms surface has neither get nor getAll — alarm existence cannot be verified, and a blind re-create would reset intact alarms (never a guess)"
      );
    }
    let store;
    try {
      store = await readStore();
    } catch (err) {
      return failure("INTERNAL_ERROR", `keepalive restore: the persisted store could not be read: ${err}`);
    }
    const restored = [];
    const intact = [];
    let refusal = null;
    for (const worker of Object.keys(store)) {
      const record = store[worker];
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        if (refusal === null) {
          refusal = failure(
            "INTERNAL_ERROR",
            `keepalive restore: the persisted record for '${worker}' is malformed (not an object) — the store is never guessed`
          );
        }
        continue;
      }
      const period = record.periodMinutes;
      if (!Number.isInteger(period) || period < KEEPALIVE_PERIOD_MIN || period > KEEPALIVE_PERIOD_MAX) {
        if (refusal === null) {
          refusal = failure(
            "INTERNAL_ERROR",
            `keepalive restore: the persisted record for '${worker}' has a malformed periodMinutes (${JSON.stringify(period)}) — outside the bounded window, never re-guessed`
          );
        }
        continue;
      }
      const name = `${KEEPALIVE_ALARM_PREFIX}${worker}`;
      let exists = false;
      try {
        if (typeof alarmsApi.get === "function") {
          const alarm = await alarmsApi.get(name);
          exists = alarm !== undefined && alarm !== null;
        } else {
          const all = await alarmsApi.getAll();
          exists = (Array.isArray(all) ? all : []).some((alarm) => alarm?.name === name);
        }
      } catch (err) {
        if (refusal === null) {
          refusal = failure("INTERNAL_ERROR", `keepalive restore: the alarm lookup failed for '${worker}': ${err}`);
        }
        continue;
      }
      if (exists) {
        // Intact: NEVER re-created (a re-create would restart the
        // alarm's period cadence — a silent reschedule).
        intact.push(worker);
        continue;
      }
      try {
        await alarmsApi.create(name, { periodInMinutes: period });
        restored.push(worker);
      } catch (err) {
        if (refusal === null) {
          refusal = failure(
            "INTERNAL_ERROR",
            `keepalive restore: the lost alarm could not be re-created for '${worker}' (the record stays armed; a later restore retries): ${err}`
          );
        }
      }
    }
    if (refusal !== null) {
      // The frozen refusal shape (exactly like arm/disarm refusals):
      // the already-restored alarms are observable through the next
      // restore/observe, never self-reported on a refusal.
      return refusal;
    }
    return { ok: true, restored, intact };
  }

  return Object.freeze({ arm, disarm, observe, handleAlarm, restoreAlarms });
}
