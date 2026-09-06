/**
 * Z.ai browser Worker adapter tests (CTRL-014) — the offline/injected
 * matrix over the deterministic page simulator. CONTINUATION 22 (PR
 * #6 review 5125571572, the REQUEST CHANGES decision, resolution
 * path (b) "implementing the frozen Work Order semantics") restores
 * the FROZEN CTRL-014 WORK ORDER contract on top of the day's live
 * evidence: the acceptance is the provider-owned START SIGNAL — THE
 * CONVERSATION-STATE ADVANCEMENT (the user-turn count advanced past
 * the dispatch baseline AND the exact correlated text landed as a
 * user-message row — the new turn is OURS) with the composer action
 * slot's Send->Stop transition corroborating (the Stop control
 * rendered with the send control absent, the composer decisively
 * empty: the draft consumed — a prompt still held in the composer is
 * the provider's own proof the submission was NOT consumed, so a
 * Stop control over a text-holding composer is a foreign generation,
 * never the signal) and, on a fresh session, the chat-object
 * creation — gated by the ASYNC-OUTCOME HOLD after the signal (the
 * known popup's observed asynchronous arrival). THE FROZEN WORK
 * ORDER'S DIALOG LAW (restored): the KNOWN submission-blocking popup
 * ("Currently in peak hours", LIVE-OBSERVED capacity modal) is the
 * ONLY surface that ever receives Enter — exactly once per retry
 * attempt, ONLY when observed, the dismissal VERIFIED by post-action
 * observation, then the FULL PREPARATION RESTART (Agent -> model ->
 * prompt -> send -> verification); unknown/differently-shaped
 * dialogs, dialogs during preparation, and dialogs during recovery
 * ALL fail closed UNKNOWN_DIALOG ("the adapter must not blindly
 * press keys"); NO key is ever pressed on a timer (the timed-Enter
 * cadence is removed with the 13:58 directive model). The pinned
 * laws: the provisioning wait; the successful submission (zero
 * Enters); the queued generation confirmed by pure observation; the
 * one-Enter popup path with the verified dismissal and the restart;
 * the never-dismissing popup bounded by the attempt budget; the
 * auth/error-shaped popup refusals (never Enter); the async
 * peak-hours modality through the hold; the restored-prompt
 * unconfirmed re-send; the false-positive surfaces
 * (contradictory/unresolvable/enabled-lie/ambiguous slots, the
 * foreign-generation Stop-over-text) that never count as working;
 * the bounded no-signal timeout; no duplicate submission while a
 * generation is already running; the c6 pre-send gate and compose
 * re-establishment; the FOUR-FIELD submitted record (attempts,
 * popupDismissals, composeReestablishments, generation); the
 * recovery WITHOUT a persistent registry (the service-worker
 * restart — never SESSION_UNKNOWN) running the same watch; and the
 * recovery's dropped-row/Regenerate CONTEXT laws and dialog
 * fail-closed law.
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
  // The CONTINUATION-16 chat-state URL (see fixtures.js): the page's
  // routing state — default null models the FRESH session (the origin
  // base, no chat object); a "/c/<id>" value models an EXISTING chat.
  chatUrl = null,
  // The CONTINUATION-23 chat-tab-baseline knobs (see fixtures.js): the
  // turn-index badge on the in-flight row, the body-level
  // human-verification captcha popup (initial / on-send-armed), and
  // the assistant-row completion-error rendering.
  turnIndexBadge = false,
  humanVerification = false,
  humanVerificationOnSend = null,
  assistantText = null,
  completionErrorText = null,
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
      chatUrl,
      turnIndexBadge,
      humanVerification,
      humanVerificationOnSend,
      assistantText,
      completionErrorText,
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

test("the observation vocabulary is exactly the frozen thirteen-state set", () => {
  // CONTINUATION 23 (the chat-tab baseline): the LIVE-OBSERVED
  // human-verification gate joins the frozen vocabulary (the
  // body-level Aliyun captcha surface — a distinct state from every
  // dialog form).
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
    "human-verification-required",
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

test("a visible unknown dialog observes unexpected-dialog (outside submission verification) — the typed vocabulary is PRODUCED again", async () => {
  // CONTINUATION 22 (PR #6 review 5125571572, path (b)): dialog
  // recognition is RESTORED — a standalone observation of a
  // dialog-bearing surface produces the typed dialog states (the
  // frozen Work Order's "detection and typed reporting of ...
  // expected blocking-dialog, unexpected-dialog" scope). A
  // non-auth/non-error dialog outside the submission-verification
  // window classifies unexpected-dialog.
  const built = build({ dialog: { text: "Some unprompted modal" } });
  const observed = await built.adapter.observeSession("w1");
  assert.equal(observed.ok, true);
  assert.equal(observed.observation.state, "unexpected-dialog");
  // The dialog was never dismissed — the observation is read-only.
  assert.ok(built.pages[0].state.dialog);
});

test("a visible auth-shaped dialog observes authentication-required; a visible error-shaped dialog observes provider-error", async () => {
  // The dialog CONTENT classification (the c12 law, restored): the
  // auth-shaped and error-shaped dialogs are typed by their text at
  // ANY phase — they are never the known popup and never Enter.
  const auth = build({ dialog: { text: "Please log in to continue" } });
  const authObserved = await auth.adapter.observeSession("w1");
  assert.equal(authObserved.observation.state, "authentication-required");
  const error = build({ dialog: { text: "Something went wrong" } });
  const errorObserved = await error.adapter.observeSession("w1");
  assert.equal(errorObserved.observation.state, "provider-error");
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
  // CONTINUATION 15 (PR #6 review 5124990727 + review 5125102305): the
  // acceptance is the AGENT-START SIGNAL — the send click swaps the
  // action slot to the Stop control (the generation entering flight)
  // with the composer decisively empty (the draft consumed), and the
  // AGENT-START WATCH observes it on its first read: zero Enter
  // nudges (the signal is present before any cadence tick), the
  // submission recorded with generation:"working" (the signal itself).
  const { adapter, pages } = build();
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.composeReestablishments, 0);
  assert.equal(result.submitted.generation, "working"); // the start signal itself — the Stop control visible, the composer decisively empty
  // The governed flow never presses Enter on the happy path (the
  // start signal is observed before any cadence tick — CONTINUATION 15).
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  // The start signal is the provider's own proof; the landed row and
  // the cleared composer are CONTEXT facts cross-checked here:
  // the conversation holds the exact prompt and the composer is empty.
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

test("the PROVISIONING WAIT: a fresh-session surface that is not yet ready becomes ready within the bounded settle and the governed sequence completes (the fresh-session provisioning latency)", async () => {
  // CONTINUATION 15 (PR #6 review 5124990727, the required
  // "provisioning wait" regression): a FRESH Agent session's surface
  // is not immediately ready for input — the provider provisions the
  // chat object asynchronously (the operator's observed repeated
  // GET/polling until the chat exists; the composer surface becomes
  // an enabled input only when provisioning completes). The adapter's
  // bounded settle tolerates the not-yet-ready window (the ambiguous
  // composer-not-enabled reads are retried, never fatal), and the
  // governed sequence completes on the readied surface: the start
  // signal is observed and the submission recorded.
  let probes = 0;
  const built = build({
    beforeRespond: (message, state) => {
      if (message.op === "probe") {
        probes += 1;
        if (probes <= 2) {
          state.composerDisabled = true; // the provisioning window: the composer is not yet an enabled input
        } else {
          state.composerDisabled = false; // provisioning completed — the chat surface is ready
        }
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "working");
  assert.equal(built.pages[0].state.conversation.includes(PROMPT), true);
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // the signal arrived before any cadence tick
});

test("PROVISIONING-NOT-READY: a fresh Agent-mode session whose surface never becomes a ready input fails closed with the typed provisioning refusal — the exact prompt is never typed, nothing is ever sent, and the Enter cadence never starts", async () => {
  // CONTINUATION 16 (PR #6 review 5125198728, requirements 1 + 9 —
  // the "provisioning-not-ready" regression): the creation of the
  // fresh Agent-mode chat/session is an ASYNCHRONOUS provider
  // operation; the most reliable observable that provisioning
  // completed is the composer becoming a visible ENABLED input. The
  // surface here passes the initial precheck (ready before the mode
  // switch), then re-provisions on the Agent-mode switch and NEVER
  // readies again (the hung provisioning window): the bounded
  // PROVISIONING WAIT exhausts and Start fails closed with the
  // TYPED provisioning refusal — the exact prompt is never typed
  // into an unprovisioned surface, nothing is ever sent, no Enter
  // is ever issued, and nothing ever lands.
  const AGENT_PILL = "#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type";
  const built = build({
    beforeRespond: (message, state) => {
      // The fresh Agent-mode session re-provisions after the mode
      // switch: the composer (an enabled input at the precheck)
      // becomes a not-yet-ready input, and provisioning NEVER
      // completes (the hung window).
      if (message.op === "click" && message.selector === AGENT_PILL) {
        state.__provisioning = true;
      }
      if (state.__provisioning && message.op === "probe") {
        state.composerDisabled = true;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "RETRY_EXHAUSTED");
  assert.ok(/did not complete provisioning/.test(result.error.message), result.error.message);
  assert.ok(/asynchronous provider operation/.test(result.error.message), result.error.message);
  const history = built.pages[0].history().filter((c) => c.op !== "probe");
  assert.equal(history.filter((c) => c.op === "type").length, 0); // never typed into the unprovisioned surface
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0); // never sent
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 0); // the watch never started
  assert.equal(built.pages[0].state.conversation.length, 0); // nothing landed
  assert.equal(result.submitted, undefined); // never a claimed submission
});

test("THE CHAT-STATE CREATION FACT: a successful Start on a FRESH session carries the provider's own chat-object creation — the session URL advanced from the origin base to the /c/<chatId> route (the bundle-proven accepted-submission routing)", async () => {
  // CONTINUATION 16 (PR #6 review 5125198728, requirement 4 candidate
  // (a) — "the appearance/creation of the chat object/session state
  // after provisioning"): the provider's submission handler creates
  // the chat server-side on the ACCEPTED first submission (the chat
  // id from the response -> the current-chat store ->
  // REFRESH_AGENT_CHAT_LIST -> history.replaceState(`/c/<id>`) —
  // BUNDLE-PROVEN) and the 429/capacity path returns BEFORE the
  // creation. The fixture models the same machine: the fresh session
  // starts at the origin base (no chat object), the accepted
  // submission creates the chat and advances the URL, and the start
  // signal (the Stop slot + the decisively empty composer + the chat
  // object created — the combined detector) is observed on exactly
  // that surface.
  const built = build();
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "working"); // the start signal itself
  // The chat object was created by the accepted submission: the URL
  // advanced from the origin base to the chat route.
  assert.equal(built.pages[0].state.chatCreated, true);
  assert.ok(built.pages[0].state.url.startsWith("https://chat.z.ai/c/"), built.pages[0].state.url);
  // The landed row and the cleared composer are the CONTEXT facts.
  assert.ok(built.pages[0].state.conversation.includes(PROMPT));
  assert.equal(built.pages[0].state.composerValue, "");
});

test("THE FOREIGN-GENERATION FALSE POSITIVE on a fresh session: a Stop control over a decisively empty composer with the chat object NEVER created (the submission was never accepted) is NOT the start signal — Start fails closed, never ok:true", async () => {
  // CONTINUATION 16 (PR #6 review 5125198728, requirement 4 —
  // "combine signals when needed for confidence"): the c15 detector
  // (the Stop slot + the decisively empty composer alone) could not
  // distinguish OUR accepted generation from a FOREIGN one on a
  // fresh session where the input state was discarded around the
  // send and a foreign generation holds the action slot. The
  // provider's own routing state closes the gap: OUR accepted
  // submission CREATES the chat object (the URL advance —
  // bundle-proven), so a Stop control over an empty composer with
  // NO chat object is a foreign generation, never our start signal.
  // MACHINE-DIFFERENTIATED: the c15 detector accepted exactly this
  // surface as ok:true (the git-stash differential against the
  // pre-c16 zaiAdapter.js fails this regression at the first watch
  // round).
  const built = build({
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        // The input state is discarded around the send (the c6
        // failure mode) AND a foreign generation takes the action
        // slot: the provider's own concurrency gate never accepted
        // OUR prompt — the chat object is never created, the URL
        // never advances.
        state.__foreign = true;
      }
      if (state.__foreign && message.op === "probe") {
        state.__foreign = false;
        state.composerValue = ""; // the input was discarded
        state.stop.visible = true; // the FOREIGN generation holds the slot
        state.conversation = state.conversation.filter((t) => t !== PROMPT); // nothing of ours landed
        // The provider's concurrency gate refused OUR submission
        // BEFORE the chat creation (the bundle's 429-before-create
        // path): no chat object, no URL advance.
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.submitted, undefined); // NEVER a claimed submission — the c15 false positive is closed
  // The surface's own routing state held: the chat object was never
  // created (the URL never advanced past the origin base).
  assert.equal(built.pages[0].state.chatCreated, false);
  assert.equal(built.pages[0].state.url, "https://chat.z.ai/");
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT)); // our prompt never landed
  // The failure is typed and routed by the chat state: the first
  // exhaustion (empty composer, no evidence, NO chat object) took
  // the safe compose re-establishment, and the bounded attempts
  // ended in a typed refusal.
  assert.ok(["PAGE_MALFORMED", "AMBIGUOUS_STATE", "RETRY_EXHAUSTED"].includes(result.error.code));
});

test("THE EXISTING-CHAT VACUITY LAW: on an existing chat (the session URL already at /c/<chatId> at dispatch) the start signal is the conversation advancement + the Stop slot + the decisively empty composer — the chat-state conjunct is vacuous, and no new URL advance is required", async () => {
  // CONTINUATION 16: an existing chat's URL is already at a chat
  // route BEFORE the submission — the chat-object-creation conjunct
  // applies only to FRESH sessions (the provider's URL advance
  // happens exactly once, at the accepted FIRST submission; the
  // mid-conversation recovery's `continue` submissions ride the
  // same law). CONTINUATION 20: the signal still requires the
  // conversation-state advancement (the new turn landed) — the
  // vacuity is the chat-object conjunct's alone. On the existing
  // chat the detector is the advancement + Stop-slot +
  // empty-composer reading, with no spurious URL requirement.
  const built = build({ chatUrl: "https://chat.z.ai/c/existing-chat-77" });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "working");
  // The URL never re-advanced (the chat object already existed) and
  // the acceptance needed no new URL fact — the conjunct was vacuous.
  assert.equal(built.pages[0].state.url, "https://chat.z.ai/c/existing-chat-77");
  assert.equal(built.pages[0].state.chatCreated, true);
  assert.ok(built.pages[0].state.conversation.includes(PROMPT));
  assert.equal(built.pages[0].state.composerValue, "");
});

test("THE CONVERSATION-ADVANCEMENT ACCEPTANCE (the directive's conjunct): the start signal fires only with the conversation state advanced past the dispatch baseline — the new user turn carrying the EXACT governed prompt — AND the Send→Stop working state corroborating, the composer decisively empty, and (a fresh session) the chat object created — every leg directly asserted", async () => {
  // CONTINUATION 20 (PR #6 comment 5559533083, the superseding
  // execution directive): "prompt acceptance = conversation state
  // advances with a new turn; generation start = provider working
  // state (e.g. Send/Stop transition) as corroborating evidence".
  // The operator's reported runtime object — `chat` with
  // `history.messages` — lives in closure-scoped provider stores,
  // unreachable through the supported extension surface; the
  // RENDERED user-message rows are its observable projection
  // (userTurnCountOf), and the dispatch-baseline delta is the new
  // turn. This regression asserts every leg of the conjunct on the
  // genuine happy path: the turn count advanced from the dispatch
  // baseline (0 -> 1), the exact prompt landed as the new turn, the
  // Stop control rendered with the send control absent, the
  // composer read decisively empty, and the fresh session's URL
  // advanced to the /c/ chat route (the chat object created).
  const built = build();
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "working");
  // The conversation-state advancement: the user-turn count advanced
  // past the dispatch baseline (the new turn landed exactly once).
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
  // The provider's working state, corroborating: the Stop control
  // rendered (the Send→Stop action-slot transition).
  assert.equal(built.pages[0].state.stop.visible, true);
  // The composer decisively empty (the draft consumed).
  assert.equal(built.pages[0].state.composerValue, "");
  // The fresh session's chat object created (the URL advanced).
  assert.equal(built.pages[0].state.chatCreated, true);
  assert.ok(built.pages[0].state.url.startsWith("https://chat.z.ai/c/"));
});

test("THE DISCARDED-INPUT NO-ADVANCEMENT LAW (the c20 discriminator on an existing chat): our dispatch's input is discarded and a FOREIGN generation takes the Stop slot with the composer decisively empty — the conversation state NEVER advances past the dispatch baseline, so the start signal NEVER fires (the c16 Stop+empty+chat reading alone would have recorded ok:true here — the conversation-advancement conjunct closes that hole)", async () => {
  // CONTINUATION 20 (PR #6 comment 5559533083): "prompt acceptance =
  // conversation state ADVANCES with a new turn" — the advancement
  // is the delta past the dispatch baseline. On an EXISTING chat the
  // c16 signal was the Stop slot + the decisively empty composer
  // alone (the chat-object conjunct vacuous) — a foreign generation
  // over a discarded input satisfied it. The c20 conjunct requires
  // the new turn: this surface (our prompt typed + verified + sent;
  // the input discarded around the send — the row withdrawn before
  // any observation; the foreign generation's Stop; the empty
  // composer; NO new turn) never fires the signal, and the watch
  // fails closed with the typed diagnosis. Machine-differentiated:
  // at the pre-c20 adapter this surface records ok:true.
  const built = build({
    chatUrl: "https://chat.z.ai/c/existing-chat-77",
    conversation: ["an earlier operator turn"], // the pre-dispatch baseline: one user turn
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__sent = true;
      }
      if (state.__sent && message.op === "probe") {
        state.__sent = false;
        state.composerValue = ""; // our dispatch's input was discarded
        state.stop.visible = true; // the FOREIGN generation holds the slot
        state.conversation = state.conversation.filter((t) => t !== PROMPT); // our row is withdrawn before any observation
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.submitted, undefined); // NEVER a claimed submission
  // The conversation NEVER advanced: exactly the one pre-dispatch
  // turn — our prompt never landed (the discarded input).
  assert.equal(built.pages[0].state.conversation.length, 1);
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT));
  // The failure is typed and fail-closed (the exhaustion routes the
  // empty composer + no evidence + the existing chat to the
  // accepted-not-started refusal, never a re-establishment).
  assert.ok(["PAGE_MALFORMED", "AMBIGUOUS_STATE", "RETRY_EXHAUSTED"].includes(result.error.code));
});

test("THE STALE-EXACT-ROW INTERPLAY: an existing chat whose conversation ALREADY carries the exact governed prompt row from a prior run — the landed-row protection refuses the dispatch before the watch (the row is indistinguishable from a landed submission at the read; never submitted twice), and the bounded attempts fail closed with the typed refusal", async () => {
  // CONTINUATION 14's no-duplicate law meets CONTINUATION 20's
  // acceptance hierarchy on the stale-row surface: a prior run's
  // exact row in the evidence + our prompt typed into the composer
  // is the prompt-present-in-composer-AND-in-evidence state —
  // ensurePrompt refuses it (a landed row is never re-submitted),
  // so the dispatch never reaches the send; the c20 conjunct is
  // never even consulted. The honest law for this surface is the
  // landed-row protection, and the refusal is typed.
  const built = build({
    chatUrl: "https://chat.z.ai/c/existing-chat-77",
    conversation: [PROMPT], // the STALE exact row from a prior run
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.submitted, undefined);
  // The stale row is the ONLY turn — nothing was added, nothing was
  // sent (the landed row is protected from the duplicate).
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
  assert.ok(["PAGE_MALFORMED", "AMBIGUOUS_STATE", "RETRY_EXHAUSTED"].includes(result.error.code));
});

test("THE FOREIGN-TURN DISCRIMINATOR: the conversation advances with a DIFFERENT text (a foreign turn) while the Stop control renders and the composer is decisively empty — the advancement happened but NOT with the exact correlated text: never the start signal", async () => {
  // CONTINUATION 20 (PR #6 comment 5559533083): the acceptance leg
  // is the CONJUNCT of the advancement (the count delta) AND the
  // exact correlated text as the new turn — "the new turn is OURS".
  // A foreign turn (the operator's manual typing, a queued prior
  // prompt) advancing the count while OUR dispatch's input was
  // discarded (our row withdrawn before any observation) and a
  // foreign generation runs satisfies the delta alone; the
  // exact-text conjunct refuses it. Fail closed.
  const built = build({
    chatUrl: "https://chat.z.ai/c/existing-chat-77",
    conversation: ["an earlier operator turn"], // the pre-dispatch baseline: one user turn
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__sent = true;
      }
      if (state.__sent && message.op === "probe") {
        state.__sent = false;
        state.composerValue = ""; // our dispatch's input was discarded
        state.stop.visible = true; // the FOREIGN generation holds the slot
        state.conversation = state.conversation.filter((t) => t !== PROMPT); // our row is withdrawn before any observation
        state.conversation.push("an unrelated operator prompt"); // the FOREIGN turn advanced the count
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.submitted, undefined);
  // Our exact prompt NEVER landed (the foreign turn is the only new row).
  assert.ok(!built.pages[0].state.conversation.includes(PROMPT));
  assert.ok(built.pages[0].state.conversation.includes("an unrelated operator prompt"));
  assert.ok(["PAGE_MALFORMED", "AMBIGUOUS_STATE", "RETRY_EXHAUSTED"].includes(result.error.code));
});

test("THE REPEATED-RECOVERY ADVANCEMENT: a SECOND hung recovery on a chat whose conversation already carries an earlier `continue` row still fires the start signal — the advancement is the turn-count DELTA (the stale row never blocks the signal; a new turn lands for the new dispatch)", async () => {
  // CONTINUATION 20 (PR #6 comment 5559533083): the advancement is
  // measured as the user-turn count delta past the DISPATCH
  // baseline — deliberately NOT as text-presence-vs-baseline (a
  // presence-delta design would permanently block every recovery
  // after the first one on the same chat, because the earlier
  // `continue` row is already present at the second dispatch). The
  // count-delta design fires the signal exactly when the NEW turn
  // lands. This regression machine-differentiates the two designs.
  const built = await hungSession();
  // The FIRST recovery: the `continue` turn lands, the generation
  // resumes, the signal fires.
  const first = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(built.pages[0].state.conversation.filter((t) => t === "continue").length >= 1);
  // The session hangs AGAIN: the generation re-arms the Stop slot.
  built.pages[0].state.stop.visible = true;
  // The SECOND recovery on the SAME chat: the earlier `continue`
  // row is already in the conversation at the second dispatch — the
  // count-delta conjunct must still fire on the NEW turn.
  const second = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.recovered.acceptance, "agent-start");
  assert.equal(second.recovered.generation, "working");
  // The new turn landed for the second dispatch (the count advanced
  // past the second dispatch's baseline).
  assert.ok(built.pages[0].state.conversation.filter((t) => t === "continue").length >= 2);
  assert.equal(built.pages[0].state.composerValue, "");
});

test("the queued generation becomes active mid-watch and the acceptance is confirmed by PURE OBSERVATION — zero Enter (no key is ever pressed on a timer)", async () => {
  // CONTINUATION 22 (PR #6 review 5125571572, path (b)): the timed
  // Enter cadence is REMOVED — the watch observes and NOTHING else.
  // The queued surface: the send consumed the prompt (the row landed,
  // the composer decisively empty) but the generation is NOT yet
  // active (the provider's queued state — no Stop control). The
  // watch's pure observation rounds wait (no nudge, no keypress)
  // while the queue drains; the Stop control appears on a later
  // probe; the signal is observed and the acceptance is held through
  // the async-outcome window.
  let probesAfterSend = 0;
  const built = build({
    generates: false, // the queued submission: the row lands, the composer clears, but the generation does NOT start yet
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.__sent = true;
      }
      if (message.op === "probe" && state.__sent) {
        probesAfterSend += 1;
        if (probesAfterSend === 6) {
          state.stop.visible = true; // the queued generation becomes active on the 6th post-send probe
          state.generates = true;
        }
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "working");
  const enters = built.pages[0].history().filter((c) => c.op === "pressEnter").length;
  // ZERO Enters: the Enter is reserved for the OBSERVED known popup
  // alone (the frozen Work Order) — a queued generation is confirmed
  // by observation, never by a keypress.
  assert.equal(enters, 0);
  assert.equal(built.pages[0].state.composerValue, "");
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // landed once, never resent
});

test("NO DUPLICATE SUBMISSION while a generation is already running: the Stop control over a text-holding composer is NEVER the start signal — zero send clicks, zero Enters (no popup was ever observed), and the bounded budget fails closed", async () => {
  // The frozen no-duplicate law: a generation that was already active
  // when the pre-send gate read the surface (the precheck passed on
  // the earlier ready-for-input read; a foreign generation started
  // during the preparation). The detector REFUSES the false positive:
  // the composer still holds the exact prompt (the submission was not
  // consumed — the provider's own proof), so the Stop control over a
  // text-holding composer is never the start signal. The gate never
  // clicks the send control (the slot renders the Stop control), the
  // watch never presses Enter (no dialog was ever observed — the
  // Enter is reserved for the known popup alone), the exhaustion
  // routes the bounded re-send, and the budget fails closed — the
  // prompt is never submitted twice, the conversation never grows.
  const built = build({
    beforeRespond: (message, state) => {
      if (message.op === "type") {
        // the foreign generation turned active right after the
        // precheck: the provider's real mutually exclusive action
        // slot during an active generation renders the Stop control
        // with the send control ABSENT (the queued-input draft stays
        // in the composer).
        state.stop.visible = true;
        state.sendInaccessible = true;
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/remains in the composer/.test(result.error.message), result.error.message);
  // ZERO send clicks: the gate never clicked (the slot rendered the Stop control all along).
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  // ZERO Enters: no dialog was ever observed — a keypress here would
  // be exactly the blind key the frozen Work Order forbids.
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  // ZERO landed rows: the conversation never grew.
  assert.equal(built.pages[0].state.conversation.length, 0);
  // The prompt stayed in the composer — the draft was never consumed.
  assert.equal(built.pages[0].state.composerValue, PROMPT);
  // The provider's Stop control (the foreign generation) was never clicked by the adapter.
  const stopClicks = built.pages[0].history().filter(
    (c) => c.op === "click" && String(c.selector).includes('aria-label="Stop"')
  );
  assert.equal(stopClicks.length, 0);
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
  // CONTINUATION-14 lineage: under the current contract the Start
  // records at the FIRST post-send observation of the start signal
  // (the landed exact turn + the Stop control) — no Send-reappearance
  // boundary is ever waited for.
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
  // CONTINUATION 22 (PR #6 review 5125571572, path (b) — the frozen
  // Work Order's dialog law): "Unknown or differently-shaped dialogs
  // must fail closed." A dialog that appears during preparation is
  // never the known popup (that is classifiable ONLY inside the
  // submission-verification window) — the adapter never prepares
  // through a modal, never presses a key.
  const built = build({
    beforeRespond: (message, state) => {
      if (message.op === "click" && String(message.selector).includes("nth-of-type(2)")) {
        state.dialog = { text: "An unexpected modal" }; // appears after the Agent pill click
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  assert.ok(/outside the submission-verification window/.test(result.error.message), result.error.message);
  const ops = built.pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, ["click"]); // the Agent pill click only — nothing typed, nothing sent, no keypress
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  assert.ok(built.pages[0].state.dialog); // never dismissed
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
  // CONTINUATION 15: the never-starting surface exhausts the watch
  // with the exact text still in the composer — the bounded re-send
  // route, never a claimed submission.
  assert.ok(/remains in the composer/.test(result.error.message), result.error.message);
});

// --------------------------------------------------------------------
// The CONTINUATION-22 regressions (PR #6 review 5125571572, the
// REQUEST CHANGES decision, path (b) — the frozen Work Order's
// "Known submission-popup recovery"): the OBSERVED known popup is
// the ONLY surface that ever receives Enter (once per retry
// attempt, dismissal verified, full preparation restart); every
// other dialog shape fails closed; the async peak-hours modality
// runs through the hold and the popup path.
// --------------------------------------------------------------------

test("the KNOWN submission-blocking popup triggers exactly ONE Enter, the VERIFIED dismissal, and the FULL PREPARATION RESTART before the resend of the exact prompt", async () => {
  // The frozen Work Order: "When and only when the adapter observes
  // the known submission-blocking popup, it may press `Enter` once
  // for the current retry attempt. After dismissal it must restart
  // from Agent selection, model selection, exact prompt entry, send
  // and submission verification." The popupOnSend modality models
  // the blocking popup (the prompt stays in the composer, nothing
  // lands); the hook disarms the re-blocking on the first Enter
  // (the provider admits the next submission). The restart's
  // re-selection is idempotent: each control is still clicked
  // EXACTLY ONCE, the prompt still sits in the composer
  // byte-identical (the popup blocked the submission, so it is sent
  // AS-IS with no re-type), and the decisive acceptance follows.
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
  assert.equal(result.submitted.attempts, 2); // the preparation restart after the dismissal
  assert.equal(result.submitted.popupDismissals, 1); // the Enter was actually issued on the actually-observed popup
  assert.equal(result.submitted.generation, "working");
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
  assert.equal(sends, 2); // the initial send + the resend after the restart
  assert.equal(clicks, 5); // pill + trigger + option + send + resend
  assert.equal(types, 1); // the exact prompt typed ONCE — resent, never re-typed
  assert.equal(enters, 1); // exactly ONE Enter per observed popup — never on a timer
});

test("a popup that never stops re-blocking exhausts the bounded attempt budget without pretending success", async () => {
  // "Retries are bounded/configurable." Every resend re-triggers the
  // blocking popup (the real capacity modality while the condition
  // holds): with 3 attempts, at most 2 Enter presses (one per
  // restartable attempt; the final attempt fails without pressing).
  // Bounded, fail-closed, never a claimed submission.
  const { adapter, pages } = build({ popupOnSend: true, popupText: "Confirm submission" });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "RETRY_EXHAUSTED");
  assert.ok(/known submission-blocking popup persisted/.test(result.error.message), result.error.message);
  const enters = pages[0].history().filter((c) => c.op === "pressEnter").length;
  assert.ok(enters <= 2, `expected at most 2 Enter presses, saw ${enters}`);
  assert.ok(!pages[0].state.conversation.includes(PROMPT)); // never claimed submitted
});

test("an auth-shaped popup during submission fails closed AUTHENTICATION_INTERRUPTED (no Enter)", async () => {
  const { adapter, pages } = build({ popupOnSend: true, popupText: "Please log in to submit" });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AUTHENTICATION_INTERRUPTED");
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // auth dialogs NEVER receive Enter
});

test("an error-shaped popup during submission fails closed PROVIDER_ERROR (no Enter)", async () => {
  const { adapter, pages } = build({ popupOnSend: true, popupText: "Submission failed: rate limit" });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "PROVIDER_ERROR");
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // error dialogs NEVER receive Enter
});

test("two simultaneous dialogs during submission fail closed without pressing anything", async () => {
  // A scriptable page bridge serving canned facts: a normal ready
  // surface until the send, then TWO dialogs visible at once (an
  // ambiguous dialog surface — never the known popup, never Enter).
  const tabs = [{ id: 7, url: "https://chat.z.ai/" }];
  const tabsApi = fakeMessagingTabsApi({ tabs });
  let sent = false;
  let typed = "";
  const readyFacts = () => ({
    authButtons: { texts: ["New Chat", "Agent"] },
    composerVisible: { visible: true, count: 1 },
    composerEnabled: { enabled: true },
    composerValue: { value: typed },
    sendVisible: { visible: true, count: 1 },
    sendEnabled: { enabled: false },
    pageLocation: { href: sent ? "https://chat.z.ai/" : "https://chat.z.ai/" },
    dialogCount: { count: sent ? 2 : 0 },
    alertVisible: { visible: false, count: 0 },
    stopCandidate0: { visible: false, count: 0 },
    stopCandidate1: { visible: false, count: 0 },
    stopCandidate2: { visible: false, count: 0 },
    stopCandidate3: { visible: false, count: 0 },
    postResponseRegenerate: { visible: false, count: 0 },
    dialogText: { text: null },
    alertText: { text: null },
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
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  assert.ok(/simultaneously/.test(result.error.message));
});

test("the asynchronous peak-hours dialog materializing after the optimistic landing: the KNOWN-POPUP path dismisses it (one Enter, verified, full restart) and the strong acceptance then fails closed with the REFUSED-ECHO diagnosis — the landed row is the provider's local optimistic echo, never resent", async () => {
  // The REAL provider modality (LIVE-OBSERVED, the operator's captured
  // run): the "Currently in peak hours" capacity dialog materializes
  // only when the ASYNC error arrives — after the optimistic landing
  // (the exact user-message row + the cleared composer). The watch's
  // dialog dispatch observes it and routes the KNOWN-POPUP path: ONE
  // Enter, the VERIFIED dismissal, the FULL preparation restart. The
  // restart's ensurePrompt then sees the landed row with the empty
  // composer (the already-landed branch) and the watch observes — but
  // the capacity rejection means NO generation started and NO chat
  // object was created (the 429/capacity path returns BEFORE the chat
  // creation, BUNDLE-PROVEN), so the start signal never appears and
  // the exhaustion diagnoses the landed row as the provider's LOCAL
  // OPTIMISTIC ECHO of a submission the server REFUSED — never resent
  // (the governed prompt is never submitted twice; the operator
  // observes or re-invokes).
  const built = build({
    generates: false, // the capacity error means no generation started
    popupAfterSend: { probes: 1 }, // materializes on the 1st fact read after the send
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/local echo of a submission the server REFUSED/.test(result.error.message), result.error.message);
  assert.ok(/chat object was never created/.test(result.error.message), result.error.message);
  const history = built.pages[0].history();
  assert.equal(history.filter((c) => c.op === "type").length, 1); // typed exactly once
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1); // never resent
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 1); // exactly one Enter — the observed known popup
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // never duplicated
});

test("the peak-hours popup WITH the provider's prompt restore: the restored prompt is resent AS-IS after the verified dismissal and the full preparation restart — never re-typed, and the acceptance is the start signal", async () => {
  // The provider's MODEL_CONCURRENCY_LIMIT handler also RESTORES the
  // submitted prompt into the composer (bundle-proven) and WITHDRAWS
  // the optimistic row: after the ONE Enter dismissal and the FULL
  // preparation restart, the restored prompt is sent AS-IS (never
  // re-typed, never rewritten), and the resend is an ordinary fresh
  // submission that creates the chat and starts the generation — the
  // start signal is the acceptance.
  const built = build({
    popupAfterSend: { probes: 1, restore: true },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.popupDismissals, 1);
  assert.equal(result.submitted.generation, "working");
  const history = built.pages[0].history();
  assert.equal(history.filter((c) => c.op === "type").length, 1); // the restored prompt is sent AS-IS — never re-typed
  const sends = history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 2); // the initial send + the resend after the restart
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 1); // exactly one Enter
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // the resent row — never duplicated
  assert.equal(built.pages[0].state.stop.visible, true); // the agent actively working
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
        // observation; the send click itself always succeeds). CONTINUATION
        // 16: the submission also never creates the chat object (the
        // surface never accepted it — the URL state resets with the
        // filtered row, the bundle's refused-before-creation path).
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
      }
    },
  });
  const result = await swallowed.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/was not present in the composer/.test(result.error.message), result.error.message);
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

test("a dialog present from the very start fails closed UNKNOWN_DIALOG at the precheck — nothing is prepared, typed, or sent", async () => {
  // CONTINUATION 22 (the frozen Work Order's dialog law): the initial
  // authenticated-state precheck observes the dialog-bearing surface
  // and fails closed UNKNOWN_DIALOG before ANY preparation (the
  // adapter never prepares through a modal, never presses a key).
  const built = build({ dialog: { text: "An unexpected modal" } });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  assert.ok(/before preparation/.test(result.error.message), result.error.message);
  const ops = built.pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, []); // nothing was pressed
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
  const { adapter, pages } = build({ sidebarHistory: [PROMPT] });
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
        // CONTINUATION 16: the submission never landed, so the chat
        // object was never created (the refused-before-creation
        // semantics) — the URL state resets with the filtered row.
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
      }
    },
  });
  const result = await swallowed.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/was not present in the composer/.test(result.error.message), result.error.message);
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
        // CONTINUATION 16: the submission did not land, so the chat
        // object was never created either (the provider's refused-
        // before-creation path) — the URL state resets with the row.
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
        state.stop.visible = false; // nothing is generating
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 2);
  assert.equal(result.submitted.composeReestablishments, 1);
  const history = built.pages[0].history().filter((c) => c.op !== "probe");
  // The first attempt's watch runs its full bounded window as PURE
  // OBSERVATION (the discarded-input surface shows no start signal,
  // no dialog — ZERO Enters: the Enter is reserved for the observed
  // known popup alone) BEFORE the exhaustion routes the compose
  // re-establishment. The sequence is the c6 chain: pill -> trigger
  // -> option -> type -> send -> [the watch's bounded observation]
  // -> compose control -> re-type -> send.
  assert.deepEqual(
    history.map((c) => c.op),
    ["click", "click", "click", "type", "click", "click", "type", "click"]
  );
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 0); // no dialog was ever observed — zero keypresses
  assert.equal(history.filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length, 1);
  assert.equal(history.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 2);
  const typeTexts = history.filter((c) => c.op === "type").map((c) => c.text);
  assert.deepEqual(typeTexts, [PROMPT, PROMPT]);
  // Acceptance came only from the START SIGNAL after the RESEND (the
  // Stop control visible with the composer decisively empty).
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1);
  assert.equal(built.pages[0].state.stop.visible, true);
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
        // CONTINUATION 16: the submission did not land, so the chat
        // object was never created either (the provider's refused-
        // before-creation path) — the URL state resets with the row.
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
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
        // CONTINUATION 16: the chat object is never created either
        // (the refused-before-creation semantics).
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
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
        // CONTINUATION 16: the chat object is never created (the
        // refused-before-creation semantics — the URL resets with
        // the filtered row).
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
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
// 6(b)) and the result-shape invariant (the frozen four-field record)
// that makes the cited three-field legacy record structurally
// unreachable at this tip.
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

test("every ok:true Start with a submission carries EXACTLY the frozen FOUR-FIELD submitted record (attempts, popupDismissals, composeReestablishments, generation)", async () => {
  // CONTINUATION 22 (PR #6 review 5125571572, path (b)): the
  // popupDismissals accounting is RESTORED with the known-popup
  // recovery — the frozen four-field invariant (PR #6 review
  // 5123260890, requirement 2: "the existing four-field submission
  // result invariant"). There are exactly TWO ok:true Start shapes:
  // the idempotent alreadyActive re-report (NO submitted record at
  // all) and recordSubmission — the only submission path, which
  // reports exactly {attempts, popupDismissals,
  // composeReestablishments, generation}. This regression pins the
  // invariant on the direct-acceptance, the popup-recovery, and the
  // compose-re-establishment paths.
  const FOUR_FIELDS = ["attempts", "composeReestablishments", "generation", "popupDismissals"];

  // (1) The direct acceptance path.
  const happy = build();
  const okResult = await happy.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(okResult.ok, true, JSON.stringify(okResult));
  assert.deepEqual(Object.keys(okResult.submitted).sort(), FOUR_FIELDS);
  assert.equal(okResult.submitted.popupDismissals, 0);
  assert.equal(okResult.submitted.composeReestablishments, 0);

  // (2) The KNOWN-POPUP recovery path (the dismissed popup counted).
  const popup = build({
    popupOnSend: true,
    popupText: "Confirm your submission",
    beforeRespond: (message, state) => {
      if (message.op === "pressEnter") {
        state.popupOnSend = false;
      }
    },
  });
  const popupResult = await popup.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(popupResult.ok, true, JSON.stringify(popupResult));
  assert.deepEqual(Object.keys(popupResult.submitted).sort(), FOUR_FIELDS);
  assert.equal(popupResult.submitted.popupDismissals, 1);

  // (3) The compose-re-establishment path (the second observed
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
        // the submission did not land, so the chat object was never
        // created either (the provider's refused-before-creation
        // path) — the URL state resets with the row.
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
        state.stop.visible = false;
      }
    },
  });
  const recoveredResult = await recovered.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(recoveredResult.ok, true, JSON.stringify(recoveredResult));
  assert.deepEqual(Object.keys(recoveredResult.submitted).sort(), FOUR_FIELDS);
  assert.equal(recoveredResult.submitted.composeReestablishments, 1);
  assert.equal(recoveredResult.submitted.popupDismissals, 0);

  // (4) The idempotent alreadyActive re-report carries NO submitted
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
  // CONTINUATION 16: the captured surface's turn actually completed
  // (the captured assistant capacity reply proves it), so the chat
  // object EXISTS on this surface — the exhaustion routes the
  // ACCEPTED-NOT-STARTED diagnosis (the compose re-establishment is
  // chat-state-gated OFF: the input was not discarded; the provider
  // accepted SOMETHING — the near-miss — and the bounded attempts
  // re-verify byte-identically through the ordinary gate path, the
  // provider's own concurrency gate the only duplicate guard).
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/chat object was created/.test(result.error.message), result.error.message);
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
  // CONTINUATION 16: the compose re-establishment is chat-state-gated
  // OFF on this surface (the chat object exists — the captured
  // assistant reply proves a completed turn): the input was not
  // discarded, so the circular-control recovery never fires; the
  // bounded attempts re-type through the ordinary gate-verified path.
  const composeClicks = built.pages[0].history().filter((c) => c.op === "click" && c.selector === COMPOSE_CONTROL).length;
  assert.equal(composeClicks, 0);
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

test("a Start whose exact prompt is ALREADY in the message evidence with a decisively-empty composer never resends — the landed message is CONTEXT ONLY and the absent start signal fails closed (no duplicate submission)", async () => {
  // Requirement 5 (PR #6 review 5123047551) + CONTINUATION 15 (PR
  // #6 review 5124990727 + review 5125102305): when the provider state
  // shows the prompt already landed (message rows carry the exact
  // prompt, composer decisively empty — e.g. the in-memory registry
  // was lost on service-worker restart after a landed submission),
  // the re-run Start re-establishes the idempotent preparation and
  // re-observes for the AGENT-START signal WITHOUT typing or sending
  // again (a landed message is never resent). With NO start signal
  // ever appearing on this surface (nothing generating), the watch
  // fails closed with the queued/completed-unobserved diagnosis —
  // the message evidence is context only, never the acceptance
  // predicate, and never a resend trigger.
  const { adapter, pages } = build({
    conversation: [PROMPT],
    // CONTINUATION 16: a landed prompt means an accepted submission —
    // the session's chat object exists (the surface is an EXISTING
    // chat at /c/<id>, not a fresh session at the origin base).
    chatUrl: "https://chat.z.ai/c/prior-session-42",
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/queued or have completed unobserved/.test(result.error.message), result.error.message);
  const history = pages[0].history().filter((c) => c.op !== "probe");
  assert.deepEqual(
    history.filter((c) => c.op !== "pressEnter").map((c) => c.op),
    ["click", "click", "click"] // preparation only
  );
  assert.equal(history.filter((c) => c.op === "type").length, 0); // never typed
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
  // The fixture's default successful send renders the Stop control
  // immediately (the generation-in-flight surface) with the new turn
  // landed, so the Start records the start signal on its FIRST
  // post-send observation (CONTINUATION 20 — no completion
  // transition is required for the acceptance; the c14
  // Send-reappearance boundary is superseded). The hung state is
  // then re-armed by the caller-facing line below.
  const built = build({ ...options });
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
  assert.equal(result.recovered.acceptance, "agent-start"); // CONTINUATION 15: the start signal is the acceptance
  assert.equal(result.recovered.generation, "working");
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  // The acceptance evidence: the exact recovery wording landed in
  // the conversation — never an alternative, never merely a resumed
  // generation state.
  assert.ok(pages[0].state.conversation.includes("continue"));
  // The async-outcome hold's probes are filtered; the recovery's
  // non-probe tail is the governed chain: [click(Stop), type,
  // click(send)] — exactly ONE continue typed.
  const history = pages[0].history().filter((c) => c.op !== "probe");
  const tail = history.slice(-4);
  const types = tail.filter((c) => c.op === "type");
  assert.equal(types.length, 1);
  assert.equal(types[0].text, "continue");
  // No Enter ever: the recovery path has no popup recovery.
  assert.equal(history.filter((c) => c.op === "pressEnter").length, 0);
});

test("recovery where the provider DROPS the `continue` row: the conversation-state ADVANCEMENT is the acceptance — a row that never lands fails the started recovery closed (the operator observes; the resumed generation is context, never the proof)", async () => {
  // CONTINUATION 20 (PR #6 comment 5559533083, the superseding
  // execution directive): "prompt acceptance = conversation state
  // advances with a new turn" — the user-turn advancement is now a
  // REQUIRED leg of the start signal (the user-turn count advanced
  // past the dispatch baseline AND the exact correlated text landed
  // as a user-message row), with the Send→Stop working state as
  // corroborating evidence. A provider that drops the landed row
  // from the conversation surface never shows the advancement: the
  // watch exhausts and the recovery FAILS CLOSED with the typed
  // diagnosis — the resumed generation's Stop control and the
  // cleared composer are context, never the proof. (The c15
  // "row-drop never fails a started recovery" tolerance is
  // superseded by the directive's acceptance hierarchy; the
  // operator's reported runtime — "subsequent successful prompts
  // add another message/turn to chat.history.messages" — has the
  // successful prompt ALWAYS adding the turn, so the dropped-row
  // surface is a REFUSAL surface under this contract.)
  const built = await hungSession({
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button" && state.composerValue === "continue") {
        state.__sentRecovery = true;
      }
      if (message.op === "probe" && state.__sentRecovery) {
        state.__sentRecovery = false;
        // The provider dropped the recovery message from the
        // conversation surface: it never landed as a user message
        // even though the generation resumed and the composer cleared.
        if (state.conversation[state.conversation.length - 1] === "continue") {
          state.conversation.pop();
        }
      }
    },
  });
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  // The advancement never showed: the recovery fails closed with the
  // typed diagnosis — never an inferred success, never a record.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/agent-start watch exhausted|post-response|Observe the session/i.test(result.error.message));
  // The exact fixed message never landed in the conversation evidence.
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
  // The resumed generation's surface held (context, not the proof):
  // the Stop control visible with the composer decisively empty.
  assert.equal(built.pages[0].state.stop.visible, true);
  assert.equal(built.pages[0].state.composerValue, "");
  // Bounded: the fixed message was typed exactly once (the watch's
  // exhaustion deliberately does NOT loop a fresh attempt — a retry
  // would re-Stop the RESUMED generation and re-send `continue`).
  const recoveriesTyped = built.pages[0].history().filter((c) => c.op === "type" && c.text === "continue").length;
  assert.equal(recoveriesTyped, 1);
});

test("recovery without a registry entry (the service-worker restart) runs the governed sequence from the request's own correlation — never SESSION_UNKNOWN", async () => {
  // CONTINUATION 15 (PR #6 review 5124829301, requirement 6: "Do not
  // require a persistent in-memory session across service-worker
  // restarts for the operation described above; recovery behavior
  // must follow the same Send-control rule") — the operator's
  // SESSION_UNKNOWN live run is the motivating evidence. A LOST
  // registry no longer refuses: the request itself carries the
  // Worker/Work-Item/tab correlation and the governed sequence (the
  // Stop-visible precondition -> the adapter-owned Stop -> verified
  // stopped -> the exact `continue` -> the agent-start watch) runs
  // from it, succeeding on the start signal. A registry entry that
  // CONTRADICTS the request still fails closed STALE_REFERENCE (the
  // separate regressions below).
  const { adapter, pages } = build();
  pages[0].state.stop.visible = true; // the hung generation (the service worker restarted; the registry is gone)
  const result = await adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.acceptance, "agent-start");
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.ok(pages[0].state.conversation.includes("continue"));
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

test("a provider dialog visible during hung recovery fails closed UNKNOWN_DIALOG — the bounded popup recovery applies only to submission (never a blind keypress)", async () => {
  // CONTINUATION 22 (PR #6 review 5125571572, path (b) — the frozen
  // Work Order's dialog law): the KNOWN-POPUP Enter path is defined
  // ONLY for the submission flow (its full-restart semantics — Agent
  // -> model -> prompt -> send — belongs to Start); a dialog visible
  // during the recovery fails closed UNKNOWN_DIALOG. Zero Enter
  // presses, zero Stop clicks — the dialog is never inspected beyond
  // its classification, never dismissed.
  const built = await hungSession();
  built.pages[0].state.dialog = { text: "Some modal" };
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "UNKNOWN_DIALOG");
  assert.ok(/applies only to submission/.test(result.error.message), result.error.message);
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // never an Enter
  const stopClicks = built.pages[0].history().filter(
    (c) => c.op === "click" && String(c.selector).includes('aria-label="Stop"')
  );
  assert.equal(stopClicks.length, 0); // the governed Stop was never reached — the precheck refused first
  assert.ok(built.pages[0].state.dialog); // never dismissed, never consulted beyond the typed classification
  assert.ok(built.pages[0].state.conversation.includes("continue") === false); // the fixed message was never typed
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
  assert.equal(result.recovered.acceptance, "agent-start"); // CONTINUATION 15: the start signal is the acceptance
  assert.ok(built.pages[0].state.conversation.includes("continue"));
  // The adapter's own Stop happened through the long-task-labeled
  // candidate (the real post-stop surface rendered: the Regenerate
  // control became visible — context only, never clicked).
  assert.equal(built.pages[0].state.regenerate.visible, true);
  assert.ok(!built.pages[0].state.regenerate.clicked, "the Regenerate control must never be clicked");
});

test("a Regenerate control appearing after the adapter's own Stop is CONTEXT ONLY — it is never clicked; under the conversation-advancement acceptance a dropped `continue` row fails the recovery closed (the operator observes)", async () => {
  // Requirement 4 (PR #6 comment 5557087907): "Generation resuming, a
  // cleared composer, or a Regenerate button appearing are context
  // only and never acceptance by themselves." CONTINUATION 20 (PR #6
  // comment 5559533083): the acceptance is the CONJUNCT — the
  // conversation-state advancement (the new `continue` turn landed)
  // WITH the provider-owned working state (the Stop control) — so
  // this surface (the post-stop Regenerate control visible, the send
  // control back, the `continue` row DROPPED by the hook) has no
  // advancement: the recovery fails closed with the typed
  // post-response/unobserved diagnosis. The Regenerate control is
  // never clicked as a remedy or an acceptance.
  const built = await hungSession({
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button" && state.composerValue === "continue") {
        state.__sentRecovery = true;
      }
      if (message.op === "probe" && state.__sentRecovery) {
        state.__sentRecovery = false;
        // The provider dropped the recovery message from the
        // conversation surface: it never landed as a user message
        // even though the post-response context looks healthy.
        if (state.conversation[state.conversation.length - 1] === "continue") {
          state.conversation.pop();
        }
      }
    },
  });
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  // No conversation advancement: fail closed with the typed
  // diagnosis — the Regenerate surface and the cleared composer are
  // context, never the proof.
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/agent-start watch exhausted|post-response|Observe the session/i.test(result.error.message));
  // The post-response surface rendered and the Regenerate control was never clicked.
  assert.equal(built.pages[0].state.regenerate.visible, true);
  assert.ok(!built.pages[0].state.regenerate.clicked, "the Regenerate control must never be clicked");
  // The dropped row never landed — the advancement requirement is
  // what fails the recovery (the c20 acceptance leg).
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
  assert.equal(built.pages[0].state.composerValue, "");
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
  const built = await hungSession();
  // The session's prompt is in the conversation evidence AND back in
  // the composer un-submitted (a failed retry re-entered it); the
  // generation has ended (no Stop control).
  built.pages[0].state.stop.visible = false;
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
        // stays decisively disabled). CONTINUATION 16: the chat
        // object never lands either (the refused-before-creation
        // semantics).
        state.conversation = state.conversation.filter((t) => t !== PROMPT);
        state.chatCreated = false;
        state.url = "https://chat.z.ai/";
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
  // CONTINUATION 15: the never-taking send exhausts the watch with
  // the exact text still in the composer — the bounded re-send
  // route, never a claimed submission.
  assert.ok(/remains in the composer/.test(result.error.message), result.error.message);
  // The preparatory control state (the send control computed ENABLED
  // with the exact prompt in the composer) held on every post-typing
  // read — and never produced a submitted record.
  const lastGate = suppress.pages[0].history().filter((c) => c.op === "probe").at(-1);
  assert.ok(lastGate.probes.some((p) => p.name === "sendEnabled"));
  assert.equal(result.submitted, undefined);
});

test("the Stop control replacing the send control IS THE AGENT-START SIGNAL — the acceptance is recorded AT THE SIGNAL (the provider's own in-flight computation), and the completion swap-back is CONTEXT", async () => {
  // CONTINUATION 15 (PR #6 review 5124990727 + review 5125102305 — the
  // "verified Send->Stop/action-control transition" the review names
  // as the preferred detector): the continuation-14 boundary law is
  // REVERSED — the provider's slot swap send -> Stop is the
  // provider's OWN computed proof that a current message is in
  // flight (an Agent generation actively working), and the
  // acceptance is recorded AT THE SIGNAL with the composer
  // decisively empty (the draft consumed): one send click, ZERO
  // Enter nudges (the signal is present before any cadence tick),
  // generation:"working". The completion transition (the Stop
  // control disappears, the send control returns, the Regenerate
  // control renders) is CONTEXT — a completed-unobserved generation
  // inside the watch's observation gap fails closed with the
  // post-response diagnosis (the (b) arm).
  const { adapter, pages } = build(); // generates: true — the Stop control appears on the send and stays (the generation in flight)
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.generation, "working"); // the start signal itself
  assert.equal(result.submitted.composeReestablishments, 0);
  // The single send click of the whole run; ZERO Enter nudges.
  assert.equal(pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 1);
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  // The signal held at the recording read: the Stop control visible with the composer decisively empty.
  assert.equal(pages[0].state.stop.visible, true);
  assert.equal(pages[0].state.composerValue, "");
  assert.ok(pages[0].state.conversation.includes(PROMPT)); // the landed row — context

  // (b) The completion INSIDE the watch's observation gap (a short
  // generation: the Stop control appears and completes between
  // probes): the start signal is never observed, the watch fails
  // closed with the post-response/completed-unobserved diagnosis —
  // never a claimed submission, never a resend.
  const completing = build({ generationCompletes: 1 }); // completes on the FIRST post-send probe — inside the observation gap
  const completed = await completing.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(completed.ok, false, JSON.stringify(completed));
  assert.equal(completed.error.code, "AMBIGUOUS_STATE");
  assert.ok(/queued or have completed unobserved/.test(completed.error.message), completed.error.message);
  assert.equal(completing.pages[0].state.regenerate.visible, true); // the real post-response surface rendered
  assert.ok(!completing.pages[0].state.regenerate.clicked); // the Regenerate control is never automated
  assert.equal(completing.pages[0].state.conversation.filter((t) => t === PROMPT).length, 1); // landed once, never resent
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
  // CONTINUATION 22: the contradictory slot refuses the send click at
  // the gate (the click fires only on the "send" control state), the
  // watch observes its full bounded windows as PURE OBSERVATION (ZERO
  // Enters — no dialog was ever observed), and the exhaustion refuses
  // on the contradictory slot: never a claimed submission.
  assert.equal(stuck.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  const sends = stuck.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length;
  assert.equal(sends, 1); // the initial send only — the post-send slot turned contradictory (the stuck surface renders both controls) and the retries never click again
  assert.ok(!("submitted" in result), "a contradictory control state never produces a submitted record");
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
  // CONTINUATION 22: the watch observes its full bounded windows on
  // the untrustworthy surface as PURE OBSERVATION (ZERO Enters — no
  // dialog was ever observed, and the Enter never resubmits an empty
  // composer anyway), and NOTHING ELSE runs after the send: no
  // compose-control click, no resend. The exhaustion refuses on the
  // enabled-vs-empty contradiction.
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
  assert.deepEqual(postSend.map((c) => c.op), []); // no automation after the send — pure observation only
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
  assert.ok(/enabled state could not be read decisively/.test(result.error.message), result.error.message);
  // CONTINUATION 22: the watch observes its full bounded windows as
  // PURE OBSERVATION (ZERO Enters); the exhaustion refuses on the
  // unreadable control state.
  assert.equal(doubled.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  assert.ok(!("submitted" in result), "an unreadable control state never produces a submitted record");
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
  // exact "continue" -> the agent-start-signal acceptance.
  // CONTINUATION 14: generationCompletes: null overrides the helper default — the
  // queued-surface model needs NO completion transition (the Stop interval must stay
  // open for the recovery to find it).
  const built = await hungSession();
  built.pages[0].state.stop.visible = false; // the queued state — the generation is NOT yet active (no Stop control)
  built.pages[0].state.pendingStop = 2; // the generation becomes active on the 2nd fact read
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.recovered.message, "continue");
  assert.equal(result.recovered.acceptance, "agent-start"); // CONTINUATION 15: the start signal is the acceptance
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
  const built = await hungSession();
  built.pages[0].state.stop.visible = false; // the queued state persists — the Stop interval never opens
  const historyBefore = built.pages[0].history().length;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/hung precondition/.test(result.error.message));
  assert.ok(/decisively DISABLED/.test(result.error.message));
  assert.ok(/start signal itself/.test(result.error.message), result.error.message);
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
  const built = await hungSession();
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
// primary execution state machine. SUPERSEDED c14 FRAMING, corrected
// to the CURRENT law (CONTINUATION 15/20 — the assertions were always
// updated; these comments now state the current semantics): the
// acceptance is the agent-start signal, recorded BEFORE any
// completion; the Send control's disappearance/reappearance is a
// modeled provider transition, CONTEXT ONLY. The laws,
// regression-pinned: the Send control disappears (the Stop
// replacement while the generation is in flight) and reappears on
// completion — context, never the acceptance; an INACCESSIBLE Send
// control routes into the agent-start watch whose timed Enter
// cadence is the recovery (the existing page primitive, never popup
// handling, zero dialog inspection) with the state machine
// continuing through the re-observation; a Send control that never
// becomes resolvable fails closed after the bounded retry budget;
// the click itself failing routes the same recovery; and the
// recovery's continue-send uses the same control-state rule.
// --------------------------------------------------------------------

test("the Send-control state machine: the send control DISAPPEARS (the Stop control replacing it while the generation is in flight) and REAPPEARS on completion — a CONTEXT-ONLY transition, the acceptance recorded at the start signal and HELD through the async-outcome window", async () => {
  // The full machine: press Send -> the action slot swaps to the Stop
  // control (the Send control ABSENT — the transient missing Send the
  // wait tolerates, never an error) -> the generation completes ->
  // the slot swaps back to the send control (the REAPPEARANCE) — a
  // CONTEXT-ONLY provider transition: the acceptance is the START
  // SIGNAL (the landed exact turn advancing the conversation state,
  // the Stop control corroborating), observed on the FIRST post-send
  // read. Here the completion lands on the 2nd fact read: the watch's
  // first read observed the signal, and the ASYNC-OUTCOME HOLD (the
  // c22 gate) then observes the completion within its bounded window
  // — the hold's completed-generation early exit resolves the async
  // outcome (a generation that ran to completion was accepted — no
  // late popup can follow), and the recording still describes the
  // SIGNAL moment (generation "working", the completion
  // unclassified context).
  const built = build({ generationCompletes: 2 });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.generation, "working"); // the start signal — the recording describes the acceptance moment
  assert.equal(result.submitted.composeReestablishments, 0);
  // The completion landed INSIDE the async-outcome hold window (the
  // 2nd fact read) — the hold resolved the outcome and returned; the
  // completion itself is unclassified context (never an acceptance
  // predicate, never a refusal).
  assert.equal(built.pages[0].state.regenerate.visible, true); // the completion rendered within the hold window
  assert.ok(built.pages[0].state.conversation.includes(PROMPT));
  // No Enter in the ordinary machine: the send control was resolvable
  // at the send step, the click succeeded, and no dialog was ever
  // observed.
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
});

test("the Send control INACCESSIBLE at the send step: NO Enter is ever issued (the frozen Work Order reserves Enter for the OBSERVED known popup alone) — the send is never clicked and the bounded attempts fail closed with the typed unresolvable-slot diagnosis", async () => {
  // CONTINUATION 22 (PR #6 review 5125571572, path (b)): the
  // directive-era Enter fallback at the send step is REMOVED — the
  // frozen Work Order's ONLY Enter is the observed-known-popup
  // recovery, and "the adapter must not blindly press keys." The
  // `sendInaccessible` knob models the slot rendering NEITHER
  // control: the gate never clicks (the slot is not the send
  // control), the watch observes (pure observation), and the bounded
  // attempt budget fails closed with the typed unresolvable-slot
  // diagnosis — never a keypress, never a claimed submission.
  const built = build({ sendInaccessible: true });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/neither the send control nor the Stop control/.test(result.error.message), result.error.message);
  // ZERO keypresses: an unresolved send control is NEVER a blind-key
  // surface — the Enter exists only for the observed known popup.
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 0); // nothing landed
  assert.ok(!("submitted" in result), "an unresolvable control state never produces a submitted record");
});

test("the send click itself failing (the slot re-rendering TWO send controls — an ambiguous click target): NO Enter fallback exists — the bounded attempts re-attempt the REAL send control and fail closed with the typed unreadable-control diagnosis", async () => {
  // CONTINUATION 22: the directive-era Enter fallback is REMOVED.
  // The surface re-renders TWO send controls so the click REFUSES
  // (the page script's exactly-one rule — never a best-effort
  // click). No key is pressed (the Enter exists only for the
  // observed known popup): every bounded attempt re-verifies the
  // prompt, re-attempts the real send control, and the budget ends
  // in the typed unreadable-control refusal — the prompt is never
  // submitted through a keypress, never claimed.
  const built = build({
    beforeRespond: (message, state) => {
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.duplicateSend = true; // the surface re-rendered TWO send controls — every subsequent click refuses
      }
    },
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/enabled state could not be read decisively/.test(result.error.message), result.error.message);
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0); // never a blind keypress
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 3); // each bounded attempt re-attempted the REAL control
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 0); // nothing landed
  assert.ok(!("submitted" in result));
});

test("the Send control never becoming resolvable: the bounded retry budget fails closed with the typed unresolvable-slot diagnosis — ZERO Enters, never a claimed submission", async () => {
  // The persistent variant: the `sendInaccessible` knob persists —
  // the slot never re-renders the Send control. No key is ever
  // pressed (the Enter exists only for the observed known popup);
  // every bounded attempt re-verifies the prompt, never clicks, and
  // the watch's exhaustion analysis refuses with the
  // unresolvable-slot diagnosis. The budget ends in the typed
  // failure.
  const built = build({
    generates: false,
    sendInaccessible: true, // persists — the slot never re-renders a control
  });
  const result = await built.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/neither the send control nor the Stop control/.test(result.error.message), result.error.message);
  // ZERO keypresses across every bounded attempt — the watch is PURE
  // OBSERVATION.
  assert.equal(built.pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  // The Send control was never clicked.
  assert.equal(built.pages[0].history().filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  // Nothing landed — no acceptance was ever claimed from the
  // unresolvable surface.
  assert.equal(built.pages[0].state.conversation.filter((t) => t === PROMPT).length, 0);
  assert.ok(!("submitted" in result), "an unresolvable control state never produces a submitted record");
});

test("the recovery's continue-send with an INACCESSIBLE Send control: NO Enter fallback exists — the fixed `continue` stays unsubmitted in the composer and the recovery fails closed with the typed unresolvable-slot diagnosis (never a blind keypress)", async () => {
  // CONTINUATION 22: the frozen Work Order's Enter is the
  // observed-known-popup recovery during SUBMISSION alone — the
  // recovery's continue-send has NO fallback. After the adapter's
  // own verified Stop, the post-stop re-render leaves the slot
  // rendering NEITHER control (the hook arms `sendInaccessible` on
  // the Stop click): the read-back verifies the exact fixed
  // `continue` byte-identically, the send click is impossible, no
  // key is pressed, and the watch's exhaustion analysis refuses on
  // the untrustworthy unresolvable slot (the composer still holding
  // the fixed message). Failure to confirm a required transition is
  // a typed governance-hold outcome.
  const built = await hungSession({
    beforeRespond: (message, state) => {
      if (message.op === "click" && String(message.selector).includes('aria-label="Stop"')) {
        state.sendInaccessible = true; // the post-stop re-render broke the slot — the Send control unresolvable at the continue-send
      }
    },
  });
  const historyBeforeRecovery = built.pages[0].history().length;
  const result = await built.adapter.recoverHungWorker({ worker: "w1", workItem: "CTRL-014", tabId: 7 });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/neither the send control nor the Stop control/.test(result.error.message), result.error.message);
  const recoveryOps = built.pages[0].history().slice(historyBeforeRecovery).filter((c) => c.op !== "probe");
  assert.equal(recoveryOps.filter((c) => c.op === "pressEnter").length, 0); // never a blind keypress
  assert.equal(recoveryOps.filter((c) => c.op === "click" && c.selector === "#send-message-button").length, 0);
  // The fixed message was typed and read back byte-identically but
  // never submitted through a keypress.
  assert.equal(built.pages[0].state.composerValue, "continue");
  assert.ok(!built.pages[0].state.conversation.includes("continue"));
});

// --------------------------------------------------------------------
// CONTINUATION 23 — THE CHAT-TAB BASELINE (PR #6 comments 5560253287 +
// 5560261256, the ARCHITECT directives; the LIVE-OBSERVED unauthenticated
// Chat-surface experiment, 2026-09-06 15:41-16:09Z).
// --------------------------------------------------------------------

test("THE CHAT REFERENCE PATH: Start mode \"chat\" runs the LIVE-PROVEN unauthenticated Chat lifecycle — ZERO Agent-pill clicks, ZERO model clicks, ZERO provisioning wait — and records the four-field submission through the shared signal", async () => {
  // The directive's reference implementation: the ordinary Chat tab is
  // ready-for-input AT REST (LIVE-OBSERVED: the composer visible and
  // enabled on the unauthenticated surface before any interaction), so
  // the chat mode skips the entire Agent preparation (the explicitly
  // isolated Agent delta) and runs the shared submission lifecycle:
  // type -> send -> the advancement-based start signal -> the record.
  const { adapter, pages } = build({ authenticated: false });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.session, { worker: "w1", workItem: "CTRL-014", tabId: 7 });
  // The frozen FOUR-FIELD record (the pre-c13 invariant) — the mode
  // does not widen the submitted shape.
  assert.deepEqual(Object.keys(result.submitted), ["attempts", "popupDismissals", "composeReestablishments", "generation"]);
  assert.equal(result.submitted.attempts, 1);
  assert.equal(result.submitted.generation, "working");
  // THE EXPLICITLY-ISOLATED AGENT DELTA, pinned by absence: no mode
  // pill, no model trigger, no model option is ever touched.
  const clicks = pages[0].history().filter((c) => c.op === "click").map((c) => c.selector);
  assert.equal(clicks.includes("#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type"), false);
  assert.equal(clicks.includes('button[aria-label="Select a model"]'), false);
  assert.equal(clicks.some((s) => String(s).includes('aria-label="model-item"')), false);
  assert.deepEqual(clicks, ["#send-message-button"]); // the send alone
  // The chat-mode session registry records the mode (the recovery and
  // the observations carry the authentication posture).
  assert.equal(pages[0].state.conversation.includes(PROMPT), true);
  assert.equal(pages[0].state.composerValue, "");
});

test("THE CHAT BASELINE'S AUTH-MARKER LAW: the unauthenticated Chat surface (the \"Sign in\" call-to-action beside a functional composer) is the ACCEPTED baseline for mode \"chat\" — and the typed AUTHORIZATION_REQUIRED refusal for the governed mode \"agent\" (the delta pinned on both sides)", async () => {
  // PR #6 comment 5560261256: "the real Z.ai Chat tab baseline does NOT
  // require authentication and the worker must NOT gate on
  // authentication when performing the baseline experiment"; point 6:
  // "do NOT infer that the Agent-tab authentication behavior is
  // applicable to Chat mode". LIVE-OBSERVED: the auth CTA count read 1
  // the entire session while the composer was ready and the submission
  // was accepted.
  const chat = build({ authenticated: false });
  const chatResult = await chat.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(chatResult.ok, true, JSON.stringify(chatResult));
  // The AGENT mode on the SAME surface: the frozen Work Order's
  // authenticated-session contract, unchanged.
  const agent = build({ authenticated: false });
  const agentResult = await agent.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "agent" });
  assert.equal(agentResult.ok, false);
  assert.equal(agentResult.error.code, "AUTHORIZATION_REQUIRED");
  // And the absent mode is the governed agent default.
  const absent = build({ authenticated: false });
  const absentResult = await absent.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT });
  assert.equal(absentResult.ok, false);
  assert.equal(absentResult.error.code, "AUTHORIZATION_REQUIRED");
});

test("THE HUMAN-VERIFICATION GATE (the c23 discovery): the body-level Aliyun captcha popup visible during the watch — while the start signal's legs ALL fire (the row landed, the composer cleared, the URL advanced, the slot swapped) — is NEVER the acceptance and NEVER the known popup: the typed HUMAN_VERIFICATION_REQUIRED refusal, zero Enter presses (the operator's out-of-band action)", async () => {
  // The LIVE-OBSERVED modality (15:43:18-15:48): the first post-send
  // read carries the landed row, the cleared composer, the /c/<chatId>
  // URL, the Stop control — AND the body-level captcha popup that the
  // dialog channel cannot see (dialogCount 0). The adapter never
  // solves it and never presses Enter on it.
  const { adapter, pages } = build({ authenticated: false, humanVerificationOnSend: 0 });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "HUMAN_VERIFICATION_REQUIRED");
  assert.ok(/interactive human verification/.test(result.error.message), result.error.message);
  assert.ok(/out of band/.test(result.error.message), result.error.message);
  // ZERO Enter presses — the captcha is never the known popup (the
  // Enter path is reserved for the observed dialog-channel popup
  // alone), and no retry burns the budget (the refusal is terminal).
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
  assert.equal(pages[0].history().filter((c) => c.op === "type").length, 1); // the prompt typed exactly once (no restart loop)
  // The dialog channel never saw it: the fixture's captcha resolves
  // only through #aliyunCaptcha-window-popup (no dialog selector).
  assert.equal(pages[0].state.humanVerification.visible, true);
});

test("THE HUMAN-VERIFICATION PRECHECK: the captcha popup visible before preparation fails closed in BOTH modes before anything is typed", async () => {
  const { adapter, pages } = build({ authenticated: false, humanVerification: true });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "HUMAN_VERIFICATION_REQUIRED");
  // Nothing typed, nothing sent, nothing clicked.
  const ops = pages[0].history().filter((c) => c.op !== "probe").map((c) => c.op);
  assert.deepEqual(ops, []);
  // The governed agent mode refuses identically (the gate is
  // mode-independent).
  const agent = build({ authenticated: true, humanVerification: true });
  const agentResult = await agent.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "agent" });
  assert.equal(agentResult.ok, false);
  assert.equal(agentResult.error.code, "HUMAN_VERIFICATION_REQUIRED");
});

test("THE HUMAN-VERIFICATION OBSERVATION: ObserveZaiSession reports the typed human-verification-required state (the thirteenth vocabulary entry, LIVE-OBSERVED)", async () => {
  const { adapter } = build({ authenticated: false, humanVerification: true });
  const result = await adapter.observeSession("w1");
  assert.equal(result.ok, true);
  assert.equal(result.observation.state, "human-verification-required");
  assert.ok(/Aliyun captcha/.test(result.observation.detail), result.observation.detail);
});

test("THE TURN-INDEX BADGE LAW (the c23 discovery): the in-flight turn's user row renders as the exact prompt followed by whitespace and the \"N/M\" badge (LIVE-OBSERVED \"... the word OK.         2/2\") — the start signal fires on the badge-suffixed row; a leading-character near-miss still fails; a foreign badge text still fails", async () => {
  // The successful second submission on an existing chat: the new row
  // carries the badge while the generation is in flight.
  const { adapter, pages } = build({
    authenticated: false,
    chatUrl: "https://chat.z.ai/c/fixture-existing",
    conversation: ["An earlier turn"],
    turnIndexBadge: true,
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.submitted.generation, "working");
  // The landed row IS the badge-suffixed form.
  const expectedRow = `${PROMPT}         2/2`;
  assert.ok(pages[0].state.conversation.includes(expectedRow));
  // The near-miss: a row that lost the leading character (the
  // operator's captured `ispatch ...` surface) never satisfies the
  // exact-row predicate even with a badge — the watch exhausts.
  // (Modeled through the foreign-turn discriminator below.)
  const foreign = build({
    authenticated: false,
    chatUrl: "https://chat.z.ai/c/fixture-existing",
    conversation: ["An earlier turn"],
    turnIndexBadge: true,
    beforeRespond: (message, state) => {
      // Corrupt the typed text BEFORE the send lands it: the row lands
      // as the near-miss + badge — never the exact predicate.
      if (message.op === "send" || (message.op === "click" && message.selector === "#send-message-button")) {
        state.composerValue = state.composerValue.slice(1);
      }
    },
  });
  const foreignResult = await foreign.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(foreignResult.ok, false, JSON.stringify(foreignResult));
  assert.notEqual(foreignResult.error.code, "INTERNAL_ERROR");
});

test("THE COMPLETION-ERROR LAW (the c23 discovery): the provider's completed-with-error surface — the assistant row reading \"No response, Please try again later. SyntaxError: ...\" with the action-slot facts IDENTICAL to a successful completion (the send control back, the Stop gone, the Regenerate visible) — is a typed PROVIDER_ERROR refusal inside the async-outcome hold, never an accepted outcome", async () => {
  // The LIVE-OBSERVED modality (15:59:26): the captcha was solved, the
  // generation "completed" — and the assistant row rendered the
  // provider's completion error. The action-slot facts alone are
  // INDISTINGUISHABLE from success (the review's ok:true-while-broken
  // class); the assistant-row text is the only discriminator.
  const { adapter } = build({
    authenticated: false,
    // The completion transition INSIDE the hold window, after the
    // start signal's stop-visible read (arm on the first read, complete
    // on the second — the signal fires on the first).
    generationCompletes: 2,
    completionErrorText: "No response, Please try again later. SyntaxError: Unexpected token '<', \"<!doctypeh\"... is not valid JSON",
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "PROVIDER_ERROR");
  assert.ok(/completion error/.test(result.error.message), result.error.message);
  assert.ok(/No response/.test(result.error.message), result.error.message);
  // A QUIET completed surface (no error text) still accepts through
  // the hold's early exit — the regression does not weaken the
  // acceptance (a successful completion remains a completion).
  const quiet = build({
    authenticated: false,
    generationCompletes: 2,
    assistantText: "The governed response.",
  });
  const quietResult = await quiet.adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(quietResult.ok, true, JSON.stringify(quietResult));
  assert.equal(quietResult.submitted.generation, "working");
});

test("THE CHAT-MODE HUNG WORKER + THE RECOVERY: the retained-draft Stop surface (the LIVE-OBSERVED unauthenticated dispatch modality — the slot reporting a task while the draft is retained) routes the exhaustion with the slot fact in the typed detail; a chat-mode session's recovery keeps the unauthenticated posture", async () => {
  // The exhaustion surface: the composer retains the exact text while
  // the Stop control renders with the send control REMOVED from the
  // slot (the LIVE-OBSERVED hang: #send-message-button absent, the
  // Stop control present, the draft retained, no row landed).
  const { adapter, pages } = build({
    authenticated: false,
    generates: false, // the slot swap never happens on the send
    stop: { visible: false },
    beforeRespond: (message, state) => {
      // After the send, force the LIVE-OBSERVED hang surface: the slot
      // reports Stop (the send control gone from the DOM) while the
      // draft is retained.
      if (message.op === "click" && message.selector === "#send-message-button") {
        state.composerValue = PROMPT; // the draft retained
        state.stop.visible = true; // the slot reports a task
        state.sendInaccessible = true; // the send control removed (the real slot swap)
        state.conversation.pop(); // no row landed
      }
    },
  });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chat" });
  assert.equal(result.ok, false, JSON.stringify(result));
  // The typed exhaustion: the retained-draft refusal with the c23
  // slot-state detail (never ok, never a blind resend).
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/remains in the composer/.test(result.error.message), result.error.message);
  assert.ok(/Stop control while the draft is retained/.test(result.error.message), result.error.message);
  assert.equal(pages[0].history().filter((c) => c.op === "pressEnter").length, 0);
});

test("THE MODE VALIDATION: an unknown Start mode is the typed refusal (the closed vocabulary — never a guessed behavior)", async () => {
  const { adapter } = build({ authenticated: false });
  const result = await adapter.startWorkerSession({ worker: "w1", workItem: "CTRL-014", prompt: PROMPT, mode: "chatbot" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "AMBIGUOUS_STATE");
  assert.ok(/"chat" or "agent"/.test(result.error.message), result.error.message);
});
