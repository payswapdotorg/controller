/**
 * Z.ai browser Worker adapter tests (CTRL-014) — the offline/injected
 * matrix over the deterministic page simulator: the governed
 * new-session sequence, submission confirmation-before-success (the
 * continuation-6 correction: the pre-send gate, MESSAGE-EXCLUSIVE
 * acceptance evidence, decisive composer reads, and the bounded
 * compose re-establishment — the operator-described circular
 * control), auth-interrupt/budget fail-closed behavior, the fixed
 * Stop -> continue hung-worker recovery (acceptance proven by
 * conversation evidence — a resumed generation state alone never
 * succeeds), identity preservation, and stale/contradictory reference
 * refusal (including the stale correlated Start fail-closed
 * regression). The CONTINUATION-13 regressions (PR #6 review
 * 5124488246 — "REMOVE POPUP DETECTION/RECOVERY PATH") pin the
 * dialog-blind law: a visible provider dialog never observes, never
 * blocks, never triggers Enter, and never fails any governed flow —
 * Start and Recover proceed on the control-state and
 * message-evidence facts alone, the adapter never issues a
 * pressEnter command, and the submitted record is the popup-free
 * three-field shape. The CONTINUATION-12 regressions (PR #6 comment
 * 5557322324) pin the composer control-state transition as an
 * explicit submission-state observation channel: the provider's own
 * send/Stop slot computation and send-disabled computation are
 * observed on every fact read, cross-check the acceptance recording,
 * fail closed on contradictory or unreadable control states, and
 * the recovery's precondition waits (bounded) for the Stop-visible
 * interval to open.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createZaiAdapter, ZAI_SESSION_OBSERVATIONS } from "../src/zaiAdapter.js";
import { fakeZaiPage, fakeMessagingTabsApi, fakePageBridge } from "./fixtures.js";

const PROMPT = [
  "## GOVERNED WORKER PROMPT",
  "",
  "Implement CTRL-014 exactly. Multi-line & special 'characters' — verbatim.",
].join("\n");

/**
 * The composer Agent/compose control locator (LIVE-OBSERVED 2026-09-06:
 * the unique data-active button of the composer form containing
 * #chat-input — the operator-described circular control).
 */
const COMPOSE_CONTROL = "form:has(#chat-input) button[data-active]";

function build({
  authenticated = true,
  agent = { present: true, active: false },
  conversation = [],
  stop = { visible: false },
  popupOnSend = false,
  popupText = "Confirm submission",
  popupAfterSend = null,
  generates = true,
  tabsCount = 1,
  beforeRespond = null,
  dialog = null,
  alert = null,
  extraTabs = [],
  selectedValue = null,
  modelOptions = null,
  modelTrigger = true,
  modelTriggerAria = true,
  modelIdStuck = false,
  modelTextStuck = false,
  sidebarHistory = [],
  composeControl = true,
  composeStuck = false,
  duplicateComposer = false,
  // The CONTINUATION-12 control-state knobs (see fixtures.js).
  sendSlotStuck = false,
  sendEnabledLie = false,
  duplicateSend = false,
  generationCompletes = null,
  // The CONTINUATION-14 Send-inaccessible knob (see fixtures.js).
  sendInaccessible = false,
} = {}) {
  const pages = [];
  const tabs = [];
  for (let i = 0; i < tabsCount; i++) {
    const page = fakeZaiPage({
      authenticated,
      agent,
      conversation,
      stop,
      popupOnSend,
      popupText,
      popupAfterSend,
      generates,
      beforeRespond,
      dialog,
      alert,
      selectedValue,
      modelOptions: modelOptions ?? undefined,
      modelTrigger,
      modelTriggerAria,
      modelIdStuck,
      modelTextStuck,
      sidebarHistory,
      composeControl,
      composeStuck,
      duplicateComposer,
      sendSlotStuck,
      sendEnabledLie,
      duplicateSend,
      generationCompletes,
      sendInaccessible,
    });
    pages.push(page);
    tabs.push({ id: 7 + i, url: "https://chat.z.ai/", title: "Z.ai", page });
  }
  tabs.push(...extraTabs);
  const tabsApi = fakeMessagingTabsApi({ tabs });
  const adapter = createZaiAdapter({
    tabsApi,
    pageBridge: fakePageBridge(tabsApi),
    sleep: async () => {},
    now: () => 1725500000000,
    settlePolls: 4,
    settleIntervalMs: 0,
  });
  return { adapter, tabsApi, pages, tabs };
}

// --------------------------------------------------------------------
// The typed observation vocabulary.
// --------------------------------------------------------------------

test("the observation vocabulary is exactly the frozen twelve-state set", () => {
  assert.deepEqual([...ZAI_SESSION_OBSERVATIONS], [
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
});

// --------------------------------------------------------------------
// ObserveZaiSession.
// --------------------------------------------------------------------

test("an unauthenticated session observes authentication-required", async () => {
  const { adapter } = build({ authenticated: false });
  const result = await adapter.observeSession("w1");
  assert.equal(result.ok, true);
  assert.equal(result.observation.state, "authentication-required");
  assert.equal(result.observation.tabId, 7);
});

test("no provider tab observes session-missing (nothing is opened for a read-only observation)", async () => {
  const { adapter } = build({ tabsCount: 0 });
  const result = await adapter.observeSession("w1");
  assert.equal(result.ok, true);
  assert.equal(result.observation.state, "session-missing");
  assert.equal(result.observation.tabId, null);
});

test("multiple provider tabs without a session correlation observe ambiguous", async () => {
  const { adapter } = build({ tabsCount: 3 });
  const result = await adapter.observeSession("w1");
  assert.equal(result.ok, true);
  assert.equal(result.observation.state, "ambiguous");
});

test("an authenticated idle session observes ready-for-input", async () => {
  const { adapter } = build();
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "ready-for-input");
});

test("a generating session observes working", async () => {
  const { adapter } = build({ stop: { visible: true } });
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "working");
});

test("a visible provider dialog is NEVER an observation signal — the surface classifies by its composer/control facts (the dialog-blind law)", async () => {
  // CONTINUATION 13 (PR #6 review 5124488246, requirements 1-2): the
  // adapter performs NO dialog recognition, so a dialog-bearing
  // authenticated surface classifies by its non-dialog facts exactly
  // as it would without the dialog. The dialog is neither a positive
  // nor a negative signal: an idle enabled composer still observes
  // ready-for-input, and a generating surface (the Stop control
  // visible) still observes working. The pre-correction adapter
  // classified these same surfaces unexpected-dialog /
  // authentication-required / provider-error from the dialog's shape
  // and text — re-adding any dialog classification fails this
  // regression.
  const idle = build({ dialog: { text: "Some unprompted modal" } });
  const observed = await idle.adapter.observeSession("w1");
  assert.equal(observed.ok, true);
  assert.equal(observed.observation.state, "ready-for-input");
  const generating = build({ dialog: { text: "Some unprompted modal" }, stop: { visible: true } });
  const working = await generating.adapter.observeSession("w1");
  assert.equal(working.observation.state, "working");
  // The dialog is still sitting on the (simulated) provider surface —
  // untouched, unprobed, unclassified.
  assert.ok(generating.pages[0].state.dialog);
});

test("a visible alerting error surface observes provider-error", async () => {
  const { adapter } = build({ alert: { text: "Request failed" } });
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "provider-error");
});

test("a started session whose tab vanished observes session-missing", async () => {
  const { adapter, tabsApi } = build();
  await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  tabsApi._tabs.length = 0; // the tab closes
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "session-missing");
});

// --------------------------------------------------------------------
// StartZaiWorkerSession — the governed sequence.
// --------------------------------------------------------------------

test("the happy path runs the exact governed sequence and confirms submission", async () => {
  // CONTINUATION 14: the acceptance is recorded at the
  // SEND-REAPPEARANCE BOUNDARY — the send click swaps the action slot
  // to the Stop control (the generation entering flight), the bounded
  // wait tolerates the transient missing Send control, and the
  // completion transition (the Stop control gone, the send control
  // back) opens the boundary at which the message-exclusive evidence
  // is recorded (generation reported as the boundary read: "waiting").
  const { adapter, pages } = build({ generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.composeReestablishments, 0);
  assert.equal(result.submitted.generation, "waiting"); // the boundary read — the Stop control gone, the send control back
  // The governed flow never presses Enter (the popup dismissal path
  // is removed — CONTINUATION 13).
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  // The submission is confirmed by observation: the conversation holds
  // the exact prompt and the composer is cleared.
  assert.ok(pages[0].state.conversation.includes(PROMPT));
  assert.equal(pages[0].state.composerValue, "");
  assert.equal(pages[0].state.agent.active, true);
  // The selected model is the frozen GLM-5.3 — the operator's
  // authenticated surface starts on GLM-5.2 (selectedValue "glm-5.2",
  // trigger id #model-selector-glm-5_2-button, trigger text
  // "GLM-5.2"), and the live-observed trigger id derivation makes the
  // selection's ground truth #model-selector-glm-5_3-button.
  assert.equal(pages[0].state.selectedValue, "glm-5.3");
  // The exact command sequence: agent pill -> model trigger (the
  // generic aria candidate) -> the exact data-value option -> type
  // (verbatim) -> send.
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, ["click", "click", "click", "type", "click"]);
  const clickSelectors = pages[0]
    .history()
    .filter((c) => c.op === "click")
    .map((c) => c.selector);
  assert.deepEqual(clickSelectors, [
    "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type",
    'button[aria-label="Select a model"]',
    'button[aria-label="model-item"][data-value="glm-5.3"]',
    "#send-message-button",
  ]);
});

test("the prompt is carried byte-identical into the composer (never rewritten)", async () => {
  const { adapter, pages } = build();
  const typed = pages[0].history().filter((c) => c.op === "type");
  await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  const typeCommands = pages[0].history().filter((c) => c.op === "type");
  assert.equal(typeCommands.length, 1);
  assert.equal(typeCommands[0].text, PROMPT);
  void typed;
});

test("an unauthenticated session fails closed AUTHORIZATION_REQUIRED with zero send commands", async () => {
  const { adapter, pages } = build({ authenticated: false });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHORIZATION_REQUIRED");
  const ops = pages[0].history().filter((c) => c.op !== "probe");
  assert.deepEqual(ops, []); // nothing was typed or sent
});

