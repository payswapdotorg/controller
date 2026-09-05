/**
 * Z.ai browser Worker adapter tests (CTRL-014) — the offline/injected
 * matrix over the deterministic page simulator: the governed
 * new-session sequence, submission confirmation-before-success, the
 * bounded known-popup Enter recovery with full preparation restart,
 * unknown-dialog/auth-interrupt/budget fail-closed behavior, the
 * fixed Stop -> continue hung-worker recovery (acceptance proven by
 * conversation evidence — a resumed generation state alone never
 * succeeds), identity preservation, and stale/contradictory
 * reference refusal (including the stale correlated Start
 * fail-closed regression).
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

function build({
  authenticated = true,
  agent = { present: true, active: false },
  conversation = [],
  stop = { visible: false },
  popupOnSend = false,
  popupText = "Confirm submission",
  generates = true,
  tabsCount = 1,
  beforeRespond = null,
  dialog = null,
  alert = null,
  extraTabs = [],
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
      generates,
      beforeRespond,
      dialog,
      alert,
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
  assert.equal(pages[0].state.selectedModel, "GLM-5.3");
  // The exact command sequence: agent -> model trigger -> model option
  // -> type (verbatim) -> send.
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, ["click", "click", "clickIndex", "type", "click"]);
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
  pages[0].state.modelOptions = ["GLM-5.3-Flash  NEW  Lightweight", "GLM-5.2  Previous"];
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(pages[0].history().every((c) => c.op !== "type" && c.op !== "pressEnter"));
});

test("two exact GLM-5.3 options are an ambiguous model selection (GLM-5.3-Flash must not match)", async () => {
  const { adapter } = build();
  // Override the model options: two exact-token matches plus the
  // Flash variant (which must NEVER satisfy the exact-token match).
  const built = build();
  built.pages[0].state.modelOptions = ["GLM-5.3 A", "GLM-5.3 B", "GLM-5.3-Flash C"];
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  void adapter;
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

test("the known popup triggers one Enter, a full preparation restart, and succeeds on the retry", async () => {
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
  // The full preparation sequence restarted: the Agent mode was
  // already established by the first attempt, so the restart
  // re-observes the active pill idempotently (no second pill click —
  // re-clicking would navigate the provider to a fresh Agent-mode
  // session); model selection, prompt entry, and send ran twice,
  // plus one Enter.
  const history = pages[0].history();
  const clicks = history.filter((c) => c.op === "click").length;
  const types = history.filter((c) => c.op === "type").length;
  const enters = history.filter((c) => c.op === "pressEnter").length;
  const pillClicks = history.filter(
    (c) => c.op === "click" && c.selector === "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"
  ).length;
  assert.equal(pillClicks, 1); // the Agent pill clicked exactly once
  assert.equal(clicks, 5); // (agent pill + model trigger + send), then (model trigger + send)
  assert.equal(types, 2); // the exact prompt re-entered after restart
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
    conversationCandidate1: { text: null },
    conversationCandidate2: { text: null },
    conversationCandidate3: { text: null },
    userMessageCandidate0: { texts: [] },
    userMessageCandidate1: { texts: [] },
    userMessageCandidate2: { texts: [] },
  });
  const agentFacts = () => ({
    agentCandidate0: { count: 1 },
    agentActive0: { count: 1 },
    agentActive1: { count: 0 },
    agentActive2: { count: 0 },
    agentActive3: { count: 0 },
  });
  const modelFacts = () => ({
    modelOptionTexts: { texts: ["GLM-5.3-Flash NEW", "GLM-5.3 Flagship", "GLM-5.2 Previous"] },
    triggerText: { text: "GLM-5.3" },
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
