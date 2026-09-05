/**
 * The Z.ai browser Worker adapter (CTRL-014) — the ONLY place Z.ai
 * provider knowledge lives in the product.
 *
 * Contract (spec/work-items/CTRL-014.md, the frozen architecture's
 * "Z.ai browser worker — MVP contract"):
 *
 *   new worker session (exact governed sequence, no reordering):
 *     1. find/open/focus an authenticated chat.z.ai session;
 *     2. verify the authenticated state;
 *     3. select the `Agent` control (the sidebar mode-toggle Agent
 *        pill — the live-observed structure is documented at
 *        ZAI_LOCATORS.agentControl);
 *     4. select model `GLM-5.3` (provider model identifier `5.3` —
 *        surface-encoded by the provider as the option-row
 *        data-value `glm-5.3`, LIVE-OBSERVED; the trigger is located
 *        through its live-observed generic candidates, never a
 *        hardcoded model-specific id);
 *     5. enter the EXACT Controller-generated governed prompt verbatim;
 *     6. send;
 *     7. verify ACTUAL submission from the resulting provider state.
 *
 *   known submission-blocking popup: press `Enter` once per retry
 *   attempt, then RESEND the exact prompt (the operator's recovery
 *   loop — the preparation stays established; never a full
 *   preparation restart, and never a resend of an already-confirmed
 *   submission). Unknown/differently-shaped dialogs fail closed —
 *   the adapter never blindly presses keys, and the absence of a
 *   popup is NEVER acceptance evidence (acceptance is always the
 *   verified provider-state confirmation of step 7).
 *
 *   hung worker: `Stop` -> verified stopped -> the FIXED message
 *   `continue` -> verified acceptance (the exact message confirmed
 *   present in the conversation/user-message evidence with the
 *   composer cleared — a resumed generation state alone is NEVER
 *   acceptance evidence). No alternate recovery wording. Bounded
 *   attempts; failure to confirm a required transition is a typed
 *   governance-hold outcome.
 *
 * Layering:
 *   - every provider locator lives in ZAI_LOCATORS below (with its
 *     observation provenance); nothing Z.ai-specific leaks into the
 *     service router, the message boundary, or any Controller core;
 *   - the adapter drives the provider page ONLY through the typed
 *     page bridge (zaiPageBridge.js -> page/zaiPage.js), never
 *     touching DOM APIs itself;
 *   - a click is NEVER evidence of success: every action is followed
 *     by a post-action observation that must establish the expected
 *     resulting state, or the sequence fails closed;
 *   - the in-memory session registry preserves the Worker / Work Item
 *     / browser-tab correlation across retries and recovery; stale or
 *     contradictory references fail closed (SESSION_UNKNOWN /
 *     STALE_REFERENCE). The registry is session-scoped, never
 *     persisted, and never authoritative: repository machine state,
 *     Work Orders, lifecycle, review and merge policy remain in the
 *     Controller/repository, untouched by this adapter;
 *   - human authentication is out of band. The adapter detects
 *     authentication-required surfaces and fails closed; it never
 *     fills credentials, never automates login, and never bypasses
 *     provider security controls.
 *
 * All budgets are constructor-injectable (frozen defaults) so the
 * offline test matrix runs deterministically with a fake page bridge
 * and a fake clock.
 */

import { failure } from "./errors.js";

/**
 * The frozen typed observation vocabulary — exactly the states the
 * work order requires the Controller to be able to distinguish.
 */
export const ZAI_SESSION_OBSERVATIONS = Object.freeze([
  "authentication-required",
  "session-missing",
  "ready-for-input",
  "working",
  "waiting",
  "stopped",
  "prompt-submitted",
  "prompt-unconfirmed",
  "expected-blocking-dialog",
  "unexpected-dialog",
  "ambiguous",
  "provider-error",
]);

/**
 * The Z.ai provider locators. Provenance is explicit:
 *
 * LIVE-OBSERVED (2026-09-05, supported Chromium against the real
 * https://chat.z.ai origin): the composer textarea, the send button,
 * the model-selector trigger, the model option rows, the modal
 * dialog containers, the alert surface, and the authentication
 * call-to-action button texts were all observed on the live provider
 * surface (unauthenticated landing state).
 *
 * AUTHENTICATED-SURFACE — the sidebar mode toggle (LIVE-OBSERVED
 * 2026-09-06 on the real https://chat.z.ai origin, both in the live
 * DOM and in the provider's own front-end code): the toggle is
 * exactly two <button> pills — Chat first, Agent second — inside the
 * #sidebar shell, rendered in BOTH the expanded sidebar (pill labels
 * "Chat"/"Agent"; the provider's own i18n renders Agent_Mode as
 * "Agent") and the collapsed sidebar (icon-only pills whose text is
 * empty). Every pill ALWAYS carries a data-active attribute ("true"
 * or the string "false"); the pills carry no id, no aria-label, and
 * no role. Clicking the Agent pill switches the provider app into
 * Agent mode (a new Agent-mode session). The structural candidate
 * resolves the second-and-last button of the two-pill pair; the text
 * scan covers the expanded labeled pills; the active marker is
 * data-active="true" on that same pill.
 *
 * AUTHENTICATED-SURFACE-DECLARED: the Stop control, the conversation
 * log and user-message rows exist only behind human authentication,
 * which is out of band for this adapter. Their locators are declared
 * here as CANDIDATE lists, are verified by post-action observation at
 * first authenticated use, and fail closed (typed refusal, never a
 * guessed action) whenever they do not resolve exactly. A wrong
 * declared locator can therefore only produce a typed refusal —
 * never an incorrect provider action.
 */
