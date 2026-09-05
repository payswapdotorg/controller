/**
 * Deterministic offline fixtures for the CTRL-012 extension tests.
 *
 * Everything here is synthetic but shape-faithful to the real authority
 * surfaces: the same machine-state schema (0.1), the same frozen
 * lifecycle vocabulary, the same work-order grammar. No network, no
 * credentials, no Chrome APIs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The extension root (for manifest-referenced-file checks).
 */
export const EXTENSION_ROOT = join(here, "..");

/**
 * A synthetic machine state mirroring the live repository's shape at
 * the CTRL-012 activation (activeWorkItem CTRL-012, READY, Stage 7,
 * completed x11).
 */
export const FIXTURE_REPOSITORY = "pectoraux/controller";
export const FIXTURE_SHA = "398c0e8c06c2bae4cb4a864990b36cb0fd47b88f";
export const FIXTURE_BRANCH = "main";

export function fixtureMachineState(overrides = {}) {
  return JSON.stringify({
    schemaVersion: "0.1",
    repository: FIXTURE_REPOSITORY,
    roadmap: "spec/roadmap/roadmap.md",
    architecture: "spec/architecture/controller-architecture.md",
    buildProcess: "spec/operations/controller-build-process.md",
    activeWorkItem: "CTRL-012",
    status: "READY",
    automationStage: "STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP",
    completed: [
      "CTRL-001", "CTRL-002", "CTRL-003", "CTRL-004", "CTRL-005",
      "CTRL-006", "CTRL-007", "CTRL-008", "CTRL-009", "CTRL-010", "CTRL-011",
    ],
    rules: {
      repositoryIsSourceOfTruth: true,
      controllerRuntimeStateIsReconstructible: true,
      onePrPerWorkItem: true,
      workerCannotMerge: true,
      failClosedOnContradiction: true,
      humanOperatorIsTemporaryMechanicalController: false,
      architectMustAnnounceAutomationStage: true,
    },
    nextAction:
      "CTRL-012 is READY and authorized. Dispatch it from the exact current main SHA.",
    ...overrides,
  });
}

export function fixtureWorkOrder(overrides = {}) {
  return [
    "# CTRL-012 — Browser Control Surface Foundation",
    "",
    "Status: `READY`",
    "",
    "## Authorization",
    "",
    "Synthetic fixture work order (shape-faithful to the real grammar).",
    "",
    ...overrides.lines ?? [],
  ].join("\n");
}

/**
 * A deterministic fake fetch implementing exactly the four GET shapes
 * the content client issues: repository lookup, branch head, machine
 * state at SHA, work order at SHA. Records every requested URL so
 * tests can pin the pinned-SHA read discipline.
 */
export function fakeAuthorityFetch({ machineState = fixtureMachineState(), workOrder = fixtureWorkOrder(), repository = FIXTURE_REPOSITORY, branch = FIXTURE_BRANCH, sha = FIXTURE_SHA, repositoryStatus = 200, stateStatus = 200, workOrderStatus = 200, transportFailures = [] } = {}) {
  const requested = [];
  const pendingFailures = [...transportFailures];
  const fetchImpl = async (url, _options) => {
    requested.push(String(url));
    if (pendingFailures.length > 0) {
      throw pendingFailures.shift();
    }
    const text = String(url);
    if (text === `https://api.github.com/repos/${repository}`) {
      if (repositoryStatus !== 200) {
        return fakeResponse(repositoryStatus);
      }
      return fakeResponse(200, JSON.stringify({ default_branch: branch, full_name: repository }));
    }
    if (text === `https://api.github.com/repos/${repository}/commits/${branch}`) {
      return fakeResponse(200, JSON.stringify({ sha }));
    }
    if (text === `https://raw.githubusercontent.com/${repository}/${sha}/spec/state/controller-program-state.json`) {
      if (stateStatus !== 200) {
        return fakeResponse(stateStatus);
      }
      return fakeResponse(200, machineState);
    }
    const workOrderMatch = text.match(
      /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/spec\/work-items\/([A-Za-z0-9-]+)\.md$/
    );
    if (workOrderMatch) {
      if (workOrderStatus !== 200) {
        return fakeResponse(workOrderStatus);
      }
      return fakeResponse(200, workOrder);
    }
    return fakeResponse(404);
  };
  return { fetchImpl, requested };
}