test("multiple provider tabs with no correlation fail closed before any page command", async () => {
  const { adapter, pages } = build({ tabsCount: 2 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.deepEqual(pages.flatMap((p) => p.history()), []);
});

test("a missing Agent control fails closed without typing or sending", async () => {
  const { adapter, pages } = build({ agent: { present: false, active: false } });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, []);
});

// --------------------------------------------------------------------
// Agent selection — the LIVE-OBSERVED sidebar mode-toggle pill
// (focused regression coverage for the observed real-surface states:
// the pre-correction declared locators matched NOTHING on the real
// authenticated surface, and Start failed closed AMBIGUOUS_STATE).
// --------------------------------------------------------------------

test("the collapsed icon-only sidebar resolves the Agent pill structurally (no text anywhere)", async () => {
  // LIVE-OBSERVED collapsed state (the real landing/authenticated
  // collapsed sidebar): the mode pills carry icons only (empty text)
  // — the structural candidate, never a text scan, must resolve the
  // Agent pill.
  // CONTINUATION 14: generationCompletes opens the Send-reappearance
  // boundary at which the Start's acceptance is recorded.
  const { adapter, pages } = build({ sidebar: "collapsed", generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  const pillClick = pages[0].history().find(
    (c) => c.op === "click" && c.selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"
  );
  assert.ok(pillClick, "the structural Agent-pill selector was clicked");
  assert.equal(pages[0].state.agent.active, true);
});

test("the expanded labeled sidebar resolves the Agent pill and verifies the active-mode marker", async () => {
  // LIVE-OBSERVED expanded state (the operator's observed surface):
  // the pills carry the labels "Chat"/"Agent" (the provider's own
  // i18n renders Agent_Mode as "Agent") — the structural candidate
  // resolves, the click flips the pill, and data-active="true" is
  // the acceptance evidence.
  const { adapter, pages } = build({ sidebar: "expanded", generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(pages[0].state.agent.active, true);
  const pillClick = pages[0].history().find(
    (c) => c.op === "click" && c.selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"
  );
  assert.ok(pillClick, "the Agent pill was clicked");
});

test("Agent mode already active: no pill click is issued (idempotent preparation)", async () => {
  // Clicking an already-active Agent pill would navigate the
  // provider app to a fresh Agent-mode session for nothing; the
  // marker that resolved BEFORE any click establishes the selection.
  const { adapter, pages } = build({ agent: { present: true, active: true }, generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  const pillClicks = pages[0].history().filter(
    (c) => c.op === "click" && c.selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"
  );
  assert.equal(pillClicks.length, 0); // no pill click — idempotent
  assert.equal(pages[0].state.agent.active, true);
});

test("the observed real-surface failure, reproduced: an aria-labeled Agent button without the sidebar pills fails closed", async () => {
  // The pre-correction declared locator assumed a
  // button[aria-label="Agent"] surface. That element does not exist
  // on the real surface (LIVE-OBSERVED). If ONLY such a surface were
  // present, the adapter must refuse — the typed AMBIGUOUS_STATE the
  // operator observed — and never click an aria-labeled guess.
  const { adapter, pages } = build({
    agent: { present: false, active: false },
    buttons: () => [{ text: "Agent", ariaLabel: "Agent", disabled: false, active: false }],
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.match(result.error.message, /did not resolve to exactly one element/);
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, []); // nothing was typed or sent
});

test("a mode-pill click that never activates the Agent pill fails closed (the marker is the evidence)", async () => {
  // The click lands but the provider never switches the mode (a
  // provider change, a blocked handler): the data-active marker is
  // LIVE-OBSERVED ground truth — no marker, no success, and no weak
  // "control still present" acceptance (a click is never evidence).
  const stuck = build({
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        state.agent.active = false; // every observation still reports Chat active
      }
    },
  });
  const result = await stuck.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.match(result.error.message, /did not become the active mode pill/);
  const ops = stuck.pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  // The bounded retry budget: one pill click per attempt (3), and
  // nothing was ever typed or sent.
  assert.deepEqual(ops, ["click", "click", "click"]);
});

test("a missing GLM-5.3 model option fails closed without sending", async () => {
  const { adapter, pages } = build();
  // Remove the exact GLM-5.3 option: only Flash and 5.2 remain.
  pages[0].state.modelOptions = [
    { text: "GLM-5.3-Flash  NEW  Lightweight", value: "x-preview-l", disabled: false },
    { text: "GLM-5.2   Previous flagship", value: "glm-5.2", disabled: false },
  ];
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(pages[0].history().every((c) => c.op !== "type" && c.op !== "pressEnter"));
});

test("two exact GLM-5.3 options are an ambiguous model selection (GLM-5.3-Flash must not match)", async () => {
  const built = build();
  // Override the model options: two exact-token matches plus the
  // Flash variant (which must NEVER satisfy the exact-token match).
  built.pages[0].state.modelOptions = [
    { text: "GLM-5.3 A", value: "a", disabled: false },
    { text: "GLM-5.3 B", value: "b", disabled: false },
    { text: "GLM-5.3-Flash C", value: "glm-5.3-flash", disabled: false },
  ];
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
});

// --------------------------------------------------------------------
// Model selection — the LIVE-OBSERVED authenticated surface (focused
// regression coverage for the continuation-5 work order, PR #6
// comment 5554526659: the operator's saved HTML shows the trigger
// #model-selector-glm-5_2-button with aria "Select a model" while the
// screen stays on GLM-5.2 — the pre-correction hardcoded
// model-selector-x-preview-l-button locator never matched that
// surface). The fake models the live structure exactly: the trigger
// id embeds the SELECTED model's data-value ("." -> "_"), the option
// rows carry data-value, and the trigger text displays the selected
// model's label.
// --------------------------------------------------------------------

test("the id-family candidate resolves the model trigger when the aria-label is absent", async () => {
  // A provider surface variant without the trigger aria-label: the
  // second live-observed candidate (the id-prefix/suffix family)
  // must resolve the trigger — never a hardcoded model-specific id.
  const { adapter, pages } = build({ modelTriggerAria: false, generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  const triggerClick = pages[0].history().find(
    (c) => c.op === "click" && c.selector === 'button[id^="model-selector-"][id$="-button"]'
  );
  assert.ok(triggerClick, "the id-family candidate clicked the trigger");
  assert.equal(pages[0].state.selectedValue, "glm-5.3");
});

test("the model already GLM-5.3: no trigger click is issued (idempotent preparation)", async () => {
  // Both selection ground truths already hold (the trigger displays
  // GLM-5.3 and carries #model-selector-glm-5_3-button): re-clicking
  // the trigger would toggle the option menu open for nothing.
  const { adapter, pages } = build({ selectedValue: "glm-5.3", generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  const triggerClicks = pages[0].history().filter(
    (c) => c.op === "click" && (c.selector === 'button[aria-label="Select a model"]' || c.selector === 'button[id^="model-selector-"][id$="-button"]')
  ).length;
  assert.equal(triggerClicks, 0); // no trigger click — idempotent
  assert.equal(pages[0].state.selectedValue, "glm-5.3");
});

test("the observed real-surface failure, reproduced: the hardcoded x-preview-l trigger assumption fails closed on the authenticated surface", async () => {
  // The operator's authenticated surface trigger is
  // #model-selector-glm-5_2-button (aria "Select a model"), NOT the
  // unauthenticated #model-selector-x-preview-l-button. A surface
  // with NO trigger at all must fail closed with the typed trigger
  // resolution refusal — never a guessed model action.
  const { adapter, pages } = build({ modelTrigger: false });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.match(result.error.message, /model selector trigger did not resolve to exactly one element/);
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, ["click"]); // only the Agent pill click; nothing typed or sent
});

test("a selection whose trigger id never flips fails closed (the id-family ground truth)", async () => {
  // The exact option click lands, the trigger text updates to
  // GLM-5.3, but the provider never re-renders the trigger id (it
  // stays glm-5_2): BOTH ground truths are required — the id-family
  // signal is live-observed (the operator's HTML), and a missing one
  // is a typed refusal, never a weak acceptance.
  const stuck = build({ modelIdStuck: true });
  const result = await stuck.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.match(result.error.message, /selected-model trigger id did not resolve/);
  assert.ok(stuck.pages[0].history().every((c) => c.op !== "type" && c.op !== "pressEnter"));
});

test("a selection whose trigger text never updates fails closed (the display ground truth)", async () => {
  // The option click lands, the trigger id flips to glm-5_3, but the
  // model header still displays GLM-5.2: the trigger display is the
  // live-observed model header — a stale display is a typed refusal.
  const stuck = build({ modelTextStuck: true });
  const result = await stuck.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.match(result.error.message, /does not display the GLM-5.3 label/);
  assert.ok(stuck.pages[0].history().every((c) => c.op !== "type" && c.op !== "pressEnter"));
});

test("two rows carrying the glm-5.3 data-value are an ambiguous model selection", async () => {
  // The data-value ground truth must resolve to EXACTLY ONE row; a
  // duplicated provider value is ambiguous and fails closed before
  // any option click.
  const built = build();
  built.pages[0].state.modelOptions = [
    { text: "GLM-5.3 A", value: "glm-5.3", disabled: false },
    { text: "GLM-5.3 B", value: "glm-5.3", disabled: false },
    { text: "GLM-5.2   Previous", value: "glm-5.2", disabled: false },
  ];
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.match(result.error.message, /data-value rows/);
  const optionClicks = built.pages[0].history().filter(
    (c) => c.op === "click" && c.selector === 'button[aria-label="model-item"][data-value="glm-5.3"]'
  ).length;
  assert.equal(optionClicks, 0); // ambiguous resolution never clicks
});

test("a disabled GLM-5.3 option row (the live unauthenticated surface) refuses the click and fails closed", async () => {
  // LIVE-OBSERVED unauthenticated menu state: the GLM-5.3 row carries
  // disabled="" — the closed page vocabulary refuses disabled
  // elements, the bounded retry re-attempts, and the final refusal
  // names the disabled row (never a guessed click, never a
  // success).
  const built = build({
    modelOptions: [
      { text: "GLM-5.3-Flash  NEW  Lightweight flagship", value: "x-preview-l", disabled: false },
      { text: "GLM-5.3   Flagship model", value: "glm-5.3", disabled: true },
      { text: "GLM-5.2   Previous flagship", value: "glm-5.2", disabled: false },
    ],
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_REFUSED");
  assert.match(result.error.message, /disabled/);
  assert.ok(built.pages[0].history().every((c) => c.op !== "type" && c.op !== "pressEnter"));
  assert.equal(built.pages[0].state.selectedValue, "glm-5.2"); // never selected
});

test("a provider dialog appearing during preparation NEVER blocks the governed Start and never receives Enter (the dialog-blind law)", async () => {
  // CONTINUATION 13 (PR #6 review 5124488246, requirement 2): "a
  // visible dialog must NOT be used as a positive or negative popup
  // signal for the normal CTRL-014 path." A dialog that appears right
  // after the Agent pill click (the pre-correction adapter failed
  // closed UNKNOWN_DIALOG here) is simply not consulted: the governed
  // sequence runs to completion, the acceptance is the
  // message-exclusive evidence, and NO Enter is ever issued. The
  // dialog is still sitting on the surface at the end — untouched.
  const built = build({
    generationCompletes: 1, // CONTINUATION 14: the completion opens the Send-reappearance boundary
    beforeRespond: (message, state) => {
      if (message.op === "click" && String(message.selector).includes("nth-of-type(2)")) {
        state.dialog = { text: "An unexpected modal" }; // appears after the Agent pill click
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "waiting"); // the boundary read — CONTINUATION 14
  assert.ok(built.pages[0].state.conversation.includes(PROMPT)); // the acceptance evidence
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  assert.ok(built.pages[0].state.dialog); // never dismissed, never consulted
});

test("a send that never confirms submission retries within the budget, then fails closed", async () => {
  // The send click "succeeds" but the submission never takes: on every
  // later probe the composer still holds the exact prompt and the
  // conversation never grows — the adapter must report unconfirmed,
  // restart the bounded preparation, and finally fail closed WITHOUT
  // ever claiming submission.
  const suppress = build({
    generates: false, // CONTINUATION 14: nothing ever generates — the surface stays "send"-controlled
    beforeRespond: (message, state) => {
      if (message.op === "type") {
        state.__typed = message.text;
      }
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__blocked = true;
      }
      if (message.op === "probe" && state.__blocked) {
        state.composerValue = state.__typed; // the send did not take
        state.conversation = state.conversation.filter((t) => t !== PROMPT); // CONTINUATION 14: the conversation never grows (the stated semantics, modeled faithfully)
      }
    },
  });
  const result = await suppress.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not confirmed by observation/.test(result.error.message));
});

// --------------------------------------------------------------------
// The CONTINUATION-13 regressions (PR #6 review 5124488246 — the
// ARCHITECT work order "REMOVE POPUP DETECTION/RECOVERY PATH"): a
// visible provider dialog never triggers Enter, never triggers
// popup-specific recovery, and never blocks a governed flow.
// --------------------------------------------------------------------

test("a submission-blocking dialog the adapter does not recognize: bounded blind retries of the same send, fail closed, and NEVER an Enter press", async () => {
  // The popupOnSend modality models the provider surface that blocks
  // every send behind a modal dialog (the prompt stays in the
  // composer, the conversation never grows). The dialog-blind adapter
  // (CONTINUATION 13) has no popup concept: each attempt re-observes
  // an unconfirmed send (the composer still holds the exact prompt)
  // and resends within the bounded budget, then fails closed — the
  // pre-correction adapter pressed Enter here (the popup dismissal
  // path); re-adding it fails this regression.
  const built = build({ popupOnSend: true, popupText: "Confirm submission" });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not confirmed by observation/.test(result.error.message));
  const history = built.pages[0].history();
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 0); // never an Enter
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 3); // the bounded budget of blind retries
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
  assert.ok(built.pages[0].state.dialog); // the dialog was never dismissed
});

test("the asynchronous peak-hours dialog materializing ON the verification read: the adapter stays dialog-blind — the acceptance is the message-exclusive evidence and NO Enter is ever issued", async () => {
  // The REAL provider modality (LIVE-OBSERVED, the operator's captured
  // run): the "Currently in peak hours" capacity dialog materializes
  // only when the ASYNC error arrives — after the optimistic landing
  // (the exact user-message row + the cleared composer). CONTINUATION
  // 13 removed the async-outcome hold that watched for it: the
  // confirm-shaped verdict IS the acceptance (message-exclusive
  // evidence, gated on control-state consistency), and the dialog —
  // materializing on this very read — is invisible to every fact the
  // adapter probes. The pre-correction adapter caught the popup
  // through the hold, pressed Enter, and restarted the preparation;
  // re-adding any of that fails this regression.
  const built = build({
    generates: false, // the capacity error means no generation started
    popupAfterSend: { probes: 1 }, // materializes on the 1st fact read after the send (the verdict read itself)
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1); // no preparation restart — there is no popup path
  assert.equal(result.submitted.generation, "waiting"); // the operator's literal surface shape
  assert.deepEqual(Object.keys(result.submitted).sort(), ["attempts", "composeReestablishments", "generation"]);
  const history = built.pages[0].history();
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 0); // never an Enter
  assert.equal(history.filter((c) => c.op === "type").length, 1); // typed exactly once
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1); // never resent
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // never duplicated
  assert.ok(built.pages[0].state.dialog); // the dialog is sitting on the surface — untouched, unprobed
});

test("the provider's restored prompt (the async error's sibling outcome) flows through the ORDINARY unconfirmed-retry path — never a popup path, never an Enter", async () => {
  // The provider's MODEL_CONCURRENCY_LIMIT handler can RESTORE the
  // submitted prompt into the composer after the optimistic landing.
  // The dialog-blind adapter sees exactly one thing: the composer
  // holding text on the verification read — the ordinary "send did
  // not take" unconfirmed semantics. The bounded retry resends the
  // restored prompt as-is (never re-typed — ensurePrompt verifies it
  // byte-for-byte and sends as-is), and the resend's own confirm-
  // shaped verdict is the acceptance. The pre-correction adapter
  // routed this through the popup hold (Enter + full restart);
  // re-adding that fails this regression.
  const built = build({
    generates: false,
    popupAfterSend: { probes: 1, restore: true },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2); // the ordinary bounded retry
  const history = built.pages[0].history();
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 0); // never an Enter
  assert.equal(history.filter((c) => c.op === "type").length, 1); // the restored prompt is sent AS-IS — never re-typed
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 2); // the send + the resend
  assert.ok(built.pages[0].state.conversation.includes(PROMPT)); // the resend landed
  assert.ok(built.pages[0].state.dialog); // the dialog is still there — untouched
});

test("a send that clears the composer without message-evidence confirmation is NEVER success (no popup does not mean accepted)", async () => {
  // The frozen acceptance rule (PR #6 comment 5554526659): "no popup
  // = success" is FORBIDDEN. Here no dialog ever appears, every send
  // click succeeds, the composer clears — but the provider state
  // never shows the exact prompt in the MESSAGE evidence. Acceptance
  // requires message-exclusive confirmation (an exact user-message
  // row or the [role="log"] region) with a decisively cleared
  // composer; the corrected adapter additionally runs the bounded
  // compose re-establishment between attempts (the continuation-6
  // second failure mode) and still never claims submission.
  // CONTINUATION 14: generates: false models the capacity-shaped
  // no-generation surface (the comment's own semantics) — the Stop
  // control never renders, the control state stays "send", and the
  // exhausted wait routes the discarded-input branch on every attempt.
  const swallowed = build({
    generates: false,
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        // The adversarial provider state: the message evidence NEVER
        // contains the exact prompt (the hook filters it out of every
        // observation; the send click itself always succeeds).
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
      }
    },
  });
  const result = await swallowed.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not present in the composer after the send attempt/.test(result.error.message));
  assert.ok(!swallowed.pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
  const history = swallowed.pages[0].history();
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 3); // the bounded budget of send attempts
  // The bounded compose re-establishment ran once per exhausted
  // attempt (the input state was re-established, re-typed, and
  // re-verified — still no acceptance without message evidence).
  // CONTINUATION 14: the surface is the capacity-shaped no-generation
  // surface (generates: false) — the Stop control never renders, so
  // the control state stays "send" and the exhausted wait routes the
  // discarded-input branch.
  const composeClicks = history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length;
  assert.equal(composeClicks, 3);
});

test("a dialog present from the very start NEVER blocks the governed Start (the precheck itself is dialog-blind)", async () => {
  // The from-the-start variant of the dialog-blind law: the initial
  // authenticated-state precheck sees the dialog-bearing surface and
  // classifies it by its composer facts (ready-for-input — the
  // pre-correction adapter failed closed UNKNOWN_DIALOG before any
  // preparation). The full governed sequence then runs to the
  // message-exclusive acceptance, with zero Enter presses and the
  // dialog untouched.
  const built = build({ generationCompletes: 1, dialog: { text: "An unexpected modal" } });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(built.pages[0].state.conversation.includes(PROMPT));
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  assert.ok(built.pages[0].state.dialog); // untouched
});

// --------------------------------------------------------------------
// Continuation 6 (PR #6 review 5123047551) — the live false-positive
// correction: the pre-send gate, message-exclusive acceptance
// evidence, decisive composer reads, and the bounded compose
// re-establishment (the operator-described circular control).
// --------------------------------------------------------------------

test("the reproduced live false positive: a weak surface carrying the prompt is NEVER already-confirmed evidence (the prompt is typed, sent, and accepted on message evidence only)", async () => {
  // The live defect signature: Start returned submitted (attempts=1,
  // popupDismissals=0, generation=waiting) while the operator's
  // post-run DOM showed an EMPTY #chat-input and a DISABLED send
  // control — the prompt had never been entered. Root cause: the
  // acceptance predicate consulted broad non-message surfaces (a
  // sidebar/history region whose text contained the prompt). The
  // correction: acceptance evidence is message-exclusive, so the
  // weak surface never shortcuts the submission — the honest path
  // types, verifies at the send gate, sends, and accepts only on
  // the real message evidence.
  const { adapter, pages } = build({ sidebarHistory: [PROMPT], generationCompletes: 1 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.composeReestablishments, 0);
  const history = pages[0].history().filter((c) => c.op !== "probe");
  // The honest path: the prompt WAS typed and sent (the weak surface
  // never stood in for a submission).
  assert.deepEqual(history.map((c) => c.op), ["click", "click", "click", "type", "click"]);
  assert.equal(history.filter((c) => c.op === "type").length, 1);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  // The acceptance evidence is the conversation message row — the
  // submission ACTUALLY landed exactly once.
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
});

test("a weak surface carrying the prompt NEVER confirms an unlanded submission (fail closed, no success)", async () => {
  // The adversarial variant of the live false positive: the send
  // discards the prompt (empty composer, disabled send) and the ONLY
  // surface carrying the prompt is the weak non-message surface. The
  // pre-correction predicate accepted exactly this state; the
  // corrected predicate runs the bounded compose re-establishment
  // and fails closed — never a success, never a duplicate send past
  // the budget.
  const swallowed = build({
    sidebarHistory: [PROMPT],
    generates: false, // CONTINUATION 14: the discarded-input surface — nothing generates, the control state stays "send"
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
      }
    },
  });
  const result = await swallowed.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not present in the composer after the send attempt/.test(result.error.message));
  assert.ok(!swallowed.pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
});

test("the pre-send gate: a prompt lost between the read-back and the send is NEVER sent — the composer is re-established, the prompt re-typed, and only then sent once", async () => {
  // The operator-observed discarding mode: the typed read-back
  // verifies, then the provider discards the input state before the
  // send. The gate (a fresh decisive read immediately before the
  // send) refuses to send the empty composer; the bounded recovery
  // re-establishes the input state; the next attempt re-types the
  // exact prompt byte-identical and only THEN sends — exactly one
  // send in the whole history, never an empty-composer send.
  let readBacks = 0;
  let discards = 0;
  const built = build({
    generationCompletes: 1, // CONTINUATION 14: the resend's completion opens the boundary
    beforeRespond: (message, state) => {
      if (message.op === "type") {
        readBacks = 0; // the read-back follows the type
      }
      if (message.op === "probe") {
        readBacks += 1;
        if (readBacks > 1 && state.composerValue === PROMPT && discards === 0) {
          discards = 1;
          state.composerValue = ""; // discarded after the read-back, before the send
        }
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.composeReestablishments, 1);
  const history = built.pages[0].history().filter((c) => c.op !== "probe");
  // pill -> trigger -> option -> type -> [gate refuses] -> compose
  // control -> re-type -> send. The ONLY send comes AFTER the second
  // type (the first send never happened — the gate refused it).
  assert.deepEqual(history.map((c) => c.op), ["click", "click", "click", "type", "click", "type", "click"]);
  const clickSelectors = history.filter((c) => c.op === "click").map((c) => c.selector);
  assert.deepEqual(clickSelectors, [
    "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type",
    'button[aria-label="Select a model"]',
    'button[aria-label="model-item"][data-value="glm-5.3"]',
    COMPOSE_CONTROL,
    "#send-message-button",
  ]);
  const typeTexts = history.filter((c) => c.op === "type").map((c) => c.text);
  assert.deepEqual(typeTexts, [PROMPT, PROMPT]); // byte-identical re-type
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
});

test("the second observed failure mode: a send that discards the prompt (empty composer, disabled send) triggers the bounded compose re-establishment, re-type, re-read, and resend", async () => {
  // PR #6 review 5123047551, requirement 3: after the initial send
  // attempt the prompt is NOT present in the composer (the provider
  // discarded the input state — the operator's captured post-run
  // DOM). The correction: re-establish the input state through the
  // Agent/compose control, re-type the exact prompt byte-for-byte,
  // re-read it byte-for-byte, and only then resend.
  let sendAttempts = 0;
  const built = build({
    generationCompletes: 1, // CONTINUATION 14: the resend's completion opens the boundary
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          state.__discard = true; // the first send discards the input state
        }
      }
      if (message.op === "probe" && state.__discard) {
        state.__discard = false;
        if (state.conversation[state.conversation.length - 1] === PROMPT) {
          state.conversation.pop(); // the submission did not land
        }
        state.stop.visible = false; // nothing is generating
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.composeReestablishments, 1);
  const history = built.pages[0].history().filter((c) => c.op !== "probe");
  assert.deepEqual(history.map((c) => c.op), ["click", "click", "click", "type", "click", "click", "type", "click"]);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length, 1);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 2);
  const typeTexts = history.filter((c) => c.op === "type").map((c) => c.text);
  assert.deepEqual(typeTexts, [PROMPT, PROMPT]);
  // Acceptance came only from the message evidence after the RESEND.
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
});

test("a compose control whose click never re-establishes an enabled composer fails closed (never success, never a blind resend)", async () => {
  // The stuck recovery: the Agent/compose control click "succeeds"
  // but the composer never becomes an enabled input, and the
  // unestablished composer refuses the re-type. The Start fails
  // closed within the bounded budget without ever claiming
  // submission.
  let sendAttempts = 0;
  const built = build({
    composeStuck: true,
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          state.__discard = true;
        }
      }
      if (message.op === "probe" && state.__discard) {
        state.__discard = false;
        if (state.conversation[state.conversation.length - 1] === PROMPT) {
          state.conversation.pop();
        }
        state.stop.visible = false;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_REFUSED");
  assert.ok(/did not accept the exact text verbatim/.test(result.error.message));
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
  const history = built.pages[0].history();
  assert.equal(history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length, 1);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  // Every re-type was REFUSED by the unestablished composer (the
  // bounded attempt budget of type commands) — the typed text never
  // landed: the composer stays empty.
  assert.equal(history.filter((c) => c.op === "type").length, 3);
  assert.equal(built.pages[0].state.composerValue, "");
});

test("an ABSENT compose control fails closed: the discarded-input-state recovery cannot re-establish the composer, and Start never claims submission (the exact live signature: waiting, empty composer, no message evidence)", async () => {
  // Continuation 7, PR #6 comment 5554962511, requirement 6: the
  // composer-discarded live failure mode with the circular
  // Agent/compose control MISSING from the composer form. The exact
  // live signature is reproduced: every send discards the input
  // state (the submission never lands — no message evidence), the
  // Stop control never shows (generation reads "waiting" — a CONTEXT
  // field, never a proof), and the composer is decisively EMPTY. The
  // recovery resolves ZERO candidates and fails closed
  // AMBIGUOUS_STATE: never a blind click (there is nothing to click
  // — absence is a refusal, not an action), never a guessed
  // re-establishment, and the bounded budget bounds the verified
  // resends (each preceded by the byte-identical read-back and the
  // pre-send gate — never a blind resend).
  const built = build({
    composeControl: false,
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        // The submission never lands on ANY attempt: the message
        // evidence never carries the prompt, and nothing ever
        // generates (the "waiting" shape of the live capture).
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
        state.stop.visible = false;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/did not resolve to exactly one element/.test(result.error.message));
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
  const history = built.pages[0].history();
  // The compose control was NEVER clicked (zero candidates resolved —
  // the absence fails closed before any action).
  assert.equal(history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length, 0);
  // The bounded budget: every attempt typed the exact prompt, passed
  // the pre-send gate, sent exactly once, and failed to re-establish
  // the input state — 3 attempts, 3 verified sends, zero successes.
  assert.equal(history.filter((c) => c.op === "type").length, 3);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 3);
  const typeTexts = history.filter((c) => c.op === "type").map((c) => c.text);
  assert.deepEqual(typeTexts, [PROMPT, PROMPT, PROMPT]); // byte-identical every time
});

test("an AMBIGUOUS compose control (two data-active buttons in the composer form) fails closed without EVER being clicked", async () => {
  // Continuation 7, PR #6 comment 5554962511, requirement 6: a
  // provider surface whose composer form renders TWO data-active
  // buttons — the structural locator resolves MANY, and the
  // re-establishment must fail closed AMBIGUOUS_STATE BEFORE any
  // click: never a blind click (ambiguity is a refusal, not an
  // action), never a guessed re-establishment. The discarded-input
  // state is the same live signature (waiting, empty composer, no
  // message evidence), and Start never claims submission within the
  // bounded budget.
  const built = build({
    composeControl: "ambiguous",
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
        state.stop.visible = false;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/did not resolve to exactly one element/.test(result.error.message));
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
  const history = built.pages[0].history();
  // The compose control was NEVER clicked — the two-candidate
  // resolution is a refusal that precedes every action.
  assert.equal(history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length, 0);
  assert.equal(history.filter((c) => c.op === "type").length, 3);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 3);
});

// --------------------------------------------------------------------
// Continuation 8 (PR #6 comment 5555093252) — the operator's cited
// false-positive JSON re-issued as a work order: the literal live
// capture reproduced at the corrected tip (requirements 1, 6(a), and
// 6(b)) and the result-shape invariant that makes the cited
// three-field record structurally unreachable at this tip.
// --------------------------------------------------------------------

test("the operator's literal capture reproduced: the prompt NEVER enters the composer (every typed input is discarded before the read-back), the send control stays disabled, and the surface is waiting-shaped — Start fails closed, never ok:true", async () => {
  // PR #6 comment 5555093252, requirements 1, 6(a), and 6(b): the
  // operator's captured post-run DOM — an EMPTY #chat-input with a
  // DISABLED #send-message-button — combined with the weak sidebar
  // surface carrying the exact prompt is the EXACT state under which
  // the pre-correction a22febe adapter returned the cited false
  // positive (`ok:true` with the three-field `submitted`
  // {attempts:1, popupDismissals:0, generation:"waiting"} — zero
  // typing accepted, zero sending). The corrected adapter refuses:
  // every bounded attempt types the exact prompt, the decisive
  // read-back catches the discarded input state BEFORE any send (the
  // send control is disabled the entire run — nothing was ever
  // sendable, and nothing is ever sent), and the budget ends in a
  // TYPED failure. `generation:"waiting"` is reported context only —
  // it never participates in acceptance.
  const built = build({
    sidebarHistory: [PROMPT], // the weak surface that produced the live false positive
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        // The provider discards the typed input state before every
        // read: the composer reads decisively EMPTY at every
        // read-back (the prompt was never present in #chat-input).
        state.composerValue = "";
        // The submission never lands (no message evidence) and
        // nothing ever generates — the "waiting" shape of the live
        // capture, context only, never a proof.
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
        state.stop.visible = false;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/did not hold the exact governed prompt verbatim/.test(result.error.message));
  // Never claimed submitted: the message evidence never carried the prompt.
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT));
  const history = built.pages[0].history();
  // The send control was NEVER clicked — it is disabled while the
  // composer is empty, the composer was decisively empty at every
  // decisive read, and the pre-send gate never admits an empty
  // composer. Zero sends in the entire run.
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  // The bounded budget: three attempts, each typing the exact prompt
  // byte-identical and catching the discarded input state at the
  // decisive read-back.
  assert.equal(history.filter((c) => c.op === "type").length, 3);
  const typeTexts = history.filter((c) => c.op === "type").map((c) => c.text);
  assert.deepEqual(typeTexts, [PROMPT, PROMPT, PROMPT]);
});

test("every ok:true Start with a submission carries EXACTLY the popup-free three-field submitted record — a result carrying popupDismissals identifies a stale service worker", async () => {
  // CONTINUATION 13 (PR #6 review 5124488246, requirement 1): the
  // popupDismissals accounting is removed with the whole popup
  // mechanism. The operator-cited legacy records carried
  // `submitted = {attempts, popupDismissals, generation}` (and the
  // continuation-8 four-field shape added composeReestablishments) —
  // at this tip there are exactly TWO ok:true Start shapes: the
  // idempotent alreadyActive re-report (NO submitted record at all)
  // and recordSubmission — the only submission path, which reports
  // exactly {attempts, composeReestablishments, generation}. A Start
  // result carrying a popupDismissals field cannot have been produced
  // by this code: it identifies a stale service worker. This
  // regression pins the invariant on BOTH the direct-acceptance path
  // and the compose-re-establishment path.
  const THREE_FIELDS = ["attempts", "composeReestablishments", "generation"];

  // (1) The direct acceptance path.
  const happy = build({ generationCompletes: 1 });
  const okResult = await happy.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  assert.deepEqual(Object.keys(okResult.submitted).sort(), THREE_FIELDS);
  assert.equal(okResult.submitted.composeReestablishments, 0);

  // (2) The compose-re-establishment path (the second observed
  // failure mode recovered within the budget).
  let sendAttempts = 0;
  const recovered = build({
    generationCompletes: 1, // CONTINUATION 14: the resend's completion opens the boundary
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        sendAttempts += 1;
        if (sendAttempts === 1) {
          state.__discard = true;
        }
      }
      if (message.op === "probe" && state.__discard) {
        state.__discard = false;
        if (state.conversation[state.conversation.length - 1] === PROMPT) {
          state.conversation.pop();
        }
        state.stop.visible = false;
      }
    },
  });
  const recoveredResult = await recovered.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(recoveredResult.ok, true, JSON.stringify(recoveredResult));
  assert.deepEqual(Object.keys(recoveredResult.submitted).sort(), THREE_FIELDS);
  assert.equal(recoveredResult.submitted.composeReestablishments, 1);

  // (3) The idempotent alreadyActive re-report carries NO submitted
  // record at all — every result WITH a submitted record went
  // through recordSubmission (the three-field shape).
  const again = await happy.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.alreadyActive, true);
  assert.ok(!("submitted" in again), "the alreadyActive re-report never carries a submitted record");
});

// --------------------------------------------------------------------
// Continuation 9 (PR #6 review 5123260890) — the operator's committed
// main-branch proof artifacts (payswapdotorg/controller 5d14d90: the
// captured Z.ai HTML + screenshot) analyzed as OPERATOR EVIDENCE ONLY
// (never CTRL-014 acceptance): the user-message row's trimmed text is
// the exact submitted prompt byte-for-byte, the row reads
// "ispatch APP-001 ..." (the intended prompt's leading "D" lost), the
// assistant replied "Model is currently at capacity ...", the composer
// reads empty, and [role="log"] matches ZERO elements. The three
// machine-side locks: the near-miss row is NEVER acceptance, a mixed
// message REGION (assistant echo) is never USER-message evidence, and
// the known-popup path restarts the FULL preparation sequence.
// --------------------------------------------------------------------

test("the operator's captured near-miss run: a user-message row that lost the prompt's LEADING CHARACTER is NEVER acceptance — Start keeps the byte-identical chain (including the leading character) and fails closed, never ok:true", async () => {
  // The operator's literal captured run (main 5d14d90, PR #6 review
  // 5123260890): the submitted row reads "ispatch APP-001 ..." — the
  // intended governed prompt's leading "D" is missing, so the landed
  // message is NOT byte-identical to the exact prompt. The machine
  // chain stays byte-identical the whole way (every bounded attempt
  // types the FULL prompt including the leading "D" and re-verifies
  // the read-back), and the acceptance predicate requires the EXACT
  // user-message row — the near-miss row never confirms, no matter
  // how waiting-shaped the surface is (generation:"waiting" is
  // context, never a predicate). The budget ends in a TYPED refusal.
  const GOVERNED = "Dispatch APP-001 from this exact main SHA through the Pectoraux Controller. No successor Work Item is authorized.";
  const NEAR_MISS = GOVERNED.slice(1); // the leading "D" lost — the captured row
  const built = build({
    beforeRespond: (message, state) => {
      // The pre-send gate passes (the composer holds the EXACT
      // prompt, leading "D" included); the SURFACE loses the
      // leading character at submission time, exactly as captured:
      // the landed row is the near-miss, the composer clears.
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.composerValue = NEAR_MISS;
      }
      // The provider is at capacity: nothing generates — the
      // waiting-shaped surface of the captured run.
      if (message.op === "probe") {
        state.stop.visible = false;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: GOVERNED });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not present in the composer after the send attempt/.test(result.error.message));
  // The typed chain is byte-identical INCLUDING the leading
  // character: every bounded attempt typed the FULL governed prompt.
  const typedTexts = built.pages[0].history().filter((c) => c.op === "type").map((c) => c.text);
  assert.equal(typedTexts.length, 3); // the bounded budget
  assert.deepEqual(typedTexts, [GOVERNED, GOVERNED, GOVERNED]);
  // The near-miss row landed (the surface's loss — operator
  // evidence), but the EXACT prompt never appeared as a user row,
  // and the near-miss never confirmed a submission.
  assert.equal(built.pages[0].state.conversation.filter((t) => t === NEAR_MISS).length, 3);
  assert.ok(!built.pages[0].state.conversation.includes(GOVERNED)); // never claimed submitted
  const sends = built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 3); // the bounded budget of send attempts
  // The bounded compose re-establishment ran once per exhausted
  // attempt (the cleared-but-unconfirmed second failure mode).
  const composeClicks = built.pages[0].history().filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length;
  assert.equal(composeClicks, 3);
});

