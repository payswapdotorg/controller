/**
 * The background service — wires the whole resident loop.
 *
 *   alarm (intervalMinutes) -> supervisor.tick() -> github (source of truth)
 *                                        └─> intelligence driver (chat tab |
 *                                            local endpoint | none)
 *
 * Message boundary (popup/options -> here):
 *   { type: "controller:status" }                    -> live status + log tail
 *   { type: "controller:start" } / { "...:stop" }     -> loop enable/disable
 *   { type: "controller:tick" }                       -> run one cycle NOW
 *   { type: "controller:config:get" }                 -> the normalized config
 *   { type: "controller:config:set", config }         -> validate + persist
 *   { type: "controller:chat:attach" }                -> attach/resurrect the chat tab
 *   { type: "controller:chat:test" }                  -> ping + one driver round-trip
 *
 * Everything is fail-closed and typed; the log ring (last 200 records) is the
 * operator's observability surface in the popup.
 */

import { loadConfig, saveConfig, CONFIG_KEY } from "./config.js";
import { createSupervisor } from "./supervisor.js";
import { createDriverFromConfig } from "./intelligence.js";
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
  const driver = createDriverFromConfig(state.config, state.chatDriver);
  state.supervisor = createSupervisor({
    github: state.github,
    intelligence: driver,
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

async function handleMessage(message, _sender, sendResponse) {
  try {
    switch (message?.type) {
      case "controller:status": {
        sendResponse({
          ok: true,
          status: state.supervisor?.status() ?? null,
          config: state.config,
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
  runtimeApi.onMessage.addListener(handleMessage);
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
