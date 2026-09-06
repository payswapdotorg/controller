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
 *     6. send;
 *     7. verify ACTUAL submission from the resulting provider state —
 *         MESSAGE-EXCLUSIVE USER-message evidence only: the exact
 *         prompt observed as an EXACT user-message row, with a
 *         DECISIVELY empty composer (an absent or ambiguous
 *         composer read is never "cleared" and never "present").
 *         Containment in a mixed message REGION (user + assistant
 *         text, e.g. `[role="log"]`) is never acceptance evidence —
 *         an assistant echo of the exact prompt with an empty
 *         composer is not a submission (continuation 9, PR #6
 *         review 5123260890, requirement 2). `generation:"waiting"`
 *         is reported context only — it NEVER participates in the
 *         acceptance predicate. Broad region matches are never
 *         acceptance evidence.
 *
 *   known submission-blocking popup: press `Enter` exactly once for
 *   that retry, verify the dismissal by post-action observation,
 *   then RESTART THE FULL PREPARATION SEQUENCE (Agent -> model ->
 *   prompt — the idempotent re-selection re-establishes every
 *   governed ground truth the popup interaction may have disturbed;
 *   continuation 9, PR #6 review 5123260890, requirement 3) and only
 *   then permit the same decisive submission acceptance. Never a
 *   bare resend on an unverified surface, never a resend of an
 *   already-confirmed submission, and never popup absence as
 *   success (acceptance is always the verified provider-state
 *   confirmation of step 7). Unknown/differently-shaped dialogs
 *   fail closed — the adapter never blindly presses keys.
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
 *   — a second bounded submission-recovery path alongside the
 *   known-popup path, never a blind resend, and never a duplicate
 *   of an already-confirmed submission.
 *
 *   hung worker: `Stop` -> verified stopped -> the FIXED message
 *   `continue` -> verified acceptance (the exact message confirmed
 *   present in the user-message evidence with the composer cleared
 *   — a resumed generation state alone is NEVER
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

/** Dialog text patterns that reclassify a dialog as auth or error. */
const AUTH_DIALOG_PATTERN = /sign\s*in|log\s*in|sign\s*up|authenticate|login/i;
const ERROR_DIALOG_PATTERN = /error|went\s*wrong|rate\s*limit|too\s*many|unavailable|failed|forbidden/i;
const PROVIDER_ALERT_PATTERN = /error|went\s*wrong|rate\s*limit|too\s*many|unavailable|failed|forbidden|denied/i;

/** Frozen default budgets (all constructor-injectable for tests). */
const DEFAULTS = Object.freeze({
  settlePolls: 8, // post-action observation polls per step
  settleIntervalMs: 400, // delay between polls
  confirmationHoldPolls: 10, // the post-confirmation async-outcome watch (continuation 10)
  maxSubmissionAttempts: 3, // bounded preparation/send/verify attempts
  maxRecoveryAttempts: 2, // bounded Stop/continue recovery attempts
});

/**
 * Create the Z.ai Worker adapter.
 *
 * @param {{ tabsApi: object, pageBridge: object, providerUrl?: string,
 *           sleep?: Function, now?: Function, settlePolls?: number,
 *           settleIntervalMs?: number, confirmationHoldPolls?: number,
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
  confirmationHoldPolls = DEFAULTS.confirmationHoldPolls,
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
    { name: "dialogCount", selector: ZAI_LOCATORS.dialog, mode: "count" },
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
    { name: "dialogText", selector: ZAI_LOCATORS.dialog, mode: "text" },
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

  /**
   * The ASYNC SUBMISSION-OUTCOME HOLD (continuation 10, PR #6 review
   * 5123872434, requirements 1-3). The REAL known blocking popup is
   * the provider's "Currently in peak hours" capacity dialog —
   * LIVE-OBSERVED in the operator's captured run (repository of
   * record, main 5d14d90): a bits-ui modal carrying role="dialog",
   * aria-modal="true" and data-state="open" that IS matched by the
   * adapter's `[role="dialog"], dialog` observation channel (the
   * modality is an accessible in-page DOM dialog — NOT a native or
   * browser-level modal). The provider's own bundle code (the
   * MODEL_CONCURRENCY_LIMIT error handler) proves the TIMING: the
   * prompt is optimistically landed and the composer cleared FIRST,
   * and the popup materializes only when the asynchronous
   * chat-completion error arrives — the same handler also RESTORES
   * the submitted prompt into the composer. The submission-
   * verification settle therefore observes the confirm-shaped state
   * (decisively-empty composer + the exact user-message row) BEFORE
   * the popup exists and closes its window: exactly the operator's
   * continuation-10 run — Start returned ok:true with attempts=1,
   * popupDismissals=0 while the popup was visibly present and never
   * dismissed (the Enter path was never REACHED, not never invoked).
   *
   * This hold re-opens the window: after the confirm-shaped state is
   * observed, the surface is watched for the bounded
   * confirmationHoldPolls budget for exactly the two observables of
   * that asynchronous outcome — a dialog (classified in the
   * verifying-submission phase: the known popup, or an auth/error/
   * unknown dialog that fails closed) and a composer that has been
   * refilled (the provider's own prompt restore — the unconfirmed
   * resend path). Outcomes:
   *   { held: true, facts }  — an async outcome observable appeared;
   *                           the caller dispatches on these fresher
   *                           facts (the known-popup Enter path, the
   *                           fail-closed dialog refusals, or the
   *                           unconfirmed bounded retry);
   *   { held: false, facts } — the confirmation HELD for the whole
   *                           budget (facts = the freshest quiet
   *                           read; null when no read succeeded);
   *                           the acceptance is recorded from it;
   *   { held: false, facts: null } — the outcome window was
   *                           UNWATCHABLE (every read failed): the
   *                           acceptance is NOT asserted without the
   *                           bounded popup watch — fail closed.
   * The hold never treats popup ABSENCE as success by itself: the
   * acceptance it returns is still the message-exclusive exact-row +
   * decisively-empty-composer evidence already observed, merely held
   * through the async-outcome window; a popup that materializes
   * beyond the bounded window is a live-evidence matter, never a
   * code-side guess.
   */
  async function holdForAsyncSubmissionOutcome(tabId) {
    let quiet = null;
    for (let i = 0; i < confirmationHoldPolls; i++) {
      await sleep(settleIntervalMs);
      const read = await readFacts(tabId);
      if (!read.ok) {
        continue; // a transport failure is not a submission outcome
      }
      quiet = read.facts;
      const dialog = classifyDialog(read.facts, "verifying-submission");
      if (dialog.kind !== "none") {
        return { held: true, facts: read.facts };
      }
      const value = composerValueOf(read.facts);
      if (value !== null && value.length > 0) {
        return { held: true, facts: read.facts };
      }
      // CONTINUATION 12 (PR #6 comment 5557322324, requirements 2-3):
      // the control-state channel's OWN async-outcome observable. The
      // provider's MODEL_CONCURRENCY_LIMIT handler restores the prompt
      // into the composer AND recomputes the send control ENABLED in the
      // SAME reactive update — so an enabled send control during the
      // hold is the provider's own "a prompt is (back) present"
      // computation even when the raw #chat-input value read itself
      // lags or degrades (the restore path focuses and resizes the
      // textarea before the read stabilizes). The enabled reading fires
      // the SAME held dispatch as a refilled composer: the unconfirmed
      // bounded retry path. A decisively disabled send control (the
      // at-rest/emptied state — the provider's own computed "no prompt")
      // is NOT an outcome and never fires the hold.
      if (sendEnabledOf(read.facts) === true) {
        return { held: true, facts: read.facts };
      }
    }
    return { held: false, facts: quiet };
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
   * "a contradictory/unreadable control state fails closed"): the
   * submission-acceptance control-state consistency gate. Returns a
   * typed AMBIGUOUS_STATE refusal when the recording facts carry a
   * contradictory or unreadable composer action-slot state, or when
   * the provider's own computed prompt-present signal contradicts the
   * decisively-empty composer read (send ENABLED while #chat-input
   * reads "" — the composer read is untrustworthy and the acceptance
   * is never recorded from it), or when the send control resolved
   * ambiguously (the enabled probe degraded to null on a zero/many
   * match while the control is visible). Returns null when the
   * control state is consistent — the caller records the acceptance.
   * Context semantics are untouched: a "stop" reading (generation in
   * progress) and a "send" reading consistent with the composer are
   * BOTH acceptable recording states (the frozen acceptance rule is
   * the message-exclusive evidence, not the control state).
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
   * sent). A dialog visible at this point fails closed — never type
   * through a modal.
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
    const composerValue = composerValueOf(facts.facts);
    if (composerValue === null) {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer value could not be read decisively (absent or ambiguous) — refusing to prepare a submission on an unreadable input state"
      );
    }
    if (composerValue === prompt) {
      return { ok: true, present: true };
    }
    if (composerValue === "" && messageEvidenceContains(facts.facts, prompt)) {
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
    // attempt runs the full preparation (Agent -> model -> prompt).
    // CONTINUATION 9 (PR #6 review 5123260890, requirement 3):
    // after the known-popup Enter and its VERIFIED dismissal, the
    // next attempt RESTARTS THE FULL PREPARATION SEQUENCE — the
    // popup interaction can disturb the governed surface state, and
    // the idempotent re-selection (Agent, model) re-establishes
    // every governed ground truth before the prompt is (re)entered
    // and (re)sent. An unconfirmed send whose composer still holds
    // the exact prompt resends as-is (the pre-send gate re-verifies
    // it byte-for-byte); an already-confirmed submission is never
    // resent.
    let attempts = 0;
    let popupDismissals = 0;
    let composeReestablishments = 0;
    let lastRefusal = null;
    let prepared = false;

    /**
     * Record the CONFIRMED submission (the shared acceptance path).
     * CONTINUATION 12 (PR #6 comment 5557322324, requirements 4-7): the
     * recording is now GATED on the control-state consistency of the
     * recording facts — a contradictory or unreadable composer
     * action-slot state, or an enabled send control contradicting the
     * decisively-empty composer read, refuses the acceptance (fail
     * closed) instead of recording from an untrustworthy surface. The
     * frozen acceptance rule is UNCHANGED: a send/control transition is
     * context and cross-check only, never acceptance by itself — the
     * acceptance remains the MESSAGE-EXCLUSIVE exact-prompt evidence
     * plus the DECISIVELY empty composer, and the `submitted` record
     * keeps exactly its frozen four-field shape.
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
        popupDismissals,
        composeReestablishments,
        submittedAt: now(),
        wasWorking: generation === "working",
        recoveries: 0,
      };
      sessions.set(worker, record);
      return {
        ok: true,
        session: { worker, workItem, tabId },
        submitted: { attempts, popupDismissals, composeReestablishments, generation },
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
        // provider-state evidence (e.g. the dismissed popup had let it
        // land): never resend the governed prompt. CONTINUATION 12: a
        // control-state inconsistency on the recording facts refuses
        // the acceptance — the bounded retry re-observes (never resends
        // a confirmed submission) and fails closed if it persists.
        const recorded = recordSubmission(entered.facts);
        if (recorded.ok) {
          return recorded;
        }
        lastRefusal = recorded;
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
      const gateDialog = classifyDialog(gate.facts, "preparing");
      if (gateDialog.kind !== "none") {
        lastRefusal = failure(
          "UNKNOWN_DIALOG",
          `a dialog is visible at the send gate: ${gateDialog.reason}`
        );
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
      // 6. Send.
      const sent = await send(tabId);
      if (!sent.ok) {
        lastRefusal = sent;
        continue;
      }
      // 7. Verify ACTUAL submission from the resulting provider
      //    state. Decisive outcomes only: a dialog, a DECISIVELY
      //    cleared composer WITH message-exclusive evidence of the
      //    exact prompt (confirmed), or a composer that still HOLDS
      //    the prompt (the send did not take). An absent/ambiguous
      //    composer read is NOT decisive — the budget bounds the
      //    wait and the final classification fails closed.
      const verdict = await settle(tabId, [], (f) => {
        const dialog = classifyDialog(f, "verifying-submission");
        if (dialog.kind !== "none") {
          return true;
        }
        const composerValue = composerValueOf(f);
        if (composerValue === null) {
          return false; // an unreadable composer is NOT decisive
        }
        if (composerValue === "" && messageEvidenceContains(f, prompt)) {
          return true; // confirmed by message-exclusive evidence
        }
        return composerValue.length > 0; // unconfirmed (send did not take)
      });
      if (!verdict.ok) {
        lastRefusal = verdict;
        continue;
      }
      let facts = verdict.facts;
      // CONTINUATION 10 (PR #6 review 5123872434, requirements 1-3):
      // the confirm-shaped verdict is NOT yet final on this provider.
      // The real known blocking popup ("Currently in peak hours",
      // MODEL_CONCURRENCY_LIMIT) materializes ASYNCHRONOUSLY — after
      // the optimistic landing the settle just observed — so the
      // acceptance is recorded only after the bounded async-outcome
      // hold. A popup (or the provider's prompt restore) observed
      // during the hold replaces the facts and dispatches below: the
      // frozen known-popup contract (Enter exactly once -> verified
      // dismissal -> FULL preparation restart -> re-enter/re-verify
      // -> resend only under the governed preconditions), the
      // fail-closed dialog refusals, or the unconfirmed bounded
      // retry. An unwatchable hold fails closed: the acceptance is
      // never asserted without the bounded popup watch.
      if (composerValueOf(facts) === "" && messageEvidenceContains(facts, prompt)) {
        const hold = await holdForAsyncSubmissionOutcome(tabId);
        if (hold.held) {
          facts = hold.facts;
          // CONTINUATION 12 (PR #6 comment 5557322324, requirements 6-7):
          // the held async outcome is dispatched through the SAME
          // control-state consistency gate before any recovery path —
          // an enabled send control observed with a decisively EMPTY
          // composer is the contradictory surface (the provider's own
          // computation says a prompt is present while the raw read
          // says none), and it fails closed IMMEDIATELY. The compose
          // re-establishment is never invoked on an untrustworthy
          // composer read, and the acceptance is never recorded from
          // it — the race in which the optimistic landing is accepted
          // (or recovered) before the provider can expose a
          // contradictory composer/control state is closed on every
          // observable surface.
          const heldControlRefusal = controlStateRefusal(hold.facts);
          if (heldControlRefusal) {
            return heldControlRefusal;
          }
        } else if (hold.facts) {
          // The confirmation HELD through the async-outcome window:
          // record the acceptance from the freshest quiet read (the
          // message-exclusive exact-row + decisively-empty-composer
          // evidence, held — popup absence itself is never success,
          // and a popup beyond the bounded window is a live-evidence
          // matter). CONTINUATION 12: the recording is gated on the
          // control-state consistency of the quiet facts — a
          // contradictory/unreadable action-slot state or an
          // enabled-send-vs-empty-composer contradiction fails closed
          // (the bounded retry re-observes; a confirmed submission is
          // never resent).
          const recorded = recordSubmission(hold.facts);
          if (recorded.ok) {
            return recorded;
          }
          lastRefusal = recorded;
          continue;
        } else {
          lastRefusal = failure(
            "PAGE_UNAVAILABLE",
            "the post-confirmation outcome watch could not read the provider surface — the submission acceptance is not asserted without the bounded popup watch"
          );
          continue;
        }
      }
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
        // The ONE bounded Enter press for this attempt. CONTINUATION 9
        // (PR #6 review 5123260890, requirement 3): after the VERIFIED
        // dismissal, the next attempt RESTARTS THE FULL PREPARATION
        // SEQUENCE (Agent -> model -> prompt) — the popup interaction
        // can disturb the governed surface state (mode, model, input),
        // and the idempotent re-selection re-establishes every
        // governed ground truth before the resend. The dismissal
        // itself is NEVER success ("never treat popup absence as
        // success"); only the decisive submission acceptance of step
        // 7 can confirm, and an already-confirmed submission (the
        // popup let it land) is still never resent.
        // CONTINUATION 10 (PR #6 review 5123872434, requirement 3):
        // popupDismissals increments ONLY AFTER the known popup was
        // actually observed AND the Enter action was actually issued —
        // a refused or failed press never counts a dismissal.
        const pressed = await pressEnter(tabId);
        if (!pressed.ok) {
          lastRefusal = pressed;
          continue;
        }
        popupDismissals += 1;
        const dismissed = await settle(tabId, [], (f) => dialogCount(f) === 0);
        if (!dismissed.ok) {
          lastRefusal = dismissed;
          continue;
        }
        if (dialogCount(dismissed.facts) !== 0) {
          lastRefusal = failure("UNKNOWN_DIALOG", "the known popup did not dismiss after the Enter press");
          continue;
        }
        prepared = false; // the next attempt restarts the FULL preparation sequence
        continue;
      }
      const composerValue = composerValueOf(facts);
      if (composerValue !== null && composerValue.length > 0) {
        // Unconfirmed: the send did not take (the composer still holds
        // the prompt). The bounded retry resends the exact prompt.
        lastRefusal = failure(
          "PAGE_MALFORMED",
          "the prompt remained unsubmitted after the send (submission was not confirmed by observation)"
        );
        continue;
      }
      if (composerValue === "") {
        // The SECOND observed failure mode (PR #6 review
        // 5123047551, requirement 3): the composer is decisively
        // empty, the submission is NOT confirmed by message
        // evidence, and no dialog explains it — the provider
        // discarded the input state around the send attempt (the
        // operator's captured post-run DOM: an empty composer with
        // a disabled send control). Fail-closed remediation: the
        // bounded compose re-establishment; the next attempt
        // re-types the exact prompt byte-for-byte, re-reads it
        // byte-for-byte, and only then resends.
        const reestablished = await reestablishComposer(tabId);
        if (reestablished.ok) {
          composeReestablishments += 1;
          lastRefusal = failure(
            "PAGE_MALFORMED",
            "the prompt was not present in the composer after the send attempt (submission not confirmed by message evidence) — the composer input state was re-established for a re-typed, re-verified resend"
          );
        } else {
          lastRefusal = reestablished;
        }
        continue;
      }
      // An unreadable composer after the budget: never "cleared",
      // never "present" — fail closed.
      lastRefusal = failure(
        "AMBIGUOUS_STATE",
        "the composer state could not be read decisively after the send (absent or ambiguous) — submission is unconfirmed"
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
        const c = classifySession(f, session, "recovery");
        if (
          ["authentication-required", "provider-error", "unexpected-dialog", "expected-blocking-dialog"].includes(
            c.state
          )
        ) {
          return true; // a decisive failure surface ends the wait immediately
        }
        // The precondition's decidable outcomes: the generation ACTIVE
        // (Stop visible — both computed label states), the
        // post-response surface (the Regenerate control — the
        // generation already ended), or the composer holding text (the
        // prompt present — no active generation to recover).
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
        // was restored (the known popup path) — there is no active
        // generation to recover and the operator procedure is a
        // re-Start, not a recovery. Otherwise the bounded wait did not
        // observe the generation become active: the queued-state
        // refusal names the control-state reading and the timing
        // guidance (invoke while the Stop control is visibly present,
        // not merely immediately after Start returns).
        const composerValue = composerValueOf(observed.facts);
        if (composerValue !== null && composerValue.length > 0) {
          return failure(
            "AMBIGUOUS_STATE",
            "the hung precondition (generation in progress) is not established — the composer holds text and the send control is rendered with no Stop control visible: the submission was not accepted or the prompt was restored (the known popup path), so there is no active generation to recover; handle the provider popup state if one is present and re-Start the worker session"
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
      const sent = await send(tabId);
      if (!sent.ok) {
        lastRefusal = sent;
        continue;
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
      const accepted = await settle(tabId, [], (f) => {
        const composerValue = composerValueOf(f);
        const cleared = composerValue === ""; // decisive only
        if (cleared && messageEvidenceContains(f, ZAI_RECOVERY_MESSAGE)) {
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
      const composerValue = composerValueOf(f);
      const cleared = composerValue === ""; // decisive only
      const confirmed = messageEvidenceContains(f, ZAI_RECOVERY_MESSAGE);
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
