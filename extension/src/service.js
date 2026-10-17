/**
 * The background service — wires the whole resident loop.
 *
 *   alarm (intervalMinutes) -> supervisor.tick() -> github (source of truth)
 *                                        └─> intelligence chain (chat tab |
 *                                            muse spark | copilot bridge |
 *                                            any local endpoint | none)
 *
 * Message boundary (popup/options -> here):
 *   { type: "controller:status" }                    -> live status + log tail
 *   { type: "controller:start" } / { "...:stop" }     -> loop enable/disable
 *   { type: "controller:tick" }                       -> run one cycle NOW
 *   { type: "controller:config:get" }                 -> the normalized config
 *   { type: "controller:config:set", config }         -> validate + persist
 *   { type: "controller:chat:attach" }                -> attach/resurrect the chat tab
 *   { type: "controller:chat:test" }                  -> ping + one chat driver round-trip
 *   { type: "controller:intelligence:test" }          -> probe every enabled chain source
 *
 * Everything is fail-closed and typed; the log ring (last 200 records) is the
 * operator's observability surface in the popup.
 *
 * The onMessage listener ALWAYS returns true and lets the async handler call
 * sendResponse when it is ready: an async listener that returns a Promise
 * (instead of literal true) has its response channel closed by current
 * Chromium builds before the first await settles — the v1 defect the E2E
 * caught at config:set ("no response"). Returning true keeps the channel
 * open in Chromium/Opera AND Firefox alike.
 */

import { loadConfig, saveConfig, CONFIG_KEY } from "./config.js";
import { createSupervisor } from "./supervisor.js";
import { createDriverFromConfig, createChainDriver } from "./intelligence.js";
import { createChatzaiWebDriver } from "./chatzai.js";
import * as githubApi from "./github.js";

const LOG_KEY = "controller.log";
const LOG_LIMIT = 200;

let storageApi = globalThis.chrome?.storage;
let tabsApi = globalThis.chrome?.tabs;
let alarmsApi = globalThis.chrome?.alarms;
let runtimeApi = globalThis.chrome?.runtime;

const state = {
  config: null,
  log: [],
  supervisor: null,
  chatDriver: null,
  intelligenceDriver: null,
  github: null,
  alarmName: "controller-cycle",
};

function log(record) {
  state.log.push({ at: record.at ?? new Date().toISOString(), ...record });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  void persistLog();
}

async function persistLog() {
  try {
    await storageApi.local.set({ [LOG_KEY]: state.log.slice(-LOG_LIMIT) });
  } catch {
    // storage full/unavailable — the in-memory ring keeps working.
  }
}

async function restoreLog() {
  try {
    const stored = await storageApi.local.get(LOG_KEY);
    state.log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  } catch {
    state.log = [];
  }
}

function makeGithubClient(config) {
  const { owner, repo, token } = config.github;
  return {
    getSnapshot: () => githubApi.getSnapshot(token, owner, repo),
    mergePullRequest: (number, message) =>
      githubApi.mergePullRequest(token, owner, repo, number, config.github.mergeMethod, message),
    comment: (number, body) => githubApi.comment(token, owner, repo, number, body),
    createIssue: (title, body, labels) => githubApi.createIssue(token, owner, repo, title, body, labels),
    createBranch: (name, sha) => githubApi.createBranch(token, owner, repo, name, sha),
  };
}

function messaging() {
  return {
    sendToTab: (tabId, message) =>
      new Promise((resolve, reject) => {
        tabsApi.sendMessage(tabId, message, (response) => {
          const err = globalThis.chrome?.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve(response);
        });
      }),
  };
}

function rebuildRuntime() {
  state.github = makeGithubClient(state.config);
  state.chatDriver = createChatzaiWebDriver({
    tabs: {
      get: (id) => tabsApi.get(id),
      query: (q) => tabsApi.query(q),
      create: (opts) => tabsApi.create(opts),
    },
    messaging: messaging(),
    config: () => state.config,
    log,
  });
  state.intelligenceDriver = createDriverFromConfig(state.config, state.chatDriver, fetch, log);
  state.supervisor = createSupervisor({
    github: state.github,
    intelligence: state.intelligenceDriver,
    config: state.config,
    log,
  });
}

async function scheduleAlarm() {
  await alarmsApi.clear(state.alarmName).catch(() => {});
  if (state.config.loop.enabled) {
    await alarmsApi.create(state.alarmName, { periodInMinutes: state.config.loop.intervalMinutes });
    log({ kind: "loop", level: "info", message: `loop scheduled every ${state.config.loop.intervalMinutes} min` });
  }
}

async function handleTick() {
  if (!state.config.loop.enabled) return;
  try {
    await state.supervisor.tick();
  } catch (error) {
    log({ kind: "cycle", level: "error", message: `cycle crashed: ${error?.message ?? error}` });
  }
}

/**
 * Probe every usable intelligence source with a harmless directive probe.
 * Returns per-source results so the popup can show which source would carry
 * the loop right now (the chain itself rotates at ask time; this is a
 * read-only health surface).
 */