test("an ASSISTANT echo of the exact prompt in a mixed message REGION is never USER-message acceptance evidence — the region path is removed, and re-adding it fails this regression", async () => {
  // PR #6 review 5123260890, requirement 2: "exact prompt observed in
  // message-exclusive USER-message evidence". The eliminated
  // [role="log"] REGION-containment path accepted ANY text in the
  // region — including an assistant echo of the exact prompt, which
  // with an empty composer would have confirmed a submission that
  // never happened. This canned-facts page serves the region-shaped
  // echo (conversationCandidate0 carries the exact prompt) while the
  // USER rows never do: the adapter must not consult the region at
  // all, exhaust the bounded budget, and fail closed. If the region
  // path were ever re-added, this page would confirm and the
  // regression would fail.
  const tabs = [{ id: 7, url: "https://chat.z.ai/" }];
  const tabsApi = fakeMessagingTabsApi({ tabs });
  let typed = "";
  const baseFacts = () => ({
    authButtons: { texts: ["New Chat", "Agent"] },
    composerVisible: { visible: true, count: 1 },
    composerEnabled: { enabled: true },
    composerValue: { value: typed },
    sendVisible: { visible: true, count: 1 },
    sendEnabled: { enabled: typed.length > 0 },
    alertVisible: { visible: false, count: 0 },
    stopCandidate0: { visible: false, count: 0 },
    stopCandidate1: { visible: false, count: 0 },
    alertText: { text: null },
    // The assistant echo: the REGION text carries the exact prompt;
    // the USER-message rows never do.
    conversationCandidate0: { text: PROMPT },
    userMessageCandidate0: { texts: [] },
    userMessageCandidate1: { texts: [] },
    userMessageCandidate2: { texts: [] },
    composeControl0: { count: 1 },
    agentCandidate0: { count: 1 },
    agentActive0: { count: 1 },
    agentActive1: { count: 0 },
    agentActive2: { count: 0 },
    agentActive3: { count: 0 },
    modelTriggerCount0: { count: 1 },
    modelTriggerCount1: { count: 1 },
    modelTriggerText0: { text: "GLM-5.3" },
    modelTriggerText1: { text: "GLM-5.3" },
    modelTriggerSelectedId: { count: 1 },
  });
  const bridge = {
    send: async (_tabId, command) => {
      if (command.op === "probe") {
        return { ok: true, facts: baseFacts() };
      }
      if (command.op === "type") {
        typed = command.text;
        return { ok: true, typed: true, value: command.text };
      }
      if (command.op === "click" && command.selector === "#send-message-button") {
        typed = ""; // the composer clears; the echo is all that remains
        return { ok: true, clicked: true };
      }
      return { ok: true, clicked: true };
    },
  };
  const adapter = createZaiAdapter({ tabsApi, pageBridge: bridge, sleep: async () => {}, settlePolls: 2, settleIntervalMs: 0 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(["PAGE_MALFORMED", "AMBIGUOUS_STATE", "RETRY_EXHAUSTED"].includes(result.error.code));
  // The USER-message rows never carried the exact prompt; the
  // region-shaped echo was never consulted as evidence.
  assert.ok(!("submitted" in result), "an assistant echo never produces a submitted record");
});

test("an ambiguous composer surface (two visible #chat-input elements) fails closed before ANY action — nothing prepared, typed, or sent", async () => {
  // The pre-correction `?? \"\"` coercion treated an unreadable
  // composer as empty (cleared). The corrected adapter requires
  // DECISIVE reads: an ambiguous composer surface (the value and
  // enabled probes degrade to null facts) never reaches preparation
  // — the precheck itself fails closed.
  const built = build({ duplicateComposer: true });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/not ready for a new worker session/.test(result.error.message));
  const ops = built.pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, []); // nothing was clicked, typed, or sent
});