const ZAI_LOCATORS = Object.freeze({
  // LIVE-OBSERVED on the real provider surface.
  composer: "#chat-input",
  send: "#send-message-button",
  // The model selector (LIVE-OBSERVED 2026-09-06 on the real
  // https://chat.z.ai origin — the closed state AND the opened
  // option list — and corroborated by the operator's saved
  // authenticated Agent-surface HTML, PR #6 comment 5554526659): the
  // trigger is ONE button carrying aria-label="Select a model"
  // whose id embeds the SELECTED model's provider value with
  // "." -> "_" (live: data-value "x-preview-l" ->
  // #model-selector-x-preview-l-button, trigger text
  // "GLM-5.3-Flash"; operator: GLM-5.2 selected ->
  // #model-selector-glm-5_2-button). The id is therefore NOT a
  // stable locator: the trigger resolves through the aria-label,
  // else the id-prefix/suffix family — never a hardcoded
  // model-specific id (the pre-correction
  // #model-selector-x-preview-l-button assumption never matched the
  // authenticated Agent surface). The option rows are
  // button[aria-label="model-item"] carrying data-value (the
  // provider's machine model ids, live: "x-preview-l", "glm-5.3",
  // "glm-5.2" — the Work Order's provider model identifier 5.3 is
  // surface-encoded as data-value "glm-5.3"); the exact GLM-5.3 row
  // is resolved by BOTH its exact leading text token and its
  // data-value, and the post-selection verification requires BOTH
  // the trigger displaying the model label and the trigger carrying
  // the selected-model id.
  modelTrigger: Object.freeze([
    'button[aria-label="Select a model"]',
    'button[id^="model-selector-"][id$="-button"]',
  ]),
  modelOption: 'button[aria-label="model-item"]',
  modelOptionExact: 'button[aria-label="model-item"][data-value="glm-5.3"]',
  modelTriggerSelected: "#model-selector-glm-5_3-button",
  dialog: '[role="dialog"], dialog',
  alert: '[role="alert"]',
  allButtons: "button",
  authButtonTexts: Object.freeze(["Sign in", "Log in", "Sign up"]),
  // AUTHENTICATED-SURFACE — the sidebar mode toggle (LIVE-OBSERVED
  // 2026-09-06; see the provenance comment above the table). The
  // structural candidate is the second-and-last button of the
  // two-button mode-pill pair inside #sidebar (chat-group tab buttons
  // are excluded by :not([id]) — they carry chat-group-tab-* ids).
  agentControl: Object.freeze([
    "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type",
  ]),
  agentActive: Object.freeze([
    '#sidebar button[data-active="true"]:not([id]):nth-of-type(2):last-of-type',
  ]),
  agentText: "Agent",
  agentTextScan: "#sidebar button[data-active]:not([id])",
  stopControl: Object.freeze(['button[aria-label="Stop"]', 'button[title="Stop"]']),
  stopText: "Stop",
  conversation: Object.freeze(['[role="log"]', '[class*="conversation"]', '[class*="message-list"]', "main"]),
  userMessage: Object.freeze([
    '[class*="user"][class*="message"]',
    '[data-role="user"]',
    '[class*="user-message"]',
  ]),
});

/** The exact model the Work Order freezes for new worker sessions. */
const ZAI_MODEL = Object.freeze({
  label: "GLM-5.3",
  providerId: "5.3",
});

/** The FIXED hung-worker recovery message — no alternate wording. */
const ZAI_RECOVERY_MESSAGE = "continue";

/** Dialog text patterns that reclassify a dialog as auth or error. */
const AUTH_DIALOG_PATTERN = /sign\s*in|log\s*in|sign\s*up|authenticate|login/i;
const ERROR_DIALOG_PATTERN = /error|went\s*wrong|rate\s*limit|too\s*many|unavailable|failed|forbidden/i;
const PROVIDER_ALERT_PATTERN = /error|went\s*wrong|rate\s*limit|too\s*many|unavailable|failed|forbidden|denied/i;

/** Frozen default budgets (all constructor-injectable for tests). */
const DEFAULTS = Object.freeze({
  settlePolls: 8, // post-action observation polls per step
  settleIntervalMs: 400, // delay between polls
  maxSubmissionAttempts: 3, // bounded preparation/send/verify attempts
  maxRecoveryAttempts: 2, // bounded Stop/continue recovery attempts
});

/**
 * Create the Z.ai Worker adapter.
 *
 * @param {{ tabsApi: object, pageBridge: object, providerUrl?: string,
 *           sleep?: Function, now?: Function, settlePolls?: number,
 *           settleIntervalMs?: number, maxSubmissionAttempts?: number,
 *           maxRecoveryAttempts?: number }} wiring
 *        `pageBridge` is the typed channel to the content script
 *        (createZaiPageBridge); tests inject a scriptable fake.
 */