async function probeIntelligenceSources() {
  const driver = state.intelligenceDriver;
  const results = [];
  if (typeof driver?.health !== "function") {
    // Legacy single-driver mode: one probe.
    const reply = await driver.ask({
      kind: "directive",
      brief: "Controller connectivity probe. Reply with exactly: WAIT: probe acknowledged",
    });
    return { mode: state.config.intelligence.driver, results: [{ source: reply.driver ?? "driver", ok: reply.ok, error: reply.error ?? null, text: reply.ok ? reply.text.slice(0, 200) : null }] };
  }
  for (const source of driver.health()) {
    if (!source.usable) {
      results.push({ source: source.id, ok: false, skipped: true, error: source.enabled ? "not usable (no url?)" : "disabled" });
      continue;
    }
    const single = await (() => {
      // Build a one-off chain of exactly this source so benching state of the
      // live chain is untouched by probes.
      const probe = createChainDriver(
        [{ id: source.id, kind: source.kind, url: source.url, enabled: true }],
        {
          chatDriverFactory: () => state.chatDriver,
          timeoutMs: Math.min((state.config.intelligence.timeoutSeconds ?? 120) * 1000, 30_000),
          failureThreshold: 1,
          cooldownMs: 60_000,
          log: () => {},
        },
      );
      return probe.ask({ kind: "directive", brief: "Controller connectivity probe. Reply with exactly: WAIT: probe acknowledged" });
    })();
    results.push({ source: source.id, ok: single.ok, error: single.error ?? null, text: single.ok ? single.text.slice(0, 200) : null });
  }
  return { mode: state.config.intelligence.driver, results };
}

async function handleMessage(message, _sender, sendResponse) {
  try {
    switch (message?.type) {
      case "controller:status": {
        sendResponse({
          ok: true,
          status: state.supervisor?.status() ?? null,
          config: state.config,
          sources: typeof state.intelligenceDriver?.health === "function" ? state.intelligenceDriver.health() : null,
          log: state.log.slice(-50),
        });
        return false;
      }
      case "controller:start": {
        const { config, issues } = await saveConfig(storageApi, { ...state.config, loop: { ...state.config.loop, enabled: true } });
        state.config = config;
        rebuildRuntime();
        await scheduleAlarm();
        log({ kind: "loop", level: "info", message: "loop started" });
        issues.forEach((issue) => log({ kind: "config", level: "warn", message: issue }));
        sendResponse({ ok: true });
        void handleTick();
        return false;
      }
      case "controller:stop": {
        const { config } = await saveConfig(storageApi, { ...state.config, loop: { ...state.config.loop, enabled: false } });
        state.config = config;
        rebuildRuntime();
        await scheduleAlarm();
        log({ kind: "loop", level: "info", message: "loop stopped" });
        sendResponse({ ok: true });
        return false;
      }
      case "controller:tick": {
        sendResponse({ ok: true });
        void handleTick();
        return false;
      }
      case "controller:config:get": {
        sendResponse({ ok: true, config: state.config });
        return false;
      }
      case "controller:config:set": {
        const { config, issues } = await saveConfig(storageApi, message.config ?? {});
        state.config = config;
        rebuildRuntime();
        await scheduleAlarm();
        issues.forEach((issue) => log({ kind: "config", level: "warn", message: issue }));
        log({ kind: "config", level: "info", message: "config updated" });
        sendResponse({ ok: true, issues });
        return false;
      }
      case "controller:chat:attach": {
        const result = await state.chatDriver.attach();
        if (result.ok) {
          const { config } = await saveConfig(storageApi, { ...state.config, chat: { ...state.config.chat, tabId: result.tabId } });
          state.config = config;
          rebuildRuntime();
          log({ kind: "chat", level: "info", message: `chat tab ${result.reused ? "reused" : "opened"}: #${result.tabId}` });
        }
        sendResponse(result);
        return false;
      }
      case "controller:chat:test": {
        const reply = await state.chatDriver.ask({
          kind: "directive",
          brief: "Controller connectivity probe. Reply with exactly: WAIT: probe acknowledged",
        });
        log({ kind: "chat", level: reply.ok ? "info" : "warn", message: reply.ok ? `chat driver round-trip ok (${reply.text.slice(0, 80)})` : `chat driver failed: ${reply.error}` });
        sendResponse(reply);
        return false;
      }
      case "controller:intelligence:test": {
        const probe = await probeIntelligenceSources();
        log({
          kind: "chain",
          level: "info",
          message: `intelligence probe (${probe.mode}): ${probe.results.map((r) => `${r.source}=${r.ok ? "ok" : r.skipped ? "skipped" : "fail"}`).join(", ")}`,
        });
        sendResponse({ ok: probe.results.some((r) => r.ok), ...probe });
        return false;
      }
      default:
        sendResponse({ ok: false, error: `unknown message type: ${message?.type ?? "(none)"}` });
        return false;
    }
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message ?? error) });
    return false;
  }
}

async function boot() {
  await restoreLog();
  state.config = await loadConfig(storageApi);
  rebuildRuntime();
  await scheduleAlarm();
  log({ kind: "boot", level: "info", message: `controller background up (driver=${state.config.intelligence.driver}, loop=${state.config.loop.enabled ? "on" : "off"})` });
  runtimeApi.onMessage.addListener((message, sender, sendResponse) => {
    void handleMessage(message, sender, sendResponse);
    return true; // keep the response channel open across the handler's awaits
  });
  alarmsApi.onAlarm.addListener((alarm) => {
    if (alarm?.name === state.alarmName) void handleTick();
  });
  if (state.config.loop.enabled) void handleTick();
}

boot().catch((error) => {
  // Boot must never leave the extension half-wired silently.
  try {
    state.log.push({ at: new Date().toISOString(), kind: "boot", level: "error", message: String(error?.message ?? error) });
    void persistLog();
  } catch {}
});
