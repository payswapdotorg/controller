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
 *     5. enter the EXACT Controller-generated governed prompt verbatim
 *        (byte-identical read-back BEFORE any send);
 *     5b. PRE-SEND GATE (continuation 6, PR #6 review 5123047551): a
 *         FRESH decisive composer read immediately before the send —
 *         the exact prompt must STILL be present, verbatim; an
 *         unreadable, empty, or rewritten composer is NEVER sent;
 *     6. send — the composer action-slot STATE MACHINE (continuation
 *        14, PR #6 review 5124542353 / the work order 5557596159):
 *        the Send control must be RESOLVED/ACCESSED decisively (the
 *        provider's own slot renders send XOR Stop). When it cannot
 *        be — the slot renders the Stop control, a contradictory or
 *        unresolvable slot, or the send click itself fails — the
 *        ENTER FALLBACK fires exactly ONCE for that attempt: the
 *        existing Enter page primitive (closed-vocabulary,
 *        command-gated) is pressed — the pre-send gate has just
 *        verified the exact prompt decisively present in the
 *        composer, so the Enter submits it — and the state machine
 *        continues into the Send-reappearance wait. The fallback is
 *        for an inaccessible/unavailable Send control ONLY: never
 *        popup recognition, never dialog inspection, and never a
 *        second Enter within the same attempt (the bounded attempt
 *        budget governs the retries);
 *     7. WAIT boundedly until the Send control REAPPEARS, then verify
 *        ACTUAL submission from the resulting provider state —
 *        MESSAGE-EXCLUSIVE USER-message evidence only: the exact
 *        prompt observed as an EXACT user-message row, with a
 *        DECISIVELY empty composer (an absent or ambiguous
 *        composer read is never "cleared" and never "present").
 *        A TRANSIENT missing Send control (the Stop control
 *        replacing it while the generation is in flight — the
 *        provider's own slot machine) is NOT an error: the wait
 *        tolerates it within the bounded budget. The acceptance is
 *        recorded ONLY at the Send-reappearance boundary — never
 *        while the control state is stop; a Stop state persisting
 *        past the budget fails closed with the typed mid-generation
 *        diagnosis (a confirmed submission is NEVER resent); a Send
 *        control reappearing WITHOUT the exact user-message evidence
 *        is the contract's unsuccessful branch (the bounded
 *        exact-prompt re-establishment/resend); a Send control that
 *        never becomes resolvable fails closed after the bounded
 *        retry budget. Containment in a mixed message REGION (user
 *        + assistant text, e.g. `[role="log"]`) is never acceptance
 *        evidence — an assistant echo of the exact prompt with an
 *        empty composer is not a submission (continuation 9, PR #6
 *        review 5123260890, requirement 2). `generation:"waiting"`
 *        is reported context only — it NEVER participates in the
 *        acceptance predicate. Broad region matches are never
 *        acceptance evidence.
 *
 *   provider dialogs are NOT a governed signal (continuation 13, PR
 *   #6 review 5124488246 — the ARCHITECT work order "REMOVE POPUP
 *   DETECTION/RECOVERY PATH"): the adapter performs NO dialog
 *   recognition, NO provider-specific popup shape matching, NO
 *   submission hold watching for a delayed/async popup, NO
 *   Enter-based popup dismissal, NO popup resend path, and NO
 *   popupDismissals accounting. A visible dialog is never used as a
 *   positive or negative signal on the normal CTRL-014 path — the
 *   governed Start and Recover flows proceed on the control-state
 *   and message-evidence facts alone (a dialog that physically
 *   blocks the surface expresses itself through those facts: an
 *   unreadable composer, a send that does not take, a bounded
 *   budget exhaustion — every one of them fails closed through the
 *   ordinary bounded paths). The ONLY Enter the adapter ever issues
 *   is the continuation-14 Send-inaccessible fallback (exactly one
 *   per bounded attempt — never popup recognition, never dialog
 *   inspection, never a dismissal).
 *
 *   the second observed failure mode (continuation 6, PR #6 review
 *   5123047551): the input state can be discarded around a send
 *   attempt — the composer reads decisively empty while the
 *   submission is NOT confirmed by message evidence (the operator's
 *   captured post-run DOM: an empty `#chat-input` and a disabled
 *   `#send-message-button`, the prompt never entered). The bounded
 *   remediation re-establishes the input state through the
 *   provider's Agent/compose UI control (the operator-described
 *   circular control of the composer form), verifies the composer
 *   is visible and enabled, re-types the exact prompt
 *   byte-for-byte, re-reads it byte-for-byte, and only then resends
 *   — a bounded submission-recovery path, never a blind resend, and
 *   never a duplicate of an already-confirmed submission.
 *
 *   hung worker: `Stop` -> verified stopped -> the FIXED message
 *   `continue` -> verified acceptance (the exact message confirmed
 *   present in the user-message evidence with the composer cleared
 *   — a resumed generation state alone is NEVER
 *   acceptance evidence). The continue-send uses the SAME
 *   control-state rule as Start (continuation 14, PR #6 review
 *   5124542353): the Send control resolved/accessed decisively, else
 *   the Enter fallback exactly once for that recovery attempt. The
 *   acceptance is the frozen message-exclusive evidence (recorded as
 *   soon as the exact `continue` lands with the composer decisively
 *   cleared — typically in the queued window with the Send control
 *   rendered, the reappearance trivially holding; a resumed
 *   generation observed at the acceptance read is reported as
 *   context, never the proof). No alternate recovery wording.
 *   Bounded attempts; failure to confirm a required transition is a
 *   typed governance-hold outcome.
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
 * The two dialog-shaped states ("expected-blocking-dialog",
 * "unexpected-dialog") are part of the spec-pinned vocabulary and
 * remain DECLARED, but since continuation 13 (PR #6 review
 * 5124488246) removed dialog recognition they are no longer
 * PRODUCED: no classification path observes dialogs, so a visible
 * provider dialog can never surface as (or influence) a session
 * observation.
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
 * the model-selector trigger, the model option rows, the alert
 * surface, and the authentication call-to-action button texts were
 * all observed on the live provider surface (unauthenticated
 * landing state).
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
  // CONTINUATION 13 (PR #6 review 5124488246): the dialog locator is
  // REMOVED — the adapter performs no dialog recognition at all; a
  // visible provider dialog is never probed, never classified, and
  // never a signal on the governed paths.
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
  // The provider Stop control (CONTINUATION-11, PR #6 comment
  // 5557087907, requirement 2 facts — LIVE-OBSERVED wrapper family +
  // provider-bundle-proven slot): the composer action slot renders
  // through a bits-ui Tooltip trigger — a DIV carrying
  // data-tooltip-trigger whose aria-label is the computed tooltip
  // content (LIVE-OBSERVED family: every one of the ten wrappers in
  // the operator's saved authenticated capture at main 5d14d90 is a
  // div[data-tooltip-trigger][aria-label=...], including the send
  // slot's aria-label="Send Message" wrapping #send-message-button).
  // The provider's own bundle code swaps that slot between the send
  // control and the Stop control (the render conditional: no current
  // message or the current message done -> send; otherwise -> Stop —
  // exactly the operator's observation "Z.ai then replaced Stop with
  // the normal send control") and computes the Stop tooltip content
  // as "Stop" OR the long-task text "The current task is in progress.
  // Please cancel it before starting other tasks." — the SAME control
  // in two label states. The bundle attaches the abort click handler
  // to the INNER button (a synthetic click on the wrapper div never
  // reaches a descendant handler), so the live-observed candidates
  // resolve the inner button THROUGH the wrapper's machine label; the
  // pre-correction button[aria-label="Stop"] / button[title="Stop"]
  // candidates are retained only as trailing fallbacks (they match
  // ZERO elements on the live wrapper-div surface — the pre-correction
  // adapter could never see or click the real Stop control).
  stopControl: Object.freeze([
    '[data-tooltip-trigger][aria-label="Stop"] button',
    '[data-tooltip-trigger][aria-label^="The current task is in progress"] button',
    'button[aria-label="Stop"]',
    'button[title="Stop"]',
  ]),
  stopText: "Stop",
  // The post-response Regenerate control (CONTINUATION-11, LIVE-OBSERVED
  // in the operator's saved authenticated capture at main 5d14d90 and
  // bundle-proven): the bits-ui tooltip wrapper
  // div[data-tooltip-trigger][aria-label="Regenerate"] wrapping the
  // provider's own button.regenerate-response-button (a circular
  // svg.size-5 icon; the class list toggles "visible" /
  // "invisible group-hover:visible" — only the completed/stopped
  // last response's control is visible). CONTEXT ONLY: the frozen
  // recovery needs NO regeneration (post-stop the composer is enabled
  // and the send control is back, so the fixed `continue` is typed and
  // sent directly); this locator exists for the post-response
  // DIAGNOSTIC fact only and is NEVER a click target.
  postResponseRegenerate: '[data-tooltip-trigger][aria-label="Regenerate"] button.regenerate-response-button',
  // AUTHENTICATED-SURFACE-DECLARED message-evidence candidates. The
  // CONTINUATION-6 ELIMINATION (PR #6 review 5123047551): the
  // acceptance predicate previously consulted BROAD region
  // candidates ('[class*="conversation"]', '[class*="message-list"]',
  // 'main') — surfaces that are NOT message-exclusive. A sidebar or
  // history region whose rendered text can contain the exact prompt
  // (e.g. an earlier conversation titled with the governed prompt)
  // combined with an empty or ambiguous composer read produced the
  // live FALSE POSITIVE: Start reported `submitted` (attempts=1,
  // popupDismissals=0, generation="waiting") while the operator's
  // post-run DOM showed an EMPTY `#chat-input` and a DISABLED send
  // control — the prompt had never been entered. LIVE-OBSERVED
  // 2026-09-06 (real origin, fact-only): the broad candidates match
  // ZERO elements on the live surface — they were never
  // live-observed acceptance surfaces at all.
  //
  // THE CONTINUATION-9 ELIMINATION (PR #6 review 5123260890,
  // requirement 2 — "exact prompt observed in message-exclusive
  // user-message evidence"): the `[role="log"]` REGION-containment
  // path is REMOVED as an acceptance surface (not merely demoted).
  // The region carries assistant text as well as user text — an
  // assistant echo of the exact prompt with a decisively-empty
  // composer would confirm a submission that never happened. The
  // region also matched ZERO elements on the LIVE-OBSERVED
  // authenticated surface (the operator's captured run,
  // 2026-09-06: `role="log"` count 0), while the user-message row's
  // trimmed text IS the exact submitted prompt byte-for-byte (the
  // captured row reads "ispatch APP-001 ..." for the submitted
  // "ispatch APP-001 ..." — the row is the verbatim submission; the
  // intended prompt's leading "D" loss is caught by the EXACT-row
  // equality). A region that can match non-user text is never
  // user-message evidence; acceptance is the EXACT USER-MESSAGE ROW
  // ONLY, and the broad candidates stay REMOVED.
  userMessage: Object.freeze([
    '[class*="user"][class*="message"]',
    '[data-role="user"]',
    '[class*="user-message"]',
  ]),
  // The composer Agent/compose UI control — the operator-described
  // CIRCULAR control (PR #6 review 5123047551, requirement 3): the
  // bounded input-state re-establishment path. LIVE-OBSERVED
  // 2026-09-06 (real origin, fact-only, zero clicks): the composer
  // FORM that contains `#chat-input` renders EXACTLY THREE buttons —
  // `#upload-file-button` (aria-label "More"), the Agent/compose
  // toggle (NO id, NO aria-label, ALWAYS carrying the provider's
  // universal mode marker data-active "true"|"false"), and
  // `#send-message-button`. The structural candidate resolves that
  // unique data-active button of the composer form; a wrong or
  // shifted structure resolves to zero/many and the re-establishment
  // fails closed (never a blind click).
  composeControl: Object.freeze(["form:has(#chat-input) button[data-active]"]),
});

/** The exact model the Work Order freezes for new worker sessions. */
const ZAI_MODEL = Object.freeze({
  label: "GLM-5.3",
  providerId: "5.3",
});

/** The FIXED hung-worker recovery message — no alternate wording. */
const ZAI_RECOVERY_MESSAGE = "continue";

/** The alert-surface text pattern that classifies a provider error. */
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
 *           settleIntervalMs?: number,
 *           maxSubmissionAttempts?: number, maxRecoveryAttempts?: number }} wiring
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
    // CONTINUATION 12 (PR #6 comment 5557322324, requirements 2-3): the
    // provider's OWN computed composer-emptiness signal. The provider
    // bundle computes `#send-message-button`.disabled from the composer
    // text (disabled when the trimmed input is empty — plus its
    // connection/role gates) and swaps the composer action slot between
    // the send control and the Stop control on the current-message-done
    // conditional, so the send control's enabled state is an
    // independent provider-computed observation of "a prompt is present",
    // cross-checking the raw #chat-input value read. The page script's
    // "enabled" probe mode reads exactly this (disabled property +
    // aria-disabled), degrading to a null fact on a zero/many match.
    { name: "sendEnabled", selector: ZAI_LOCATORS.send, mode: "enabled" },
    { name: "alertVisible", selector: ZAI_LOCATORS.alert, mode: "visible" },
  ];

  const STOP_PROBES = ZAI_LOCATORS.stopControl.map((selector, i) => ({
    name: `stopCandidate${i}`,
    selector,
    mode: "visible",
  }));

  // The post-response CONTEXT fact (continuation 11, PR #6 comment
  // 5557087907): the Regenerate control's visibility distinguishes the
  // post-response surface (the last response complete or stopped —
  // nothing to recover) from an unreadable/mid-transition surface. A
  // read-only fact: the control is NEVER a click target, and its
  // visibility is never an acceptance predicate.
  const POST_RESPONSE_PROBES = [
    { name: "postResponseRegenerate", selector: ZAI_LOCATORS.postResponseRegenerate, mode: "visible" },
  ];

  const EVIDENCE_PROBES = [
    { name: "alertText", selector: ZAI_LOCATORS.alert, mode: "text" },
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
      probes: [...BASE_PROBES, ...STOP_PROBES, ...POST_RESPONSE_PROBES, ...EVIDENCE_PROBES, ...extraProbes],
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

  // CONTINUATION 13 (PR #6 review 5124488246): the async
  // submission-outcome hold (continuation 10) is REMOVED together
  // with the whole popup recognition mechanism — no submission
  // window watches for a delayed/async dialog or the provider's
  // prompt restore. The acceptance follows the frozen rule directly:
  // the message-exclusive exact-row evidence + the decisively empty
  // composer, gated on control-state consistency.

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
  function stopVisible(facts) {
    return STOP_PROBES.some((probe) => facts[probe.name]?.visible === true);
  }

  /**
   * @private — the post-response CONTEXT observable (continuation 11,
   * PR #6 comment 5557087907): the Regenerate control visible on the
   * completed/stopped last response. Read-only diagnostic context —
   * never a click target, never an acceptance predicate.
   */
  function postResponseRegenerateVisible(facts) {
    return facts.postResponseRegenerate?.visible === true;
  }

  /**
   * A DECISIVE composer read (continuation 6, PR #6 review
   * 5123047551): exactly the string value when the composer resolved
   * to exactly one visible element, else null (absent OR ambiguous).
   * An ambiguous read is NEVER coerced: null is never "cleared"
   * (the pre-correction `?? ""` coercion treated an unreadable
   * composer as empty — a false-positive acceptance source) and
   * never "present". Callers must fail closed on null.
   */
  function composerValueOf(facts) {
    const value = facts.composerValue?.value;
    return typeof value === "string" ? value : null;
  }

  /**
   * @private — CONTINUATION 12 (PR #6 comment 5557322324, requirements
   * 2-3): the provider's own computed composer-emptiness signal, read
   * from the send control's enabled state. Decisive boolean when the
   * send control resolved to exactly one visible element, else null
   * (absent, ambiguous, or a fact the surface did not answer — never
   * guessed). `true` is the provider computing "a prompt is present";
   * `false` is the provider computing "no prompt" (the trimmed input
   * empty, plus its connection/role gates); null is an unreadable
   * control state — callers fail closed on null wherever the reading
   * is load-bearing.
   */
  function sendEnabledOf(facts) {
    const enabled = facts.sendEnabled?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  }

  /**
   * @private — CONTINUATION 12 (PR #6 comment 5557322324, requirements
   * 2-3): the EXPLICIT submission-state observation channel — the
   * composer action-slot reading. The provider's own bundle (the
   * composer action slot) renders the send control when there is no
   * current message or the current message is done, and swaps the slot
   * to the Stop control while the current message is in flight — the
   * two slots are MUTUALLY EXCLUSIVE on the real surface. The channel's
   * reading:
   *   "stop"          — the Stop control visible (the send control
   *                     absent): the provider's current message is in
   *                     flight — generation/submission ACTIVE. CONTEXT
   *                     ONLY, never acceptance evidence (requirement 4:
   *                     acceptance stays the message-exclusive exact-row
   *                     + decisively-empty-composer evidence).
   *   "send"          — the send control visible (Stop absent): no
   *                     in-flight current message. Whether a prompt is
   *                     present is the sendEnabled/composer reading.
   *   "contradictory" — BOTH controls visible: a malformed surface (the
   *                     real slot renders exactly one). Fails closed.
   *   "unresolvable"  — NEITHER control visible: the composer action
   *                     slot is absent or unreadable. Fails closed.
   */
  function controlStateOf(facts) {
    const stop = stopVisible(facts);
    const send = facts.sendVisible?.visible === true;
    if (stop && send) {
      return "contradictory";
    }
    if (stop) {
      return "stop";
    }
    if (send) {
      return "send";
    }
    return "unresolvable";
  }

  /**
   * @private — CONTINUATION 12 (PR #6 comment 5557322324, requirement 7:
   * "a contradictory/unreadable control state fails closed"), REVERSED
   * in its stop-state permission by CONTINUATION 14 (PR #6 review
   * 5124542353, the review's gap 1: "controlStateRefusal() explicitly
   * permits `stop` as a recording state" — no more): the
   * submission-acceptance control-state consistency gate. Returns a
   * typed AMBIGUOUS_STATE refusal when the recording facts carry a
   * contradictory or unreadable composer action-slot state, when the
   * provider's own computed prompt-present signal contradicts the
   * decisively-empty composer read (send ENABLED while #chat-input
   * reads "" — the composer read is untrustworthy and the acceptance
   * is never recorded from it), when the send control resolved
   * ambiguously (the enabled probe degraded to null on a zero/many
   * match while the control is visible), or — since continuation 14
   * — when the composer action slot STILL RENDERS THE STOP CONTROL
   * (the generation actively in progress): the acceptance is
   * recorded ONLY after the Send control REAPPEARS (the
   * state-machine boundary of the continuation-14 work order), never
   * while the control state is stop. Returns null when the control
   * state is consistent — the caller records the acceptance.
   */
  function controlStateRefusal(facts) {
    const control = controlStateOf(facts);
    if (control === "contradictory") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot is contradictory — both the send control and the Stop control are visible (the provider's slot renders exactly one); the submission acceptance is not recorded from an unreadable control state"
      );
    }
    if (control === "unresolvable") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot is unreadable — neither the send control nor the Stop control is visible; the submission acceptance is not recorded from an unreadable control state"
      );
    }
    // CONTINUATION 14 (PR #6 review 5124542353 — the review's gap 1):
    // a "stop" control state is NO LONGER a permitted recording state.
    // The reappearance of the Send control is now the state-machine
    // boundary: while the Stop control is rendered (the generation
    // actively in progress) the acceptance is never recorded.
    if (control === "stop") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot still renders the Stop control — the generation is actively in progress; since continuation 14 the acceptance is recorded only after the Send control reappears (the state-machine boundary), never while the control state is stop"
      );
    }
    const sendEnabled = sendEnabledOf(facts);
    if (control === "send" && facts.sendVisible?.visible === true && sendEnabled === null) {
      return failure(
        "AMBIGUOUS_STATE",
        "the send control's enabled state could not be read decisively (absent or ambiguous) while the control is visible — the submission acceptance is not recorded from an unreadable control state"
      );
    }
    if (sendEnabled === true && composerValueOf(facts) === "") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot contradicts the composer read — the provider's send control is computed ENABLED (a prompt present) while #chat-input reads decisively empty; the composer read is untrustworthy and the submission acceptance is not recorded from it"
      );
    }
    return null;
  }

  /**
   * The MESSAGE-EXCLUSIVE USER-message acceptance evidence
   * (continuation 6; tightened continuation 9, PR #6 review
   * 5123260890, requirement 2): the exact prompt observed as an
   * EXACT user-message row — the strongest provider-state proof
   * available, and the ONLY acceptance surface. LIVE-OBSERVED
   * 2026-09-06 (the operator's captured run): the user-message
   * row's trimmed text is the exact submitted prompt byte-for-byte,
   * and `[role="log"]` matched ZERO elements on the live surface.
   * Broad region matches (the eliminated candidates) are never
   * evidence: a non-message surface whose text contains the prompt
   * (a sidebar or history region) proved nothing while producing a
   * live false-positive `submitted` — never a guessed success. A
   * mixed message REGION (user + assistant text) is equally never
   * evidence: an assistant echo of the exact prompt with an empty
   * composer is not a submission. The near-miss row (the operator's
   * captured `ispatch ...` row for the intended `Dispatch ...`
   * prompt — the leading character lost) fails the exact-row
   * equality and never confirms.
   */
  function messageEvidenceContains(facts, text) {
    for (const probe of EVIDENCE_PROBES) {
      if (probe.name.startsWith("userMessageCandidate")) {
        const texts = facts[probe.name]?.texts;
        if (Array.isArray(texts) && texts.includes(text)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * The typed session-state classifier. `session` is the registry
   * record when the observation belongs to an active worker session
   * (null for a standalone observation). CONTINUATION 13 (PR #6
   * review 5124488246): dialogs are NEVER classified — a visible
   * provider dialog is not a signal; the classifier reads only the
   * alert surface, the auth markers, and the composer/control/message
   * facts.
   */
  function classifySession(facts, session) {
    const composerVisible = facts.composerVisible?.visible === true;
    const composerEnabled = facts.composerEnabled?.enabled === true;
    const composerValue = typeof facts.composerValue?.value === "string" ? facts.composerValue.value : null;
    const alertVisible = facts.alertVisible?.visible === true;
    const alertText = String(facts.alertText?.text ?? "");

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
      const promptPresent = messageEvidenceContains(facts, session.prompt);
      if (promptPresent && composerValue === "") {
        return { state: "prompt-submitted", detail: "the session prompt is confirmed present in the message evidence and generation is pending" };
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
   * CONTINUATION 13: a visible dialog is not consulted here — the
   * preparation proceeds on the control facts alone.
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
   * and fails closed. CONTINUATION 13: a visible dialog is not
   * consulted here — the preparation proceeds on the control facts
   * alone.
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
   * recovery loop: after an unconfirmed send, the exact prompt is
   * RESENT; the preparation is never restarted for a resend. Three
   * observed states:
   *   - the composer already holds the exact prompt (an unconfirmed
   *     send, or the submission was not accepted): it is sent as-is
   *     — the provider surface is not disturbed with a re-type;
   *   - the composer is DECISIVELY empty and the message evidence
   *     already contains the exact prompt: the submission is ALREADY
   *     CONFIRMED — no resend (the governed prompt is never submitted
   *     twice; acceptance is message-exclusive provider-state
   *     confirmation, never a blind resend);
   *   - otherwise: the prompt is (re)typed and the byte-identical
   *     read-back is verified BEFORE any send (a rewritten or
   *     truncated prompt is never submitted).
   * An ABSENT or AMBIGUOUS composer read is never "empty" and never
   * "present" — it fails closed (an unreadable input state is never
   * sent). CONTINUATION 13: a visible dialog is not consulted here —
   * the decision is made on the composer/message facts alone.
   */
  async function ensurePrompt(tabId, prompt) {
    const facts = await readFacts(tabId);
    if (!facts.ok) {
      return facts;
    }
    const composerValue = composerValueOf(facts.facts);
    if (composerValue === null) {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer value could not be read decisively (absent or ambiguous) — refusing to prepare a submission on an unreadable input state"
      );
    }
    if (composerValue === "" && messageEvidenceContains(facts.facts, prompt)) {
      return { ok: true, confirmed: true, facts: facts.facts };
    }
    if (composerValue === prompt) {
      // CONTINUATION 14 (PR #6 review 5124542353 / the work order
      // 5557596159, requirement 6 — "never duplicate an
      // already-confirmed user message", hardened): the composer
      // holds the exact prompt AND the message evidence already
      // carries it — the submission appears already confirmed (the
      // provider's restored copy over the landed row). The governed
      // prompt is never submitted twice: a typed refusal, never a
      // resend, never a re-type. (Without the evidence, the exact
      // prompt in the composer is the ordinary unconfirmed state —
      // sent as-is, the provider surface never disturbed with a
      // re-type.)
      if (messageEvidenceContains(facts.facts, prompt)) {
        return failure(
          "AMBIGUOUS_STATE",
          "the exact prompt is present in the composer AND in the message evidence — the submission appears already confirmed (the provider's restored copy over the landed row); the governed prompt is never submitted twice, so the bounded retry re-observes instead of resending"
        );
      }
      return { ok: true, present: true };
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

  /**
   * CONTINUATION 14 (PR #6 review 5124542353, requirement 5 — the
   * work order 5557596159): the Send-inaccessible Enter fallback.
   * Invokes the EXISTING page primitive (page/zaiPage.js pressEnter:
   * the closed-vocabulary Enter key dispatch on the focused element)
   * EXACTLY ONCE per bounded attempt, ONLY when the Send control
   * could not be resolved/accessed decisively (the slot rendering the
   * Stop control, a contradictory or unresolvable slot, or the send
   * click itself failing), and only AFTER the pre-send gate verified
   * the exact prompt decisively present in the composer — the focused
   * composer receives the Enter and submits it. This is NEVER popup
   * recognition or handling: no dialog is inspected, classified, or
   * dismissed by it, and no governed flow issues any other Enter.
   * The state machine continues from the Enter into the
   * Send-reappearance wait (the re-observation): a Send control that
   * becomes resolvable proceeds through the boundary; one that never
   * does fails closed after the bounded retry budget.
   */
  async function pressEnter(tabId) {
    return pageBridge.send(tabId, { zaiPage: true, op: "pressEnter" });
  }

  /**
   * The SECOND bounded submission-recovery path (continuation 6, PR
   * #6 review 5123047551, requirement 3): re-establish the composer
   * input state through the provider's Agent/compose UI control —
   * the operator-described CIRCULAR control of the composer form
   * (the unique data-active button of the form containing
   * `#chat-input`, LIVE-OBSERVED structure). The control must
   * resolve to EXACTLY ONE element — a blind click is never issued;
   * a zero/many resolution fails closed. The click is verified by
   * POST-ACTION OBSERVATION, never by the click itself: the composer
   * must become VISIBLE and ENABLED within the settle budget. This
   * path never types and never sends — the caller's next bounded
   * attempt re-types the exact prompt byte-for-byte, re-reads it
   * byte-for-byte, and only then resends.
   */
  async function reestablishComposer(tabId) {
    const controlProbes = ZAI_LOCATORS.composeControl.map((selector, i) => ({
      name: `composeControl${i}`,
      selector,
      mode: "count",
    }));
    const facts = await readFacts(tabId, controlProbes);
    if (!facts.ok) {
      return facts;
    }
    const counts = controlProbes.map((probe) => facts.facts[probe.name]?.count ?? 0);
    const resolved = counts.findIndex((count) => count === 1);
    if (resolved === -1) {
      return failure(
        "AMBIGUOUS_STATE",
        `the composer Agent/compose control did not resolve to exactly one element (candidate counts: ${counts.join("/")}) — the input state cannot be re-established`
      );
    }
    const clicked = await click(tabId, ZAI_LOCATORS.composeControl[resolved]);
    if (!clicked.ok) {
      return clicked;
    }
    // A click is NEVER evidence: verify the composer input state is
    // actually re-established — visible AND enabled (a decisive
    // enabled read requires the composer to resolve exactly once).
    const verified = await settle(tabId, [], (f) =>
      f.composerVisible?.visible === true && f.composerEnabled?.enabled === true
    );
    if (!verified.ok) {
      return verified;
    }
    if (
      verified.facts.composerVisible?.visible !== true ||
      verified.facts.composerEnabled?.enabled !== true
    ) {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer did not become a visible enabled input after the Agent/compose control click — the input state was not re-established"
      );
    }
    return { ok: true };
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
    // ready for the preparation sequence). CONTINUATION 13: a visible
    // dialog is never consulted — the precheck reads the
    // alert/auth-marker/composer facts only.
    const settled = await settle(tabId, [], (f) => {
      const c = classifySession(f, null);
      return c.state !== "ambiguous";
    });
    if (!settled.ok) {
      return settled;
    }
    const precheck = classifySession(settled.facts, null);
    if (precheck.state === "authentication-required") {
      return failure(
        "AUTHORIZATION_REQUIRED",
        `the chat.z.ai session is not authenticated: ${precheck.detail}. Human authentication is out of band — authenticate in the provider tab, then start the worker session again`
      );
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
    // attempt runs the full preparation (Agent -> model -> prompt).
    // CONTINUATION 13 (PR #6 review 5124488246): the popup recovery
    // branch is REMOVED — an unconfirmed send whose composer still
    // holds the exact prompt resends as-is (the pre-send gate
    // re-verifies it byte-for-byte); an already-confirmed submission
    // is never resent; a send that appears not to take (or a surface
    // a dialog renders unreadable) exhausts the bounded budget and
    // fails closed through the ordinary paths.
    let attempts = 0;
    let composeReestablishments = 0;
    let lastRefusal = null;
    let prepared = false;

    /**
     * Record the CONFIRMED submission (the shared acceptance path).
     * CONTINUATION 12 (PR #6 comment 5557322324, requirements 4-7): the
     * recording is GATED on the control-state consistency of the
     * recording facts — a contradictory or unreadable composer
     * action-slot state, or an enabled send control contradicting the
     * decisively-empty composer read, refuses the acceptance (fail
     * closed) instead of recording from an untrustworthy surface. The
     * frozen acceptance rule is UNCHANGED: a send/control transition is
     * context and cross-check only, never acceptance by itself — the
     * acceptance remains the MESSAGE-EXCLUSIVE exact-prompt evidence
     * plus the DECISIVELY empty composer. CONTINUATION 13: the
     * `submitted` record carries exactly the three popup-free fields
     * (attempts, composeReestablishments, generation) — the
     * popupDismissals accounting is removed with the popup mechanism.
     */
    const recordSubmission = (facts) => {
      const controlRefusal = controlStateRefusal(facts);
      if (controlRefusal) {
        return controlRefusal;
      }
      const generation = stopVisible(facts) ? "working" : "waiting";
      const record = {
        worker,
        workItem,
        tabId,
        prompt,
        attempts,
        composeReestablishments,
        submittedAt: now(),
        wasWorking: generation === "working",
        recoveries: 0,
      };
      sessions.set(worker, record);
      return {
        ok: true,
        session: { worker, workItem, tabId },
        submitted: { attempts, composeReestablishments, generation },
      };
    };

    /**
     * CONTINUATION 14 (PR #6 review 5124542353 / the ARCHITECT work
     * order 5557596159 — "REPLACE POPUP DETECTION WITH SEND-CONTROL
     * STATE MACHINE"): THE SEND-REAPPEARANCE BOUNDARY — the bounded
     * wait until the Send control REAPPEARS (the composer action slot
     * renders the send control again) with the resulting provider
     * state decidable-success: the exact prompt present in the
     * MESSAGE-EXCLUSIVE evidence with the composer decisively empty.
     * A TRANSIENT missing Send control (the Stop control replacing
     * it while the generation is in flight — the provider's own slot
     * machine) is NOT an error: the wait tolerates it within the
     * bounded settle budget. The wait is DECISIVE only on the success
     * boundary or a decisive failure surface (authentication required
     * / a provider error); every other observable keeps waiting — an
     * instantaneous Send-visible reading in the processing window
     * (the composer still holding the exact prompt) is
     * indistinguishable from the provider's restored copy at any
     * single instant, so only the decidable-success reading (or the
     * budget's exhaustion) routes the state machine: the duplication
     * protection. The EXHAUSTION analysis routes the final facts:
     *   - the boundary reached -> the acceptance is recorded (the
     *     recording gate refuses a contradictory/unreadable control
     *     state, and since continuation 14 a "stop" state too — the
     *     acceptance is NEVER recorded while the generation is in
     *     progress);
     *   - the Stop control persistently visible -> the typed
     *     mid-generation refusal: whether or not the submission is
     *     confirmed by the evidence, a confirmed submission is NEVER
     *     resent, and the bounded retry re-observes;
     *   - the evidence present on a non-recordable read (the composer
     *     holding text or unreadable) -> the never-resend refusal (a
     *     resend would duplicate the landed message);
     *   - the Send control reappeared WITHOUT the exact user-message
     *     evidence -> the contract's unsuccessful branch: the bounded
     *     exact-prompt re-establishment/resend (the next attempt); the
     *     DISCARDED variant (empty composer, no evidence) runs the
     *     compose re-establishment first;
     *   - a contradictory or unresolvable slot / an unreadable
     *     composer -> the existing fail-closed refusals.
     *
     * @returns {Promise<{recorded?: object, refusal: object,
     *                    reestablished?: boolean}>}
     */
    const sendBoundaryOutcome = async () => {
      const boundary = await settle(tabId, [], (f) => {
        const c = classifySession(f, null);
        if (c.state === "authentication-required" || c.state === "provider-error") {
          return true; // a decisive failure surface ends the wait
        }
        if (controlStateOf(f) !== "send") {
          return false; // the Send control has not reappeared — the transient missing-Send window (the Stop state) is tolerated, never an error
        }
        // THE BOUNDARY: the Send control reappeared AND the resulting
        // state is decidable-success (the exact prompt in the
        // message-exclusive evidence with the composer decisively
        // empty).
        return composerValueOf(f) === "" && messageEvidenceContains(f, prompt);
      });
      if (!boundary.ok) {
        return { refusal: boundary };
      }
      const f = boundary.facts;
      const verdict = classifySession(f, null);
      if (verdict.state === "authentication-required") {
        return {
          refusal: failure(
            "AUTHORIZATION_REQUIRED",
            `the chat.z.ai session lost authentication before the submission was accepted: ${verdict.detail}. Human authentication is out of band — authenticate in the provider tab, then start the worker session again`
          ),
        };
      }
      if (verdict.state === "provider-error") {
        return { refusal: failure("PROVIDER_ERROR", `the provider surfaced an error before the submission was accepted: ${verdict.detail}`) };
      }
      const control = controlStateOf(f);
      const composerValue = composerValueOf(f);
      const evidence = messageEvidenceContains(f, prompt);
      if (control === "send" && composerValue === "" && evidence) {
        // THE BOUNDARY reached: record the acceptance from the
        // MESSAGE-EXCLUSIVE evidence (the exact row + the decisively
        // empty composer), GATED on the control-state consistency of
        // the recording facts (the continuation-12 contradictions,
        // plus the continuation-14 stop-state refusal).
        const recorded = recordSubmission(f);
        if (recorded.ok) {
          return { recorded };
        }
        return { refusal: recorded };
      }
      // The MALFORMED control states refuse BEFORE any evidence
      // routing: a contradictory or unresolvable slot never yields a
      // recordable, resendable, or discardable reading — the surface
      // is unreadable and the typed refusal says so.
      if (control === "contradictory" || control === "unresolvable") {
        return { refusal: controlStateRefusal(f) };
      }
      if (control === "stop") {
        // The mid-generation outcome: the Stop control still rendered
        // (the generation actively in progress) and the Send control
        // not reappeared within the bounded wait. The acceptance is
        // recorded only at the boundary — and a submission confirmed
        // by the evidence is NEVER resent (the bounded retries
        // re-observe through the already-confirmed path).
        return {
          refusal: failure(
            "AMBIGUOUS_STATE",
            evidence
              ? "the Send control did not reappear within the bounded wait — the Stop control remains visible (the generation is actively in progress) while the submission is CONFIRMED by the message-exclusive evidence. The acceptance is recorded only at the Send-reappearance boundary (the continuation-14 state machine); the confirmed submission is NEVER resent — observe the session, or widen the settle budget and re-invoke Start"
              : "the Send control did not reappear within the bounded wait — the Stop control remains visible (a generation is in progress) and the exact prompt's submission is not confirmed by message evidence; the bounded retry re-observes"
          ),
        };
      }
      if (evidence) {
        // The submission is CONFIRMED by the evidence but the boundary
        // did not open on a recordable read: the composer holds text
        // (the provider's restored copy over the landed row) or is
        // unreadable. Never resent — a resend would duplicate the
        // landed message; the bounded retry re-observes.
        return {
          refusal: failure(
            "AMBIGUOUS_STATE",
            composerValue !== null
              ? "the exact prompt is present in the message evidence AND the composer holds text (the provider's restored copy or a pending state) — the submission appears already confirmed and the governed prompt is never submitted twice; the bounded retry re-observes"
              : "the exact prompt is present in the message evidence but the composer state could not be read decisively — the acceptance is not recorded from an untrustworthy surface and the confirmed submission is never resent; the bounded retry re-observes"
          ),
        };
      }
      if (control === "send" && composerValue !== null && composerValue.length > 0) {
        // The contract's UNSUCCESSFUL branch: the Send control
        // reappeared WITHOUT the exact user-message evidence (the
        // prompt was returned to or remains in the composer). The
        // bounded retry re-establishes the exact prompt
        // byte-identically (ensurePrompt verifies it — a restored
        // exact prompt is sent as-is) and resends.
        return {
          refusal: failure(
            "PAGE_MALFORMED",
            "the Send control reappeared without the exact user-message evidence — the prompt was returned to or remains in the composer and the submission was not confirmed by observation; the bounded retry re-establishes the exact prompt byte-identically and resends"
          ),
        };
      }
      if (control === "send" && composerValue === "") {
        const refusal = controlStateRefusal(f);
        if (refusal) {
          return { refusal };
        }
        // The SECOND observed failure mode (PR #6 review 5123047551,
        // requirement 3): the composer decisively empty, the submission
        // NOT confirmed by message evidence — the provider discarded
        // the input state around the send attempt. The bounded compose
        // re-establishment; the next attempt re-types the exact prompt
        // byte-for-byte, re-reads it byte-for-byte, and only then
        // resends.
        const reestablished = await reestablishComposer(tabId);
        if (reestablished.ok) {
          return {
            refusal: failure(
              "PAGE_MALFORMED",
              "the prompt was not present in the composer after the send attempt (submission not confirmed by message evidence) — the composer input state was re-established for a re-typed, re-verified resend"
            ),
            reestablished: true,
          };
        }
        return { refusal: reestablished };
      }
      const refusal = controlStateRefusal(f);
      if (refusal) {
        return { refusal };
      }
      return {
        refusal: failure(
          "AMBIGUOUS_STATE",
          "the composer state could not be read decisively after the send (absent or ambiguous) — submission is unconfirmed"
        ),
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
        // The submission was already confirmed by MESSAGE-EXCLUSIVE
        // provider-state evidence (e.g. the send landed while the
        // verification was reading): never resend the governed prompt.
        // CONTINUATION 14: the recording WAITS for the
        // Send-reappearance boundary — the shared boundary wait + the
        // exhaustion analysis (a "stop" control state never records;
        // the bounded retry re-observes, never resends a confirmed
        // submission).
        const outcome = await sendBoundaryOutcome();
        if (outcome.recorded) {
          return outcome.recorded;
        }
        if (outcome.reestablished) {
          composeReestablishments += 1;
        }
        lastRefusal = outcome.refusal;
        continue;
      }
      // 5b. The PRE-SEND GATE (continuation 6, PR #6 review
      //     5123047551, requirement 1): the exact prompt must be
      //     verified present in the composer by a FRESH DECISIVE read
      //     immediately before the send — an unreadable, empty, or
      //     rewritten composer is NEVER sent. The provider can
      //     discard the input state between the read-back and the
      //     send; the gate catches it and the bounded recovery
      //     re-establishes the input state for a re-typed,
      //     re-verified resend on the next attempt.
      const gate = await readFacts(tabId);
      if (!gate.ok) {
        lastRefusal = gate;
        continue;
      }
      if (composerValueOf(gate.facts) !== prompt) {
        const reestablished = await reestablishComposer(tabId);
        if (reestablished.ok) {
          composeReestablishments += 1;
          lastRefusal = failure(
            "PAGE_MALFORMED",
            "the exact prompt was not present in the composer at the send gate (an unreadable, empty, or rewritten composer is never sent) — the composer input state was re-established for a re-typed, re-verified resend"
          );
        } else {
          lastRefusal = reestablished;
        }
        continue;
      }
      // 6. SEND — the composer action-slot state machine (CONTINUATION
      //    14, PR #6 review 5124542353 / the work order 5557596159):
      //    the Send control must be RESOLVED/ACCESSED decisively (the
      //    provider's own slot renders send XOR Stop). When the gate
      //    facts show the slot NOT rendering the Send control (the
      //    Stop state, a contradictory, or an unresolvable slot), or
      //    when the send click itself fails, the ENTER FALLBACK fires:
      //    the existing Enter page primitive exactly ONCE for this
      //    attempt (the pre-send gate has just verified the exact
      //    prompt decisively present in the composer, so the focused
      //    composer's Enter submits it), and the state machine
      //    continues into the Send-reappearance wait. The fallback is
      //    for an inaccessible/unavailable Send control ONLY — never
      //    popup recognition, never dialog inspection, and no second
      //    Enter within the same attempt (the bounded attempt budget
      //    governs the retries).
      let sent = false;
      if (controlStateOf(gate.facts) === "send") {
        const clicked = await send(tabId);
        sent = clicked.ok;
      }
      if (!sent) {
        const enter = await pressEnter(tabId);
        if (!enter.ok) {
          lastRefusal = enter;
          continue;
        }
      }
      // 7. THE SEND-REAPPEARANCE BOUNDARY: the bounded wait until the
      //    Send control REAPPEARS, then the boundary inspection —
      //    success (the exact prompt in the message-exclusive evidence
      //    with the composer decisively empty) records the acceptance;
      //    the contract's unsuccessful branch (the Send control
      //    reappeared without the evidence) routes the bounded
      //    re-establish/resend; a Stop state that persists past the
      //    budget fails closed with the typed mid-generation diagnosis
      //    (a confirmed submission is NEVER resent); the contradictory/
      //    unresolvable/unreadable surfaces fail closed through the
      //    existing control-state refusals. CONTINUATION 13: a visible
      //    dialog is never a decisive signal here — the wait reads only
      //    the control-state, composer, and message-evidence facts.
      const outcome = await sendBoundaryOutcome();
      if (outcome.recorded) {
        return outcome.recorded;
      }
      if (outcome.reestablished) {
        composeReestablishments += 1;
      }
      lastRefusal = outcome.refusal;
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
      // CONTINUATION 12 (PR #6 comment 5557322324, requirement 8 — the
      // diagnosis of the repeated AMBIGUOUS_STATE immediately after a
      // successful Start whose result says generation:"waiting"):
      // Start returns when the SUBMISSION is confirmed (message-
      // exclusive evidence), which can PRECEDE the generation becoming
      // ACTIVE — the provider's composer action slot renders the Stop
      // control only while a current message is in flight, so a
      // queued-but-not-yet-active generation shows the send control
      // with no Stop. The pre-correction settle treated the FIRST
      // non-ambiguous classification as decisive — a "ready-for-input"
      // reading (composer enabled, no Stop) resolved IMMEDIATELY and
      // the precondition refusal fired before the Stop-visible
      // interval could open: exactly the operator's repeated
      // AMBIGUOUS_STATE. The correction: the precondition's bounded
      // wait now WAITS for the Stop-visible interval to OPEN (or a
      // decidable alternative to appear — the post-response surface,
      // a composer holding text, or a decisive failure surface) within
      // the same bounded settle budget. The frozen recovery contract
      // is UNALTERED: the adapter still owns Stop -> verify stopped ->
      // exact continue -> conversation evidence, the precondition
      // still requires the Stop control visible before any action,
      // and an exhaustion still fails closed — the wait only tolerates
      // the generation-start latency the provider itself exhibits.
      const observed = await settle(tabId, [], (f) => {
        const c = classifySession(f, session);
        if (["authentication-required", "provider-error"].includes(c.state)) {
          return true; // a decisive failure surface ends the wait immediately
        }
        // The precondition's decidable outcomes: the generation ACTIVE
        // (Stop visible — both computed label states), the
        // post-response surface (the Regenerate control — the
        // generation already ended), or the composer holding text (the
        // prompt present — no active generation to recover).
        // CONTINUATION 13: a visible dialog is never a failure surface
        // here — the wait reads the control/message facts only.
        return (
          stopVisible(f) ||
          postResponseRegenerateVisible(f) ||
          (composerValueOf(f) !== null && composerValueOf(f).length > 0)
        );
      });
      if (!observed.ok) {
        lastRefusal = observed;
        continue;
      }
      const precheck = classifySession(observed.facts, session);
      if (precheck.state === "authentication-required") {
        return failure("AUTHENTICATION_INTERRUPTED", `authentication was required during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "provider-error") {
        return failure("PROVIDER_ERROR", `the provider surfaced an error during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "ambiguous") {
        // CONTINUATION 13: the dialog-driven UNKNOWN_DIALOG refusal is
        // removed (a visible dialog is never a signal in this flow —
        // PR #6 review 5124488246, requirement 6); only the genuinely
        // ambiguous CONTROL surface still fails closed.
        return failure(
          "AMBIGUOUS_STATE",
          `an ambiguous control surface is visible during recovery (the composer is not a decidable input surface): ${precheck.detail}`
        );
      }
      if (!stopVisible(observed.facts)) {
        // The CONTINUATION-11 post-response diagnostic (PR #6 comment
        // 5557087907): the operator's failed live run manually pressed
        // the provider Stop control BEFORE invoking the recovery — the
        // post-stopped surface has no Stop control, and the generic
        // refusal could not distinguish "already stopped/finished"
        // from an unreadable surface, which is exactly the ambiguity
        // that produced the failed run. When the post-response
        // observables are present (the Regenerate control visible AND
        // the composer enabled), the refusal names them and the wrong
        // procedure explicitly. Fail-closed either way — the recovery
        // is never attempted without the adapter-owned precondition,
        // and the Regenerate control is never automated.
        const postResponse =
          postResponseRegenerateVisible(observed.facts) &&
          observed.facts.composerEnabled?.enabled === true;
        if (postResponse) {
          return failure(
            "AMBIGUOUS_STATE",
            "the hung precondition (generation in progress) is not established — the provider Stop control is not visible and the post-response state is observed (the Regenerate control is visible and the composer is enabled: the last response is complete or stopped, so there is nothing to recover; if the generation was stopped manually before this call, that is the wrong procedure — invoke the recovery while generation is genuinely active so the adapter can own the governed Stop action)"
          );
        }
        // CONTINUATION 12 (requirement 8): the control-state-diagnosed
        // refusals. The composer holding text while no Stop control is
        // visible means the submission was not accepted or the prompt
        // was returned to the composer (the provider's own restore) —
        // there is no active generation to recover and the operator
        // procedure is a re-Start, not a recovery. Otherwise the bounded
        // wait did not observe the generation become active: the
        // queued-state refusal names the control-state reading and the
        // timing guidance (invoke while the Stop control is visibly
        // present, not merely immediately after Start returns).
        const composerValue = composerValueOf(observed.facts);
        if (composerValue !== null && composerValue.length > 0) {
          return failure(
            "AMBIGUOUS_STATE",
            "the hung precondition (generation in progress) is not established — the composer holds text and the send control is rendered with no Stop control visible: the submission was not accepted or the prompt was returned to the composer, so there is no active generation to recover; re-Start the worker session"
          );
        }
        const sendEnabled = sendEnabledOf(observed.facts);
        const controlDetail =
          sendEnabled === null
            ? "the send control's enabled state could not be read decisively"
            : sendEnabled
              ? "the send control is rendered ENABLED while the composer reads decisively empty (the provider computes a prompt present — the composer read is untrustworthy)"
              : "the send control is rendered decisively DISABLED with a decisively empty composer (the provider's own computed no-prompt state)";
        return failure(
          "AMBIGUOUS_STATE",
          `the hung precondition (generation in progress) is not established — the provider Stop control is not visible: ${controlDetail}, and the bounded wait did not observe the generation become active. A Start result carrying generation:"waiting" records a CONFIRMED submission whose generation start can lag (the provider's queued state); invoke the recovery while the provider is actively generating (the Stop control visibly present — both computed label states are handled), not merely immediately after Start returns`
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
      // The continue-send — the SAME control-state rule as Start
      // (CONTINUATION 14, PR #6 review 5124542353): the Send control
      // must be RESOLVED/ACCESSED decisively; when it cannot be (the
      // slot rendering the Stop control, a contradictory or
      // unresolvable slot, or the click itself failing), the ENTER
      // FALLBACK fires exactly ONCE for this recovery attempt — the
      // composer is verified to hold the exact fixed `continue`
      // byte-identically, so the focused composer's Enter submits it.
      // Never popup recognition, never dialog inspection.
      let sent = false;
      if (controlStateOf(readBack.facts) === "send") {
        const clicked = await send(tabId);
        sent = clicked.ok;
      }
      if (!sent) {
        const enter = await pressEnter(tabId);
        if (!enter.ok) {
          lastRefusal = enter;
          continue;
        }
      }

      // 4. verify acceptance: the EXACT fixed message `continue`
      // must be confirmed present in the MESSAGE-EXCLUSIVE
      // USER-message evidence (an exact user-message row — the
      // continuation-9 tightened surface; a mixed message region is
      // never evidence) with a DECISIVELY cleared composer — an
      // absent/ambiguous composer read is never "cleared" (the
      // message left the composer and landed in the conversation). A
      // resumed generation state — the Stop control returning, the
      // composer clearing — is observed context, NEVER acceptance
      // evidence: it does not identify the recovery message.
      // CONTINUATION 14 (PR #6 review 5124542353): the acceptance is
      // the frozen evidence rule and is recorded AS SOON AS the exact
      // `continue` lands with the composer decisively cleared —
      // typically in the queued window with the Send control rendered
      // (the reappearance trivially holding; pinned by the
      // regressions). The boundary wait is deliberately NOT extended
      // past a landed row: requirement 6 of the work order forbids
      // duplicating an already-confirmed user message, and a recovery
      // retry after an exhausted boundary wait would re-Stop the
      // RESUMED generation and re-send `continue` — exactly the
      // duplicate the frozen rule exists to prevent. A resumed
      // generation observed at the acceptance read is reported as
      // context (generation:"working"), never as the proof.
      // CONTINUATION 13: a visible dialog never ends this wait and
      // never fails it — the acceptance is decided on the
      // message/composer facts alone.
      const accepted = await settle(tabId, [], (f) => {
        const composerValue = composerValueOf(f);
        const cleared = composerValue === ""; // decisive only
        if (cleared && messageEvidenceContains(f, ZAI_RECOVERY_MESSAGE)) {
          return true; // acceptance confirmed by post-action evidence
        }
        // Decisive contradictions end the wait early (classified
        // below): authentication dropping, an error alert, an
        // ambiguous control surface. Anything else keeps waiting
        // within the bounded budget.
        const verdict = classifySession(f, session);
        return ["authentication-required", "provider-error", "ambiguous"].includes(verdict.state);
      });
      if (!accepted.ok) {
        lastRefusal = accepted;
        continue;
      }
      const f = accepted.facts;
      const composerValue = composerValueOf(f);
      const cleared = composerValue === ""; // decisive only
      const confirmed = messageEvidenceContains(f, ZAI_RECOVERY_MESSAGE);
      if (!(cleared && confirmed)) {
        // Classify a decisive contradiction if one ended the wait.
        const verdict = classifySession(f, session);
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
        if (verdict.state === "ambiguous") {
          // CONTINUATION 13: the dialog-driven UNKNOWN_DIALOG refusal is
          // removed (a visible dialog is never a signal in this flow);
          // only the genuinely ambiguous CONTROL surface fails closed.
          return failure(
            "AMBIGUOUS_STATE",
            `an ambiguous control surface is visible while verifying recovery-message acceptance: ${verdict.detail}`
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
  async function observePage(tabId, session) {
    const facts = await settle(tabId, [], (f) =>
      classifySession(f, session ?? null).state !== "ambiguous"
    );
    if (!facts.ok) {
      return { state: "ambiguous", detail: facts.error.message };
    }
    return classifySession(facts.facts, session ?? null);
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