export function fakeResponse(status, body = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

/**
 * A deterministic in-memory chrome.storage.local fake.
 */
export function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const written = [];
  return {
    async get(key) {
      if (typeof key === "string") {
        return { [key]: structuredClone(data.get(key)) };
      }
      const out = {};
      for (const k of key) {
        out[k] = structuredClone(data.get(k));
      }
      return out;
    },
    async set(items) {
      written.push(structuredClone(items));
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    },
    /** Test-only: the raw current data (for byte-identity proofs). */
    _dump() {
      return Object.fromEntries(data);
    },
    _written() {
      return written;
    },
  };
}

/**
 * A deterministic chrome.tabs fake.
 */
export function fakeTabsApi({ tabs = [], createFailure = null, queryFailure = null } = {}) {
  const created = [];
  const queries = [];
  return {
    async query(pattern) {
      queries.push(pattern);
      if (queryFailure) {
        throw queryFailure;
      }
      return tabs.filter((tab) => typeof tab.url === "string" && tab.url.startsWith(String(pattern.url).replace(/\*$/, "")));
    },
    async create(options) {
      if (createFailure) {
        throw createFailure;
      }
      const tab = { id: tabs.length + 101, ...options };
      tabs.push(tab);
      created.push(options);
      return tab;
    },
    // CTRL-014: the base fake models tabs WITHOUT the Z.ai content
    // script — every page-channel send fails closed exactly like a
    // real tab with no receiving end.
    async sendMessage() {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
    async update(tabId, options) {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) {
        throw new Error(`cannot update tab ${tabId}: no such tab`);
      }
      Object.assign(tab, options);
      return tab;
    },
    async get(tabId) {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) {
        throw new Error(`cannot get tab ${tabId}: no such tab`);
      }
      return tab;
    },
    _created() {
      return created;
    },
    _queries() {
      return queries;
    },
  };
}

/**
 * Read and parse the extension manifest (for the manifest tests).
 */
export function loadManifest() {
  return JSON.parse(readFileSync(join(EXTENSION_ROOT, "manifest.json"), "utf-8"));
}

/**
 * Read a text file relative to the extension root.
 */
export function readExtensionFile(relativePath) {
  return readFileSync(join(EXTENSION_ROOT, relativePath), "utf-8");
}

// ---------------------------------------------------------------------------
// CTRL-013 fixtures: the GitHub OAuth device flow and the app API client.
// ---------------------------------------------------------------------------

/**
 * A deterministic fake of the two GitHub device-flow endpoints.
 * Implements exactly the documented wire behavior: /login/device/code
 * returns the device code; /login/oauth/access_token answers
 * authorization_pending / slow_down (retryable) and then the terminal
 * sequence configured by `tokenOutcome`. Records every request body
 * (they contain only the public client id and codes — never secrets).
 */
export function fakeDeviceFlowEndpoints({
  clientId = "Ov23cliEntId0123456789",
  scopes = ["public_repo"],
  userCode = "ABCD-1234",
  deviceCode = "d3v1c3c0d3",
  verificationUri = "https://github.com/login/device",
  expiresIn = 900,
  interval = 1,
  tokenOutcome = "token", // token | expired_token | access_denied | device_flow_disabled
  pendingRounds = 2,
  slowDownRounds = 0,
  codeStatus = 200,
  codeBody = null,
} = {}) {
  const requests = [];
  let polls = 0;
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ?? "";
    const params = Object.fromEntries(new URLSearchParams(body).entries());
    requests.push({ url: String(url), params });
    if (String(url) === "https://github.com/login/device/code") {
      if (codeStatus !== 200) {
        return fakeResponse(codeStatus, codeBody ?? "");
      }
      return fakeResponse(
        200,
        JSON.stringify({
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: verificationUri,
          expires_in: expiresIn,
          interval,
        })
      );
    }
    if (String(url) === "https://github.com/login/oauth/access_token") {
      polls += 1;
      if (polls <= pendingRounds) {
        return fakeResponse(200, JSON.stringify({ error: "authorization_pending" }));
      }
      if (polls <= pendingRounds + slowDownRounds) {
        return fakeResponse(200, JSON.stringify({ error: "slow_down" }));
      }
      if (tokenOutcome === "token") {
        return fakeResponse(
          200,
          JSON.stringify({ access_token: "gho_testtokenvalue111111111111111111", token_type: "bearer", scope: scopes.join(" ") })
        );
      }
      return fakeResponse(200, JSON.stringify({ error: tokenOutcome }));
    }
    return fakeResponse(404);
  };
  return { fetchImpl, requests, _polls: () => polls };
}