test("an unreadable composer value is NEVER treated as cleared or present — Start refuses at the decisive-read gate without typing or sending", async () => {
  // Canned facts: a structurally normal authenticated surface whose
  // composer VALUE probe is ambiguous (value: null). The preparation
  // is idempotently established (already active/selected — zero
  // clicks), then ensurePrompt requires a DECISIVE read and fails
  // closed: null is never "" (cleared) and never the prompt.
  const tabs = [{ id: 7, url: "https://chat.z.ai/" }];
  const tabsApi = fakeMessagingTabsApi({ tabs });
  let types = 0;
  let sends = 0;
  const baseFacts = () => ({
    authButtons: { texts: ["New Chat", "Agent"] },
    composerVisible: { visible: true, count: 1 },
    composerEnabled: { enabled: true },
    composerValue: { value: null, ambiguous: true },
    sendVisible: { visible: true, count: 1 },
    sendEnabled: { enabled: false },
    alertVisible: { visible: false, count: 0 },
    stopCandidate0: { visible: false, count: 0 },
    stopCandidate1: { visible: false, count: 0 },
    alertText: { text: null },
    conversationCandidate0: { text: null },
    userMessageCandidate0: { texts: [] },
    userMessageCandidate1: { texts: [] },
    userMessageCandidate2: { texts: [] },
    composeControl0: { count: 1 },
    agentCandidate0: { count: 1 },
    agentActive0: { count: 1 },
    agentActive1: { count: 0 },
    agentActive2: { count: 0 },
    agentActive3: { count: 0 },
    modelTriggerCount0: { count: 1 },
    modelTriggerCount1: { count: 1 },
    modelTriggerText0: { text: "GLM-5.3" },
    modelTriggerText1: { text: "GLM-5.3" },
    modelTriggerSelectedId: { count: 1 },
  });
  const bridge = {
    send: async (_tabId, command) => {
      if (command.op === "probe") {
        return { ok: true, facts: baseFacts() };
      }
      if (command.op === "type") {
        types += 1;
        return { ok: true, typed: true, value: command.text };
      }
      if (command.op === "click" && command.selector === "#send-message-button") {
        sends += 1;
        return { ok: true, clicked: true };
      }
      return { ok: true, clicked: true };
    },
  };
  const adapter = createZaiAdapter({ tabsApi, pageBridge: bridge, sleep: async () => {}, settlePolls: 2, settleIntervalMs: 0 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/could not be read decisively/.test(result.error.message));
  assert.equal(types, 0); // never typed into an unreadable input state
  assert.equal(sends, 0); // never sent
});

test("a Start whose exact prompt is ALREADY in the message evidence with a decisively-empty composer never resends (no duplicate submission)", async () => {
  // Requirement 5 (PR #6 review 5123047551): when the provider state
  // shows the prompt already landed (message rows carry the exact
  // prompt, composer decisively empty — e.g. the in-memory registry
  // was lost on service-worker restart after a landed submission),
  // the re-run Start re-establishes the idempotent preparation and
  // re-reports the submission WITHOUT typing or sending again. The
  // SAME result shape (attempts=1, generation=waiting) is now
  // reachable ONLY through genuine message evidence — contrast the
  // weak-surface variant above, which types and sends.
  const { adapter, pages } = build({ conversation: [PROMPT] });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.composeReestablishments, 0);
  assert.equal(result.submitted.generation, "waiting");
  const history = pages[0].history().filter((c) => c.op !== "probe");
  assert.deepEqual(history.map((c) => c.op), ["click", "click", "click"]); // preparation only
  assert.equal(history.filter((c) => c.op === "type").length, 0);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // never duplicated
});