export function createZaiAdapter({
  tabsApi,
  pageBridge,
  providerUrl = "https://chat.z.ai",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  settlePolls = DEFAULTS.settlePolls,
  settleIntervalMs = DEFAULTS.settleIntervalMs,
  maxSubmissionAttempts = DEFAULTS.maxSubmissionAttempts,
  maxRecoveryAttempts = DEFAULTS.maxRecoveryAttempts,
} = {}) {
  if (typeof tabsApi?.query !== "function" || typeof tabsApi?.update !== "function") {
    throw new Error("createZaiAdapter requires a tabsApi with query/create/update/get");
  }
  if (typeof pageBridge?.send !== "function") {
    throw new Error("createZaiAdapter requires a pageBridge with send(tabId, command)");
  }
  const origin = new URL(providerUrl).origin;

  // The in-memory session registry: worker name -> the exact
  // Worker/Work-Item/tab correlation. Never persisted, never
  // authoritative; a service-worker restart loses it and later
  // references fail closed SESSION_UNKNOWN (documented limitation).
  const sessions = new Map();

  // ------------------------------------------------------------------
  // Page facts: the closed probe set every observation is built from.
  // ------------------------------------------------------------------

  const BASE_PROBES = [
    { name: "authButtons", selector: ZAI_LOCATORS.allButtons, mode: "texts" },
    { name: "composerVisible", selector: ZAI_LOCATORS.composer, mode: "visible" },
    { name: "composerEnabled", selector: ZAI_LOCATORS.composer, mode: "enabled" },
    { name: "composerValue", selector: ZAI_LOCATORS.composer, mode: "value" },
    { name: "sendVisible", selector: ZAI_LOCATORS.send, mode: "visible" },
    { name: "dialogCount", selector: ZAI_LOCATORS.dialog, mode: "count" },
    { name: "alertVisible", selector: ZAI_LOCATORS.alert, mode: "visible" },
  ];

  const STOP_PROBES = ZAI_LOCATORS.stopControl.map((selector, i) => ({
    name: `stopCandidate${i}`,
    selector,
    mode: "visible",
  }));

  const EVIDENCE_PROBES = [
    { name: "dialogText", selector: ZAI_LOCATORS.dialog, mode: "text" },
    { name: "alertText", selector: ZAI_LOCATORS.alert, mode: "text" },
    ...ZAI_LOCATORS.conversation.map((selector, i) => ({
      name: `conversationCandidate${i}`,
      selector,
      mode: "text",
    })),
    ...ZAI_LOCATORS.userMessage.map((selector, i) => ({
      name: `userMessageCandidate${i}`,
      selector,
      mode: "texts",
    })),
  ];

  /**
   * Probe the page once and derive the structural fact set. Fact
   * probes degrade to explicit null facts when a surface is absent
   * (absence is information, never a guess); only a structurally
   * unusable page response fails the read.
   */
  async function readFacts(tabId, extraProbes = []) {
    const response = await pageBridge.send(tabId, {
      zaiPage: true,
      op: "probe",
      probes: [...BASE_PROBES, ...STOP_PROBES, ...EVIDENCE_PROBES, ...extraProbes],
    });
    if (!response.ok) {
      return response; // typed page-surface refusal
    }
    return { ok: true, facts: Object.freeze({ ...response.facts, _tabId: tabId }) };
  }

  /**
   * Settle-poll: re-read facts until the classifier yields a decisive
   * state (or the budget is exhausted). A transport failure is NOT
   * decisive — the content script may still be injecting after a
   * navigation (document_idle) — so failures are retried within the
   * same bounded budget and only the final failure surfaces.
   * Deterministic offline via the injected sleep/page bridge.
   */
  async function settle(tabId, extraProbes, isDecisive) {
    let last;
    for (let i = 0; i < settlePolls; i++) {
      if (i > 0) {
        await sleep(settleIntervalMs);
      }
      last = await readFacts(tabId, extraProbes);
      if (last.ok && isDecisive(last.facts)) {
        return last;
      }
    }
    return last;
  }

  // ------------------------------------------------------------------
  // Fact interpretation (all provider semantics live below this line).
  // ------------------------------------------------------------------

  /** @private */
  function authMarkerCount(facts) {
    const texts = facts.authButtons?.texts;
    if (!Array.isArray(texts)) {
      return 0;
    }
    return texts.filter((text) => ZAI_LOCATORS.authButtonTexts.includes(text)).length;
  }

  /** @private */
  function dialogCount(facts) {
    const count = facts.dialogCount?.count;
    return typeof count === "number" ? count : 0;
  }

  /** @private */
  function stopVisible(facts) {
    return STOP_PROBES.some((probe) => facts[probe.name]?.visible === true);
  }

  /**
   * The exact-text confirmation: the strongest evidence available —
   * an exact user-message match, else exact containment in a resolved
   * conversation region — never a guessed success.
   */
  function conversationContains(facts, text) {
    for (const probe of EVIDENCE_PROBES) {
      if (probe.name.startsWith("userMessageCandidate")) {
        const texts = facts[probe.name]?.texts;
        if (Array.isArray(texts) && texts.includes(text)) {
          return true;
        }
      }
    }
    for (const probe of EVIDENCE_PROBES) {
      if (probe.name.startsWith("conversationCandidate")) {
        const conversation = facts[probe.name]?.text;
        if (typeof conversation === "string" && conversation.includes(text)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Classify the dialog surface (exactly one dialog) during a given
   * phase. The KNOWN submission-blocking popup is the modal dialog
   * observed while verifying a submission: not an auth surface, not
   * an error surface. Anything else — a dialog during preparation or
   * recovery, multiple simultaneous dialogs, auth-shaped or
   * error-shaped dialogs — is NOT the known popup and fails closed.
   */
  function classifyDialog(facts, phase) {
    const count = dialogCount(facts);
    if (count === 0) {
      return { kind: "none" };
    }
    if (count > 1) {
      return { kind: "unknown", reason: `${count} dialogs are visible simultaneously — an ambiguous dialog surface` };
    }
    // Auth/error-shaped dialogs are classified by their CONTENT at any
    // phase: they are never the known popup and never press Enter.
    const text = facts.dialogText?.text ?? "";
    if (AUTH_DIALOG_PATTERN.test(text)) {
      return { kind: "auth", reason: "the dialog is an authentication surface" };
    }
    if (ERROR_DIALOG_PATTERN.test(text)) {
      return { kind: "error", reason: "the dialog is an error surface" };
    }
    if (phase !== "verifying-submission") {
      return { kind: "unknown", reason: "a dialog is visible outside the submission-verification window" };
    }
    return { kind: "known-popup" };
  }

  /**
   * The typed session-state classifier. `session` is the registry
   * record when the observation belongs to an active worker session
   * (null for a standalone observation).
   */
  function classifySession(facts, session, phase = "idle") {
    const composerVisible = facts.composerVisible?.visible === true;
    const composerEnabled = facts.composerEnabled?.enabled === true;
    const composerValue = typeof facts.composerValue?.value === "string" ? facts.composerValue.value : null;
    const alertVisible = facts.alertVisible?.visible === true;
    const alertText = String(facts.alertText?.text ?? "");

    const dialog = classifyDialog(facts, phase);
    if (dialog.kind === "auth") {
      return { state: "authentication-required", detail: dialog.reason };
    }
    if (dialog.kind === "error") {
      return { state: "provider-error", detail: dialog.reason };
    }
    if (dialog.kind === "unknown") {
      return dialog.reason.includes("ambiguous dialog")
        ? { state: "ambiguous", detail: dialog.reason }
        : { state: "unexpected-dialog", detail: dialog.reason };
    }
    if (dialog.kind === "known-popup") {
      return { state: "expected-blocking-dialog", detail: "the known submission-blocking popup is visible" };
    }
    if (alertVisible && PROVIDER_ALERT_PATTERN.test(alertText)) {
      return { state: "provider-error", detail: "an alerting error surface is visible" };
    }
    if (authMarkerCount(facts) > 0) {
      return { state: "authentication-required", detail: "the provider is presenting authentication controls" };
    }
    if (!composerVisible) {
      return { state: "ambiguous", detail: "no composer is visible in an apparently authenticated surface" };
    }
    if (stopVisible(facts)) {
      return session
        ? { state: "prompt-submitted", detail: "generation is in progress for the submitted session prompt" }
        : { state: "working", detail: "generation is in progress" };
    }
    if (session) {
      const promptPresent = conversationContains(facts, session.prompt);
      if (promptPresent && (composerValue === null || composerValue.length === 0)) {
        return { state: "prompt-submitted", detail: "the session prompt is confirmed present and generation is pending" };
      }
      if (promptPresent && composerValue === session.prompt) {
        return { state: "prompt-unconfirmed", detail: "the prompt remains unsubmitted in the composer" };
      }
      if (session.wasWorking && composerEnabled) {
        return { state: "stopped", detail: "generation stopped; input is available" };
      }
    }
    if (composerEnabled) {
      return { state: "ready-for-input", detail: "authenticated and ready for input" };
    }
    return { state: "ambiguous", detail: "the composer is present but neither enabled nor generating" };
  }

  // ------------------------------------------------------------------
  // Tab-layer primitives (find/open/focus; origin-scoped, generic).
  // ------------------------------------------------------------------

  async function discoverTabs() {
    try {
      const tabs = await tabsApi.query({ url: `${origin}/*` });
      if (!Array.isArray(tabs)) {
        return failure("TABS_UNAVAILABLE", "tab discovery returned a non-list result");
      }
      return { ok: true, tabs };
    } catch (err) {
      return failure("TABS_UNAVAILABLE", `tab discovery failed: ${err}`);
    }
  }

  async function focusTab(tabId) {
    try {
      await tabsApi.update(tabId, { active: true });
      return { ok: true };
    } catch (err) {
      return failure("PAGE_UNAVAILABLE", `focusing the provider tab ${tabId} failed: ${err}`);
    }
  }

  async function tabStillAtOrigin(tabId) {
    try {
      const tab = await tabsApi.get(tabId);
      const url = typeof tab?.url === "string" ? tab.url : null;
      const atOrigin = url !== null && (url === origin || url.startsWith(`${origin}/`));
      if (!atOrigin) {
        return failure("STALE_REFERENCE", `tab ${tabId} is no longer a ${origin} session (${url ?? "no url"})`);
      }
      return { ok: true, tab };
    } catch (err) {
      return failure("STALE_REFERENCE", `the referenced browser-session tab ${tabId} is gone: ${err}`);
    }
  }

  /**
   * Resolve the target tab for a worker: the registry correlation if
   * the worker has an active session, else origin discovery (exactly
   * one tab, or open one when none exists and opening is allowed).
   */
  async function resolveTargetTab(workerName, { allowOpen = true } = {}) {
    const session = sessions.get(workerName);
    if (session) {
      const still = await tabStillAtOrigin(session.tabId);
      if (!still.ok) {
        return {
          ok: true,
          observation: { state: "session-missing", tabId: session.tabId, detail: still.error.message },
        };
      }
      return { ok: true, tabId: session.tabId };
    }
    const discovered = await discoverTabs();
    if (!discovered.ok) {
      return discovered;
    }
    const tabs = discovered.tabs;
    if (tabs.length === 0) {
      if (!allowOpen) {
        return { ok: true, observation: { state: "session-missing", tabId: null, detail: "no chat.z.ai tab is open" } };
      }
      try {
        const tab = await tabsApi.create({ url: providerUrl, active: true });
        if (typeof tab?.id !== "number") {
          return failure("TABS_UNAVAILABLE", "opening the provider tab returned an unusable result");
        }
        return { ok: true, tabId: tab.id, opened: true };
      } catch (err) {
        return failure("TABS_UNAVAILABLE", `opening the provider tab failed: ${err}`);
      }
    }
    if (tabs.length > 1) {
      return {
        ok: true,
        observation: {
          state: "ambiguous",
          tabId: null,
          detail: `${tabs.length} chat.z.ai tabs are open with no active session correlation — exactly one is required`,
        },
      };
    }
    return { ok: true, tabId: tabs[0].id };
  }

  // ------------------------------------------------------------------
  // Page actions (every action followed by a verified observation).
  // ------------------------------------------------------------------

  async function click(tabId, selector) {
    return pageBridge.send(tabId, { zaiPage: true, op: "click", selector });
  }

  async function clickIndex(tabId, selector, index) {
    return pageBridge.send(tabId, { zaiPage: true, op: "clickIndex", selector, index });
  }

  async function typeText(tabId, selector, text) {
    return pageBridge.send(tabId, { zaiPage: true, op: "type", selector, text });
  }

  async function pressEnter(tabId) {
    return pageBridge.send(tabId, { zaiPage: true, op: "pressEnter" });
  }

  /**
   * Step: select the Agent control — the sidebar mode-toggle Agent
   * pill (LIVE-OBSERVED structure: two <button> pills, Chat first,
   * Agent second, inside #sidebar; every pill always carries
   * data-active "true"|"false"). Resolution: the structural
   * second-of-the-pair pill, else (fallback) the unique sidebar mode
   * pill whose exact text is "Agent" (the expanded labeled sidebar —
   * the collapsed icon-only pills resolve structurally). Idempotence:
   * when the Agent pill already carries data-active="true" the Agent
   * mode is already selected and NO click is issued (clicking the
   * pill opens a fresh Agent-mode session on the provider side).
   * Verification: the Agent pill carries data-active="true" after
   * the action — a click is never evidence of the mode switch; a
   * marker that never appears fails closed (no weak acceptance).
   * No dialog is expected while preparing — any dialog at this point
   * fails closed UNKNOWN_DIALOG.
   */
  async function selectAgent(tabId) {
    const agentProbes = ZAI_LOCATORS.agentControl.map((selector, i) => ({
      name: `agentCandidate${i}`,
      selector,
      mode: "count",
    }));
    const agentActiveProbes = ZAI_LOCATORS.agentActive.map((selector, i) => ({
      name: `agentActive${i}`,
      selector,
      mode: "count",
    }));
    const agentTextScanProbe = {
      name: "agentTextScan",
      selector: ZAI_LOCATORS.agentTextScan,
      mode: "texts",
    };
    const facts = await readFacts(tabId, [
      ...agentProbes,
      ...agentActiveProbes,
      agentTextScanProbe,
    ]);
    if (!facts.ok) {
      return facts;
    }
    const dialog = classifyDialog(facts.facts, "preparing");
    if (dialog.kind !== "none") {
      return failure("UNKNOWN_DIALOG", `no dialog is expected during preparation: ${dialog.reason}`);
    }
    // Idempotence: the Agent pill is already the active mode pill —
    // clicking it would navigate the provider app to a fresh
    // Agent-mode session for nothing; the selection already holds.
    if (agentActiveProbes.some((probe) => facts.facts[probe.name]?.count === 1)) {
      return { ok: true, alreadyActive: true };
    }
    const agentCounts = agentProbes.map((probe) => facts.facts[probe.name]?.count ?? 0);
    const resolvedAgent = agentCounts.findIndex((count) => count === 1);
    if (resolvedAgent !== -1) {
      const clicked = await click(tabId, ZAI_LOCATORS.agentControl[resolvedAgent]);
      if (!clicked.ok) {
        return clicked;
      }
    } else {
      // Text-scan fallback: the unique visible sidebar mode pill
      // whose exact text is "Agent" (clickIndex shares this texts
      // probe's visible-match ordering on the SAME selector).
      const texts = facts.facts.agentTextScan?.texts ?? [];
      const hits = texts
        .map((text, index) => ({ text, index }))
        .filter((entry) => entry.text === ZAI_LOCATORS.agentText);
      if (hits.length !== 1) {
        return failure(
          "AMBIGUOUS_STATE",
          `the Agent control did not resolve to exactly one element (candidate counts: ${agentCounts.join("/")}, exact-text matches: ${hits.length})`
        );
      }
      const clicked = await clickIndex(tabId, ZAI_LOCATORS.agentTextScan, hits[0].index);
      if (!clicked.ok) {
        return clicked;
      }
    }
    // Verification: the Agent pill becomes the active mode pill
    // (data-active="true") within the settle budget.
    const verified = await settle(tabId, agentActiveProbes, (f) =>
      agentActiveProbes.some((probe) => (f[probe.name]?.count ?? 0) === 1)
    );
    if (!verified.ok) {
      return verified;
    }
    const activeMarker = agentActiveProbes.some((probe) => (verified.facts[probe.name]?.count ?? 0) === 1);
    if (!activeMarker) {
      // The marker is LIVE-OBSERVED ground truth, not a declared
      // guess: a click is never evidence of the mode switch. A pill
      // that did not become the active mode pill means the selection
      // did not take — fail closed, never inferring success from a
      // click (no weak "control still present" acceptance).
      return failure(
        "AMBIGUOUS_STATE",
        "the Agent selection could not be verified by post-action observation (the Agent pill did not become the active mode pill)"
      );
    }
    return { ok: true };
  }

  /**
   * Step: select model GLM-5.3 (provider id 5.3). The live model
   * selector is located through the LIVE-OBSERVED generic candidates
   * (the aria-labeled trigger, else the model-selector id family) —
   * never a hardcoded model-specific id: the trigger id embeds the
   * SELECTED model and changes with the selection (the
   * pre-correction #model-selector-x-preview-l-button assumption
   * never matched the authenticated Agent surface). The exact option
   * is resolved by TWO live-observed ground truths: the unique option
   * row whose leading text token is EXACTLY the model label, and the
   * unique row carrying the option's data-value. Verification: after
   * the click, the trigger DISPLAYS the model label as its leading
   * text token (the model header, live-observed on both surfaces) AND
   * the trigger id has become the selected-model id. A click is never
   * evidence; a ground truth that never appears fails closed (no weak
   * acceptance). Idempotence: when both ground truths already hold,
   * NO trigger click is issued (re-clicking would toggle the option
   * menu open for nothing). A disabled option row (the live
   * unauthenticated surface keeps GLM-5.3 disabled) refuses the click
   * and fails closed. No dialog is expected while preparing — any
   * dialog at this point fails closed UNKNOWN_DIALOG.
   */
  async function selectModel(tabId) {
    const triggerCountProbes = ZAI_LOCATORS.modelTrigger.map((selector, i) => ({
      name: `modelTriggerCount${i}`,
      selector,
      mode: "count",
    }));
    const triggerTextProbes = ZAI_LOCATORS.modelTrigger.map((selector, i) => ({
      name: `modelTriggerText${i}`,
      selector,
      mode: "text",
    }));
    const selectedIdProbe = {
      name: "modelTriggerSelectedId",
      selector: ZAI_LOCATORS.modelTriggerSelected,
      mode: "count",
    };
    const optionProbes = [
      { name: "modelOptionTexts", selector: ZAI_LOCATORS.modelOption, mode: "texts" },
      { name: "modelOptionExactCount", selector: ZAI_LOCATORS.modelOptionExact, mode: "count" },
    ];
    /** Both live-observed ground truths of an established selection. */
    const selectionVerified = (f) =>
      ZAI_LOCATORS.modelTrigger.some(
        (_, i) => leadingToken(String(f[`modelTriggerText${i}`]?.text ?? "")) === ZAI_MODEL.label
      ) && f.modelTriggerSelectedId?.count === 1;

    const facts = await readFacts(tabId, [...triggerCountProbes, ...triggerTextProbes, selectedIdProbe]);
    if (!facts.ok) {
      return facts;
    }
    const dialog = classifyDialog(facts.facts, "preparing");
    if (dialog.kind !== "none") {
      return failure("UNKNOWN_DIALOG", `no dialog is expected during preparation: ${dialog.reason}`);
    }
    // Idempotence: both ground truths already hold — the model is
    // already the frozen model; no trigger click (re-clicking would
    // toggle the option menu open for nothing).
    if (selectionVerified(facts.facts)) {
      return { ok: true, alreadySelected: true };
    }
    // Resolve the trigger: the first live-observed candidate matching
    // exactly one visible element.
    const counts = triggerCountProbes.map((probe) => facts.facts[probe.name]?.count ?? 0);
    const resolved = counts.findIndex((count) => count === 1);
    if (resolved === -1) {
      return failure(
        "AMBIGUOUS_STATE",
        `the model selector trigger did not resolve to exactly one element through the live-observed candidates (candidate counts: ${counts.join("/")})`
      );
    }
    const opened = await click(tabId, ZAI_LOCATORS.modelTrigger[resolved]);
    if (!opened.ok) {
      return opened;
    }
    const listed = await settle(tabId, optionProbes, (f) => {
      const texts = f.modelOptionTexts?.texts;
      return Array.isArray(texts) && texts.length > 0;
    });
    if (!listed.ok) {
      return listed;
    }
    const options = listed.facts.modelOptionTexts?.texts;
    if (!Array.isArray(options) || options.length === 0) {
      return failure("AMBIGUOUS_STATE", "the model option list did not open (no model options became visible)");
    }
    // The exact option: BOTH live-observed ground truths — the unique
    // exact-leading-token text match AND the unique data-value row.
    const textHits = options
      .map((text, index) => ({ text, index }))
      .filter((entry) => leadingToken(entry.text) === ZAI_MODEL.label);
    const valueCount = listed.facts.modelOptionExactCount?.count ?? 0;
    if (textHits.length !== 1 || valueCount !== 1) {
      return failure(
        "AMBIGUOUS_STATE",
        `the ${ZAI_MODEL.label} option did not resolve to exactly one model option (${textHits.length} exact text matches among ${options.length} options; ${valueCount} data-value rows)`
      );
    }
    const chosen = await click(tabId, ZAI_LOCATORS.modelOptionExact);
    if (!chosen.ok) {
      return chosen;
    }
    // Verification: BOTH ground truths — the trigger displays the
    // model label AND carries the selected-model id.
    const confirmed = await settle(tabId, [...triggerTextProbes, selectedIdProbe], selectionVerified);
    if (!confirmed.ok) {
      return confirmed;
    }
    if (!selectionVerified(confirmed.facts)) {
      const displays = triggerTextProbes.some(
        (_, i) => leadingToken(String(confirmed.facts[`modelTriggerText${i}`]?.text ?? "")) === ZAI_MODEL.label
      );
      return failure(
        "AMBIGUOUS_STATE",
        `the selected model could not be verified on the model control (the trigger ${
          displays ? "displays" : "does not display"
        } the ${ZAI_MODEL.label} label as its leading text token; the selected-model trigger id ${
          confirmed.facts.modelTriggerSelectedId?.count === 1 ? "resolved" : "did not resolve"
        })`
      );
    }
    return { ok: true };
  }

  /**
   * Step: enter the exact governed prompt, verbatim, and verify the
   * read-back is byte-identical BEFORE sending (a rewritten or
   * truncated prompt is never submitted).
   */
  async function enterPrompt(tabId, prompt) {
    const typed = await typeText(tabId, ZAI_LOCATORS.composer, prompt);
    if (!typed.ok) {
      return typed;
    }
    const readBack = await readFacts(tabId);
    if (!readBack.ok) {
      return readBack;
    }
    if (readBack.facts.composerValue?.value !== prompt) {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer did not hold the exact governed prompt verbatim — refusing to send a rewritten prompt"
      );
    }
    return { ok: true };
  }

  /**
   * Step: ensure the exact governed prompt is present in the
   * composer, byte-identical, before (re)sending — the operator's
   * recovery loop: after the known-popup Enter (or an unconfirmed
   * send), the exact prompt is RESENT; the preparation is never
   * restarted for a resend. Three observed states:
   *   - the composer already holds the exact prompt (an unconfirmed
   *     send, or the popup blocked the submission): it is sent as-is
   *     — the provider surface is not disturbed with a re-type;
   *   - the composer is empty AND the conversation already contains
   *     the exact prompt: the submission is ALREADY CONFIRMED — no
   *     resend (the governed prompt is never submitted twice;
   *     acceptance is provider-state confirmation, never a blind
   *     resend);
   *   - otherwise: the prompt is (re)typed and the byte-identical
   *     read-back is verified BEFORE any send (a rewritten or
   *     truncated prompt is never submitted).
   * A dialog visible at this point fails closed — never type through
   * a modal.
   */
  async function ensurePrompt(tabId, prompt) {
    const facts = await readFacts(tabId);
    if (!facts.ok) {
      return facts;
    }
    const dialog = classifyDialog(facts.facts, "preparing");
    if (dialog.kind !== "none") {
      return failure(
        "UNKNOWN_DIALOG",
        `a dialog is visible while preparing the prompt submission: ${dialog.reason}`
      );
    }
    const composerValue = typeof facts.facts.composerValue?.value === "string" ? facts.facts.composerValue.value : "";
    if (composerValue === prompt) {
      return { ok: true, present: true };
    }
    if (composerValue.length === 0 && conversationContains(facts.facts, prompt)) {
      return { ok: true, confirmed: true, facts: facts.facts };
    }
    return enterPrompt(tabId, prompt);
  }

  /**
   * Send (a click is NOT evidence): submission is verified from the
   * resulting provider state by the caller.
   */
  async function send(tabId) {
    return click(tabId, ZAI_LOCATORS.send);
  }

  // ------------------------------------------------------------------
  // The governed new-worker-session sequence.
  // ------------------------------------------------------------------

  /**
   * Start a governed Z.ai worker session for the exact Worker / Work
   * Item correlation, carrying the exact governed prompt.
   *
   * @returns {Promise<{ ok: true, session: object, submitted: object } |
   *           { ok: false, error: object }>}
   */
  async function startWorkerSession({ worker, workItem, prompt }) {
    // Registry gate: one active session per Worker. The same
    // correlation re-reports idempotently; a different Work Item
    // contradicts the active correlation and fails closed.
    const existing = sessions.get(worker);
    if (existing) {
      if (existing.workItem === workItem) {
        // A stale correlated reference is a typed failure, NEVER a
        // successful Start: a registry entry whose tab is gone, or
        // whose tab navigated away from the provider origin, fails
        // closed STALE_REFERENCE — the dead session is never
        // re-reported as `alreadyActive` and never silently
        // re-established (the in-memory registry is lost on
        // service-worker restart, after which Start re-runs the full
        // governed sequence for a fresh correlation).
        const still = await tabStillAtOrigin(existing.tabId);
        if (!still.ok) {
          return failure(
            "STALE_REFERENCE",
            `the active session correlation for worker '${worker}' (work item '${workItem}', tab ${existing.tabId}) is stale — ${still.error.message}. The stale session cannot be re-reported or re-established by Start; the in-memory registry is lost on service-worker restart, after which StartZaiWorkerSession re-runs the full governed sequence`
          );
        }
        const observation = await observePage(existing.tabId, existing);
        return {
          ok: true,
          alreadyActive: true,
          session: { worker, workItem, tabId: existing.tabId },
          observation,
        };
      }
      return failure(
        "AMBIGUOUS_STATE",
        `worker '${worker}' already has an active session for work item '${existing.workItem}' — contradictory session references fail closed`
      );
    }

    // 1. find/open/focus an authenticated chat.z.ai session.
    const target = await resolveTargetTab(worker, { allowOpen: true });
    if (!target.ok) {
      return target;
    }
    if (target.observation) {
      return failure("AMBIGUOUS_STATE", target.observation.detail);
    }
    const tabId = target.tabId;
    const focused = await focusTab(tabId);
    if (!focused.ok) {
      return focused;
    }

    // 2. verify the authenticated state (and that the surface is
    // ready for the preparation sequence).
    const settled = await settle(tabId, [], (f) => {
      const c = classifySession(f, null, "preparing");
      return c.state !== "ambiguous";
    });
    if (!settled.ok) {
      return settled;
    }
    const precheck = classifySession(settled.facts, null, "preparing");
    if (precheck.state === "authentication-required") {
      return failure(
        "AUTHORIZATION_REQUIRED",
        `the chat.z.ai session is not authenticated: ${precheck.detail}. Human authentication is out of band — authenticate in the provider tab, then start the worker session again`
      );
    }
    if (precheck.state === "unexpected-dialog" || precheck.state === "expected-blocking-dialog") {
      return failure("UNKNOWN_DIALOG", `a dialog is visible on the target session before preparation: ${precheck.detail}`);
    }
    if (precheck.state === "provider-error") {
      return failure("PROVIDER_ERROR", `the target session is presenting an error surface: ${precheck.detail}`);
    }
    if (precheck.state !== "ready-for-input") {
      return failure(
        "AMBIGUOUS_STATE",
        `the target session is not ready for a new worker session (observed: ${precheck.state} — ${precheck.detail})`
      );
    }

    // 3-7. bounded preparation/send/verification attempts. The first
    // attempt runs the full preparation (Agent -> model -> prompt);
    // a resend (after the known-popup Enter, or an unconfirmed send)
    // re-uses the established preparation and RESENDS the exact
    // prompt — the operator's recovery loop: Enter once, then
    // resend; never a full preparation restart, and never a resend
    // of an already-confirmed submission.
    let attempts = 0;
    let popupDismissals = 0;
    let lastRefusal = null;
    let prepared = false;

    /** Record the CONFIRMED submission (the shared acceptance path). */
    const recordSubmission = (facts) => {
      const generation = stopVisible(facts) ? "working" : "waiting";
      const record = {
        worker,
        workItem,
        tabId,
        prompt,
        attempts,
        popupDismissals,
        submittedAt: now(),
        wasWorking: generation === "working",
        recoveries: 0,
      };
      sessions.set(worker, record);
      return {
        ok: true,
        session: { worker, workItem, tabId },
        submitted: { attempts, popupDismissals, generation },
      };
    };

    while (attempts < maxSubmissionAttempts) {
      attempts += 1;
      if (!prepared) {
        // 3. Agent selection (idempotent on the established mode).
        const agent = await selectAgent(tabId);
        if (!agent.ok) {
          lastRefusal = agent;
          continue;
        }
        // 4. Model selection (idempotent on the established model).
        const model = await selectModel(tabId);
        if (!model.ok) {
          lastRefusal = model;
          continue;
        }
        prepared = true;
      }
      // 5. Exact prompt entry / resend: the byte-identical read-back
      //    is verified before any send; an already-confirmed
      //    submission is never resent.
      const entered = await ensurePrompt(tabId, prompt);
      if (!entered.ok) {
        lastRefusal = entered;
        continue;
      }
      if (entered.confirmed) {
        // The submission was already confirmed by provider-state
        // evidence (e.g. the dismissed popup had let it land): never
        // resend the governed prompt.
        return recordSubmission(entered.facts);
      }
      // 6. Send.
      const sent = await send(tabId);
      if (!sent.ok) {
        lastRefusal = sent;
        continue;
      }
      // 7. Verify actual submission from the resulting provider state.
      const verdict = await settle(tabId, [], (f) => {
        const dialog = classifyDialog(f, "verifying-submission");
        if (dialog.kind !== "none") {
          return true;
        }
        const composerValue = typeof f.composerValue?.value === "string" ? f.composerValue.value : "";
        if (composerValue.length === 0 && conversationContains(f, prompt)) {
          return true; // confirmed
        }
        return composerValue.length > 0; // unconfirmed (send did not take)
      });
      if (!verdict.ok) {
        lastRefusal = verdict;
        continue;
      }
      const facts = verdict.facts;
      const dialog = classifyDialog(facts, "verifying-submission");
      if (dialog.kind === "auth") {
        return failure("AUTHENTICATION_INTERRUPTED", `authentication was required during submission: ${dialog.reason}`);
      }
      if (dialog.kind === "error") {
        return failure("PROVIDER_ERROR", `the provider surfaced an error during submission: ${dialog.reason}`);
      }
      if (dialog.kind === "unknown") {
        return failure("UNKNOWN_DIALOG", `a differently-shaped dialog blocked submission: ${dialog.reason}`);
      }
      if (dialog.kind === "known-popup") {
        if (attempts >= maxSubmissionAttempts) {
          return failure(
            "RETRY_EXHAUSTED",
            `the known submission-blocking popup persisted beyond the bounded attempt budget (${maxSubmissionAttempts} attempts, ${popupDismissals} dismissals)`
          );
        }
        // The ONE bounded Enter press for this attempt; the next
        // attempt RESENDS the exact prompt (the preparation stays
        // established — no restart).
        popupDismissals += 1;
        const pressed = await pressEnter(tabId);
        if (!pressed.ok) {
          lastRefusal = pressed;
          continue;
        }
        const dismissed = await settle(tabId, [], (f) => dialogCount(f) === 0);
        if (!dismissed.ok) {
          lastRefusal = dismissed;
          continue;
        }
        if (dialogCount(dismissed.facts) !== 0) {
          lastRefusal = failure("UNKNOWN_DIALOG", "the known popup did not dismiss after the Enter press");
          continue;
        }
        continue; // resend the exact prompt
      }
      const composerValue = typeof facts.composerValue?.value === "string" ? facts.composerValue.value : "";
      if (composerValue.length === 0 && conversationContains(facts, prompt)) {
        // Submission CONFIRMED by post-action observation.
        return recordSubmission(facts);
      }
      // Unconfirmed: the send did not take (the composer still holds
      // the prompt). The bounded retry resends the exact prompt.
      lastRefusal = failure(
        "PAGE_MALFORMED",
        "the prompt remained unsubmitted after the send (submission was not confirmed by observation)"
      );
    }
    return (
      lastRefusal ??
      failure("RETRY_EXHAUSTED", `the bounded submission attempt budget (${maxSubmissionAttempts}) was exhausted`)
    );
  }

  // ------------------------------------------------------------------
  // The governed hung-worker recovery.
  // ------------------------------------------------------------------

  /**
   * Recover a hung worker session: Stop -> verified stopped -> the
   * FIXED message `continue` -> verified acceptance. Bounded; every
   * required transition is verified or the recovery fails closed as
   * a governance hold.
   */
  async function recoverHungWorker({ worker, workItem, tabId }) {
    const session = sessions.get(worker);
    if (!session) {
      return failure(
        "SESSION_UNKNOWN",
        `no active Z.ai worker session for worker '${worker}' (the in-memory registry is lost on service-worker restart; restart the session through StartZaiWorkerSession)`
      );
    }
    // The exact correlation: Worker + Work Item + browser session.
    if (session.workItem !== workItem || session.tabId !== tabId) {
      return failure(
        "STALE_REFERENCE",
        `contradictory session reference: the active correlation is worker '${session.worker}' / work item '${session.workItem}' / tab ${session.tabId}`
      );
    }
    const still = await tabStillAtOrigin(tabId);
    if (!still.ok) {
      return still;
    }
    const focused = await focusTab(tabId);
    if (!focused.ok) {
      return focused;
    }

    let attempts = 0;
    let lastRefusal = null;
    while (attempts < maxRecoveryAttempts) {
      attempts += 1;
      // Observe the hang precondition: generation in progress.
      const observed = await settle(tabId, [], (f) => {
        const c = classifySession(f, session, "recovery");
        return c.state !== "ambiguous";
      });
      if (!observed.ok) {
        lastRefusal = observed;
        continue;
      }
      const precheck = classifySession(observed.facts, session, "recovery");
      if (precheck.state === "authentication-required") {
        return failure("AUTHENTICATION_INTERRUPTED", `authentication was required during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "provider-error") {
        return failure("PROVIDER_ERROR", `the provider surfaced an error during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "unexpected-dialog" || precheck.state === "expected-blocking-dialog" || precheck.state === "ambiguous") {
        return failure("UNKNOWN_DIALOG", `a dialog or ambiguous surface is visible during recovery — the bounded popup recovery applies only to submission: ${precheck.detail}`);
      }
      if (!stopVisible(observed.facts)) {
        return failure(
          "AMBIGUOUS_STATE",
          "the hung precondition (generation in progress) is not established — the provider Stop control is not visible"
        );
      }

      // 1. activate the provider Stop control.
      const stopped = await stopGeneration(tabId);
      if (!stopped.ok) {
        lastRefusal = stopped;
        continue;
      }
      // 2. verify generation stopped.
      const stopVerified = await settle(
        tabId,
        [],
        (f) => stopVisible(f) === false && f.composerEnabled?.enabled === true
      );
      if (!stopVerified.ok) {
        lastRefusal = stopVerified;
        continue;
      }
      if (stopVisible(stopVerified.facts) || stopVerified.facts.composerEnabled?.enabled !== true) {
        lastRefusal = failure(
          "AMBIGUOUS_STATE",
          "generation did not verifiably stop (the Stop control is still visible or the composer is not enabled)"
        );
        continue;
      }
      session.wasWorking = false;

      // 3. submit the FIXED recovery message — verbatim, exactly this
      // wording, never an alternative.
      const typed = await typeText(tabId, ZAI_LOCATORS.composer, ZAI_RECOVERY_MESSAGE);
      if (!typed.ok) {
        lastRefusal = typed;
        continue;
      }
      const readBack = await readFacts(tabId);
      if (!readBack.ok) {
        lastRefusal = readBack;
        continue;
      }
      if (readBack.facts.composerValue?.value !== ZAI_RECOVERY_MESSAGE) {
        lastRefusal = failure("AMBIGUOUS_STATE", "the composer did not hold the fixed recovery message verbatim");
        continue;
      }
      const sent = await send(tabId);
      if (!sent.ok) {
        lastRefusal = sent;
        continue;
      }

      // 4. verify acceptance: the EXACT fixed message `continue`
      // must be confirmed present in the conversation/user-message
      // evidence with the composer cleared (the message left the
      // composer and landed in the conversation). A resumed
      // generation state — the Stop control returning, the composer
      // clearing — is observed context, NEVER acceptance evidence:
      // it does not identify the recovery message.
      const accepted = await settle(tabId, [], (f) => {
        const composerValue = typeof f.composerValue?.value === "string" ? f.composerValue.value : "";
        const cleared = composerValue.length === 0;
        if (cleared && conversationContains(f, ZAI_RECOVERY_MESSAGE)) {
          return true; // acceptance confirmed by post-action evidence
        }
        // Decisive contradictions end the wait early (classified
        // below): authentication dropping, a dialog surface, an
        // error alert, an ambiguous surface. Anything else keeps
        // waiting within the bounded budget.
        const verdict = classifySession(f, session, "recovery-acceptance");
        return [
          "authentication-required",
          "provider-error",
          "unexpected-dialog",
          "expected-blocking-dialog",
          "ambiguous",
        ].includes(verdict.state);
      });
      if (!accepted.ok) {
        lastRefusal = accepted;
        continue;
      }
      const f = accepted.facts;
      const composerValue = typeof f.composerValue?.value === "string" ? f.composerValue.value : "";
      const cleared = composerValue.length === 0;
      const confirmed = conversationContains(f, ZAI_RECOVERY_MESSAGE);
      if (!(cleared && confirmed)) {
        // Classify a decisive contradiction if one ended the wait.
        const verdict = classifySession(f, session, "recovery-acceptance");
        if (verdict.state === "authentication-required") {
          return failure(
            "AUTHENTICATION_INTERRUPTED",
            `authentication was required while verifying recovery-message acceptance: ${verdict.detail}`
          );
        }
        if (verdict.state === "provider-error") {
          return failure(
            "PROVIDER_ERROR",
            `the provider surfaced an error while verifying recovery-message acceptance: ${verdict.detail}`
          );
        }
        if (
          verdict.state === "unexpected-dialog" ||
          verdict.state === "expected-blocking-dialog" ||
          verdict.state === "ambiguous"
        ) {
          return failure(
            "UNKNOWN_DIALOG",
            `a dialog or ambiguous surface is visible while verifying recovery-message acceptance: ${verdict.detail}`
          );
        }
        lastRefusal = failure(
          "AMBIGUOUS_STATE",
          "the fixed recovery message 'continue' was not confirmed accepted: the exact message is not present in the conversation evidence (a resumed generation state is not acceptance evidence)"
        );
        continue;
      }
      // Acceptance CONFIRMED by post-action evidence: the exact
      // fixed message landed in the conversation with the composer
      // cleared. Generation state is reported as observed context,
      // never as the acceptance proof.
      const resumed = stopVisible(f);
      session.wasWorking = resumed;
      session.recoveries = (session.recoveries ?? 0) + 1;
      return {
        ok: true,
        recovered: {
          attempts,
          message: ZAI_RECOVERY_MESSAGE,
          acceptance: "conversation-evidence",
          generation: resumed ? "working" : "waiting",
        },
        session: { worker, workItem, tabId },
      };
    }
    return (
      lastRefusal ??
      failure("RETRY_EXHAUSTED", `the bounded recovery attempt budget (${maxRecoveryAttempts}) was exhausted`)
    );
  }

  /**
   * Activate the provider Stop control: the FIRST candidate locator
   * that resolves to exactly one element (candidates are tried in
   * order — a control carrying both aria-label and title must not
   * double-count), else the unique visible button with exact text
   * "Stop".
   */
  async function stopGeneration(tabId) {
    const facts = await readFacts(tabId);
    if (!facts.ok) {
      return facts;
    }
    for (let i = 0; i < ZAI_LOCATORS.stopControl.length; i++) {
      const count = facts.facts[`stopCandidate${i}`]?.count ?? 0;
      if (count === 1) {
        return click(tabId, ZAI_LOCATORS.stopControl[i]);
      }
    }
    const texts = facts.facts.authButtons?.texts ?? [];
    const hits = texts
      .map((text, index) => ({ text, index }))
      .filter((entry) => entry.text === ZAI_LOCATORS.stopText);
    if (hits.length !== 1) {
      const counts = ZAI_LOCATORS.stopControl.map((_, i) => facts.facts[`stopCandidate${i}`]?.count ?? 0);
      return failure(
        "AMBIGUOUS_STATE",
        `the provider Stop control did not resolve to exactly one element (candidate counts: ${counts.join("/")}, exact-text matches: ${hits.length})`
      );
    }
    return clickIndex(tabId, ZAI_LOCATORS.allButtons, hits[0].index);
  }

  // ------------------------------------------------------------------
  // Observations.
  // ------------------------------------------------------------------

  /**
   * Read the current page facts and classify them (registry-aware).
   * Uses the bounded settle loop so a still-injecting content script
   * (fresh navigation) is tolerated; a persistently unreachable page
   * classifies as the typed ambiguous observation with the channel
   * failure detail.
   */
  async function observePage(tabId, session, phase = "idle") {
    const facts = await settle(tabId, [], (f) =>
      classifySession(f, session ?? null, phase).state !== "ambiguous"
    );
    if (!facts.ok) {
      return { state: "ambiguous", detail: facts.error.message };
    }
    return classifySession(facts.facts, session ?? null, phase);
  }

  /**
   * Observe a worker's Z.ai session: the registry correlation if one
   * is active, else origin-scoped discovery (exactly one tab, or the
   * typed session-missing / ambiguous states).
   */
  async function observeSession(workerName) {
    const target = await resolveTargetTab(workerName, { allowOpen: false });
    if (!target.ok) {
      return target;
    }
    if (target.observation) {
      return { ok: true, observation: { ...target.observation, worker: workerName } };
    }
    const session = sessions.get(workerName) ?? null;
    const observation = await observePage(target.tabId, session);
    return { ok: true, observation: { ...observation, tabId: target.tabId, worker: workerName } };
  }

  return Object.freeze({
    observeSession,
    startWorkerSession,
    recoverHungWorker,
  });
}

/** @private — the first whitespace-delimited token of a control's text. */
function leadingToken(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length === 0) {
    return "";
  }
  const [token] = trimmed.split(/\s+/);
  return token;
}