/**
 * A deterministic fake identity for service/client tests: holds a
 * session token exactly like the real closure does.
 */
export function fakeIdentity({ token = null } = {}) {
  let current = token;
  const invalidated = [];
  return {
    currentToken: () => current,
    invalidate() {
      invalidated.push(current);
      current = null;
    },
    _setToken(value) {
      current = value;
    },
    _invalidated: () => invalidated,
  };
}

/** A GitHub app-API JSON response shape helper. */
export function jsonResponse(status, value, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(Object.entries(headers)),
    text: async () => (value === undefined ? "" : JSON.stringify(value)),
  };
}

/** A synthetic repository summary (the /repos and /user/repos shape). */
export function fakeRepositoryPayload(fullName, overrides = {}) {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    name,
    owner: { login: owner },
    default_branch: "main",
    description: `synthetic ${fullName}`,
    private: false,
    pushed_at: "2026-09-05T00:00:00Z",
    ...overrides,
  };
}

/** A synthetic pull-request payload (the /pulls shape). */
export function fakePullRequestPayload(number, overrides = {}) {
  return {
    number,
    state: "open",
    title: `PR #${number}`,
    head: { ref: `ctrl-${number}`, sha: "a".repeat(40) },
    base: { ref: "main", sha: "b".repeat(40) },
    draft: false,
    merged: false,
    mergeable_state: "clean",
    merge_commit_sha: null,
    ...overrides,
  };
}

/**
 * A chrome.tabs fake with messaging (update/get/sendMessage) for the
 * CTRL-014 Z.ai adapter tests: tabs carry a `page` handler that
 * answers `sendMessage` exactly like the content script channel.
 */
export function fakeMessagingTabsApi({ tabs = [] } = {}) {
  const queried = [];
  const updates = [];
  const fetched = [];
  return {
    async query(pattern) {
      queried.push(pattern);
      const prefix = String(pattern.url).replace(/\*$/, "");
      return tabs.filter((tab) => typeof tab.url === "string" && tab.url.startsWith(prefix));
    },
    async create(options) {
      const tab = { id: 900 + tabs.length, ...options, active: true };
      tabs.push(tab);
      return tab;
    },
    async update(tabId, options) {
      updates.push({ tabId, options });
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) {
        throw new Error(`cannot update tab ${tabId}: no such tab`);
      }
      Object.assign(tab, options);
      return tab;
    },
    async get(tabId) {
      fetched.push(tabId);
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) {
        throw new Error(`cannot get tab ${tabId}: no such tab`);
      }
      return tab;
    },
    async sendMessage(tabId, message) {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab || typeof tab.page !== "object" || tab.page === null) {
        return Promise.reject(new Error(`Could not establish connection. Receiving end does not exist.`));
      }
      return tab.page.handle(message);
    },
    _tabs: tabs,
    _queried: queried,
    _updates: updates,
  };
}

/**
 * The deterministic offline Z.ai page simulator (CTRL-014).
 *
 * Models the live-observed provider surface so the adapter's full
 * sequencing matrix runs offline: buttons (text/aria/disabled/active),
 * the composer, the send control, the model selector (trigger +
 * option rows), the Agent control, the Stop control, the modal
 * dialog, the alert surface, and the conversation. Command semantics
 * mirror page/zaiPage.js exactly (probe/click/clickIndex/type/
 * pressEnter), including the null-fact degradation for absent
 * surfaces and the refusal semantics for ambiguous actions.
 *
 * `beforeRespond(command, state, history)` lets a test mutate the
 * page state at a precise point in the sequence (authentication
 * dropping, a popup surviving Enter, a send that does not take).
 */