// --------------------------------------------------------------------
// Identity preservation and idempotence.
// --------------------------------------------------------------------

test("starting the same correlation again re-reports idempotently without a second submission", async () => {
  const { adapter, pages } = build({ generationCompletes: 1 });
  const first = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(first.ok, true);
  const sendsBefore = pages[0].history().filter((c) => c.op === "type").length;
  const second = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyActive, true);
  assert.deepEqual(second.session, first.session);
  assert.equal(pages[0].history().filter((c) => c.op === "type").length, sendsBefore);
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
});

test("a different work item for the same worker is a contradictory session reference", async () => {
  const { adapter } = build({ generationCompletes: 1 });
  await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-999", prompt: "other" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/contradictory/.test(result.error.message));
});

test("a registry entry whose correlated tab has closed fails the correlated Start closed (STALE_REFERENCE, never alreadyActive)", async () => {
  // Regression (Architect review, finding 2): a stale correlated
  // reference must NEVER be returned as a successful Start. The
  // registry entry survives, the tab does not — the same-correlation
  // Start must fail closed with the typed stale-reference failure,
  // with no ok:true / alreadyActive / session result of any kind.
  const { adapter, tabsApi } = build({ generationCompletes: 1 });
  const first = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(first.ok, true);
  tabsApi._tabs.length = 0; // the correlated browser-session tab closes
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.alreadyActive, undefined);
  assert.equal(result.session, undefined);
  assert.equal(result.error.code, "STALE_REFERENCE");
  assert.ok(/gone/.test(result.error.message));
});

test("a registry entry whose tab navigated away from the provider origin fails the correlated Start closed (STALE_REFERENCE)", async () => {
  // The tab still exists but is no longer a chat.z.ai session: the
  // correlation is stale exactly the same way.
  const { adapter, tabsApi } = build({ generationCompletes: 1 });
  const first = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(first.ok, true);
  tabsApi._tabs[0].url = "https://example.com/"; // navigated away mid-session
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.alreadyActive, undefined);
  assert.equal(result.session, undefined);
  assert.equal(result.error.code, "STALE_REFERENCE");
  assert.ok(/no longer a/.test(result.error.message));
});

// --------------------------------------------------------------------
// The governed hung-worker recovery.
// --------------------------------------------------------------------

