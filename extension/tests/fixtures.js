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
 * CONTINUATION 22 (PR #6 review 5125571572, path (b) — the frozen
 * Work Order's dialog law RESTORED): the dialog modeling stays
 * SURFACE-FAITHFUL and is now OBSERVED again — the adapter's probe
 * vocabulary carries the dialogCount/dialogText probes, the
 * popupOnSend blocking modality, the popupAfterSend async
 * materialization with optional prompt restore, and the pressEnter
 * page primitive — so the known-popup regressions can place the
 * REAL "Currently in peak hours" capacity dialog on the surface
 * and prove the adapter presses Enter ONLY on the observed,
 * classified known popup (once per retry attempt, dismissal
 * verified, full preparation restart), and fails closed
 * UNKNOWN_DIALOG on every other dialog shape.
 *
 * CONTINUATION 14 (PR #6 review 5124542353 / the work order
 * 5557596159 — "REPLACE POPUP DETECTION WITH SEND-CONTROL STATE
 * MACHINE"): the pressEnter primitive models the provider's composer
 * keybinding (the Enter on the focused composer holding text
 * SUBMITS it — the same submission semantics as the send control's
 * click; a dialog open on the surface captures the key instead); the
 * async restore models the REAL capacity-rejection semantics (the
 * submission did NOT land — the optimistically landed row is
 * withdrawn with the restore); and the `sendInaccessible` knob
 * models the slot rendering NEITHER control (the surface whose Send
 * control cannot be resolved/accessed — the Enter-fallback
 * regressions).
 *
 * `beforeRespond(command, state, history)` lets a test mutate the
 * page state at a precise point in the sequence (authentication
 * dropping, a send that does not take).
 */
export function fakeZaiPage({
  authenticated = false,
  buttons = null,
  composerValue = "",
  dialog = null,
  alert = null,
  conversation = [],
  // The WEAK non-message surfaces (the continuation-6 eliminated
  // acceptance candidates, PR #6 review 5123047551): broad
  // class-scan regions that are NOT message-exclusive — e.g. a
  // sidebar conversation list rendering an earlier conversation
  // titled with the exact prompt. The adapter no longer probes
  // them (they are not evidence); they exist to model the live
  // false-positive source for the regression tests.
  sidebarHistory = [],
  // The model selector surface, modeling the LIVE-OBSERVED structure
  // (2026-09-06, real https://chat.z.ai, closed state AND the opened
  // option list): option rows carry aria-label="model-item" +
  // data-value; the trigger carries aria-label="Select a model" and
  // an id that embeds the SELECTED model's data-value with
  // "." -> "_"; the trigger text displays the selected model's
  // label. Default rows mirror the live menu; the default selected
  // value mirrors the operator's authenticated observation (GLM-5.2)
  // vs the live unauthenticated landing (x-preview-l).
  modelOptions = [
    { text: "GLM-5.3-Flash  NEW  Lightweight flagship model, premium quality, instant response.", value: "x-preview-l", disabled: false },
    { text: "GLM-5.3   Flagship model, excels at coding and long-horizon tasks", value: "glm-5.3", disabled: false },
    { text: "GLM-5.2   Previous flagship model", value: "glm-5.2", disabled: false },
  ],
  selectedValue = null,
  modelOpen = false,
  modelTrigger = true,
  modelTriggerAria = true,
  // Verification-failure simulations: a provider whose trigger id
  // (resp. trigger text) never tracks the selection.
  modelIdStuck = false,
  modelTextStuck = false,
  agent = { present: false, active: false },
  sidebar = "expanded",
  // The Stop control (CONTINUATION-11, PR #6 comment 5557087907,
  // requirement 2 facts — LIVE-OBSERVED wrapper family +
  // provider-bundle-proven slot): the composer action slot renders
  // through a bits-ui Tooltip trigger wrapper — a DIV carrying
  // data-tooltip-trigger whose aria-label is the COMPUTED tooltip
  // content. The provider's own bundle computes that content as
  // "Stop" OR the long-task text "The current task is in progress.
  // Please cancel it before starting other tasks." (the SAME control
  // in two label states), and attaches the abort click handler to the
  // INNER button (never the wrapper div). `stop.visible` models the
  // control's presence; `stopLongTask` models the long-task label
  // state (the wrapper's aria-label switches, so the Stop-labeled
  // candidates stop matching while the long-task-labeled candidate
  // resolves the same inner button).
  stop = { visible: false },
  stopLongTask = false,
  // CONTINUATION-12 control-state knobs (PR #6 comment 5557322324,
  // requirements 2-3 and 7 — the provider's own bundle-proven composer
  // action-slot state machine):
  //   `sendSlotStuck` models the MALFORMED surface that renders the send
  //   control AND the Stop control simultaneously (the provider's slot
  //   renders exactly one — the contradictory control state that must
  //   fail closed);
  //   `sendEnabledLie` models the surface whose send control is computed
  //   ENABLED while the composer reads decisively empty (the provider's
  //   own prompt-present computation contradicting the raw input read —
  //   the untrustworthy-composer-read contradiction that must fail
  //   closed);
  //   `duplicateSend` models two #send-message-button elements (the
  //   enabled probe degrades to an ambiguous null while the control is
  //   visible — the unreadable control state);
  //   `state.pendingStop` (armed by a test through the exposed state, or
  //   by any surface transition) models the QUEUED generation becoming
  //   active: the Stop control appears on the Nth fact read after the
  //   arming (the submission confirmed but the generation not yet
  //   active — the operator's literal generation:"waiting" surface, then
  //   the generation entering flight);
  //   `generationCompletes` models the provider's completion transition:
  //   on the Nth fact read with the Stop control visible, the current
  //   message completes (the slot swaps back to the send control and
  //   the Regenerate control renders — the real post-response surface).
  sendSlotStuck = false,
  sendEnabledLie = false,
  duplicateSend = false,
  generationCompletes = null,
  // CONTINUATION 15 (PR #6 review 5124990727 + review 5125102305): the
  // `sendInaccessible` knob models the composer action slot rendering
  // NEITHER control — #send-message-button resolves ZERO elements
  // while the composer itself stays a normal enabled input. This is
  // the surface whose Send control cannot be resolved/accessed
  // decisively: NO send click is issued (the click fires only when
  // the slot renders the send control) and the surface routes into
  // the AGENT-START WATCH, whose timed Enter cadence is the recovery
  // (a test disarms the knob on an Enter to model the provider's
  // slot re-render; a knob that persists models a Send control that
  // never becomes resolvable — the watch's bounded window fails
  // closed).
  sendInaccessible = false,
  // The post-response Regenerate control (CONTINUATION-11,
  // LIVE-OBSERVED in the operator's saved authenticated capture at
  // main 5d14d90): the bits-ui tooltip wrapper
  // div[data-tooltip-trigger][aria-label="Regenerate"] wrapping
  // button.regenerate-response-button — the circular control on the
  // completed/stopped last response. The real provider renders it
  // after a generation STOPS (exactly the operator's observed
  // post-Stop UI), so the fixture's Stop click turns it visible;
  // `regenerate.visible` also models the manually-stopped surface
  // (the operator's literal failed-run state). The control is
  // context/diagnostic only — the adapter never clicks it (a click
  // increments `regenerate.clicked`, which regressions assert never
  // happens).
  regenerate = { visible: false },
  generates = true,
  popupOnSend = false,
  popupText = "Confirm submission",
  // The REAL peak-hours modality (continuation 10, PR #6 review
  // 5123872434): LIVE-OBSERVED in the operator's captured run
  // (repository of record, main 5d14d90 — the "Currently in peak
  // hours" bits-ui capacity dialog, role="dialog" +
  // aria-modal="true" + data-state="open") and proven from the
  // provider's own bundle code (the MODEL_CONCURRENCY_LIMIT error
  // handler): the send LANDS first (the user-message row appears,
  // the composer clears, no generation starts), and the capacity
  // dialog materializes only when the ASYNCHRONOUS error arrives —
  // the same handler optionally RESTORES the submitted prompt into
  // the composer. `true` models the observed default (the popup
  // materializes on the 2nd fact read after the send, no restore);
  // `{ probes: N, text: "...", restore: true }` customizes it. This
  // is the modality the operator's continuation-10 run reproduced:
  // Start returned ok:true / popupDismissals:0 while the popup was
  // visibly present. CONTINUATION 22 (PR #6 review 5125571572,
  // path (b)): the ASYNC-OUTCOME HOLD that watches for this modality
  // is RESTORED (after the start signal, gated by the dialog
  // dispatch), and the dialog landing inside the watch is dispatched
  // by the frozen Work Order's dialog law (the known popup receives
  // the ONE bounded Enter with the verified dismissal and the full
  // preparation restart; every other shape fails closed), while the
  // prompt restore (when it survives the watch) flows through the
  // ordinary unconfirmed-retry path.
  popupAfterSend = null,
  // The composer Agent/compose control (LIVE-OBSERVED 2026-09-06,
  // real origin: the composer FORM containing #chat-input renders
  // EXACTLY THREE buttons — upload (More), the Agent/compose toggle
  // carrying data-active with no id/aria-label, and the send
  // control). Present by default; `false` models an ABSENT control
  // (the structural locator resolves ZERO candidates — the
  // continuation-7 absence regression); `"ambiguous"` models a
  // composer form rendering TWO data-active buttons (the locator
  // resolves MANY — the continuation-7 ambiguity regression: the
  // re-establishment must fail closed BEFORE any click);
  // `composeStuck` models a control whose click never yields an
  // enabled composer (the input state is not re-established);
  // `duplicateComposer` models an ambiguous composer surface (two
  // visible #chat-input elements — the value/enabled probes degrade
  // to null facts); a disabled composer refuses the type op
  // verbatim (mirroring the real page script's setValue acceptance
  // check).
  composeControl = true,
  composeStuck = false,
  duplicateComposer = false,
  beforeRespond = null,
  // CONTINUATION 16 (PR #6 review 5125198728 — the DIRECT Z.ai
  // CHAT-STATE WORKFLOW): the page's URL, modeling the provider's
  // own routing state (which chat session the page holds).
  // BUNDLE-PROVEN: the provider's submission handler creates the
  // chat object server-side on an ACCEPTED first submission (the
  // chat id from the response -> the current-chat store ->
  // REFRESH_AGENT_CHAT_LIST -> history.replaceState to `/c/<id>`),
  // and the 429/capacity path returns BEFORE the creation (no
  // chat, no URL advance). The fixture defaults to the
  // fresh-session base URL (no chat object); a surface modeling an
  // EXISTING chat passes `chatUrl: "https://chat.z.ai/c/<id>"` (an
  // accepted submission never re-advances it — the chat object
  // already exists). Read by the adapter through the page script's
  // "location" fact probe.
  chatUrl = null,
} = {}) {
  // The REAL peak-hours dialog's trimmed text as captured (title +
  // body + button labels): deliberately non-auth-shaped and
  // non-error-shaped — the known submission-blocking popup.
  const PEAK_HOURS_POPUP_TEXT =
    "Currently in peak hours GLM-5.3 is intensifying the coordination of resources, please switch to GLM-5.3-Flash for experience or try again later. Cancel Switch to GLM-5.3-Flash";
  const asyncPopup = popupAfterSend === true ? { probes: 2 } : popupAfterSend;
  const effectiveSelectedValue = selectedValue ?? (authenticated ? "glm-5.2" : "x-preview-l");
  const initialSelectedValue = effectiveSelectedValue;
  const history = [];
  // The provider's chat-object routing state: the fresh session
  // sits at the origin base (no chat); an accepted first submission
  // creates the chat and routes the page to /c/<id> (the deterministic
  // fixture chat id).
  const initialUrl = chatUrl ?? "https://chat.z.ai/";
  const state = {
    authenticated,
    composerValue,
    dialog,
    alert,
    conversation,
    sidebarHistory,
    modelOptions,
    selectedValue: effectiveSelectedValue,
    modelOpen,
    modelTrigger,
    modelTriggerAria,
    modelIdStuck,
    modelTextStuck,
    agent,
    sidebar,
    stop,
    stopLongTask,
    regenerate,
    generates,
    popupOnSend,
    popupText,
    url: initialUrl,
    chatCreated: initialUrl.startsWith("https://chat.z.ai/c/"),
    chatId: "c-014-fixture-7f3d",
    asyncPopup: asyncPopup
      ? {
          probes: asyncPopup.probes,
          text: asyncPopup.text ?? PEAK_HOURS_POPUP_TEXT,
          restore: asyncPopup.restore === true,
          fired: false,
        }
      : null,
    pendingPopup: null,
    lastSubmitted: null,
    composeControl,
    composeStuck,
    duplicateComposer,
    composerDisabled: false,
    sendSlotStuck,
    sendEnabledLie,
    duplicateSend,
    sendInaccessible,
    pendingStop: null,
    generationCompletes: generationCompletes ? { probes: generationCompletes, fired: false } : null,
    pendingCompletion: null,
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
    // The send control's own computed state (the provider bundle's
    // disabled computation: the trimmed composer text empty ->
    // disabled, plus its connection/role gates — the fixture models
    // the prompt-emptiness gate, the governed surface's always-passing
    // gates). `sendEnabledLie` models the surface whose control
    // computes ENABLED while the composer is decisively empty.
    return { disabled: sendEnabledLie ? false : state.composerValue.length === 0 };
  }

  function submit() {
    // CONTINUATION 15 (PR #6 review 5124990727 + review 5125102305): the
    // provider's OWN concurrency gate — the observed provider safety
    // property ("Z.ai already prevents a second prompt while a
    // generation is running"): a submission attempt (the send click
    // OR the composer Enter) issued while the Stop control is
    // rendered is REFUSED by the provider — nothing lands, the draft
    // stays in the composer. The duplicate guard is the provider's,
    // never an artificial adapter-side assumption.
    if (state.stop.visible) {
      return; // the provider refused the submission: the draft stays put
    }
    if (state.popupOnSend && state.composerValue.length > 0) {
      state.dialog = { text: state.popupText };
      return; // the popup blocked the submission: the prompt stays put
    }
    if (state.composerValue.length > 0) {
      state.lastSubmitted = state.composerValue;
      state.conversation.push(state.composerValue);
      state.composerValue = "";
      // CONTINUATION 16 (PR #6 review 5125198728): the chat-object
      // creation — the provider's own submission handler creates
      // the chat server-side on an ACCEPTED first submission (the
      // chat id from the response -> the current-chat store ->
      // REFRESH_AGENT_CHAT_LIST -> history.replaceState to
      // `/c/<id>`). The 429/capacity path (`asyncPopup`) returns
      // BEFORE the creation: no chat object, no URL advance — the
      // landed row is the provider's local optimistic echo of a
      // submission the server refused. The block applies only while
      // the async error is still PENDING (not yet fired): a LATER
      // submission (e.g. the timed-Enter re-submission of the
      // provider-restored prompt) is an ordinary fresh submission
      // that creates the chat when accepted. An existing chat
      // (already at /c/<id>) never re-advances.
      if (!state.chatCreated && !(state.asyncPopup && !state.asyncPopup.fired)) {
        state.chatCreated = true;
        state.url = `https://chat.z.ai/c/${state.chatId}`;
      }
      // The REAL modality: the landing happens FIRST; the capacity
      // dialog materializes only on the ASYNC error path — modeled
      // as a fact-read countdown after the send (once per Start).
      if (state.asyncPopup && !state.asyncPopup.fired) {
        state.asyncPopup.fired = true;
        state.pendingPopup = state.asyncPopup.probes;
      }
      if (state.generates) {
        state.stop.visible = true;
      }
    }
  }

  /** The trigger id the live provider derives from a data-value. */
  function triggerIdFor(value) {
    return `model-selector-${value.replace(/\./g, "_")}-button`;
  }

  /** The trigger display label for a data-value (the row's leading token). */
  function triggerTextFor(value) {
    const row = state.modelOptions.find((option) => option.value === value);
    return row ? row.text.split(/\s+/)[0] : value;
  }

  function triggerElement() {
    const valueForId = state.modelIdStuck ? initialSelectedValue : state.selectedValue;
    const valueForText = state.modelTextStuck ? initialSelectedValue : state.selectedValue;
    return {
      text: triggerTextFor(valueForText),
      isTrigger: true,
      disabled: false,
      id: triggerIdFor(valueForId),
    };
  }

  function modelOptionRows(selectorValue) {
    const open = state.modelOpen ? state.modelOptions : [];
    const rows = selectorValue ? open.filter((option) => option.value === selectorValue) : open;
    return rows.map((option) => ({
      text: option.text,
      modelOption: true,
      value: option.value,
      disabled: option.disabled === true,
    }));
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
      // The CONTINUATION-12 control-state transitions (the provider's
      // own bundle-proven composer action-slot machine):
      //   - the QUEUED generation becoming active: `state.pendingStop`
      //     counts down on each fact read and swaps the action slot to
      //     the Stop control (the current message entering flight);
      //   - the generation completing: on the Nth fact read with the
      //     Stop control visible, the current message completes (the
      //     slot swaps back to the send control and the Regenerate
      //     control renders — the real post-response surface).
      if (state.pendingStop !== null) {
        state.pendingStop -= 1;
        if (state.pendingStop <= 0) {
          state.pendingStop = null;
          state.stop.visible = true;
        }
      }
      if (state.generationCompletes && !state.generationCompletes.fired && state.stop.visible) {
        state.generationCompletes.fired = true;
        state.pendingCompletion = state.generationCompletes.probes;
      }
      if (state.pendingCompletion !== null) {
        state.pendingCompletion -= 1;
        if (state.pendingCompletion <= 0) {
          state.pendingCompletion = null;
          state.stop.visible = false;
          state.regenerate.visible = true;
        }
      }
      // The async popup materializes on the Nth fact read after the
      // send (the asynchronous MODEL_CONCURRENCY_LIMIT arrival).
      // CONTINUATION 14: the restore now models the REAL
      // capacity-rejection semantics — the submission did NOT land
      // (the error handler restores the prompt into the composer), so
      // the optimistically landed row is WITHDRAWN with the restore.
      // (The pre-correction fixture left the row in place, making the
      // evidence-present state reachable through a restore — under
      // the continuation-14 contract that state is the NEVER-RESEND
      // path, so the resend regression needs the faithful
      // no-row-after-restore surface.)
      if (state.pendingPopup !== null) {
        state.pendingPopup -= 1;
        if (state.pendingPopup <= 0) {
          state.pendingPopup = null;
          state.dialog = { text: state.asyncPopup.text };
          if (state.asyncPopup.restore) {
            if (state.conversation[state.conversation.length - 1] === state.lastSubmitted) {
              state.conversation.pop(); // the submission did not land
            }
            state.composerValue = state.lastSubmitted; // the provider's prompt restore
            state.stop.visible = false; // CONTINUATION 15: the rejected submission never started a generation — the slot swaps back
          }
        }
      }
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
      if (state.duplicateComposer) {
        // Mirrors requireSingleVisible: an ambiguous action target
        // refuses (zero best-effort typing).
        return { ok: false, error: { code: "PAGE_AMBIGUOUS", message: "type matched 2 visible elements (need exactly 1; refusing best-effort action)" } };
      }
      if (state.composerDisabled) {
        // Mirrors page/zaiPage.js setValue: a composer whose input
        // state is not established does not accept the text — the
        // typed prompt does not land.
        return { ok: false, error: { code: "PAGE_REFUSED", message: "the composer did not accept the exact text verbatim" } };
      }
      state.composerValue = message.text;
      return { ok: true, typed: true, value: state.composerValue };
    }
    if (message.op === "pressEnter") {
      // CONTINUATION 22 (PR #6 review 5125571572, path (b) — the
      // frozen Work Order's dialog law): the Enter primitive's
      // surface-faithful semantics. The real page script dispatches
      // the Enter key sequence on the FOCUSED element (the composer —
      // focused by the type op). A dialog open on the surface
      // captures the key (the dialog closes, nothing is submitted);
      // with no dialog, a composer holding text SUBMITS it (the
      // provider's composer keybinding — the same submission
      // semantics as the send control's click), SUBJECT to the
      // provider's own concurrency gate (submit() refuses while the
      // Stop control is rendered — a second prompt while a
      // generation runs is never accepted); an empty composer makes
      // the Enter a pure no-op. The adapter issues the Enter ONLY on
      // the OBSERVED, classified known submission-blocking popup
      // (the frozen Work Order's bounded recovery — once per retry
      // attempt, the dismissal verified, the full preparation
      // restart), never on a timer and never as a submission
      // mechanism.
      if (state.dialog) {
        state.dialog = null; // the dialog captured the key
      } else if (state.composerValue.length > 0) {
        submit(); // the Enter on the focused composer submits (the provider's gate decides)
      }
      return { ok: true, pressed: "Enter", target: "TEXTAREA" };
    }
    return { ok: false, error: { code: "PAGE_MALFORMED", message: "unknown op" } };
  }

  function probeFact(probe) {
    const count = (selector) => resolveList(selector).length;
    switch (probe.mode) {
      // CONTINUATION 16: the document's own URL — the selectorless
      // routing-state fact (mirrors the real page script's "location"
      // mode: reported verbatim, never interpreted here).
      case "location":
        return { ok: true, fact: { href: state.url } };
      case "count":
        return { ok: true, fact: { count: count(probe.selector), matching: count(probe.selector) } };
      case "texts": {
        const list = resolveList(probe.selector);
        if (probe.selector === "button") {
          return { ok: true, fact: { texts: visibleButtons().map((b) => b.text) } };
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
    // The model selector surface (LIVE-OBSERVED structure):
    if (selector === 'button[aria-label="Select a model"]') {
      return state.modelTrigger && state.modelTriggerAria ? [triggerElement()] : [];
    }
    if (selector === 'button[id^="model-selector-"][id$="-button"]') {
      return state.modelTrigger ? [triggerElement()] : [];
    }
    const selectedIdCandidate = selector.match(/^#model-selector-([a-z0-9._-]+)-button$/);
    if (selectedIdCandidate) {
      // The selected-state id candidate resolves ONLY while the
      // trigger id (derived from the SELECTED data-value) matches it.
      const valueForId = state.modelIdStuck ? initialSelectedValue : state.selectedValue;
      if (state.modelTrigger && triggerIdFor(valueForId) === selector.slice(1)) {
        return [triggerElement()];
      }
      return [];
    }
    if (selector === 'button[aria-label="model-item"]') {
      return modelOptionRows(null);
    }
    const optionValueMatch = selector.match(/^button\[aria-label="model-item"\]\[data-value="([^"]+)"\]$/);
    if (optionValueMatch) {
      return modelOptionRows(optionValueMatch[1]);
    }
    if (selector === "#chat-input") {
      const composer = { value: state.composerValue, isComposer: true, disabled: state.composerDisabled === true };
      return state.duplicateComposer ? [composer, { ...composer }] : [composer];
    }
    // The composer Agent/compose control (LIVE-OBSERVED 2026-09-06:
    // the unique data-active button of the composer form that
    // contains #chat-input — the operator-described circular
    // control).
    if (selector === "form:has(#chat-input) button[data-active]") {
      // The continuation-7 ambiguity simulation: a provider form
      // rendering TWO data-active buttons — the structural locator
      // resolves MANY, and the re-establishment must fail closed
      // AMBIGUOUS_STATE before ever clicking (never a blind click).
      if (state.composeControl === "ambiguous") {
        return [
          { isComposeControl: true, dataActive: "false", disabled: false },
          { isComposeControl: true, dataActive: "false", disabled: false },
        ];
      }
      return state.composeControl ? [{ isComposeControl: true, dataActive: "false", disabled: false }] : [];
    }
    if (selector === "#send-message-button") {
      // The CONTINUATION-12 faithful action-slot swap (the provider's
      // own bundle render conditional): the composer action slot renders
      // the send control when there is no current message or the current
      // message is done, and swaps the slot to the Stop control while
      // the current message is in flight — so #send-message-button is
      // ABSENT from the surface while the Stop control is visible AND
      // the composer is decisively EMPTY (the clean in-flight reading
      // the adapter's control-state channel classifies). A composer
      // holding text while the Stop control is visible models the
      // provider's queued-input surface, where the fixture keeps the
      // send control resolvable for the governed resend mechanics (the
      // real slot renders the Stop control only — the adapter resends
      // only from an unconfirmed surface, which on the real machine
      // carries no in-flight message). `sendSlotStuck` models the
      // MALFORMED surface that renders BOTH controls with an empty
      // composer (the contradictory control state that must fail
      // closed); `duplicateSend` models two send controls (the
      // ambiguous enabled read); `sendInaccessible` (CONTINUATION 14)
      // models the slot rendering NEITHER control — the
      // Send-inaccessible surface of the Enter-fallback regressions.
      if (state.sendInaccessible) {
        return [];
      }
      if (state.stop.visible && state.composerValue.length === 0 && !state.sendSlotStuck) {
        return [];
      }
      const button = Object.assign({ isSend: true }, sendButton());
      return state.duplicateSend ? [button, { ...button }] : [button];
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
    // The Stop control (CONTINUATION-11 LIVE-OBSERVED structure): the
    // wrapper-label-derived inner-button candidates (both computed
    // label states — "Stop" and the long-task text), then the legacy
    // button-shaped candidates as trailing fallbacks. The clickable is
    // the INNER button of the wrapper carrying the computed label.
    if (selector === '[data-tooltip-trigger][aria-label="Stop"] button') {
      return state.stop.visible && !state.stopLongTask ? [{ isStop: true, disabled: false }] : [];
    }
    if (selector === '[data-tooltip-trigger][aria-label^="The current task is in progress"] button') {
      return state.stop.visible && state.stopLongTask ? [{ isStop: true, disabled: false }] : [];
    }
    if (selector === 'button[aria-label="Stop"]' || selector === 'button[title="Stop"]') {
      return state.stop.visible && !state.stopLongTask ? [{ isStop: true, disabled: false }] : [];
    }
    // The post-response Regenerate control (CONTINUATION-11
    // LIVE-OBSERVED markup): the Regenerate-labeled tooltip wrapper
    // wrapping the provider's regenerate-response-button — present
    // only while the completed/stopped last response renders it.
    if (
      selector === '[data-tooltip-trigger][aria-label="Regenerate"] button.regenerate-response-button' ||
      selector === 'button.regenerate-response-button'
    ) {
      return state.regenerate.visible ? [{ isRegenerate: true, disabled: false }] : [];
    }
    if (selector === '[role="log"]') {
      return state.conversation.length > 0 ? [{ text: state.conversation.join("\n") }] : [];
    }
    if (selector === '[class*="user"][class*="message"]' || selector === '[data-role="user"]' || selector === '[class*="user-message"]') {
      return state.conversation.map((text) => ({ text, value: text }));
    }
    // The WEAK broad candidates (the eliminated acceptance surfaces):
    // they resolve to the NON-MESSAGE sidebar/history rows — never to
    // the conversation log. A weak surface carrying the exact prompt
    // is precisely the live false-positive source the corrected
    // acceptance predicate must ignore.
    if (selector === "main" || selector.includes("conversation") || selector.includes("message-list")) {
      return state.sidebarHistory.map((text) => ({ text }));
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
    // Mirrors page/zaiPage.js clickElement: a disabled element is
    // NEVER clicked (the live unauthenticated surface keeps the
    // GLM-5.3 option row disabled — the click must refuse).
    if (element.disabled) {
      return { ok: false, error: { code: "PAGE_REFUSED", message: "the matched element is disabled — action refused" } };
    }
    if (element.isSend) {
      submit();
      return { ok: true, clicked: true };
    }
    if (element.isTrigger) {
      state.modelOpen = !state.modelOpen; // the option menu toggles
      return { ok: true, clicked: true };
    }
    if (element.modelOption) {
      state.selectedValue = element.value;
      state.modelOpen = false;
      return { ok: true, clicked: true };
    }
    if (element.isStop) {
      state.stop.visible = false;
      // The REAL post-Stop surface (the operator's observed UI, PR #6
      // comment 5557087907): stopping the generation swaps the composer
      // action slot back to the send control AND renders the
      // Regenerate control on the stopped response — context only.
      state.regenerate.visible = true;
      return { ok: true, clicked: true };
    }
    if (element.isRegenerate) {
      // The adapter must NEVER reach this (regressions assert
      // regenerate.clicked stays unset): the Regenerate control is
      // post-response context, not a recovery action.
      state.regenerate.clicked = (state.regenerate.clicked ?? 0) + 1;
      return { ok: true, clicked: true };
    }
    if (element.isAgentPill) {
      // The real pill click switches the provider app into Agent
      // mode: the Agent pill becomes the active mode pill.
      state.agent.active = true;
      return { ok: true, clicked: true };
    }
    if (element.isComposeControl) {
      // The real control click re-establishes the composer input
      // state; the stuck simulation models a control whose click
      // never yields an enabled composer.
      state.composerDisabled = state.composeStuck === true;
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