export function fakeZaiPage({
  authenticated = false,
  buttons = null,
  composerValue = "",
  dialog = null,
  alert = null,
  conversation = [],
  modelOptions = ["GLM-5.3-Flash  NEW  Lightweight flagship", "GLM-5.3   Flagship model", "GLM-5.2   Previous flagship"],
  selectedModel = "GLM-5.3-Flash",
  modelOpen = false,
  agent = { present: false, active: false },
  sidebar = "expanded",
  stop = { visible: false },
  generates = true,
  popupOnSend = false,
  popupText = "Confirm submission",
  beforeRespond = null,
} = {}) {
  const history = [];
  const state = {
    authenticated,
    composerValue,
    dialog,
    alert,
    conversation,
    modelOptions,
    selectedModel,
    modelOpen,
    agent,
    sidebar,
    stop,
    generates,
    popupOnSend,
    popupText,
  };

  /**
   * The LIVE-OBSERVED sidebar mode toggle (2026-09-06, real
   * https://chat.z.ai surface): exactly two <button> pills — Chat
   * first, Agent second — both ALWAYS carrying data-active
   * ("true"|"false"), no id, no aria-label. The expanded sidebar
   * renders the pill labels; the collapsed sidebar renders
   * icon-only pills (empty text). Clicking the Agent pill switches
   * the provider app into Agent mode.
   */
  function modePills() {
    if (!state.agent.present || !state.authenticated) {
      return [];
    }
    const label = (text) => (state.sidebar === "collapsed" ? "" : text);
    return [
      { text: label("Chat"), dataActive: !state.agent.active, isChatPill: true, disabled: false },
      { text: label("Agent"), dataActive: state.agent.active, isAgentPill: true, disabled: false },
    ];
  }

  const defaultButtons = () =>
    state.authenticated
      ? [...modePills(), { text: "New Chat", ariaLabel: "New Chat", disabled: false, active: false }]
      : [
          { text: "Sign in", ariaLabel: null, disabled: false, active: false },
          { text: "Sign in", ariaLabel: null, disabled: false, active: false },
          { text: "ZCode", ariaLabel: null, disabled: false, active: false },
        ];
  const visibleButtons = () => (buttons ? buttons(state) : defaultButtons());

  function sendButton() {
    // The send control is visible whenever the composer is present.
    return { disabled: state.composerValue.length === 0 };
  }

  function submit() {
    if (state.popupOnSend && state.composerValue.length > 0) {
      state.dialog = { text: state.popupText };
      return; // the popup blocked the submission: the prompt stays put
    }
    if (state.composerValue.length > 0) {
      state.conversation.push(state.composerValue);
      state.composerValue = "";
      if (state.generates) {
        state.stop.visible = true;
      }
    }
  }

  function handle(message) {
    if (beforeRespond) {
      beforeRespond(message, state, history);
    }
    history.push(message);
    if (typeof message !== "object" || message === null || message.zaiPage !== true) {
      return { ok: false, error: { code: "PAGE_MALFORMED", message: "not a Z.ai page command" } };
    }
    if (message.op === "probe") {
      const facts = {};
      for (const probe of message.probes) {
        const fact = probeFact(probe);
        if (fact.ok === false) {
          return fact;
        }
        facts[probe.name] = fact.fact;
      }
      return { ok: true, facts };
    }
    if (message.op === "click") {
      const target = resolveSelector(message.selector);
      if (!target.ok) {
        return target;
      }
      return applyAction(target.element, target.how);
    }
    if (message.op === "clickIndex") {
      const list = resolveList(message.selector);
      if (message.index >= list.length) {
        return { ok: false, error: { code: "PAGE_AMBIGUOUS", message: "clickIndex out of range" } };
      }
      return applyAction(list[message.index], "index");
    }
    if (message.op === "type") {
      if (message.selector !== "#chat-input") {
        return { ok: false, error: { code: "PAGE_AMBIGUOUS", message: "type target not found" } };
      }
      state.composerValue = message.text;
      return { ok: true, typed: true, value: state.composerValue };
    }
    if (message.op === "pressEnter") {
      if (state.dialog) {
        state.dialog = null; // the known dismissable popup
      }
      return { ok: true, pressed: "Enter", target: "TEXTAREA" };
    }
    return { ok: false, error: { code: "PAGE_MALFORMED", message: "unknown op" } };
  }

  function probeFact(probe) {
    const count = (selector) => resolveList(selector).length;
    switch (probe.mode) {
      case "count":
        return { ok: true, fact: { count: count(probe.selector), matching: count(probe.selector) } };
      case "texts": {
        const list = resolveList(probe.selector);
        if (probe.selector === "button") {
          return { ok: true, fact: { texts: visibleButtons().map((b) => b.text) } };
        }
        if (probe.selector === 'button[aria-label="model-item"]') {
          return { ok: true, fact: { texts: state.modelOpen ? state.modelOptions : [] } };
        }
        return { ok: true, fact: { texts: list.map((el) => textOf(el)) } };
      }
      case "visible":
        return { ok: true, fact: { visible: count(probe.selector) > 0, count: count(probe.selector) } };
      case "enabled": {
        const list = resolveList(probe.selector);
        if (list.length !== 1) {
          return { ok: true, fact: { enabled: null, ambiguous: list.length > 1 } };
        }
        return { ok: true, fact: { enabled: !list[0].disabled } };
      }
      case "text": {
        const list = resolveList(probe.selector);
        if (list.length !== 1) {
          return { ok: true, fact: { text: null, ambiguous: list.length > 1 } };
        }
        return { ok: true, fact: { text: textOf(list[0]) } };
      }
      case "value": {
        const list = resolveList(probe.selector);
        if (list.length !== 1) {
          return { ok: true, fact: { value: null, ambiguous: list.length > 1 } };
        }
        return { ok: true, fact: { value: list[0].value ?? null } };
      }
      default:
        return { ok: false, error: { code: "PAGE_MALFORMED", message: "bad mode" } };
    }
  }

  function resolveList(selector) {
    if (selector === "button") {
      return visibleButtons();
    }
    if (selector === 'button[aria-label="model-item"]') {
      return state.modelOpen ? state.modelOptions.map((text) => ({ text, modelOption: true })) : [];
    }
    if (selector.includes("model-selector")) {
      return [{ text: state.selectedModel, isTrigger: true }];
    }
    if (selector === "#chat-input") {
      return state.authenticated || true ? [{ value: state.composerValue, isComposer: true }] : [];
    }
    if (selector === "#send-message-button") {
      return [Object.assign({ isSend: true }, sendButton())];
    }
    if (selector === '[role="dialog"], dialog') {
      return state.dialog ? [{ text: state.dialog.text }] : [];
    }
    if (selector === '[role="alert"]') {
      return state.alert ? [{ text: state.alert.text }] : [];
    }
    if (selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type") {
      return modePills().filter((pill) => pill.isAgentPill);
    }
    if (selector === '#sidebar button[data-active="true"]:not([id]):nth-of-type(2):last-of-type') {
      return modePills().filter((pill) => pill.isAgentPill && pill.dataActive === true);
    }
    if (selector === "#sidebar button[data-active]:not([id])") {
      return modePills();
    }
    if (selector.includes('aria-label="Stop"') || selector.includes('title="Stop"')) {
      return state.stop.visible ? [{ text: "Stop", isStop: true, disabled: false }] : [];
    }
    if (selector === '[role="log"]') {
      return state.conversation.length > 0 ? [{ text: state.conversation.join("\n") }] : [];
    }
    if (selector === '[class*="user"][class*="message"]' || selector === '[data-role="user"]' || selector === '[class*="user-message"]') {
      return state.conversation.map((text) => ({ text, value: text }));
    }
    // The remaining conversation candidates behave like the log.
    if (selector === "main" || selector.includes("conversation") || selector.includes("message-list")) {
      return state.conversation.length > 0 ? [{ text: state.conversation.join("\n") }] : [];
    }
    return [];
  }

  function resolveSelector(selector) {
    const list = resolveList(selector);
    if (list.length !== 1) {
      return {
        ok: false,
        error: { code: "PAGE_AMBIGUOUS", message: `matched ${list.length} visible elements` },
      };
    }
    return { ok: true, element: list[0], how: "selector" };
  }

  function textOf(element) {
    if (element.isComposer) {
      return element.value ?? "";
    }
    return element.text ?? "";
  }

  function applyAction(element, how) {
    if (element.isSend) {
      if (element.disabled) {
        return { ok: false, error: { code: "PAGE_REFUSED", message: "the send control is disabled" } };
      }
      submit();
      return { ok: true, clicked: true };
    }
    if (element.isTrigger) {
      state.modelOpen = true;
      return { ok: true, clicked: true };
    }
    if (element.modelOption) {
      state.selectedModel = element.text.split(/\s+/)[0];
      state.modelOpen = false;
      return { ok: true, clicked: true };
    }
    if (element.isStop) {
      state.stop.visible = false;
      return { ok: true, clicked: true };
    }
    if (element.isAgentPill) {
      // The real pill click switches the provider app into Agent
      // mode: the Agent pill becomes the active mode pill.
      state.agent.active = true;
      return { ok: true, clicked: true };
    }
    return { ok: true, clicked: true };
  }

  return Object.freeze({
    state,
    handle,
    history: () => [...history],
  });
}

/**
 * A page bridge over the fake messaging tabs API: answers exactly
 * like createZaiPageBridge would against the tab's page handler.
 */
export function fakePageBridge(tabsApi) {
  return Object.freeze({
    send: (tabId, command) => tabsApi.sendMessage(tabId, command),
  });
}