async function hungSession(options = {}) {
  // CONTINUATION 14: the generation's COMPLETION opens the
  // Send-reappearance boundary at which the Start's acceptance is
  // recorded (the fixture's default successful send renders the Stop
  // control immediately — the generation-in-flight surface — so the
  // Start needs the completion transition for the boundary). The
  // hung state is then re-armed by the caller-facing line below.
  const built = build({ generationCompletes: 1, ...options });
  const started = await built.adapter.startWorkerSession({
    worker: "w1",
    workItem: "CTRL-014",
    prompt: PROMPT,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  // The hung state: generation in progress (Stop visible).
  built.pages[0].state.stop.visible = true;
  return built;
}

test("hung-worker recovery performs Stop -> verified stopped -> fixed continue -> verified acceptance", async () => {
  const { adapter, pages } = await hungSession();
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.message, "continue");
  assert.equal(result.recovered.acceptance, "conversation-evidence");
  assert.equal(result.recovered.generation, "working");
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  // The acceptance evidence: the exact recovery wording landed in
  // the conversation — never an alternative, never merely a resumed
  // generation state.
  assert.ok(pages[0].state.conversation.includes("continue"));
  const history = pages[0].history().slice(-4).filter((c) => c.op !== "probe");
  const types = history.filter((c) => c.op === "type");
  assert.equal(types.length, 1);
  assert.equal(types[0].text, "continue");
});

test("recovery where generation resumes and the composer clears but 'continue' never lands fails closed", async () => {
  // Regression (Architect review, finding 3): the provider state
  // after the recovery send looks healthy — the Stop control
  // returns (generation resumed) and the composer is cleared — but
  // the exact fixed message never lands in the conversation
  // evidence. A resumed generation state is NOT acceptance: the
  // recovery must fail closed without ever claiming recovery.
  const built = await hungSession({
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button" && state.composerValue === "continue") {
        state.__sentRecovery = true;
      }
      if (message.op === "probe" && state.__sentRecovery) {
        state.__sentRecovery = false;
        // The provider dropped the recovery message from the
        // conversation surface: it never landed as a user message
        // even though generation resumed and the composer cleared.
        if (state.conversation[state.conversation.length - 1] === "continue") {
          state.conversation.pop();
        }
      }
    },
  });
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/not confirmed/.test(result.error.message));
  assert.ok(/resumed generation state is not acceptance/.test(result.error.message));
  // The exact fixed message never landed in the conversation evidence.
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
  // Bounded: the fixed message was submitted at most the recovery
  // attempt budget times (2 by default).
  const recoveriesTyped = built.pages[0].history().filter((c) => c.op === "type" && c.text === "continue").length;
  assert.ok(recoveriesTyped <= 2, `expected at most 2 recovery submissions, saw ${recoveriesTyped}`);
});

test("recovery of an unknown session fails closed SESSION_UNKNOWN", async () => {
  const { adapter } = build();
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SESSION_UNKNOWN");
});

test("a wrong tab correlation is a stale reference", async () => {
  const { adapter } = await hungSession();
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 999 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_REFERENCE");
});

test("a wrong work-item correlation is a contradictory reference", async () => {
  const { adapter } = await hungSession();
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-999", tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "STALE_REFERENCE");
});

test("recovery without generation in progress does not press Stop (precondition fail-closed)", async () => {
  const { adapter, pages } = await hungSession();
  pages[0].state.stop.visible = false; // not hung after all
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/hung precondition/.test(result.error.message));
});

test("authentication dropping during recovery fails closed AUTHENTICATION_INTERRUPTED", async () => {
  const { adapter, pages } = await hungSession();
  pages[0].state.authenticated = false;
  pages[0].state.agent.present = false;
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHENTICATION_INTERRUPTED");
});

test("a provider dialog visible throughout hung recovery NEVER blocks the governed sequence and never receives Enter (the recovery depends only on the Stop control state)", async () => {
  // CONTINUATION 13 (PR #6 review 5124488246, requirement 6): "For
  // hung recovery, make the adapter depend only on the actual Stop
  // control state and the frozen sequence... A dialog being present
  // must not itself trigger UNKNOWN_DIALOG in this flow." A dialog
  // sits on the surface for the WHOLE recovery: the precondition
  // settles on the Stop control, the adapter owns the Stop click,
  // verifies the stop, types the exact `continue`, sends, and accepts
  // on the message-exclusive evidence — zero Enter presses, zero
  // dialog consultations, and the dialog is still present at the
  // end. The pre-correction adapter failed closed UNKNOWN_DIALOG
  // here; re-adding that fails this regression.
  const built = await hungSession();
  built.pages[0].state.dialog = { text: "Some modal" };
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.message, "continue");
  assert.equal(result.recovered.acceptance, "conversation-evidence"); // the frozen acceptance
  assert.ok(built.pages[0].state.conversation.includes("continue"));
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // never an Enter
  assert.ok(built.pages[0].state.dialog); // the dialog was never consulted, never dismissed
});

test("recovery whose stop never verifies exhausts the bounded budget", async () => {
  // The Stop click "succeeds" but generation never actually stops:
  // every later probe re-observes the Stop control still visible.
  const built = await hungSession({
    beforeRespond: (message, state) => {
      if (state.__stopBroken && message.op === "probe") {
        state.stop.visible = true; // generation did not actually stop
      }
    },
  });
  built.pages[0].state.__stopBroken = true;
  built.pages[0].state.stop.visible = true;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false);
  assert.ok(["AMBIGUOUS_STATE", "RETRY_EXHAUSTED"].includes(result.error.code));
  // The fixed recovery message was never submitted (Stop never verified).
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
});

// --------------------------------------------------------------------
// The CONTINUATION-11 regressions (PR #6 comment 5557087907: reconcile
// the live hung-worker recovery against the real Z.ai stop/regenerate
// UI — the operator's manually-stopped run, the Stop control's two
// computed label states, and the Regenerate control's context-only
// semantics).
// --------------------------------------------------------------------

test("the operator's literal manual-Stop state fails closed with the post-response diagnostic (the Regenerate control is never automated)", async () => {
  // The operator's live run (PR #6 comment 5557087907) manually clicked
  // the provider Stop control BEFORE invoking the recovery: the
  // post-stopped surface (the send control back, the composer enabled,
  // the Regenerate control visible on the stopped response) carries NO
  // Stop control, so the adapter-owned precondition fails closed —
  // exactly the observed AMBIGUOUS_STATE. The manual Stop is the WRONG
  // operator procedure (the frozen contract is adapter-owned
  // Stop -> verified stopped -> exact continue -> verified conversation
  // evidence; the recovery must be invoked while generation is
  // genuinely active). The refusal now NAMES the post-response
  // observables (the Regenerate control visible + the composer
  // enabled) and the wrong procedure, so the ambiguity that produced
  // the failed run cannot recur silently — and the Regenerate control
  // is never clicked as a remedy.
  const built = await hungSession();
  // The manually-stopped surface: generation already stopped externally.
  built.pages[0].state.stop.visible = false;
  built.pages[0].state.regenerate.visible = true;
  const historyBeforeRecovery = built.pages[0].history().length;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/hung precondition/.test(result.error.message));
  assert.ok(/post-response state is observed/.test(result.error.message));
  assert.ok(/Regenerate control is visible/.test(result.error.message));
  assert.ok(/wrong procedure/.test(result.error.message));
  // Zero automation: no click ever issued (no Stop press, no Regenerate
  // click, no send), nothing typed, no Enter — the refusal is purely
  // observational.
  const ops = built.pages[0]
    .history()
    .slice(historyBeforeRecovery)
    .filter((c) => c.op !== "probe");
  assert.equal(ops.length, 0, JSON.stringify(ops));
  assert.ok(!built.pages[0].state.regenerate.clicked, "the Regenerate control must never be clicked");
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
});

test("the Stop control carrying the long-task tooltip label still resolves and clicks (the provider's computed label variant)", async () => {
  // The provider's own bundle computes the Stop tooltip content as
  // "Stop" OR "The current task is in progress. Please cancel it
  // before starting other tasks." — the SAME control in two label
  // states (the wrapper's aria-label switches). The wrapper-derived
  // locator resolves the inner button through BOTH labels, so the
  // frozen recovery still performs Stop -> verified stopped -> exact
  // continue -> verified acceptance while a long task runs — the
  // pre-correction button[aria-label="Stop"] candidates matched ZERO
  // elements on the wrapper-div surface in either state.
  const built = await hungSession();
  built.pages[0].state.stopLongTask = true;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.message, "continue");
  assert.equal(result.recovered.acceptance, "conversation-evidence");
  assert.ok(built.pages[0].state.conversation.includes("continue"));
  // The adapter's own Stop happened through the long-task-labeled
  // candidate (the real post-stop surface rendered: the Regenerate
  // control became visible — context only, never clicked).
  assert.equal(built.pages[0].state.regenerate.visible, true);
  assert.ok(!built.pages[0].state.regenerate.clicked, "the Regenerate control must never be clicked");
});

test("a Regenerate control appearing after the adapter's own Stop is context only — never acceptance", async () => {
  // Requirement 4 (PR #6 comment 5557087907): "Generation resuming, a
  // cleared composer, or a Regenerate button appearing are context
  // only and never acceptance by themselves." After the adapter's own
  // verified Stop, the fixture renders the REAL post-stop surface (the
  // stopped response's Regenerate control visible, the send control
  // back) — and this recovery's `continue` NEVER lands in the
  // conversation evidence, so the recovery must fail closed despite
  // the healthy-looking post-response context, with the Regenerate
  // control never clicked as a remedy.
  const built = await hungSession({
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button" && state.composerValue === "continue") {
        state.__sentRecovery = true;
      }
      if (message.op === "probe" && state.__sentRecovery) {
        state.__sentRecovery = false;
        // The provider dropped the recovery message from the
        // conversation surface: it never landed as a user message even
        // though the post-response context looks healthy.
        if (state.conversation[state.conversation.length - 1] === "continue") {
          state.conversation.pop();
        }
      }
    },
  });
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/not confirmed/.test(result.error.message));
  // The adapter's own Stop happened (the real post-stop surface
  // rendered: the Regenerate control became visible) ...
  assert.equal(built.pages[0].state.regenerate.visible, true);
  // ... but the Regenerate control was never clicked as a remedy, and
  // the exact fixed message never landed.
  assert.ok(!built.pages[0].state.regenerate.clicked, "the Regenerate control must never be clicked");
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
});

// --------------------------------------------------------------------
// Session-aware observations after submission.
// --------------------------------------------------------------------

test("a submitted session observes prompt-submitted while generating", async () => {
  const { adapter, pages } = await hungSession();
  void pages;
  const result = await adapter.observeSession("w1");
  assert.equal(result.ok, true);
  assert.equal(result.observation.state, "prompt-submitted");
});

test("a submitted prompt still sitting in the composer observes prompt-unconfirmed", async () => {
  const built = build({ generates: false });
  const started = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(started.ok, true);
  // The session's prompt is in the conversation evidence AND back in
  // the composer un-submitted (a failed retry re-entered it).
  built.pages[0].state.composerValue = PROMPT;
  const result = await built.adapter.observeSession("w1");
  assert.equal(result.observation.state, "prompt-unconfirmed");
});

