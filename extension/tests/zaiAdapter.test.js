/**
 * Z.ai browser Worker adapter tests (CTRL-014) — the offline/injected
 * matrix over the deterministic page simulator: the governed
 * new-session sequence, submission confirmation-before-success (the
 * continuation-6 correction: the pre-send gate, MESSAGE-EXCLUSIVE
 * acceptance evidence, decisive composer reads, and the bounded
 * compose re-establishment — the operator-described circular
 * control), the bounded known-popup Enter recovery with full
 * preparation restart, unknown-dialog/auth-interrupt/budget
 * fail-closed behavior, the fixed Stop -> continue hung-worker
 * recovery (acceptance proven by conversation evidence — a resumed
 * generation state alone never succeeds), identity preservation, and
 * stale/contradictory reference refusal (including the stale
 * correlated Start fail-closed regression).
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
    confirmationHoldPolls: 4,
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

test("a visible unknown dialog observes unexpected-dialog (outside submission verification)", async () => {
  const { adapter } = build({ dialog: { text: "Some unprompted modal" } });
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "unexpected-dialog");
});

test("a visible auth-shaped dialog observes authentication-required", async () => {
  const { adapter } = build({ dialog: { text: "Please sign in to continue" } });
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "authentication-required");
});

test("a visible error-shaped dialog observes provider-error", async () => {
  const { adapter } = build({ dialog: { text: "Something went wrong. Rate limit reached." } });
  const result = await adapter.observeSession("w1");
  assert.equal(result.observation.state, "provider-error");
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
  const { adapter, pages } = build();
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.popupDismissals, 0);
  assert.equal(result.submitted.generation, "working");
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
  const { adapter, pages } = build({ sidebar: "collapsed" });
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
  const { adapter, pages } = build({ sidebar: "expanded" });
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
  const { adapter, pages } = build({ agent: { present: true, active: true } });
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
  const { adapter, pages } = build({ modelTriggerAria: false });
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
  const { adapter, pages } = build({ selectedValue: "glm-5.3" });
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

test("a dialog appearing between Agent selection and model selection fails closed UNKNOWN_DIALOG", async () => {
  // The popup Enter path is submission-only: any dialog that appears
  // during preparation (here: right after the Agent pill click) must
  // fail closed BEFORE the model menu is ever opened.
  const built = build({
    beforeRespond: (message, state) => {
      if (message.op === "click" && String(message.selector).includes("nth-of-type(2)")) {
        state.dialog = { text: "An unexpected modal" }; // appears after the Agent pill click
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  const triggerClicks = built.pages[0].history().filter(
    (c) => c.op === "click" && (c.selector === 'button[aria-label="Select a model"]' || c.selector === 'button[id^="model-selector-"][id$="-button"]')
  ).length;
  assert.equal(triggerClicks, 0); // the model menu was never opened
  assert.ok(built.pages[0].history().every((c) => c.op !== "type" && c.op !== "pressEnter"));
});

test("a send that never confirms submission retries within the budget, then fails closed", async () => {
  // The send click "succeeds" but the submission never takes: on every
  // later probe the composer still holds the exact prompt and the
  // conversation never grows — the adapter must report unconfirmed,
  // restart the bounded preparation, and finally fail closed WITHOUT
  // ever claiming submission.
  const suppress = build({
    beforeRespond: (message, state) => {
      if (message.op === "type") {
        state.__typed = message.text;
      }
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__blocked = true;
      }
      if (message.op === "probe" && state.__blocked) {
        state.composerValue = state.__typed; // the send did not take
      }
    },
  });
  const result = await suppress.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/not confirmed by observation/.test(result.error.message));
});

// --------------------------------------------------------------------
// The known submission-blocking popup recovery.
// --------------------------------------------------------------------

test("the known popup triggers one Enter, then the FULL PREPARATION RESTART and the resend of the exact prompt", async () => {
  const { adapter, pages } = build({
    popupOnSend: true,
    popupText: "Confirm your submission",
    beforeRespond: (message, state) => {
      if (message.op === "pressEnter") {
        state.popupOnSend = false; // dismissed for good on the first Enter
      }
    },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.popupDismissals, 1);
  // CONTINUATION 9 (PR #6 review 5123260890, requirement 3): Enter
  // exactly once, verify the dismissal, then RESTART THE FULL
  // PREPARATION SEQUENCE before the resend. The preparation steps
  // are idempotent: the restart RE-VERIFIES the Agent mode and the
  // GLM-5.3 selection (each already established — the re-selection
  // no-ops, so each control is still clicked EXACTLY ONCE), the
  // prompt still sits in the composer byte-identical (the popup
  // blocked the submission, so it is sent AS-IS with no re-type),
  // and the decisive submission acceptance follows. The popup
  // restart-regression below models the disturbed-surface case this
  // re-verification exists for.
  const history = pages[0].history();
  const clicks = history.filter((c) => c.op === "click").length;
  const types = history.filter((c) => c.op === "type").length;
  const enters = history.filter((c) => c.op === "pressEnter").length;
  const pillClicks = history.filter(
    (c) => c.op === "click" && c.selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"
  ).length;
  const triggerClicks = history.filter(
    (c) => c.op === "click" && c.selector === 'button[aria-label="Select a model"]'
  ).length;
  const optionClicks = history.filter(
    (c) => c.op === "click" && c.selector === 'button[aria-label="model-item"][data-value="glm-5.3"]'
  ).length;
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(pillClicks, 1); // the Agent pill clicked exactly once
  assert.equal(triggerClicks, 1); // the model trigger clicked exactly once
  assert.equal(optionClicks, 1); // the exact option clicked exactly once
  assert.equal(sends, 2); // the initial send + the resend
  assert.equal(clicks, 5); // pill + trigger + option + send + resend
  assert.equal(types, 1); // the exact prompt typed ONCE — resent, never re-typed
  assert.equal(enters, 1); // exactly one Enter per popup observation
});

test("a popup that never dismisses exhausts the bounded budget without pretending success", async () => {
  const { adapter, pages } = build({ popupOnSend: true, popupText: "Confirm submission" });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "RETRY_EXHAUSTED");
  // Bounded: with 3 attempts, at most 2 Enter presses (one per
  // restartable attempt; the final attempt fails without pressing).
  const enters = pages[0].history().filter((c) => c.op === "pressEnter").length;
  assert.ok(enters <= 2, `expected at most 2 Enter presses, saw ${enters}`);
  assert.ok(!pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
});

test("an auth-shaped popup during submission fails closed AUTHENTICATION_INTERRUPTED (no Enter)", async () => {
  const { adapter, pages } = build({ popupOnSend: true, popupText: "Please log in to submit" });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHENTICATION_INTERRUPTED");
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
});

test("an error-shaped popup during submission fails closed PROVIDER_ERROR (no Enter)", async () => {
  const { adapter, pages } = build({ popupOnSend: true, popupText: "Submission failed: rate limit" });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PROVIDER_ERROR");
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
});

test("a popup whose Enter reveals the submission already landed NEVER resends the governed prompt", async () => {
  // The popup blocked a send that had in fact already been accepted:
  // after the Enter dismissal the provider state shows the exact
  // prompt in the conversation with the composer cleared — that IS
  // the acceptance evidence, and a resend would duplicate the
  // governed prompt. Exactly one send, one type, one Enter.
  const { adapter, pages } = build({
    popupOnSend: true,
    popupText: "Confirm your submission",
    beforeRespond: (message, state) => {
      if (message.op === "pressEnter") {
        state.popupOnSend = false;
        state.conversation.push(state.composerValue); // the submission had already landed
        state.composerValue = "";
      }
    },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.popupDismissals, 1);
  const history = pages[0].history();
  assert.equal(history.filter((c) => c.op === "type").length, 1);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 1);
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // never duplicated
});

test("a popup that clears the composer re-types the exact prompt before the resend (byte-identical read-back first)", async () => {
  // The popup consumed the prompt (the composer no longer holds it
  // and it never reached the conversation): the resend path re-types
  // the exact prompt, re-verifies the byte-identical read-back, and
  // only then sends — never a blind resend of an empty composer.
  const { adapter, pages } = build({
    popupOnSend: true,
    popupText: "Confirm your submission",
    beforeRespond: (message, state) => {
      if (message.op === "pressEnter") {
        state.popupOnSend = false;
        state.composerValue = ""; // the popup swallowed the prompt
      }
    },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.popupDismissals, 1);
  const history = pages[0].history();
  assert.equal(history.filter((c) => c.op === "type").length, 2); // re-typed after the popup
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 2);
  assert.ok(pages[0].state.conversation.includes(PROMPT));
  // The re-typed prompt is byte-identical (the type op carries the exact text).
  const typeTexts = history.filter((c) => c.op === "type").map((c) => c.text);
  assert.deepEqual(typeTexts, [PROMPT, PROMPT]);
});

test("the REAL peak-hours modality: the popup arrives ASYNCHRONOUSLY after the confirm-shaped state — the hold catches it and the Enter path runs", async () => {
  // CONTINUATION 10 (PR #6 review 5123872434, requirement 5 — the
  // real failure mode): the provider's "Currently in peak hours"
  // capacity dialog (LIVE-OBSERVED in the operator's captured run,
  // main 5d14d90; the provider bundle's MODEL_CONCURRENCY_LIMIT
  // handler) materializes only when the ASYNC error arrives — AFTER
  // the prompt has optimistically landed (the exact user-message row
  // + the cleared composer) and AFTER the verification settle would
  // have closed its window. This is the operator's literal
  // continuation-10 run reproduced: pre-correction, Start returned
  // ok:true / attempts=1 / popupDismissals:0 while the popup was
  // visibly present (the Enter path was never REACHED — the
  // classification window closed before the popup existed). The
  // async-outcome hold re-opens the window: the popup is observed,
  // Enter is pressed exactly once, the dismissal is verified, the
  // FULL preparation restarts, and the landed row is the acceptance
  // (the already-confirmed submission is never resent).
  const { adapter, pages } = build({
    generates: false, // the capacity error means no generation started
    popupAfterSend: true, // materializes on the 2nd fact read after the send
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2); // the preparation restart after the dismissal
  assert.equal(result.submitted.popupDismissals, 1); // the Enter was actually issued
  assert.equal(result.submitted.generation, "waiting"); // the operator's literal surface shape
  const history = pages[0].history();
  const enters = history.filter((c) => c.op === "pressEnter").length;
  assert.equal(enters, 1); // exactly one Enter per observed popup
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 1); // the landed row IS the confirmation — never resent
  assert.equal(history.filter((c) => c.op === "type").length, 1); // typed exactly once
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // never duplicated
  assert.equal(pages[0].state.dialog, null); // the popup was actually dismissed
});

test("the peak-hours popup WITH the provider's prompt restore: the restored prompt is resent as-is after the dismissal and the restart, and the resend's own outcome is held", async () => {
  // The provider's error handler also RESTORES the submitted prompt
  // into the composer (bundle-proven): after the Enter dismissal and
  // the FULL preparation restart, the restored prompt is sent AS-IS
  // (never re-typed, never rewritten), and the resend's own
  // submission outcome passes through the same async-outcome hold
  // before acceptance.
  const { adapter, pages } = build({
    generates: false,
    popupAfterSend: { probes: 2, restore: true },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.popupDismissals, 1);
  const history = pages[0].history();
  assert.equal(history.filter((c) => c.op === "type").length, 1); // the restored prompt is sent AS-IS — never re-typed
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 2); // the initial send + the resend after the restart
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 1); // exactly one Enter
  assert.equal(pages[0].state.conversation.filter((t) => t === PROMPT).length, 2); // the optimistic row + the resent row
  assert.equal(pages[0].state.dialog, null); // the popup was actually dismissed
});

test("a popup that materializes BEYOND the bounded hold budget does not retroactively fail the recorded acceptance (the hold is bounded; live evidence decides popup recovery)", async () => {
  // The honest bound (the review's requirement 7): the hold watches a
  // bounded window; a popup whose asynchronous arrival exceeds it is
  // the operator's live-evidence matter — a run without an observed
  // popup can establish happy-path submission evidence but NOT
  // popup-recovery evidence, and the code never hangs waiting for a
  // popup that may never come. The popup then materializes on the
  // next observation — exactly the operator's post-run view.
  const { adapter, pages } = build({
    generates: false,
    popupAfterSend: { probes: 6 }, // the settle read (1) + the hold (4) pass first
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.popupDismissals, 0); // no popup was observed within the bounded window
  const observed = await adapter.observeSession("w1");
  assert.equal(observed.observation.state, "unexpected-dialog"); // the popup IS visibly present now
  assert.ok(pages[0].state.dialog); // the dialog materialized after the window
});

test("an auth-shaped dialog materializing during the hold fails closed AUTHENTICATION_INTERRUPTED (no Enter, no acceptance)", async () => {
  // The hold observes dialogs in the verifying-submission phase and
  // dispatches them through the SAME fail-closed classification: an
  // auth-shaped dialog NEVER receives the Enter action and the
  // acceptance is never recorded.
  const { adapter, pages } = build({
    generates: false,
    popupAfterSend: { probes: 2, text: "Please sign in to continue" },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AUTHENTICATION_INTERRUPTED");
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // auth dialogs NEVER receive Enter
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
  const swallowed = build({
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
  const composeClicks = history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length;
  assert.equal(composeClicks, 3);
});

test("a dialog during preparation (before any send) fails closed UNKNOWN_DIALOG", async () => {
  const { adapter, pages } = build({ dialog: { text: "An unexpected modal" } });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, []); // nothing was pressed
});

test("two simultaneous dialogs during submission fail closed without pressing anything", async () => {
  // A scriptable page bridge serving canned facts: a normal ready
  // surface until the send, then TWO dialogs visible at once.
  const tabs = [{ id: 7, url: "https://chat.z.ai/" }];
  const tabsApi = fakeMessagingTabsApi({ tabs });
  let sent = false;
  let typed = "";
  const readyFacts = () => ({
    authButtons: { texts: ["New Chat", "Agent"] },
    composerVisible: { visible: true, count: 1 },
    composerEnabled: { enabled: true },
    composerValue: { value: sent ? "" : "" },
    sendVisible: { visible: true, count: 1 },
    dialogCount: { count: sent ? 2 : 0 },
    alertVisible: { visible: false, count: 0 },
    stopCandidate0: { visible: false, count: 0 },
    stopCandidate1: { visible: false, count: 0 },
    dialogText: { text: null },
    alertText: { text: null },
    conversationCandidate0: { text: null },
    userMessageCandidate0: { texts: [] },
    userMessageCandidate1: { texts: [] },
    userMessageCandidate2: { texts: [] },
    composeControl0: { count: 1 },
  });
  const agentFacts = () => ({
    agentCandidate0: { count: 1 },
    agentActive0: { count: 1 },
    agentActive1: { count: 0 },
    agentActive2: { count: 0 },
    agentActive3: { count: 0 },
  });
  const modelFacts = () => ({
    modelTriggerCount0: { count: 1 },
    modelTriggerCount1: { count: 1 },
    modelTriggerText0: { text: "GLM-5.3" },
    modelTriggerText1: { text: "GLM-5.3" },
    modelTriggerSelectedId: { count: 1 },
  });
  const bridge = {
    send: async (_tabId, command) => {
      if (command.op === "probe") {
        const facts = {
          ...readyFacts(),
          ...agentFacts(),
          ...modelFacts(),
          composerValue: { value: typed },
        };
        return { ok: true, facts };
      }
      if (command.op === "type") {
        typed = command.text;
        return { ok: true, typed: true, value: command.text };
      }
      if (command.op === "click" && command.selector === "#send-message-button") {
        sent = true;
        typed = "";
        return { ok: true, clicked: true };
      }
      return { ok: true, clicked: true, pressed: "Enter" };
    },
  };
  const adapter = createZaiAdapter({ tabsApi, pageBridge: bridge, sleep: async () => {}, settlePolls: 2, settleIntervalMs: 0 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  assert.ok(/simultaneously/.test(result.error.message));
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
  const { adapter, pages } = build({ sidebarHistory: [PROMPT] });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.popupDismissals, 0);
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
  assert.equal(result.submitted.popupDismissals, 0);
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
  assert.equal(result.submitted.popupDismissals, 0);
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

test("every ok:true Start with a submission carries EXACTLY the four-field submitted record — the cited three-field legacy shape is structurally unreachable at this tip", async () => {
  // PR #6 comment 5555093252: the operator's cited JSON carries
  // `submitted = {attempts, popupDismissals, generation}` — exactly
  // three fields, no `composeReestablishments`. That is the a22febe
  // (continuation-5) result shape, git-verifiable
  // (`git show a22febe:extension/src/zaiAdapter.js`). At the
  // corrected tip there are exactly TWO ok:true Start shapes: the
  // idempotent alreadyActive re-report (NO submitted record at all)
  // and recordSubmission — the only submission path, which ALWAYS
  // reports composeReestablishments. A Start result carrying a
  // three-field submitted record therefore cannot have been produced
  // by this code: it identifies a stale service worker. This
  // regression pins the invariant on BOTH the direct-acceptance path
  // and the compose-re-establishment path.
  const FOUR_FIELDS = ["attempts", "composeReestablishments", "generation", "popupDismissals"];

  // (1) The direct acceptance path.
  const happy = build();
  const okResult = await happy.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  assert.deepEqual(Object.keys(okResult.submitted).sort(), FOUR_FIELDS);
  assert.equal(okResult.submitted.composeReestablishments, 0);

  // (2) The compose-re-establishment path (the second observed
  // failure mode recovered within the budget).
  let sendAttempts = 0;
  const recovered = build({
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
  assert.deepEqual(Object.keys(recoveredResult.submitted).sort(), FOUR_FIELDS);
  assert.equal(recoveredResult.submitted.composeReestablishments, 1);

  // (3) The idempotent alreadyActive re-report carries NO submitted
  // record at all — every result WITH a submitted record went
  // through recordSubmission (the four-field shape).
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
    dialogCount: { count: 0 },
    alertVisible: { visible: false, count: 0 },
    stopCandidate0: { visible: false, count: 0 },
    stopCandidate1: { visible: false, count: 0 },
    dialogText: { text: null },
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

test("a popup whose dismissal ALSO resets the governed surface preparation: the FULL PREPARATION RESTART re-establishes the Agent mode before the resend (never a bare resend on an unverified surface)", async () => {
  // PR #6 review 5123260890, requirement 3: the popup interaction can
  // disturb the governed surface state. Here the Enter dismissal
  // also switches the provider app OFF the Agent mode (the pill's
  // data-active marker flips). The restart must RE-SELECT the Agent
  // pill (clicked TWICE in the whole run) and re-verify the model
  // ground truths BEFORE the resend — with the pre-continuation-9
  // "resend without restart" semantics the submission would have
  // been sent on a NON-GOVERNED (chat-mode) surface.
  const { adapter, pages } = build({
    popupOnSend: true,
    popupText: "Confirm your submission",
    beforeRespond: (message, state) => {
      if (message.op === "pressEnter") {
        state.popupOnSend = false; // dismissed for good on the first Enter
        state.agent.active = false; // the popup interaction reset the governed mode
      }
    },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.popupDismissals, 1);
  const history = pages[0].history();
  const pillClicks = history.filter(
    (c) => c.op === "click" && c.selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"
  ).length;
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  const enters = history.filter((c) => c.op === "pressEnter").length;
  assert.equal(pillClicks, 2); // the initial selection + the RESTART re-selection
  assert.equal(sends, 2); // the initial send + the resend
  assert.equal(enters, 1); // exactly one Enter per popup observation
  // The governed surface was re-established before the accepted
  // submission: the Agent mode is ACTIVE at acceptance.
  assert.equal(pages[0].state.agent.active, true);
  assert.ok(pages[0].state.conversation.includes(PROMPT));
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
    dialogCount: { count: 0 },
    alertVisible: { visible: false, count: 0 },
    stopCandidate0: { visible: false, count: 0 },
    stopCandidate1: { visible: false, count: 0 },
    dialogText: { text: null },
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
  // SAME result shape (attempts=1, popupDismissals=0,
  // generation=waiting) is now reachable ONLY through genuine
  // message evidence — contrast the weak-surface variant above,
  // which types and sends.
  const { adapter, pages } = build({ conversation: [PROMPT] });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.popupDismissals, 0);
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
  const { adapter, pages } = build();
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
  const { adapter } = build();
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
  const { adapter, tabsApi } = build();
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
  const { adapter, tabsApi } = build();
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
  const built = build(options);
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

test("a dialog during recovery fails closed UNKNOWN_DIALOG (the popup Enter path is submission-only)", async () => {
  const { adapter, pages } = await hungSession();
  pages[0].state.dialog = { text: "Some modal" };
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
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