// --------------------------------------------------------------------
// The CONTINUATION-12 regressions (PR #6 comment 5557322324 — the
// composer control-state transition as an explicit submission-state
// observation channel): the provider's own bundle computes the send
// control's disabled state from the composer text and swaps the
// composer action slot between the send control and the Stop control
// on the current-message-done conditional, so the control state is an
// independent provider-computed reading of the submission state. The
// channel's laws, regression-pinned: a disabled send control with no
// prompt is never submission; an enabled send control with the exact
// prompt is preparatory only; the Stop replacement is generation-in-
// progress context (never acceptance); the async popup after the
// optimistic landing is still caught — including while the generation
// appears active; the popup's prompt restoration never duplicates a
// confirmed submission; a contradictory or unreadable control state
// fails closed; the recovery's acceptance stays message-exclusive.
// Plus the requirement-8 diagnosis: the recovery invoked immediately
// after a Start whose recording read shows generation:"waiting" now
// WAITS (bounded) for the Stop-visible interval to open instead of
// failing on the first non-ambiguous read.
// --------------------------------------------------------------------

test("the control-state channel is part of every observation: a decisively DISABLED send control with a decisively empty composer and no message row is NEVER submission evidence", async () => {
  // Requirement 7, bullet 1. The provider's own computed no-prompt
  // state (the send control disabled, the composer decisively empty —
  // the bundle's disabled computation) is an OBSERVATION, never
  // submission evidence: a surface whose message row never lands
  // fails closed within the bounded budget, and the sendEnabled fact
  // is requested on every fact read (the channel is part of the
  // closed probe vocabulary). Pre-correction, the operator's literal
  // waiting-shaped run (empty composer, disabled send, no row)
  // produced a live false positive — never again.
  const swallowed = build({
    generates: false, // no generation ever starts
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        // The adversarial surface: the message row never lands (the
        // send discards the prompt from the evidence surface while
        // the composer reads decisively empty and the send control
        // stays decisively disabled).
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
      }
    },
  });
  const result = await swallowed.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(["PAGE_MALFORMED", "RETRY_EXHAUSTED"].includes(result.error.code));
  // The control-state channel was observed on every fact read.
  const probes = swallowed.pages[0].history().filter((c) => c.op === "probe");
  assert.ok(probes.length > 0);
  assert.ok(
    probes.every((c) => c.probes.some((p) => p.name === "sendEnabled" && p.selector === "#send-message-button" && p.mode === "enabled")),
    "every fact read carries the sendEnabled probe (the control-state channel)"
  );
  // The provider's own computed no-prompt state held throughout: the
  // send control decisively disabled with the decisively empty
  // composer — and it was never treated as submission.
  assert.equal(swallowed.pages[0].state.composerValue, "");
  assert.ok(!("submitted" in (result ?? {})));
});

test("an ENABLED send control with the exact prompt present is PREPARATORY ONLY — the control state alone never confirms a submission", async () => {
  // Requirement 7, bullet 2. The provider computes the send control
  // ENABLED exactly while a prompt is present in the composer (the
  // bundle's disabled computation) — that is the preparatory state,
  // never submission evidence. Here every send click "succeeds" but
  // the submission never takes (the composer keeps holding the exact
  // prompt, the conversation never grows): the adapter reports
  // unconfirmed, restarts the bounded preparation, and fails closed
  // WITHOUT ever claiming submission — the enabled control state was
  // observed throughout and never became acceptance.
  const suppress = build({
    generates: false, // CONTINUATION 14: nothing ever generates — the surface stays "send"-controlled
    beforeRespond: (message, state) => {
      if (message.op === "type") {
        state.__typed = message.text;
      }
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__blocked = true;
      }
      if (message.op === "probe" && state.__blocked) {
        state.composerValue = state.__typed; // the send did not take
        state.conversation = state.conversation.filter((t) => t !== PROMPT); // CONTINUATION 14: the conversation never grows (the stated semantics, modeled faithfully)
      }
    },
  });
  const result = await suppress.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not confirmed by observation/.test(result.error.message));
  // The preparatory control state (the send control computed ENABLED
  // with the exact prompt in the composer) held on every post-typing
  // read — and never produced a submitted record.
  const lastGate = suppress.pages[0].history().filter((c) => c.op === "probe").at(-1);
  assert.ok(lastGate.probes.some((p) => p.name === "sendEnabled"));
  assert.equal(result.submitted, undefined);
});

test("the Stop control replacing the send control is generation-in-progress CONTEXT — the acceptance is recorded ONLY at the Send-reappearance boundary, never while the Stop control is visible (the completion swap back opens the boundary)", async () => {
  // CONTINUATION 14 (PR #6 review 5124542353, the review's gap 1):
  // the continuation-12 law — "a 'stop' reading is an acceptable
  // recording state" — is REVERSED. The provider's slot swap
  // send -> Stop is the "a current message is in flight"
  // computation; while it persists the bounded Send-reappearance
  // wait KEEPS WAITING (the transient missing Send control is not an
  // error) and the budget's exhaustion fails closed with the typed
  // mid-generation diagnosis: the submission (the row) may be
  // CONFIRMED, but the acceptance is recorded only after the Send
  // control REAPPEARS, and the confirmed submission is NEVER resent
  // by the retries (the ensurePrompt already-confirmed path
  // re-observes only — the bounded budget ends in the typed refusal,
  // one send in the whole history). The completion transition (the
  // Stop control disappears, the send control returns, the
  // Regenerate control renders) is the boundary: the acceptance is
  // recorded there with the observed context (generation:"waiting" —
  // the boundary read).
  const { adapter, pages } = build(); // generates: true — the Stop control appears on the send and never completes
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/Stop control remains visible/.test(result.error.message));
  assert.ok(/NEVER resent/.test(result.error.message));
  // The submission landed ONCE (the row) and was never duplicated by
  // the bounded retries — the already-confirmed path re-observes only.
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
  // The single send click of the whole run.
  assert.equal(pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);

  // (b) The completion transition on the boundary read itself: the
  // current message completes — the slot swaps back to the send
  // control and the Regenerate control renders (the REAL
  // post-response surface). The acceptance is recorded from the
  // frozen evidence AT THE BOUNDARY; the completion is context.
  // (A completion arriving AFTER the boundary read is equally
  // context — unobserved, exactly like the beyond-window async
  // outcome; the recorded generation simply reports the read.)
  const completing = build({ generationCompletes: 1 });
  const completed = await completing.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(completed.submitted.generation, "waiting"); // the boundary read — the Stop control gone, the send control back
  assert.equal(completing.pages[0].state.regenerate.visible, true); // the real post-response surface rendered
  assert.ok(!completing.pages[0].state.regenerate.clicked); // the Regenerate control is never automated
  assert.ok(completing.pages[0].state.conversation.includes(PROMPT));
});

test("the provider's prompt-restore computed on the send control (ENABLED) while the composer read degrades is caught by the control-state channel — the acceptance is never recorded from an untrustworthy composer read", async () => {
  // Requirement 6's race, closed by the control-state consistency
  // gate: the MODEL_CONCURRENCY_LIMIT handler restores the prompt
  // into the composer AND recomputes the send control ENABLED in the
  // same reactive update — but the raw #chat-input value read can
  // lag or degrade across the restore transition (the handler
  // focuses and resizes the textarea). A degraded composer read
  // would otherwise let the acceptance record over a surface the
  // provider itself said held a prompt — a false acceptance. The
  // recording gate fails closed on the unreadable composer: the
  // submission is never confirmed from a read the control state
  // contradicts.
  const lagging = build({
    generates: false,
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__sent = true;
      }
      if (message.op === "probe" && state.__sent) {
        state.__sent = false;
        // The restore transition lands ON the verification reads: the
        // prompt is back in the composer (the provider computes the
        // send control ENABLED) while the #chat-input read degrades
        // to an ambiguous null.
        state.composerValue = PROMPT;
        state.duplicateComposer = true;
      }
    },
  });
  const result = await lagging.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE"); // fail closed — never a quiet acceptance
  assert.ok(/could not be read decisively|untrustworthy|contradict/.test(result.error.message));
  // The governed prompt was never resent over the untrustworthy read.
  const sends = lagging.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 1);
});

test("a CONTRADICTORY composer action slot (both the send control and the Stop control visible) fails closed — the acceptance is never recorded from a malformed control state", async () => {
  // Requirement 7, bullet 6 (the both-slots contradiction). The
  // provider's action slot renders exactly one control; a surface
  // rendering BOTH is malformed/unreadable. Pre-correction, the
  // budget-exhausted hold recorded the acceptance from whatever the
  // quiet read carried — including this contradiction. The corrected
  // recording gate refuses: AMBIGUOUS_STATE, zero Enters, and the
  // already-confirmed submission is never resent on the retry (the
  // bounded re-observation exhausts and fails closed).
  const stuck = build({ sendSlotStuck: true });
  const result = await stuck.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/contradictory/.test(result.error.message));
  assert.ok(/both the send control and the Stop control/.test(result.error.message));
  assert.equal(stuck.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  const sends = stuck.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 1); // the initial send only — the confirmed submission is never resent
});

test("the send control computed ENABLED while the composer reads decisively EMPTY is the contradictory surface — the acceptance recording fails closed before any recovery path", async () => {
  // Requirement 7, bullet 6 (the enabled-vs-composer contradiction).
  // The provider's own prompt-present computation (send ENABLED)
  // contradicting the decisively-empty composer read means the
  // composer read is untrustworthy. The recording gate refuses the
  // acceptance on EVERY bounded attempt (the confirmed-branch
  // re-observes and re-refuses) — the compose re-establishment is
  // never invoked on an untrustworthy read, and no acceptance is
  // recorded. CONTINUATION 13: with the async-outcome hold removed,
  // this contradiction is caught directly on the verification-read
  // facts through recordSubmission's control-state gate.
  const lying = build({ generates: false, sendEnabledLie: true });
  const result = await lying.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/contradicts the composer read/.test(result.error.message));
  assert.ok(/untrustworthy/.test(result.error.message));
  // Zero recovery automation on the contradictory surface: no Enter,
  // and no compose-control click after the send.
  const ops = lying.pages[0].history().filter((c) => c.op !== "probe");
  const postSend = [];
  let sent = false;
  for (const op of ops) {
    if (op.op === "click" && op.selector === "#send-message-button") {
      sent = true;
      continue;
    }
    if (sent) {
      postSend.push(op);
    }
  }
  assert.deepEqual(postSend.map((c) => c.op), []); // nothing after the send — the refusal is purely observational
});

test("an AMBIGUOUS send-control resolution (two send controls) on the verification facts fails closed — the acceptance is never recorded from an unreadable control state", async () => {
  // Requirement 7, bullet 6 (the unreadable control state). The
  // enabled probe degrades to an ambiguous null when the send
  // selector resolves to zero-or-many visible elements; a surface
  // that renders TWO send controls after the send is unreadable.
  // The recording gate refuses on every bounded attempt. CONTINUATION
  // 13: with the async-outcome hold removed, the contradiction is
  // caught directly on the verification-read facts.
  const doubled = build({
    generates: false,
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__doubled = true;
      }
      if (message.op === "probe" && state.__doubled) {
        state.duplicateSend = true; // the surface now renders two send controls
      }
    },
  });
  const result = await doubled.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/enabled state could not be read decisively/.test(result.error.message));
  assert.equal(doubled.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
});

test("the operator's literal timing: the recovery invoked immediately after a Start whose recording read shows generation:\"waiting\" now WAITS (bounded) for the Stop-visible interval to open — the frozen recovery then succeeds", async () => {
  // Requirement 8's diagnosis, corrected behavior. Start returns when
  // the submission is CONFIRMED, which can precede the generation
  // becoming ACTIVE (the provider's queued state — the send control
  // rendered, no Stop yet, exactly the generation:"waiting" recording
  // read). Pre-correction, the recovery's precondition settle treated
  // the FIRST non-ambiguous classification as decisive: a
  // ready-for-input/prompt-submitted reading without Stop resolved
  // immediately and the refusal fired before the Stop-visible
  // interval could open — the operator's repeated AMBIGUOUS_STATE.
  // The corrected precondition WAITS within the bounded settle budget
  // for the interval to open; here the Stop control appears on the
  // 2nd fact read after the recovery is invoked, and the FULL frozen
  // sequence then runs: adapter-owned Stop -> verified stopped ->
  // exact "continue" -> message-exclusive conversation-evidence
  // acceptance.
  // CONTINUATION 14: generationCompletes: null overrides the helper default — the
  // queued-surface model needs NO completion transition (the Stop interval must stay
  // open for the recovery to find it).
  const built = await hungSession({ generates: false, generationCompletes: null });
  built.pages[0].state.stop.visible = false; // the queued state — the generation is NOT yet active (no Stop control)
  built.pages[0].state.pendingStop = 2; // the generation becomes active on the 2nd fact read
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.message, "continue");
  assert.equal(result.recovered.acceptance, "conversation-evidence"); // STILL the message-exclusive acceptance
  assert.ok(built.pages[0].state.conversation.includes("continue"));
  // The adapter owned the Stop action (the post-stop surface rendered).
  assert.equal(built.pages[0].state.regenerate.visible, true);
  assert.ok(!built.pages[0].state.regenerate.clicked);
});

test("the queued state that never becomes active within the bounded wait fails closed with the control-state diagnosis (the generation:\"waiting\" guidance), never a blind Stop press", async () => {
  // Requirement 8's exhaustion branch. The generation never becomes
  // active within the bounded precondition wait: the refusal names
  // the control-state reading (the send control decisively DISABLED
  // with a decisively empty composer — the provider's own computed
  // no-prompt state) and the operator guidance (a generation:"
  // "waiting" Start records a confirmed submission whose generation
  // start can lag; invoke while the Stop control is visibly present).
  const built = await hungSession({ generates: false });
  built.pages[0].state.stop.visible = false; // the queued state persists — the Stop interval never opens
  const historyBefore = built.pages[0].history().length;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/hung precondition/.test(result.error.message));
  assert.ok(/decisively DISABLED/.test(result.error.message));
  assert.ok(/generation start can lag/.test(result.error.message));
  // Zero automation: the refusal is purely observational.
  const ops = built.pages[0].history().slice(historyBefore).filter((c) => c.op !== "probe");
  assert.equal(ops.length, 0, JSON.stringify(ops));
});

test("a restored prompt sitting in the composer (no Stop control) refuses the recovery with the re-Start guidance — there is no active generation to recover", async () => {
  // Requirement 8's prompt-present branch. The provider returned the
  // session prompt into the composer (the async error's restore —
  // the submission was invalidated): the composer holds text, the
  // send control is rendered, no Stop control is visible. There is
  // nothing to recover — the refusal says so and points at the
  // governed remedy (re-Start the worker session).
  const built = await hungSession({ generates: false });
  built.pages[0].state.composerValue = PROMPT; // the restored prompt — the submission was invalidated
  built.pages[0].state.stop.visible = false;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/hung precondition/.test(result.error.message));
  assert.ok(/composer holds text/.test(result.error.message));
  assert.ok(/re-Start the worker session/.test(result.error.message));
  assert.ok(!built.pages[0].state.conversation.includes("continue")); // nothing was sent
});

// --------------------------------------------------------------------
// The CONTINUATION-14 regressions (PR #6 review 5124542353 / the
// ARCHITECT work order 5557596159 — "REPLACE POPUP DETECTION WITH
// SEND-CONTROL STATE MACHINE"): the composer action-slot state is the
// primary execution state machine. The laws, regression-pinned: the
// Send control disappears (the Stop replacement while the generation
// is in flight) and reappears on completion — the acceptance recorded
// at the reappearance boundary; the Send control reappearing without
// the exact user-message evidence routes the contract's unsuccessful
// branch (the bounded exact-prompt re-establishment/resend); an
// INACCESSIBLE Send control triggers the Enter fallback exactly once
// per attempt (the existing page primitive, never popup handling,
// zero dialog inspection) with the state machine continuing through
// the re-observation; a Send control that never becomes resolvable
// fails closed after the bounded retry budget; the click itself
// failing routes the same fallback; and the recovery's continue-send
// uses the same control-state rule.
// --------------------------------------------------------------------

test("the Send-control state machine: the send control DISAPPEARS (the Stop control replacing it while the generation is in flight) and REAPPEARS on completion — the acceptance is recorded at the reappearance boundary", async () => {
  // The work order's requirement 3, the full machine: press Send ->
  // the action slot swaps to the Stop control (the Send control
  // ABSENT — the transient missing Send the wait tolerates, never an
  // error) -> the generation completes -> the slot swaps back to the
  // send control (the REAPPEARANCE) -> the resulting provider state
  // is inspected and the acceptance recorded (the exact prompt in the
  // message-exclusive evidence with the composer decisively empty).
  // Here the completion lands on the 2nd fact read with the Stop
  // control visible: the wait's first read observes the Stop state
  // (not decisive — keep waiting), and the second read observes the
  // boundary. The pre-correction adapter recorded from the FIRST
  // confirm-shaped reading (while the Stop control was still
  // visible); the corrected state machine records only at the
  // boundary.
  const built = build({ generationCompletes: 2 });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.generation, "waiting"); // the boundary read — the send control back
  assert.equal(result.submitted.composeReestablishments, 0);
  // The completion transition rendered the real post-response surface
  // (the Stop control gone, the Regenerate control visible) — the
  // disappearance/reappearance machine ran in full.
  assert.equal(built.pages[0].state.regenerate.visible, true);
  assert.equal(built.pages[0].state.stop.visible, false);
  assert.ok(built.pages[0].state.conversation.includes(PROMPT));
  // No Enter in the ordinary machine: the send control was resolvable
  // at the send step and the click succeeded.
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
});

test("the Send control INACCESSIBLE at the send step: the Enter fallback fires exactly once, submits the verified prompt, and the state machine continues to the boundary acceptance — zero send clicks", async () => {
  // The work order's requirement 5: "when the adapter cannot
  // resolve/access the Send control decisively, issue the existing
  // Enter primitive exactly once for that retry, then re-observe the
  // Send control. If Send becomes resolvable, continue the normal
  // state machine." The `sendInaccessible` knob models the slot
  // rendering NEITHER control; the hook disarms it on the Enter (the
  // provider's slot re-render — the Send control becomes resolvable
  // again). The pre-send gate verified the exact prompt decisively
  // present, so the focused composer's Enter submits it; the
  // Send-reappearance wait then finds the boundary and records the
  // acceptance. The pre-correction adapter had NO fallback: the send
  // click failed on the zero-match resolution and the bounded budget
  // exhausted — this regression differentiates them.
  const built = build({
    generates: false,
    sendInaccessible: true,
    beforeRespond: (message, state) => {
      if (message.op === "pressEnter") {
        state.sendInaccessible = false; // the keypress re-rendered the slot — the Send control returns
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  // The Enter fallback: EXACTLY ONE pressEnter in the whole run.
  const enters = built.pages[0].history().filter((c) => c.op === "pressEnter");
  assert.equal(enters.length, 1);
  // The Send control was never clicked — it never resolved at the
  // send step (the fallback is the ONLY path).
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  // The Enter submitted the verified prompt: the exact row landed
  // exactly once (the message-exclusive acceptance).
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
  assert.equal(result.submitted.generation, "waiting");
});

test("the send click itself failing (the slot re-rendering TWO send controls — an ambiguous click target): the Enter fallback fires once and the full state machine succeeds", async () => {
  // The second inaccessible variant: the gate facts resolve the Send
  // control (the click is attempted), but the surface re-renders TWO
  // send controls so the click REFUSES (the page script's
  // exactly-one rule — never a best-effort click). The fallback fires
  // (the Enter submits the verified prompt), the keypress re-render
  // resolves the slot again, and the Send-reappearance boundary
  // records the acceptance.
  const built = build({
    generationCompletes: 1,
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.duplicateSend = true; // the surface re-rendered TWO send controls — the click will refuse
      }
      if (message.op === "pressEnter") {
        state.duplicateSend = false; // the keypress re-rendered the slot — the Send control resolves again
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  // The Enter fallback: exactly one pressEnter (the click failed, the
  // Enter replaced it for that attempt).
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 1);
  // The failed send click WAS attempted (one click command in the
  // history) — the refusal routed the fallback.
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  // The submission landed exactly once (the message-exclusive
  // acceptance at the boundary).
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
});

test("the Send control never becoming resolvable after the Enter fallback: the bounded retry budget fails closed with the typed unresolvable-slot diagnosis (the Enter issued exactly once — the already-confirmed retries never re-Enter)", async () => {
  // The work order's requirement 5, the exhaustion branch: "If not,
  // fail closed after the bounded retry budget." The
  // `sendInaccessible` knob PERSISTS — the slot never re-renders the
  // Send control. The Enter (exactly one, on the first attempt)
  // submits the verified prompt — the row lands — but the
  // Send-reappearance wait never observes a resolvable control and
  // the analysis refuses with the unresolvable-slot diagnosis. The
  // retries find the submission already confirmed (the evidence) and
  // re-observe through the already-confirmed path — never a second
  // Enter, never a resend — and the budget ends in the typed failure.
  const built = build({
    generates: false,
    sendInaccessible: true, // persists — the Send control never becomes resolvable
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/neither the send control nor the Stop control/.test(result.error.message));
  // The Enter was issued EXACTLY ONCE (the first attempt's fallback);
  // the already-confirmed retries never re-Enter.
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 1);
  // The Send control was never clicked.
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  // The Enter DID submit the verified prompt (the row landed) — but
  // no acceptance was ever claimed from the unresolvable surface.
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
  assert.ok(!("submitted" in result), "an unresolvable control state never produces a submitted record");
});

test("the recovery's continue-send with an INACCESSIBLE Send control: the Enter fallback fires exactly once, the fixed `continue` lands, and the acceptance is the conversation evidence", async () => {
  // The work order's requirement 7 — the hung recovery uses the SAME
  // control-state rule at its continue-send. After the adapter's own
  // verified Stop, the post-stop re-render leaves the slot rendering
  // NEITHER control (the hook arms `sendInaccessible` on the Stop
  // click): the read-back verifies the exact fixed `continue`
  // byte-identically, the send click is impossible, and the Enter
  // fallback submits it — the acceptance is the message-exclusive
  // evidence (the `continue` row + the decisively cleared composer).
  const built = await hungSession({
    generates: false,
    generationCompletes: null,
    beforeRespond: (message, state) => {
      if (message.op === "click" && String(message.selector).includes('aria-label="Stop"')) {
        state.sendInaccessible = true; // the post-stop re-render broke the slot — the Send control unresolvable at the continue-send
      }
    },
  });
  const historyBeforeRecovery = built.pages[0].history().length;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.message, "continue");
  assert.equal(result.recovered.acceptance, "conversation-evidence");
  assert.ok(built.pages[0].state.conversation.includes("continue"));
  // The Enter fallback fired exactly once in the recovery.
  const recoveryOps = built.pages[0].history().slice(historyBeforeRecovery).filter((c) => c.op !== "probe");
  assert.equal(recoveryOps.filter((c) => c.op === "pressEnter").length, 1);
  // The Send control was never clicked in the recovery (the read-back
  // control state was unresolvable — the fallback was the only path).
  assert.equal(recoveryOps.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
});
