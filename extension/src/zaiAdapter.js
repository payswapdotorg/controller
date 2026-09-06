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
 *     6. send attempt — the exact governed prompt is sent ONCE per
 *        bounded attempt through the real send control (the send
 *        control is clicked when the composer action slot renders
 *        it). There is NO Enter fallback at the send step: the ONLY
 *        Enter the frozen Work Order ever permits is the
 *        known-submission-popup recovery of the section below
 *        ("When and only when the adapter observes the known
 *        submission-blocking popup, it may press `Enter` once for
 *        the current retry attempt") — the adapter never blindly
 *        presses keys. An inaccessible Send control, a slot
 *        rendering the Stop control, a contradictory or unresolvable
 *        slot, or a failed send click are unresolved send states:
 *        the submission-verification watch observes and the bounded
 *        attempt budget fails closed;
 *     6b. THE PROVISIONING WAIT (CONTINUATION 16, PR #6 review
 *         5125198728 — "IMPLEMENT THE DIRECT Z.AI CHAT-STATE
 *         WORKFLOW NOW", requirement 1): the creation of the fresh
 *         Agent-mode chat/session is treated as an ASYNCHRONOUS
 *         provider operation. The most reliable live-observable that
 *         provisioning completed: the composer becoming a VISIBLE,
 *         ENABLED, decisive input (the provider's own readiness —
 *         the surface it renders only from the provisioned session
 *         state). A bounded wait after the Agent/model preparation;
 *         a surface that never readies fails closed with the typed
 *         provisioning refusal (the exact prompt is never typed into
 *         an unprovisioned surface);
 *     7. THE SUBMISSION VERIFICATION — the frozen Work Order's step
 *        7 ("verify that the prompt was actually accepted/submitted
 *        by observing the resulting provider state. A send/click
 *        event alone is never sufficient evidence of submission."),
 *        carried by the BOUNDED WATCH (watchRounds observation
 *        rounds paced by watchRoundIntervalMs — PURE OBSERVATION, no
 *        key is ever pressed on a timer) whose acceptance detector
 *        is the provider-state composition the day's live evidence
 *        established (CONTINUATION 16/20 — the strongest "resulting
 *        provider state" reading, retained under the frozen Work
 *        Order). THE DETECTOR (startSignalOf) — signals combined for
 *        confidence:
 *          (i) THE PROMPT-ACCEPTANCE LEG, PRIMARY: THE
 *              CONVERSATION-STATE ADVANCEMENT — the user-message
 *              turn count ADVANCED past the dispatch baseline AND
 *              the exact correlated text landed as an EXACT
 *              user-message row (the new turn is OURS — a stale
 *              exact row from a prior run never advances the count;
 *              a foreign turn never carries the exact text; the
 *              count is userTurnCountOf — the rendered projection
 *              of the operator-reported chat.history.messages
 *              user-role nodes, the object itself closure-scoped);
 *          (ii) THE WORKING-STATE LEG, CORROBORATING: the Send->Stop
 *              ACTION-CONTROL TRANSITION
 *              — the composer action slot swapping to the Stop
 *              control (the provider's mutually exclusive render
 *              conditional "no current message or the current
 *              message is done -> send control; otherwise -> Stop
 *              control", LIVE-OBSERVED; a current message is not
 *              done exactly while an Agent generation is in flight),
 *              with the composer DECISIVELY EMPTY (the draft
 *              consumed — a prompt still held in the composer is the
 *              provider's own proof the submission was NOT consumed);
 *          (iii) THE FRESH-SESSION CONJUNCT: the CHAT OBJECT CREATED —
 *              the session URL advanced to /c/<chatId>. BUNDLE-PROVEN:
 *              the provider's submission handler creates the chat
 *              server-side on the ACCEPTED first submission (the
 *              chat id from the response -> the current-chat store ->
 *              REFRESH_AGENT_CHAT_LIST -> history.replaceState) and
 *              the 429/capacity path returns BEFORE the creation (no
 *              chat, no URL advance) — the URL advance is the
 *              provider's own computed proof of an ACCEPTED
 *              submission. Required only when the chat object did
 *              NOT exist at dispatch (a fresh session; on an existing
 *              chat the conjunct is vacuous — its URL is already at
 *              a chat route). A foreign generation over a discarded
 *              input on a fresh session has a Stop control and an
 *              empty composer but NO chat object — never our start
 *              signal;
 *              THE WITHDRAWN-ECHO HAZARD (the (b) candidate of the
 *              c16 review, resolved by the (i)+(iii) conjunction
 *              under CONTINUATION 20): the submit-time LOCAL
 *              optimistic echo the server can withdraw (the
 *              observed capacity rejection) never satisfies the
 *              FULL signal — the refused path never creates the
 *              chat object, and a landed-but-unaccepted row is
 *              diagnosed at the watch's exhaustion (the
 *              refused-submission diagnosis), never accepted. The
 *              chat object's store is closure-scoped (NOT a window
 *              global), its URL reflection IS the page-observable
 *              form (the (iii) conjunct); assistant-generated text
 *              is contract-forbidden; network/SSE events are not
 *              observable through the closed page vocabulary.
 *        THE WATCH LOOP: observation rounds for the start signal, a
 *        DIALOG (dispatched by the dialog law below), or a decisive
 *        failure surface. The start signal records the session
 *        (generation:"working" — the Stop control visible at the
 *        recording read) and returns control for Architect review —
 *        the final model output is NEVER waited for. A decisive
 *        failure surface (authentication required, a provider error)
 *        ends the watch with the typed refusal. The TOTAL window is
 *        bounded (watchRounds x watchRoundIntervalMs); when the
 *        start signal never appears the watch FAILS CLOSED with the
 *        typed agent-start-timeout diagnosis ROUTED THROUGH THE CHAT
 *        STATE (the provider's own accepted/refused computation):
 *        the untrustworthy surfaces refuse; the composer holding
 *        the exact prompt routes the bounded re-send attempt; the
 *        landed row with NO chat object is diagnosed the provider's
 *        local optimistic echo of a REFUSED submission (never
 *        resent); the landed row WITH the chat object is the
 *        queued/completed-unobserved context-only diagnosis; a
 *        decisively empty composer with NO chat object routes the
 *        compose re-establishment (nothing was accepted); with the
 *        chat object created it stays fail-closed (never a re-typed
 *        resend that could duplicate an accepted submission).
 *
 *   known submission-popup recovery (the frozen Work Order's "Known
 *   submission-popup recovery" section, RESTORED by CONTINUATION 22 —
 *   PR #6 review 5125571572, resolution path (b) "implementing the
 *   frozen Work Order semantics"): "When and only when the adapter
 *   observes the known submission-blocking popup, it may press
 *   `Enter` once for the current retry attempt. After dismissal it
 *   must restart from Agent selection, model selection, exact prompt
 *   entry, send and submission verification. Retries are
 *   bounded/configurable. Unknown or differently-shaped dialogs must
 *   fail closed; the adapter must not blindly press keys or infer
 *   that a popup is harmless." The KNOWN popup is the LIVE-OBSERVED
 *   provider capacity modal ("Currently in peak hours" — the
 *   operator's captured run, repository of record, main 5d14d90: a
 *   bits-ui modal carrying role="dialog", aria-modal="true" and
 *   data-state="open", matched by the `[role="dialog"], dialog`
 *   observation channel; an in-page accessible DOM dialog, never a
 *   native or browser-level modal). The provider's own bundle (the
 *   MODEL_CONCURRENCY_LIMIT error handler) proves the TIMING: the
 *   prompt lands optimistically and the popup materializes only
 *   when the asynchronous chat-completion error arrives — the same
 *   handler may RESTORE the submitted prompt into the composer. The
 *   adapter therefore (a) classifies dialogs ONLY through the closed
 *   observation channel (count + text), (b) presses Enter ONLY on
 *   the classified known popup and exactly once per retry attempt,
 *   (c) VERIFIES the dismissal by post-action observation
 *   (popupDismissals counts only actually-issued presses on
 *   actually-observed popups), (d) RESTARTS the full preparation
 *   sequence (Agent -> model -> provisioning -> prompt -> send ->
 *   verification) after every verified dismissal — the idempotent
 *   re-selection re-establishes every governed ground truth the
 *   popup interaction may have disturbed, (e) fails closed
 *   UNKNOWN_DIALOG on every other dialog shape at every phase
 *   (preparation, recovery, standalone observation outside the
 *   submission-verification window, multiple simultaneous dialogs),
 *   and (f) never treats popup ABSENCE as success — only the
 *   acceptance detector confirms a submission. An auth-shaped dialog
 *   fails closed AUTHENTICATION_INTERRUPTED / AUTHORIZATION_REQUIRED
 *   (never Enter); an error-shaped dialog fails closed
 *   PROVIDER_ERROR (never Enter).
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
 *   `continue` -> the SAME acceptance watch (PURE OBSERVATION): the
 *   continue is typed and read back byte-identically, the send
 *   control is clicked when the action slot renders it, and the
 *   watch then waits for the SAME acceptance signal — the new
 *   `continue` turn landing (the conversation state advancing past
 *   the continue-dispatch baseline with the exact text) and the
 *   Stop control corroborating (the agent resumed working) with the
 *   composer decisively empty. The acceptance is the signal itself
 *   (the landed exact `continue` row is a leg of it). No alternate
 *   recovery wording. Bounded attempts; failure to confirm a
 *   required transition is a typed governance-hold outcome. A
 *   dialog visible at any point of the recovery fails closed
 *   UNKNOWN_DIALOG (the bounded popup recovery applies only to
 *   submission — never a blind keypress). The recovery NO LONGER
 *   requires a persistent in-memory session (PR #6 review
 *   5124829301, requirement 6 — the operator's SESSION_UNKNOWN run):
 *   the request itself carries the Worker/Work-Item/tab correlation,
 *   and the governed sequence runs from it; a registry entry that
 *   CONTRADICTS the request still fails closed STALE_REFERENCE, but
 *   a lost registry (a service-worker restart) no longer refuses.
 *
 *   CTRL-014 CONTINUATION 23 — THE CHAT-TAB REFERENCE BASELINE (PR #6
 *   comments 5560253287 + 5560261256, the ARCHITECT change-of-
 *   investigation-strategy and correction directives, 2026-09-06):
 *   the ordinary UNAUTHENTICATED https://chat.z.ai Chat surface is
 *   the REFERENCE IMPLEMENTATION, LIVE-PROVEN by the worker's
 *   real-browser experiment (15:41-16:09Z, a single stable tab, the
 *   full submission lifecycle observed first-hand). The Start MODE
 *   parameter exposes it: mode "chat" (the reference) and mode
 *   "agent" (the governed Work Order contract, the absent default).
 *   THE TWO MODES SHARE THE ENTIRE submission/verification/recovery
 *   lifecycle above; the ONLY differences are the explicitly
 *   isolated AGENT DELTA — the authenticated-session gate, the
 *   Agent-pill selection, the model selection, and the provisioning
 *   wait (the chat surface is ready-for-input at rest, LIVE-OBSERVED:
 *   the fresh unauthenticated page renders a visible enabled composer
 *   beside the "Sign in" call-to-action — the auth markers are the
 *   chat baseline's ACCEPTED state, never a refusal, and never
 *   inferred onto the Agent contract). THE DISCOVERED CHAT-SURFACE
 *   FACTS, now contract laws (each LIVE-OBSERVED, each with focused
 *   regressions): (1) THE HUMAN-VERIFICATION GATE — every
 *   unauthenticated Chat submission's generation is held by a
 *   body-level Aliyun CAPTCHA slider popup (#aliyunCaptcha-window-
 *   popup, a DIRECT <body> child carrying NO role="dialog" —
 *   invisible to the dialog channel) that only the human can solve
 *   (a machine-perfect drag is rejected by the provider's risk
 *   engine after the first pass); the adapter NEVER solves it, NEVER
 *   presses Enter on it, NEVER treats it as the known popup — the
 *   typed HUMAN_VERIFICATION_REQUIRED operator gate, terminal at
 *   every phase; (2) THE COMPLETION-ERROR RENDERING — after the gate
 *   is passed the completion can FAIL server-side with the assistant
 *   row rendering "No response, Please try again later. SyntaxError:
 *   ..." while the action-slot facts (the send control back, the
 *   Stop gone, the Regenerate visible) are INDISTINGUISHABLE from a
 *   successful completion — the assistant-row text is the only
 *   completion-outcome discriminator, checked in the async-outcome
 *   hold BEFORE the completed-generation early exit; (3) THE
 *   TURN-INDEX BADGE — the provider renders the CURRENT (in-flight)
 *   turn's user row as the exact prompt followed by whitespace and
 *   the "N/M" message index ("... the word OK.         2/2"); the
 *   exact-row predicate accepts both the bare and the badge-suffixed
 *   forms (the near-miss and the foreign text still fail); (4) THE
 *   RETAINED-DRAFT STOP SURFACE — a dispatch whose input pipeline
 *   did not consume the draft can leave the action slot swapped to
 *   Stop while the composer retains the text and no row lands (the
 *   observed non-trusted-dispatch modality; the exhaustion reports
 *   the slot fact in its typed detail — never ok, never a blind
 *   resend); and the stop-recovery on the real surface PRESERVES the
 *   retained draft through the verified Stop (the provider's own
 *   stopTaskResponse), which the recovery's re-entry re-verifies.
 *   THE TAB-STABILITY FACT: the entire chat lifecycle runs in ONE
 *   tab — the URL advance to /c/<chatId> is history.replaceState
 *   (no navigation, no reload, no tab replacement; the content
 *   script's world persists).
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
 * CONTINUATION 22 (PR #6 review 5125571572, path (b)): dialog
 * recognition is RESTORED — the two dialog-shaped states
 * ("expected-blocking-dialog", "unexpected-dialog") are PRODUCED
 * again by classifySession's dialog branches (the frozen Work
 * Order's "detection and typed reporting of ... expected
 * blocking-dialog, unexpected-dialog ..." scope).
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
  "human-verification-required",
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
  // The provider dialog surface (RESTORED by CONTINUATION 22, PR
  // #6 review 5125571572, path (b) — the frozen Work Order's dialog
  // law): the in-page accessible DOM dialog channel. LIVE-OBSERVED
  // (the operator's captured run, repository of record, main
  // 5d14d90): the real "Currently in peak hours" capacity modal is
  // a bits-ui modal carrying role="dialog", aria-modal="true" and
  // data-state="open" — matched by this channel (never a native or
  // browser-level modal). The dialog is probed (count + text) and
  // classified (classifyDialog); only the classified KNOWN
  // submission-blocking popup ever receives the Enter action.
  dialog: '[role="dialog"], dialog',
  alert: '[role="alert"]',
  // The provider's INTERACTIVE HUMAN-VERIFICATION surface (CTRL-014
  // continuation 23, the ARCHITECT chat-tab-baseline directives PR #6
  // comments 5560253287 + 5560261256 — LIVE-OBSERVED 2026-09-06 on the
  // real UNAUTHENTICATED https://chat.z.ai Chat surface, the worker's
  // real-browser experiment): the Aliyun CAPTCHA slider popup injected
  // as a DIRECT <body> child (#aliyunCaptcha-window-popup, carrying
  // #aliyunCaptcha-certifyId and #aliyunCaptcha-sliding-slider inside) —
  // OUTSIDE the provider app DOM, carrying NO role="dialog" and NO
  // native <dialog>, so it is INVISIBLE to the dialog observation
  // channel (the dialogCount fact read 0 the entire time the popup was
  // visible). It gates the GENERATION of unauthenticated Chat
  // submissions (the exact observed sequence: the row lands, the
  // composer clears, the URL advances to /c/<chatId>, the action slot
  // swaps to Stop — and the completion is held until the human solves
  // the slider; a failed solve refreshes the puzzle, and repeated
  // machine-perfect solves are rejected by the provider's risk engine —
  // the interactive gate is human-only BY DESIGN). The adapter NEVER
  // solves human verification and NEVER presses Enter on it: it is a
  // typed operator gate (HUMAN_VERIFICATION_REQUIRED), distinct from
  // the dialog channel's known submission-blocking popup.
  humanVerificationPopup: "#aliyunCaptcha-window-popup",
  // The assistant message row (LIVE-OBSERVED 2026-09-06, the same
  // experiment): the rendered last provider response (.chat-assistant)
  // — including the provider's COMPLETION-ERROR rendering ("No
  // response, Please try again later. SyntaxError: Unexpected token
  // '<', \"<!doctypeh\"... is not valid JSON" — observed after the
  // human-verification gate was passed), the ONLY surface fact that
  // distinguishes a FAILED completion from a successful one: the
  // action-slot facts (the send control back, the Stop control gone,
  // the Regenerate control visible) are IDENTICAL on both surfaces.
  assistantRow: ".chat-assistant",
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

/** The alert-surface text pattern that classifies a provider error. */
const PROVIDER_ALERT_PATTERN = /error|went\s*wrong|rate\s*limit|too\s*many|unavailable|failed|forbidden|denied/i;

/**
 * CONTINUATION 23 (the chat-tab baseline, LIVE-OBSERVED 2026-09-06):
 * the trailing turn-index badge the provider renders on the CURRENT
 * (in-flight) user-message row — the exact prompt followed by
 * whitespace and the "N/M" message index (the live row read
 * "... the word OK.         2/2"). Accepted by the exact-row
 * predicate as the verbatim submission (userRowTextIsExact).
 */
const TURN_INDEX_BADGE_PATTERN = /^\s+\d+\/\d+$/;

/**
 * CONTINUATION 23 (LIVE-OBSERVED 2026-09-06, the real unauthenticated
 * Chat surface): the provider's COMPLETION-ERROR rendering on the
 * assistant row ("No response, Please try again later. SyntaxError:
 * Unexpected token '<', \"<!doctypeh\"... is not valid JSON") — the
 * asynchronous chat-completion failure surfaced as the last assistant
 * message. The action-slot facts alone cannot distinguish this
 * failed completion from a successful one.
 */
const PROVIDER_COMPLETION_ERROR_PATTERN = /no\s+response,\s*please\s+try\s+again\s+later/i;

/** Frozen default budgets (all constructor-injectable for tests). */
const DEFAULTS = Object.freeze({
  settlePolls: 8, // post-action observation polls per step
  settleIntervalMs: 400, // delay between polls
  // CONTINUATION 22 (PR #6 review 5125571572, path (b)): the bounded
  // SUBMISSION-VERIFICATION window — pure observation (no key is ever
  // pressed on a timer; the ONLY Enter is the observed-known-popup
  // recovery). 12 rounds paced 5 seconds apart (the same 60-second
  // bounded window the day's live evidence sized).
  watchRounds: 12, // bounded verification-watch observation rounds
  watchRoundIntervalMs: 5000, // the round pacing (the bounded window)
  // The post-acceptance ASYNC-OUTCOME hold (the known popup's
  // observed asynchronous timing — the provider's capacity handler
  // lands the prompt optimistically and the popup materializes only
  // when the async error arrives).
  confirmationHoldPolls: 10, // the bounded async-outcome window
  maxSubmissionAttempts: 3, // bounded preparation/send/verify attempts
  maxRecoveryAttempts: 2, // bounded Stop/continue recovery attempts
});

/**
 * Create the Z.ai Worker adapter.
 *
 * @param {{ tabsApi: object, pageBridge: object, providerUrl?: string,
 *           sleep?: Function, now?: Function, settlePolls?: number,
 *           settleIntervalMs?: number, watchRounds?: number,
 *           watchRoundIntervalMs?: number, confirmationHoldPolls?: number,
 *           maxSubmissionAttempts?: number, maxRecoveryAttempts?: number }} wiring
 *        `pageBridge` is the typed channel to the content script
 *        (createZaiPageBridge); tests inject a scriptable fake. The
 *        watch budgets size the bounded pure-observation verification
 *        window and the post-acceptance async-outcome hold
 *        (continuation 22 — the frozen Work Order semantics).
 */
export function createZaiAdapter({
  tabsApi,
  pageBridge,
  providerUrl = "https://chat.z.ai",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  settlePolls = DEFAULTS.settlePolls,
  settleIntervalMs = DEFAULTS.settleIntervalMs,
  watchRounds = DEFAULTS.watchRounds,
  watchRoundIntervalMs = DEFAULTS.watchRoundIntervalMs,
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
    // CONTINUATION 16 (PR #6 review 5125198728 — the DIRECT Z.ai
    // CHAT-STATE WORKFLOW): the page's own URL — the provider's
    // routing state (which chat session the page holds). The generic
    // "location" fact probe (page/zaiPage.js) reports
    // document.location.href verbatim with NO element and NO
    // selector; the /c/ interpretation lives HERE (chatObjectCreatedOf
    // below), never in the page script — the provider boundary holds
    // (the URL fact itself is generic page execution).
    { name: "pageLocation", mode: "location" },
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
    // The provider dialog surface (RESTORED by CONTINUATION 22, PR
    // #6 review 5125571572, path (b)): the closed-vocabulary dialog
    // observation channel (count) — the known submission-blocking
    // popup is classified from it (classifyDialog); only the
    // classified known popup ever receives the Enter action.
    { name: "dialogCount", selector: ZAI_LOCATORS.dialog, mode: "count" },
    { name: "alertVisible", selector: ZAI_LOCATORS.alert, mode: "visible" },
    // CTRL-014 continuation 23 (the chat-tab baseline): the
    // human-verification channel (the body-level Aliyun popup — a
    // DISTINCT surface from the dialog channel, read independently)
    // and the assistant-row text (the completion-error surface).
    { name: "humanVerificationVisible", selector: ZAI_LOCATORS.humanVerificationPopup, mode: "visible" },
    { name: "assistantRowText", selector: ZAI_LOCATORS.assistantRow, mode: "texts" },
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
    // The dialog text (RESTORED by CONTINUATION 22): the closed
    // classification channel for auth-shaped / error-shaped dialog
    // surfaces (the unknown-dialog fail-closed law).
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

  // CONTINUATION 22 (PR #6 review 5125571572, path (b)): the
  // ASYNC-OUTCOME HOLD is restored (continuation 10, PR #6 review
  // 5123872434 — the known popup's observed asynchronous timing:
  // the prompt lands optimistically and the "Currently in peak
  // hours" capacity dialog materializes only when the asynchronous
  // chat-completion error arrives). The hold runs AFTER the start
  // signal, inside watchSubmissionOutcome below.

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
   * @private — RESTORED by CONTINUATION 22 (PR #6 review 5125571572,
   * path (b)): the count of dialogs visible on the provider surface,
   * read from the closed `[role="dialog"], dialog` observation
   * channel (the in-page accessible DOM dialogs).
   */
  function dialogCount(facts) {
    const count = facts.dialogCount?.count;
    return typeof count === "number" ? count : 0;
  }

  /**
   * @private — CONTINUATION 23 (PR #6 comments 5560253287 + 5560261256,
   * the ARCHITECT chat-tab-baseline directives): the provider's
   * INTERACTIVE HUMAN-VERIFICATION gate — the body-level Aliyun
   * CAPTCHA popup, LIVE-OBSERVED on the real unauthenticated Chat
   * surface. A DISTINCT channel from the dialog surface (it carries
   * no role="dialog"; dialogCount reads 0 while it is visible) and a
   * DISTINCT classification from the known submission-blocking
   * popup: the known popup is Enter-dismissable by the frozen Work
   * Order's bounded recovery, while the human-verification gate is
   * solvable ONLY by the human (the operator) — the adapter never
   * presses a key on it, never clicks it, never retries it, and
   * never treats its presence as the known popup. The typed refusal
   * surfaces the operator's out-of-band action.
   */
  function humanVerificationVisible(facts) {
    return facts.humanVerificationVisible?.visible === true;
  }

  /**
   * @private — CONTINUATION 23: the provider's COMPLETION-ERROR
   * rendering on the assistant row, LIVE-OBSERVED on the real Chat
   * surface after the human-verification gate was passed: "No
   * response, Please try again later. SyntaxError: Unexpected token
   * '<', \"<!doctypeh\"... is not valid JSON". The completion-error
   * text arrives on the ASYNCHRONOUS chat-completion error — the
   * same late-observable class as the capacity popup — but rendered
   * through the assistant row instead of a dialog. The action-slot
   * facts alone (the send control back, the Stop control gone, the
   * Regenerate control visible) are IDENTICAL for a successful and a
   * FAILED completion, so this text is the only completion-outcome
   * discriminator available at the provider boundary.
   */
  function completionErrorTextOf(facts) {
    const texts = facts.assistantRowText?.texts;
    if (!Array.isArray(texts)) {
      return null;
    }
    return texts.find((t) => typeof t === "string" && PROVIDER_COMPLETION_ERROR_PATTERN.test(t)) ?? null;
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
   * @private — CONTINUATION 16 (PR #6 review 5125198728, requirement 4
   * candidate (a) — "the appearance/creation of the chat object/session
   * state after provisioning"): the CHAT-STATE fact, read from the
   * page's own URL (the provider's routing state). BUNDLE-PROVEN: the
   * provider's submission handler creates the chat object server-side
   * on an ACCEPTED first submission (the chat id from the response ->
   * the current-chat store -> REFRESH_AGENT_CHAT_LIST ->
   * history.replaceState(`/c/${chatId}`)) and the 429/capacity path
   * returns BEFORE the creation (no chat, no URL advance) — the URL
   * advance is the provider's own computed proof that the submission
   * was accepted and the chat object exists. Returns:
   *   true  — the page holds a chat object (the URL routed to /c/...);
   *   false — the fresh-session base URL (no chat object yet);
   *   null  — the location fact absent or unparsable (never guessed;
   *           callers fail closed on null wherever the reading is
   *           load-bearing — a stale page script that never answers
   *           the location fact can never satisfy the start signal).
   */
  function chatObjectCreatedOf(facts) {
    const href = facts.pageLocation?.href;
    if (typeof href !== "string" || href.length === 0) {
      return null;
    }
    try {
      return new URL(href).pathname.startsWith("/c/");
    } catch {
      return null;
    }
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
   * @private — CONTINUATION 15 (PR #6 review 5124990727): the
   * AGENT-STARTED detector. The composer action slot rendering the
   * Stop control with the send control ABSENT (the strict mutually-
   * exclusive slot reading) is the provider's OWN computed proof that
   * the current message is in flight — an Agent generation actively
   * working. This is the Send->Stop ACTION-CONTROL TRANSITION the
   * review names as the preferred detector: provider-computed (the
   * provider's own reactive render conditional — "no current message
   * or the current message is done -> send; otherwise -> Stop"),
   * causally tied to the active generation (the assistant message's
   * done flag unset exactly while the generation runs), and resilient
   * to the known races (a popup/dialog shape is never consulted; a
   * contradictory both-controls surface reads "contradictory", not
   * started). NEVER inferred from a popup, conversation text, or a
   * timer.
   */
  function agentStartedOf(facts) {
    return controlStateOf(facts) === "stop";
  }

  /**
   * @private — CONTINUATION 12 (PR #6 comment 5557322324, requirement 7:
   * "a contradictory/unreadable control state fails closed"),
   * REPURPOSED by CONTINUATION 15 (PR #6 review 5124990727): the
   * untrustworthy-surface refusal for the agent-start watch's
   * EXHAUSTION analysis. The continuation-14 REVERSAL of the
   * stop-state permission is itself superseded — a "stop" control
   * state is now the SUCCESS SIGNAL (the agent started), never a
   * refusal. What still refuses: a contradictory composer action-slot
   * state (both controls visible — the real slot renders exactly
   * one), the provider's own computed prompt-present signal
   * contradicting the decisively-empty composer read (send ENABLED
   * while #chat-input reads ""), and an ambiguous send-control
   * resolution while the control is visible — every one of them an
   * untrustworthy surface the watch's exhaustion never records
   * success from. Returns null when the surface is trustworthy.
   */
  function untrustworthySurfaceRefusal(facts) {
    const control = controlStateOf(facts);
    if (control === "contradictory") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot is contradictory — both the send control and the Stop control are visible (the provider's slot renders exactly one); the agent-start watch's exhausted reading is not taken from an unreadable control state"
      );
    }
    if (control === "unresolvable") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot is unreadable — neither the send control nor the Stop control is visible; the agent-start watch's exhausted reading is not taken from an unreadable control state"
      );
    }
    const sendEnabled = sendEnabledOf(facts);
    if (control === "send" && facts.sendVisible?.visible === true && sendEnabled === null) {
      return failure(
        "AMBIGUOUS_STATE",
        "the send control's enabled state could not be read decisively (absent or ambiguous) while the control is visible — the agent-start watch's exhausted reading is not taken from an unreadable control state"
      );
    }
    if (sendEnabled === true && composerValueOf(facts) === "") {
      return failure(
        "AMBIGUOUS_STATE",
        "the composer action slot contradicts the composer read — the provider's send control is computed ENABLED (a prompt present) while #chat-input reads decisively empty; the composer read is untrustworthy and the agent-start watch's exhausted reading is not taken from it"
      );
    }
    return null;
  }

  /**
   * The EXACT-ROW conjunct of the agent-start signal (CONTINUATION
   * 20, the ours-proof leg — the new turn is OURS): the exact
   * correlated text observed as an EXACT user-message row. History:
   * the continuation-6/9 MESSAGE-EXCLUSIVE acceptance surface (a
   * standalone predicate, superseded by the continuation-15 start
   * signal and retained as the signal's exact-row conjunct).
   * LIVE-OBSERVED
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
        if (Array.isArray(texts) && texts.some((t) => userRowTextIsExact(t, text))) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * @private — CONTINUATION 23 (the chat-tab baseline, LIVE-OBSERVED
   * 2026-09-06): the user-message row's text is the verbatim
   * submission, EXCEPT that the provider renders the CURRENT
   * (in-flight) turn's row with a trailing turn-index badge — the
   * exact prompt followed by whitespace and the "N/M" message index
   * (the live observation: the row read "Second diagnostic: please
   * reply with exactly the word OK.         2/2" for the exactly
   * submitted "Second diagnostic: please reply with exactly the word
   * OK."). The badge is the provider's own rendering of the in-flight
   * turn; the row is still the verbatim submission. The exact-row
   * predicate accepts BOTH forms (the bare exact text — the completed
   * row — and the badge-suffixed form — the in-flight row): a
   * leading-character near-miss still fails (no prefix), a foreign
   * turn still fails (different text), and a stale exact row is
   * still refused by the turn-count-delta conjunct (the count did
   * not advance).
   */
  function userRowTextIsExact(rowText, text) {
    if (rowText === text) {
      return true;
    }
    return (
      typeof rowText === "string" &&
      typeof text === "string" &&
      rowText.startsWith(text) &&
      TURN_INDEX_BADGE_PATTERN.test(rowText.slice(text.length))
    );
  }

  /**
   * @private — CONTINUATION 20 (PR #6 comment 5559533083, the
   * superseding execution directive): the provider's CONVERSATION
   * STATE — the count of user-message turns rendered on the
   * surface, the DOM projection of the operator-reported
   * `chat.history.messages` (the UUID-keyed message nodes; the
   * user-message rows are the rendered projection of the
   * user-role nodes — the object itself lives in closure-scoped
   * provider stores, unreachable through the supported extension
   * surface, so the row projection IS the observable state). The
   * count is read as the MAXIMUM across the user-message
   * candidates: the candidates are overlapping projections of the
   * SAME rows (a candidate matching zero rows returns a decisive
   * empty array — the page script's texts mode never guesses), so
   * the maximum is the faithful row count regardless of which
   * candidate the live surface actually matches. Returns null when
   * NO candidate read is structurally usable — an unreadable
   * conversation state never advances (fail-closed: null is never
   * greater than any baseline).
   */
  function userTurnCountOf(facts) {
    let best = null;
    for (const probe of EVIDENCE_PROBES) {
      if (probe.name.startsWith("userMessageCandidate")) {
        const texts = facts[probe.name]?.texts;
        if (Array.isArray(texts)) {
          best = Math.max(best ?? 0, texts.length);
        }
      }
    }
    return best;
  }

  /**
   * Classify the dialog surface (exactly one dialog) during a given
   * phase. RESTORED by CONTINUATION 22 (PR #6 review 5125571572,
   * path (b) — the frozen Work Order's dialog law). The KNOWN
   * submission-blocking popup is the modal dialog observed while
   * verifying a submission: not an auth surface, not an error
   * surface. Anything else — a dialog during preparation or
   * recovery, multiple simultaneous dialogs, auth-shaped or
   * error-shaped dialogs — is NOT the known popup and fails closed
   * (never a blind keypress).
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
   * (null for a standalone observation). CONTINUATION 22 (PR #6
   * review 5125571572, path (b)): the dialog branches are RESTORED —
   * the classifier produces "expected-blocking-dialog" /
   * "unexpected-dialog" again (the frozen Work Order's typed
   * reporting), alongside the alert/auth-marker/composer/control/
   * message facts.
   */
  function classifySession(facts, session, phase = "idle", { authMarkersBaseline = false } = {}) {
    const composerVisible = facts.composerVisible?.visible === true;
    const composerEnabled = facts.composerEnabled?.enabled === true;
    const composerValue = typeof facts.composerValue?.value === "string" ? facts.composerValue.value : null;
    const alertVisible = facts.alertVisible?.visible === true;
    const alertText = String(facts.alertText?.text ?? "");

    // CONTINUATION 23 (the chat-tab baseline): the INTERACTIVE
    // HUMAN-VERIFICATION gate is checked FIRST — before the dialog
    // branches and before every surface-state branch. It is NOT a
    // dialog (the body-level popup is invisible to the dialog
    // channel) and NOT the known submission-blocking popup (never
    // Enter-dismissable). Whatever else the surface shows, a visible
    // human-verification demand is the dominant fact: the adapter
    // can do nothing further on this surface.
    if (humanVerificationVisible(facts)) {
      return {
        state: "human-verification-required",
        detail:
          "the provider is demanding interactive human verification (a body-level Aliyun captcha slider surface, invisible to the dialog channel) — the adapter never solves human verification; complete the puzzle in the provider tab out of band, then re-invoke",
      };
    }
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
    // CONTINUATION 23 (the chat-tab baseline, PR #6 comment 5560261256
    // — "the real Z.ai Chat tab baseline does NOT require
    // authentication"): on the ordinary UNAUTHENTICATED Chat surface
    // the provider renders a fully functional composer BESIDE the
    // "Sign in" call-to-action (LIVE-OBSERVED 2026-09-06: the auth
    // CTA count read 1 the entire session while the composer was
    // ready, the prompt typed, the submission accepted, the chat
    // created, and the generation gated only by human verification).
    // For the CHAT reference mode the auth markers are the ACCEPTED
    // BASELINE, never a refusal; an auth-shaped DIALOG is still a
    // typed refusal (the dialog branch above, mode-independent).
    // The AGENT mode keeps the authenticated-session contract
    // unchanged (the explicitly-isolated Agent delta).
    if (authMarkerCount(facts) > 0 && !authMarkersBaseline) {
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
   * CONTINUATION 22 (PR #6 review 5125571572, path (b)): a dialog
   * visible during preparation fails closed UNKNOWN_DIALOG — the
   * adapter never prepares through a modal ("Unknown or
   * differently-shaped dialogs must fail closed").
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
    // CONTINUATION 22: no dialog is expected while preparing — any
    // dialog at this point fails closed UNKNOWN_DIALOG (never a
    // preparation through a modal).
    const preparingDialog = classifyDialog(facts.facts, "preparing");
    if (preparingDialog.kind !== "none") {
      return failure("UNKNOWN_DIALOG", `no dialog is expected during preparation: ${preparingDialog.reason}`);
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
   * and fails closed. CONTINUATION 22 (PR #6 review 5125571572,
   * path (b)): a dialog visible during preparation fails closed
   * UNKNOWN_DIALOG — the adapter never prepares through a modal.
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
    // CONTINUATION 22: no dialog is expected while preparing — any
    // dialog at this point fails closed UNKNOWN_DIALOG.
    const preparingDialog = classifyDialog(facts.facts, "preparing");
    if (preparingDialog.kind !== "none") {
      return failure("UNKNOWN_DIALOG", `no dialog is expected during preparation: ${preparingDialog.reason}`);
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
   * sent). CONTINUATION 22 (PR #6 review 5125571572, path (b)): a
   * dialog visible at this point fails closed UNKNOWN_DIALOG — never
   * a type through a modal.
   */
  async function ensurePrompt(tabId, prompt) {
    const facts = await readFacts(tabId);
    if (!facts.ok) {
      return facts;
    }
    const ensuringDialog = classifyDialog(facts.facts, "preparing");
    if (ensuringDialog.kind !== "none") {
      return failure(
        "UNKNOWN_DIALOG",
        `a dialog is visible while preparing the prompt submission: ${ensuringDialog.reason}`
      );
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
   * The KNOWN-POPUP recovery Enter (the frozen Work Order, RESTORED
   * by CONTINUATION 22 — PR #6 review 5125571572, path (b)): the ONLY
   * Enter the governed flows ever issue. "When and only when the
   * adapter observes the known submission-blocking popup, it may
   * press `Enter` once for the current retry attempt" — the press
   * is issued ONLY on the classified known popup (never on a timer,
   * never on an unclassified dialog, never at the send step), the
   * dismissal is VERIFIED by post-action observation, and the next
   * attempt RESTARTS the full preparation sequence. Whatever the
   * provider's key routing does with the key on the real surface
   * (dismissing the modal) is re-checked by the dismissal
   * verification: a popup that does not verifiably dismiss fails
   * closed UNKNOWN_DIALOG.
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
  // The agent-start watch (the shared governed acceptance of the
  // Start and Recover flows — CONTINUATION 15).
  // ------------------------------------------------------------------

      /**
     * CONTINUATION 15 (PR #6 review 5124990727 + review 5125102305 — the
     * superseded Send-reappearance/message-evidence state machine),
     * REVISED by CONTINUATION 16 (PR #6 review 5125198728 — the DIRECT
     * Z.ai CHAT-STATE WORKFLOW), REVISED AGAIN by CONTINUATION 20 (PR #6
     * comment 5559533083 — the superseding execution directive: the
     * operator's reported runtime object `chat` with `chat.id`,
     * `history.currentId`, UUID-keyed `history.messages`, `role`,
     * `parentId`, `childrenIds` — the provider's CONVERSATION STATE):
     * THE AGENT-START WATCH — the bounded watch for the provider-owned
     * signal that the Z.ai Agent has ACTUALLY STARTED WORKING. THE
     * DETECTOR (startSignalOf), per the directive's hierarchy —
     * prompt acceptance = the conversation state advancing with a new
     * turn; generation start = the provider's working state as
     * corroborating evidence: (i) THE CONVERSATION-STATE ADVANCEMENT
     * (continuation 20): the user-message turn count advanced past the
     * dispatch baseline AND the exact correlated text landed as a
     * user-message row — the operator's `chat.history.messages`
     * projection (the object itself lives in closure-scoped provider
     * stores, unreachable through the supported extension surface;
     * the rendered user rows ARE the observable conversation state,
     * and the count delta is the new turn; a STALE exact row from a
     * prior run never advances the count, a FOREIGN turn never
     * carries the exact text); (ii) THE PROVIDER'S WORKING STATE,
     * corroborating: the composer action slot rendering the Stop
     * control (the send control absent — the provider's mutually
     * exclusive slot machine); (iii) the composer DECISIVELY EMPTY
     * (the draft consumed — a prompt still held in the composer is
     * the provider's own proof the submission was NOT consumed, so a
     * Stop control over a text-holding composer is a foreign or
     * unconsumed generation, never our start signal); and (iv), on a
     * fresh session (the chat object did NOT exist at dispatch — the
     * session URL was at the origin base), the CHAT OBJECT CREATED
     * (the session URL advanced to /c/... — the provider's own
     * computed proof the submission was ACCEPTED: the bundle-proven
     * chat creation runs on the accepted first submission and is
     * skipped by the refused one — a foreign generation over a
     * discarded input on a fresh session has a Stop control and an
     * empty composer but NO chat object, and is never our start
     * signal). On an existing chat (the URL already at /c/... at
     * dispatch) the chat-state conjunct is vacuous — the
     * conversation-advancement + Stop-slot + empty-composer reading
     * carries the signal.
     * THE WATCH LOOP (CONTINUATION 22 — PR #6 review 5125571572,
     * path (b), the frozen Work Order semantics): rounds of bounded
     * observation (the settle budget per round) for the start signal,
     * a DIALOG, or a decisive failure surface — PURE OBSERVATION, no
     * key is ever pressed on a timer (the ONLY Enter the contract
     * permits is the observed-known-popup recovery the CALLER
     * dispatches when this watch returns the observed popup). The
     * inter-round pacing (watchRoundIntervalMs) bounds the total
     * window. One final observation round runs after the last paced
     * round; the exhaustion then FAILS CLOSED with the typed
     * agent-start-timeout diagnosis, routing the final facts THROUGH
     * THE CHAT STATE (the provider's own accepted/refused computation):
     *   - a decisive failure surface (authentication required / a
     *     provider error) -> the typed refusal;
     *   - a contradictory or unresolvable action slot -> the
     *     untrustworthy-surface refusal;
     *   - the composer holding the exact correlated text -> the
     *     bounded RE-SEND attempt (the next outer attempt re-verifies
     *     it byte-identically and re-sends through the send control);
     *   - the correlated text landed in the message evidence with a
     *     decisively empty composer and NO start signal: with the chat
     *     object created (the URL advanced) -> the queued or
     *     completed-unobserved diagnosis (the submission was accepted;
     *     the evidence is CONTEXT ONLY under this contract — never the
     *     acceptance predicate, never a resend trigger); with NO chat
     *     object (the URL never advanced) -> the refused-submission
     *     diagnosis (the landed row is the provider's local optimistic
     *     echo of a submission the server REFUSED — the observed
     *     capacity-rejection modality; the operator observes or
     *     re-invokes, never a resend);
     *   - the post-response surface (the Regenerate control) with a
     *     decisively empty composer -> the completed-unobserved
     *     diagnosis;
     *   - a decisively empty composer with no evidence and NO chat
     *     object -> the compose RE-ESTABLISHMENT (the input state was
     *     discarded around the send attempt — nothing was accepted;
     *     the next attempt re-types the exact text); with the chat
     *     object created (or the chat state unreadable) -> the
     *     accepted-not-started fail-closed refusal (NEVER the
     *     re-establishment: the submission may have been accepted, and
     *     a re-typed resend could duplicate it — the operator observes
     *     or re-invokes).
     *
     * @param {number} tabId the provider tab
     * @param {string} correlate the exact governed text whose
     *        submission the watch correlates to (the governed prompt
     *        for Start; the fixed recovery message for Recover)
     * @param {boolean} chatExistedAtDispatch whether the chat object
     *        already existed when the correlated text was dispatched
     *        (an existing chat's URL is already at /c/... — the
     *        chat-state conjunct is vacuous for the watch)
     * @param {number} baselineUserTurns the count of user-message
     *        turns rendered on the surface at the correlated text's
     *        DISPATCH (the read the caller already holds — the
     *        pre-send gate / the entered / the read-back facts): the
     *        conversation-state ADVANCEMENT is measured against this
     *        baseline (CONTINUATION 20, PR #6 comment 5559533083 —
     *        "prompt acceptance = conversation state advances with a
     *        new turn": a turn count that never advances past the
     *        baseline never carries the new turn, so a STALE exact
     *        row from a prior run is never the acceptance)
     * @param {{ popupRecovery?: boolean }} [options] CONTINUATION 22:
     *        `popupRecovery: true` (the Start flow) classifies dialogs
     *        in the "verifying-submission" phase and returns the
     *        OBSERVED KNOWN POPUP to the caller for the bounded
     *        Enter/dismiss/full-restart path; `false` (the Recover
     *        flow) fails closed on every dialog (the bounded popup
     *        recovery applies only to submission).
     * @returns {Promise<{ started?: object, refusal: object,
     *                    popup?: object, reestablished?: boolean }>}
     *         `popup` is the facts reading the observed known
     *         submission-blocking popup (popupRecovery only) — the
     *         caller owns the Enter, the dismissal verification, and
     *         the full preparation restart.
     */
    const watchAgentStart = async (tabId, correlate, chatExistedAtDispatch, baselineUserTurns, { popupRecovery = false, authMarkersBaseline = false } = {}) => {
      /**
       * The start signal: the combined provider-state detector.
       * CONTINUATION 20 (PR #6 comment 5559533083, the superseding
       * execution directive): the signal's composition now follows
       * the directive's hierarchy — the CONVERSATION-STATE
       * ADVANCEMENT is the prompt-acceptance leg (the user-turn
       * count advanced past the dispatch baseline AND the exact
       * correlated text landed as a user-message row — the new turn
       * is OURS, not a foreign turn; a stale exact row never
       * advances the count, a foreign turn never carries the exact
       * text), with the provider's working state (the Send→Stop
       * action-slot transition, `agentStartedOf`) as the
       * corroborating leg, the decisively empty composer (the
       * consumed draft — never a text-holding composer under a
       * foreign generation), and (a fresh session) the chat object
       * created — the session URL advanced to /c/... (the
       * bundle-proven server-acceptance routing that discriminates
       * the refused submission's withdrawn local echo).
       */
      const startSignalOf = (f) =>
        agentStartedOf(f) &&
        composerValueOf(f) === "" &&
        (chatExistedAtDispatch || chatObjectCreatedOf(f) === true) &&
        userTurnCountOf(f) !== null &&
        userTurnCountOf(f) > baselineUserTurns &&
        messageEvidenceContains(f, correlate);
      /**
       * The watch's dialog classification phase: the Start flow
       * verifies a submission (the known popup is classifiable); the
       * Recover flow fails closed on every dialog.
       */
      const phase = popupRecovery ? "verifying-submission" : "recovery";
      /**
       * THE DIALOG DISPATCH (CONTINUATION 22 — the frozen Work
       * Order's dialog law): auth-shaped -> AUTHENTICATION_INTERRUPTED
       * (never Enter); error-shaped -> PROVIDER_ERROR (never Enter);
       * the KNOWN submission-blocking popup, Start flow only -> the
       * observed-popup return (the CALLER's bounded Enter/dismiss/
       * full-restart path); everything else (a dialog outside the
       * submission-verification window, multiple simultaneous
       * dialogs, the recovery flow) -> UNKNOWN_DIALOG. The adapter
       * never blindly presses keys.
       */
      const dispatchDialog = (f) => {
        const dialog = classifyDialog(f, phase);
        if (dialog.kind === "none") {
          return null;
        }
        if (dialog.kind === "auth") {
          return {
            refusal: failure("AUTHENTICATION_INTERRUPTED", `authentication was required while observing the submission outcome: ${dialog.reason}`),
          };
        }
        if (dialog.kind === "error") {
          return {
            refusal: failure("PROVIDER_ERROR", `the provider surfaced an error dialog while observing the submission outcome: ${dialog.reason}`),
          };
        }
        if (popupRecovery && dialog.kind === "known-popup") {
          return { popup: f };
        }
        return {
          refusal: failure(
            "UNKNOWN_DIALOG",
            `a differently-shaped dialog is visible while observing the submission outcome: ${dialog.reason}`
          ),
        };
      };
      /**
       * THE ASYNC-OUTCOME HOLD (RESTORED by CONTINUATION 22 —
       * continuation 10, PR #6 review 5123872434: the real known
       * popup materializes only when the ASYNCHRONOUS chat-completion
       * error arrives, AFTER the optimistic landing the start signal
       * just read). The hold is a pure GATE on the acceptance: after
       * the start signal, the outcome is held through the bounded
       * confirmationHoldPolls window for exactly the late observables:
       * a dialog (dispatched by the same dialog law — the known popup
       * reaches the caller's Enter path; everything else fails
       * closed), and the provider's prompt RESTORE (a refilled
       * composer, or the send control recomputed ENABLED — the
       * provider's own "a prompt is (back) present" computation, the
       * reactive companion of the restore even while the raw value
       * read lags). A QUIET window passes the SIGNAL facts through as
       * the acceptance (the recording describes the acceptance
       * moment; later provider transitions — the completion slot
       * swap-back — are CONTEXT ONLY, exactly the c14/c15 boundary
       * law); an unwatchable window (every read failed) also passes
       * the signal through — the acceptance is never asserted beyond
       * the bounded window either way (a popup beyond it is a
       * live-evidence matter).
       */
      const holdForAsyncOutcome = async (signalFacts) => {
        for (let i = 0; i < confirmationHoldPolls; i += 1) {
          await sleep(settleIntervalMs);
          const read = await readFacts(tabId);
          if (!read.ok) {
            continue; // a transport failure is not a submission outcome
          }
          const quiet = read.facts;
          // CONTINUATION 23 (the chat-tab baseline): the INTERACTIVE
          // HUMAN-VERIFICATION gate observed inside the hold window —
          // the LIVE-OBSERVED unauthenticated-Chat modality where the
          // start signal's legs ALL fire (the row landed, the composer
          // consumed, the chat object created, the slot swapped to
          // Stop) while the GENERATION is actually held at the
          // provider's interactive captcha gate. The acceptance is
          // refused: the typed HUMAN_VERIFICATION_REQUIRED gate (the
          // operator's out-of-band action — never Enter, never the
          // known popup, never a retry).
          if (humanVerificationVisible(quiet)) {
            return {
              refusal: failure(
                "HUMAN_VERIFICATION_REQUIRED",
                "the provider demanded interactive human verification after the accepted-shaped reading: the submission's row landed and the action slot swapped, but the generation is held at the provider's interactive captcha gate (LIVE-OBSERVED on the unauthenticated Chat surface). The adapter never solves human verification — complete the puzzle in the provider tab out of band, then re-invoke Start"
              ),
            };
          }
          const dialog = dispatchDialog(quiet);
          if (dialog) {
            return dialog;
          }
          // A COMPLETED generation resolves the async outcome: the
          // capacity refusal arrives on the chat-completion error, so
          // a generation that ran to completion was accepted — no
          // late popup can follow it. The completion is CONTEXT ONLY
          // (the recording still describes the signal moment).
          // CONTINUATION 23 (the chat-tab baseline): the COMPLETED
          // surface is checked for the provider's COMPLETION-ERROR
          // rendering FIRST — LIVE-OBSERVED on the real Chat surface:
          // the assistant row reads "No response, Please try again
          // later. SyntaxError: ..." while the action-slot facts (the
          // send control back, the Stop gone, the Regenerate control
          // visible) are IDENTICAL to a successful completion. A
          // completion that the provider itself reports as failed is
          // a typed refusal, never an accepted outcome (the same
          // asynchronous chat-completion error class as the capacity
          // popup — rendered through the assistant row instead of a
          // dialog).
          if (
            postResponseRegenerateVisible(quiet) &&
            !stopVisible(quiet) &&
            completionErrorTextOf(quiet) !== null
          ) {
            return {
              refusal: failure(
                "PROVIDER_ERROR",
                "the provider completed the exchange with an error surface: the assistant row renders the provider's completion error (\"No response, Please try again later. ...\" — LIVE-OBSERVED on the real Chat surface) while the action-slot facts are indistinguishable from a successful completion. The submission was accepted but the generation failed server-side; observe the session or re-invoke Start"
              ),
            };
          }
          if (postResponseRegenerateVisible(quiet) && !stopVisible(quiet)) {
            return { accepted: signalFacts };
          }
          const value = composerValueOf(quiet);
          if (value !== null && value.length > 0) {
            return {
              refusal: failure(
                "PAGE_MALFORMED",
                "the provider returned the exact text to the composer after the accepted-shaped reading (the observed capacity-rejection restore — the submission was not accepted after all). The bounded retry re-verifies the exact text byte-identically and re-sends through the send control"
              ),
            };
          }
          if (sendEnabledOf(quiet) === true) {
            return {
              refusal: failure(
                "PAGE_MALFORMED",
                "the provider recomputed the send control enabled after the accepted-shaped reading (its own prompt-present computation — the capacity-rejection restore in flight). The bounded retry re-verifies the exact text byte-identically and re-sends through the send control"
              ),
            };
          }
        }
        return { accepted: signalFacts };
      };
      /** One observation round: decisive on the start signal, a dialog, or a failure surface. */
      const observeRound = async () => {
        const decisive = (f) => {
          if (startSignalOf(f)) {
            return true; // THE START SIGNAL (the provider's own computed proof)
          }
          if (humanVerificationVisible(f)) {
            return true; // CONTINUATION 23: the human-verification gate is decisive (typed refusal)
          }
          if (classifyDialog(f, phase).kind !== "none") {
            return true; // a visible dialog is dispatched (never ignored)
          }
          const verdict = classifySession(f, null, phase, { authMarkersBaseline });
          return verdict.state === "authentication-required" || verdict.state === "provider-error";
        };
        return settle(tabId, [], decisive);
      };
      for (let round = 0; round < watchRounds; round += 1) {
        const observed = await observeRound();
        if (observed.ok && startSignalOf(observed.facts)) {
          // The signal is observed — the ASYNC-OUTCOME HOLD gates the
          // acceptance (a late popup or the provider's restore
          // re-opens the bounded recovery; a quiet window records).
          const held = await holdForAsyncOutcome(observed.facts);
          if (held.accepted) {
            return { started: held.accepted, refusal: null };
          }
          return { started: null, refusal: held.refusal ?? null, popup: held.popup ?? null };
        }
        if (observed.ok) {
          // CONTINUATION 23 (the chat-tab baseline): the interactive
          // human-verification gate observed DURING the watch — the
          // typed refusal, terminal for Start (the operator's
          // out-of-band action; never Enter, never retried, never the
          // known popup).
          if (humanVerificationVisible(observed.facts)) {
            return {
              started: null,
              refusal: failure(
                "HUMAN_VERIFICATION_REQUIRED",
                "the provider demanded interactive human verification while observing the submission outcome: the body-level Aliyun captcha surface is visible (the submission's row landed and the generation is held at the provider's interactive gate). The adapter never solves human verification — complete the puzzle in the provider tab out of band, then re-invoke Start"
              ),
            };
          }
          const dialog = dispatchDialog(observed.facts);
          if (dialog) {
            if (dialog.refusal) {
              return { started: null, refusal: dialog.refusal };
            }
            return { started: null, refusal: null, popup: dialog.popup };
          }
          const verdict = classifySession(observed.facts, null, phase, { authMarkersBaseline });
          if (verdict.state === "authentication-required") {
            return {
              started: null,
              refusal: failure(
                "AUTHORIZATION_REQUIRED",
                `the chat.z.ai session lost authentication before the agent start was observed: ${verdict.detail}. Human authentication is out of band — authenticate in the provider tab, then start the worker session again`
              ),
            };
          }
          if (verdict.state === "provider-error") {
            return {
              started: null,
              refusal: failure("PROVIDER_ERROR", `the provider surfaced an error before the agent start was observed: ${verdict.detail}`),
            };
          }
        }
        // The round is unresolved: the inter-round pacing (PURE
        // OBSERVATION — no key is ever pressed on a timer). The
        // observation phase already consumed the settle budget; the
        // remainder of the round interval is slept here, clamped at
        // zero when the settle budget exceeds it.
        const settleWindowMs = settlePolls * settleIntervalMs;
        const waitMs = Math.max(0, watchRoundIntervalMs - settleWindowMs);
        if (waitMs > 0) {
          await sleep(waitMs);
        }
      }
      // The FINAL observation round (paced by the interval): the
      // signal may have followed the last round.
      const final = await observeRound();
      if (final.ok && startSignalOf(final.facts)) {
        const held = await holdForAsyncOutcome(final.facts);
        if (held.accepted) {
          return { started: held.accepted, refusal: null };
        }
        return { started: null, refusal: held.refusal ?? null, popup: held.popup ?? null };
      }
      // EXHAUSTION: the typed agent-start-timeout diagnosis, routed by
      // the final facts.
      if (!final.ok) {
        return { started: null, refusal: final };
      }
      const f = final.facts;
      // CONTINUATION 22: a dialog on the exhausted surface is
      // dispatched by the same dialog law (never ignored).
      const exhaustedDialog = dispatchDialog(f);
      if (exhaustedDialog) {
        if (exhaustedDialog.refusal) {
          return { started: null, refusal: exhaustedDialog.refusal };
        }
        return { started: null, refusal: null, popup: exhaustedDialog.popup };
      }
      // CONTINUATION 23 (the chat-tab baseline): the human-verification
      // gate on the exhausted surface — the typed refusal (terminal,
      // the operator's out-of-band action).
      if (humanVerificationVisible(f)) {
        return {
          started: null,
          refusal: failure(
            "HUMAN_VERIFICATION_REQUIRED",
            "the agent-start watch exhausted its bounded window with the provider demanding interactive human verification: the body-level Aliyun captcha surface is visible (the generation is held at the provider's interactive gate). The adapter never solves human verification — complete the puzzle in the provider tab out of band, then re-invoke Start"
          ),
        };
      }
      const verdict = classifySession(f, null, phase, { authMarkersBaseline });
      if (verdict.state === "authentication-required") {
        return {
          started: null,
          refusal: failure(
            "AUTHORIZATION_REQUIRED",
            `the chat.z.ai session lost authentication before the agent start was observed: ${verdict.detail}. Human authentication is out of band — authenticate in the provider tab, then start the worker session again`
          ),
        };
      }
      if (verdict.state === "provider-error") {
        return {
          started: null,
          refusal: failure("PROVIDER_ERROR", `the provider surfaced an error before the agent start was observed: ${verdict.detail}`),
        };
      }
      const surfaceRefusal = untrustworthySurfaceRefusal(f);
      if (surfaceRefusal) {
        return { started: null, refusal: surfaceRefusal };
      }
      const composerValue = composerValueOf(f);
      const evidence = messageEvidenceContains(f, correlate);
      // CONTINUATION 16: the chat-state routing — the provider's own
      // accepted/refused computation (the URL advance is the
      // bundle-proven chat-object creation on acceptance).
      const chatCreated = chatObjectCreatedOf(f);
      if (composerValue === correlate) {
        // The correlated text is STILL in the composer: the submission
        // was not consumed (the provider returned it, or the send
        // never took — its concurrency gate refuses a second prompt
        // while a generation runs). The bounded re-send attempt: the
        // next outer attempt re-verifies the byte-identical text and
        // re-sends through the send control. Never a blind re-type,
        // never a keypress (the Enter is reserved for the observed
        // known popup alone).
        // CONTINUATION 23 (the chat-tab baseline, LIVE-OBSERVED): the
        // retained-draft exhaustion surface may ALSO carry the action
        // slot swapped to Stop — the provider reporting a task in
        // progress while the input was never consumed (the observed
        // non-trusted-dispatch modality: the submission's input
        // pipeline did not take the event, or the submission is held
        // at the provider's pre-acceptance gate). The slot state is
        // reported in the typed detail (the fail-closed law is
        // unchanged: never ok, never resent blind).
        const slotWorking = stopVisible(f);
        return {
          started: null,
          refusal: failure(
            "PAGE_MALFORMED",
            `the agent-start watch exhausted its bounded window without the start signal — the exact text remains in the composer (the submission was not consumed; the provider's own concurrency gate refuses a second prompt while a generation runs${
              slotWorking
                ? ", and the action slot is swapped to the Stop control while the draft is retained — the LIVE-OBSERVED unauthenticated-Chat modality where the dispatch reported a task without consuming the input (a dispatch the provider's input pipeline did not accept, or a submission held at the provider's interactive gate)"
                : ""
            }). The bounded retry re-verifies the exact text byte-identically and re-sends through the send control`
          ),
        };
      }
      if (composerValue === "") {
        if (evidence) {
          if (chatCreated === false) {
            // CONTINUATION 16: the landed row with NO chat object —
            // the provider's own routing state proves the submission
            // was REFUSED server-side (the 429/capacity path returns
            // before the chat creation): the row is the provider's
            // local optimistic echo, not an accepted submission.
            // CONTEXT ONLY — never resent (a landed row is never
            // duplicated); the operator observes or re-invokes.
            return {
              started: null,
              refusal: failure(
                "AMBIGUOUS_STATE",
                "the agent-start watch exhausted its bounded window without the start signal — the exact text is present in the message evidence with a decisively empty composer, but the chat object was never created (the session URL never advanced to a chat route): the landed row is the provider's local echo of a submission the server REFUSED (the observed capacity-rejection modality), never an accepted one. The message evidence is context only under this contract (never the acceptance predicate), and a landed row is never resent. Observe the session or re-invoke Start to re-observe"
              ),
            };
          }
          // The correlated text LANDED (message evidence) with a
          // decisively empty composer and NO start signal: the
          // submission was ACCEPTED (the chat object created) and the
          // generation may be queued or have completed unobserved.
          // CONTEXT ONLY — never the acceptance predicate, and never a
          // resend trigger (a landed message is never duplicated).
          // The operator observes the session or re-invokes.
          return {
            started: null,
            refusal: failure(
              "AMBIGUOUS_STATE",
              `the agent-start watch exhausted its bounded window without the start signal while the exact text is present in the message evidence with a decisively empty composer${
                chatCreated === true
                  ? " and the chat object was created (the session URL advanced to a chat route — the submission was accepted)"
                  : " (the chat state could not be read decisively)"
              } — the generation may be queued or have completed unobserved; the message evidence is context only under this contract (never the acceptance predicate), and a landed message is never resent. Observe the session or re-invoke Start to re-observe`
            ),
          };
        }
        if (postResponseRegenerateVisible(f)) {
          // The post-response surface: the last response completed or
          // was stopped — a short generation may have completed inside
          // the watch's observation gap.
          return {
            started: null,
            refusal: failure(
              "AMBIGUOUS_STATE",
              "the agent-start watch exhausted its bounded window without the start signal — the post-response surface is visible (the Regenerate control): the generation appears to have completed (or was stopped) without the start signal being observed. Observe the session or re-invoke Start"
            ),
          };
        }
        if (chatCreated === false) {
          // The SECOND observed failure mode (PR #6 review 5123047551,
          // requirement 3) — now chat-state-gated (CONTINUATION 16):
          // the input state was discarded around the send attempt AND
          // the provider's own routing state proves NOTHING was
          // accepted (no chat object, the session URL never advanced)
          // — the bounded compose re-establishment is safe (the next
          // attempt re-types the exact text byte-for-byte, re-reads it
          // byte-for-byte, and only then resends).
          const reestablished = await reestablishComposer(tabId);
          if (reestablished.ok) {
            return {
              started: null,
              refusal: failure(
                "PAGE_MALFORMED",
                "the agent-start watch exhausted its bounded window without the start signal and the prompt was not present in the composer (submission not confirmed by message evidence and the chat object never created — the submission was never accepted) — the composer input state was re-established for a re-typed, re-verified resend"
              ),
              reestablished: true,
            };
          }
          return { started: null, refusal: reestablished };
        }
        // CONTINUATION 16: the chat object EXISTS (or the chat state is
        // unreadable) with a decisively empty composer, no message
        // evidence, and no start signal — the submission may have been
        // ACCEPTED (the chat route proves it; an unreadable chat state
        // never guesses). The re-establishment is NEVER taken here: a
        // re-typed resend could duplicate an accepted submission. The
        // operator observes the session or re-invokes Start.
        return {
          started: null,
          refusal: failure(
            "AMBIGUOUS_STATE",
            `the agent-start watch exhausted its bounded window without the start signal — the composer is decisively empty with no message evidence and ${
              chatCreated === true
                ? "the chat object was created (the session URL advanced to a chat route: the submission was accepted, the start signal was simply not observed in the bounded window — the generation may be queued or have completed unobserved)"
                : "the chat state could not be read decisively (the submission's acceptance is unconfirmed — no re-established resend is attempted: a re-typed send could duplicate an accepted submission)"
            }. Observe the session or re-invoke Start to re-observe`
          ),
        };
      }
      return {
        started: null,
        refusal: failure(
          "AMBIGUOUS_STATE",
          "the composer state could not be read decisively through the agent-start watch (absent or ambiguous) — the start signal is unconfirmed and the watch failed closed"
        ),
      };
    };

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
  async function startWorkerSession({ worker, workItem, prompt, mode = "agent" }) {
    // CONTINUATION 23 (PR #6 comments 5560253287 + 5560261256, the
    // ARCHITECT chat-tab-baseline directives): the MODE parameter —
    // "agent" (the default: the frozen Work Order's governed
    // authenticated Agent-mode Worker session, the contract
    // UNCHANGED) or "chat" (THE CHAT-TAB REFERENCE PATH — the
    // ARCHITECT-directed reference implementation, the
    // LIVE-PROVEN unauthenticated Chat lifecycle from which the
    // Agent behavior is derived). The two paths share the ENTIRE
    // submission/verification/recovery lifecycle (the prompt
    // entry, the send gate, the dispatch, the advancement-based
    // start signal, the async-outcome hold, the dialog law, the
    // hung-worker recovery); the ONLY differences are the
    // explicitly-isolated preparation steps and the
    // authentication posture — the minimal Agent delta this
    // continuation exists to expose:
    //   CHAT (the reference): the ordinary Chat tab, UNAUTHENTICATED
    //   by design (the "Sign in" call-to-action coexists with a
    //   fully functional composer — LIVE-OBSERVED), NO Agent-pill
    //   selection, NO model selection, NO provisioning wait (the
    //   fresh Chat surface is ready-for-input at rest).
    //   AGENT (the delta): the authenticated session gate, the
    //   Agent-pill selection, the model selection, the provisioning
    //   wait.
    if (mode !== "chat" && mode !== "agent") {
      return failure(
        "AMBIGUOUS_STATE",
        `the Z.ai adapter Start mode must be "chat" or "agent" (received: ${JSON.stringify(mode)})`
      );
    }
    const authMarkersBaseline = mode === "chat";
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

    // 2. verify the session state (and that the surface is
    // ready for the preparation sequence). CONTINUATION 22 (PR #6
    // review 5125571572, path (b)): a dialog visible on the target
    // session before preparation fails closed UNKNOWN_DIALOG (the
    // frozen Work Order's dialog law — never a preparation through
    // a modal); auth-shaped dialogs read authentication-required.
    // CONTINUATION 23: the interactive human-verification gate
    // fails closed before preparation in BOTH modes (the operator's
    // out-of-band action); the auth MARKERS are the accepted
    // baseline for the CHAT reference mode (the LIVE-PROVEN
    // unauthenticated Chat surface) and the typed authenticated-
    // session refusal for the AGENT mode (the Work Order's
    // contract, unchanged).
    const settled = await settle(tabId, [], (f) => {
      const c = classifySession(f, null, "preparing", { authMarkersBaseline });
      return c.state !== "ambiguous";
    });
    if (!settled.ok) {
      return settled;
    }
    const precheck = classifySession(settled.facts, null, "preparing", { authMarkersBaseline });
    if (precheck.state === "human-verification-required") {
      return failure("HUMAN_VERIFICATION_REQUIRED", `the provider is demanding interactive human verification before preparation: ${precheck.detail}`);
    }
    if (precheck.state === "authentication-required") {
      return failure(
        "AUTHORIZATION_REQUIRED",
        `the chat.z.ai session is not authenticated: ${precheck.detail}. Human authentication is out of band — authenticate in the provider tab, then start the worker session again`
      );
    }
    if (precheck.state === "provider-error") {
      return failure("PROVIDER_ERROR", `the target session is presenting an error surface: ${precheck.detail}`);
    }
    if (precheck.state === "unexpected-dialog" || precheck.state === "expected-blocking-dialog") {
      return failure("UNKNOWN_DIALOG", `a dialog is visible on the target session before preparation: ${precheck.detail}`);
    }
    if (precheck.state !== "ready-for-input") {
      return failure(
        "AMBIGUOUS_STATE",
        `the target session is not ready for a new worker session (observed: ${precheck.state} — ${precheck.detail})`
      );
    }

    // 3-7. bounded preparation/send/verification attempts. The first
    // attempt runs the full preparation (Agent -> model -> prompt).
    // CONTINUATION 22 (PR #6 review 5125571572, path (b) — the
    // frozen Work Order semantics): the KNOWN-POPUP recovery is
    // RESTORED — when the verification watch returns the OBSERVED
    // known submission-blocking popup, the adapter presses Enter
    // exactly once for the current retry attempt, VERIFIES the
    // dismissal by post-action observation, and the next attempt
    // RESTARTS THE FULL PREPARATION SEQUENCE (Agent -> model ->
    // provisioning -> prompt -> send -> verification). An unconfirmed
    // send whose composer still holds the exact prompt resends
    // as-is (the pre-send gate re-verifies it byte-for-byte); an
    // already-confirmed submission is never resent; unknown dialogs
    // fail closed at every step.
    let attempts = 0;
    let popupDismissals = 0;
    let composeReestablishments = 0;
    let lastRefusal = null;
    let prepared = false;

    /**
     * Record the CONFIRMED submission (the shared acceptance path).
     * The acceptance is the AGENT-START SIGNAL itself, observed by
     * watchAgentStart and gated by the ASYNC-OUTCOME HOLD — the
     * recording is entered ONLY from the started reading (the Stop
     * control visible with the composer decisively empty, held
     * through the bounded async-outcome window), so `generation` is
     * ALWAYS "working" at the recording read. The recording is GATED
     * on the trustworthiness of the recording facts (the
     * continuation-12 contradictions — a contradictory composer
     * action-slot state, the provider's computed prompt-present
     * signal contradicting the decisively-empty composer read): an
     * untrustworthy surface never records. CONTINUATION 22: the
     * `submitted` record carries the frozen FOUR-FIELD shape
     * (attempts, popupDismissals, composeReestablishments,
     * generation — the pre-c13 invariant, review 5123260890
     * requirement 2 "the existing four-field submission result
     * invariant").
     */
    const recordSubmission = (facts) => {
      const surfaceRefusal = untrustworthySurfaceRefusal(facts);
      if (surfaceRefusal) {
        return surfaceRefusal;
      }
      const generation = stopVisible(facts) ? "working" : "waiting";
      const record = {
        worker,
        workItem,
        tabId,
        prompt,
        mode,
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

    /**
     * THE KNOWN-POPUP RECOVERY PATH (CONTINUATION 22 — the frozen
     * Work Order: "When and only when the adapter observes the known
     * submission-blocking popup, it may press `Enter` once for the
     * current retry attempt. After dismissal it must restart from
     * Agent selection, model selection, exact prompt entry, send and
     * submission verification. Retries are bounded/configurable.").
     * Called ONLY with the observed popup in hand (the verification
     * watch's popup return — Enter is never issued on a timer or on
     * an unclassified dialog). The dismissal is VERIFIED by
     * post-action observation (a keypress is never evidence by
     * itself); popupDismissals counts only actually-issued presses;
     * the restart is signaled by resetting `prepared` (the next
     * attempt re-runs the idempotent full preparation — the
     * re-selection re-establishes every governed ground truth the
     * popup interaction may have disturbed). The dismissal itself is
     * NEVER success; an already-confirmed submission is still never
     * resent.
     * Returns null on a VERIFIED dismissal (the restart follows), or
     * the typed refusal.
     */
    const dismissKnownPopup = async () => {
      if (attempts >= maxSubmissionAttempts) {
        return failure(
          "RETRY_EXHAUSTED",
          `the known submission-blocking popup persisted beyond the bounded attempt budget (${maxSubmissionAttempts} attempts, ${popupDismissals} dismissals)`
        );
      }
      // The ONE bounded Enter press for this attempt.
      const pressed = await pressEnter(tabId);
      if (!pressed.ok) {
        return pressed;
      }
      popupDismissals += 1; // counted only AFTER the press was actually issued
      const dismissed = await settle(tabId, [], (f) => dialogCount(f) === 0);
      if (!dismissed.ok) {
        return dismissed;
      }
      if (dialogCount(dismissed.facts) !== 0) {
        return failure("UNKNOWN_DIALOG", "the known submission-blocking popup did not dismiss after the Enter press");
      }
      prepared = false; // the next attempt RESTARTS the full preparation sequence
      return null;
    };

    /**
     * A dialog/failure refusal that is TERMINAL for Start — the
     * c12-era dialog branches (and the frozen Work Order's
     * fail-closed dialog law) return these directly, never retried:
     * authentication is out of band (the operator authenticates and
     * re-invokes), a provider-error surface is not transient, and an
     * unknown dialog is a typed contract violation (retrying it
     * would burn the budget on the same surface).
     */
    const terminalForStart = (refusal) =>
      refusal !== null &&
      refusal !== undefined &&
      !refusal.ok &&
      ["AUTHENTICATION_INTERRUPTED", "AUTHORIZATION_REQUIRED", "HUMAN_VERIFICATION_REQUIRED", "PROVIDER_ERROR", "UNKNOWN_DIALOG"].includes(
        refusal.error?.code
      );

    while (attempts < maxSubmissionAttempts) {
      attempts += 1;
      if (!prepared) {
        // 3-4b. THE PREPARATION SEQUENCE — mode-dependent (CONTINUATION
        // 23, the chat-tab baseline): the AGENT mode runs the frozen
        // Work Order's governed preparation (the Agent-pill selection,
        // the model selection, the provisioning wait — the
        // explicitly-isolated Agent delta); the CHAT reference mode
        // runs NONE of them — the ordinary unauthenticated Chat
        // surface is ready-for-input AT REST (LIVE-OBSERVED: the
        // composer visible and enabled on the fresh surface before any
        // interaction; the precheck above already settled the
        // ready-for-input state). The popup-recovery restart resets
        // `prepared`; the CHAT restart re-marks prepared directly (no
        // mode/model ground truth to re-establish — the restart's
        // prompt re-entry and send gate re-verify everything the
        // popup interaction may have disturbed).
        if (mode === "agent") {
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
        // 4b. THE PROVISIONING WAIT (CONTINUATION 16, PR #6 review
        //     5125198728, requirement 1 — "treat creation of the
        //     chat/session as an asynchronous provider operation"): the
        //     fresh Agent-mode chat session mounts asynchronously on
        //     the provider side (the observed provisioning latency);
        //     the most reliable live-observable that provisioning
        //     completed is the composer becoming a VISIBLE, ENABLED,
        //     decisive input — the provider renders its chat-input
        //     surface only from the provisioned session state, and the
        //     enabled computation is the provider's own (its
        //     connection/role gates). The bounded wait tolerates the
        //     async window; a surface that NEVER readies within the
        //     budget fails closed with the typed provisioning refusal
        //     — the exact prompt is never typed into a surface whose
        //     session provisioning has not verifiably completed.
        const provisioned = await settle(tabId, [], (f) =>
          f.composerVisible?.visible === true && f.composerEnabled?.enabled === true
        );
        if (!provisioned.ok) {
          lastRefusal = provisioned;
          continue;
        }
        if (
          provisioned.facts.composerVisible?.visible !== true ||
          provisioned.facts.composerEnabled?.enabled !== true
        ) {
          lastRefusal = failure(
            "RETRY_EXHAUSTED",
            "the fresh Agent-mode chat session did not complete provisioning within the bounded budget — the composer never became a visible enabled input (the chat/session creation is an asynchronous provider operation). Retry Start when the provider surface is ready"
          );
          continue;
        }
          prepared = true;
        } else {
          // THE CHAT REFERENCE PATH (CONTINUATION 23): no Agent-pill
          // selection, no model selection, no provisioning wait — the
          // precheck already settled the ready-for-input surface (the
          // ordinary Chat tab renders its composer ready at rest,
          // LIVE-OBSERVED). The shared lifecycle takes over at the
          // prompt entry below.
          prepared = true;
        }
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
        // The submission already landed by MESSAGE-EXCLUSIVE provider
        // evidence (e.g. the send landed while the verification was
        // reading). The landed prompt is NEVER resent, and the
        // verification watch observes for the acceptance signal
        // (queued, active, or unobserved) with the same bounded
        // fail-closed window and the same dialog dispatch. The
        // watch's chat-state conjunct uses the chat state at THIS
        // read (a landed accepted submission has created the chat
        // object — the URL advanced; a locally-echoed refused one has
        // not, and the watch's exhaustion diagnoses exactly that).
        const outcome = await watchAgentStart(
          tabId,
          prompt,
          chatObjectCreatedOf(entered.facts) === true,
          userTurnCountOf(entered.facts) ?? 0,
          { popupRecovery: true, authMarkersBaseline }
        );
        if (outcome.started) {
          const recorded = recordSubmission(outcome.started);
          if (recorded.ok) {
            return recorded;
          }
          lastRefusal = recorded;
          continue;
        }
        if (outcome.reestablished) {
          composeReestablishments += 1;
        }
        if (outcome.popup) {
          // The OBSERVED KNOWN POPUP on the already-landed surface: the
          // bounded Enter path (below) — the dismissal and restart
          // re-observe the never-resent landed row.
          const dispatched = await dismissKnownPopup();
          if (dispatched) {
            if (terminalForStart(dispatched)) {
              return dispatched;
            }
            lastRefusal = dispatched;
            continue;
          }
          continue; // the dismissal succeeded — the restart follows
        }
        if (terminalForStart(outcome.refusal)) {
          return outcome.refusal; // the dialog/failure refusals are terminal — never retried
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
      // CONTINUATION 22: no dialog is expected at the send gate — any
      // dialog at this point fails closed UNKNOWN_DIALOG (never a
      // send through a modal).
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
      // 6. SEND: the exact governed prompt is sent ONCE per bounded
      //    attempt — the send control is clicked when the composer
      //    action slot renders it. There is NO Enter fallback at the
      //    send step (the frozen Work Order reserves Enter for the
      //    OBSERVED known popup alone — the adapter never blindly
      //    presses keys): an inaccessible Send control, a slot
      //    rendering the Stop control, a contradictory or unresolvable
      //    slot, or a send click that fails are unresolved send states
      //    — the verification watch observes and the bounded attempt
      //    budget fails closed. When the slot renders the Stop control
      //    the provider itself is mid-generation and will not accept a
      //    second prompt — the provider's own concurrency gate is the
      //    duplicate guard, never an artificial one.
      if (controlStateOf(gate.facts) === "send") {
        const clicked = await send(tabId);
        if (!clicked.ok) {
          // The click itself failed: the watch observes (never an
          // Enter — the bounded attempts re-verify and re-attempt
          // the send through the real control, or fail closed).
          lastRefusal = clicked;
        }
      }
      // 7. THE SUBMISSION VERIFICATION (the frozen Work Order's step
      //    7 — "verify that the prompt was actually accepted/submitted
      //    by observing the resulting provider state"): the bounded
      //    watch for THE CONVERSATION-STATE ADVANCEMENT (the user-turn
      //    count advanced past the DISPATCH BASELINE — the pre-send
      //    gate read above — AND the exact prompt landed as a
      //    user-message row) with the Send->Stop action-control
      //    transition corroborating (the Stop control rendered with
      //    the send control absent, the composer decisively empty)
      //    and, on a fresh session, the chat-object creation (the
      //    session URL advanced to /c/... — the provider's own proof
      //    the submission was ACCEPTED), with PURE OBSERVATION (no
      //    keypress on a timer), the DIALOG DISPATCH (the observed
      //    known popup reaches dismissKnownPopup below; every other
      //    dialog fails closed), the ASYNC-OUTCOME HOLD after the
      //    signal, and the bounded fail-closed window. The chat state
      //    at DISPATCH (the pre-send gate read) makes the conjunct
      //    vacuous on an existing chat and strict on a fresh one.
      const outcome = await watchAgentStart(
        tabId,
        prompt,
        chatObjectCreatedOf(gate.facts) === true,
        userTurnCountOf(gate.facts) ?? 0,
        { popupRecovery: true, authMarkersBaseline }
      );
      if (outcome.started) {
        const recorded = recordSubmission(outcome.started);
        if (recorded.ok) {
          return recorded;
        }
        lastRefusal = recorded;
        continue;
      }
      if (outcome.reestablished) {
        composeReestablishments += 1;
      }
      if (outcome.popup) {
        // THE OBSERVED KNOWN SUBMISSION-BLOCKING POPUP (the frozen
        // Work Order's recovery path — the ONLY Enter): the bounded
        // press, the verified dismissal, and the FULL preparation
        // restart on the next attempt.
        const dispatched = await dismissKnownPopup();
        if (dispatched) {
          if (terminalForStart(dispatched)) {
            return dispatched;
          }
          lastRefusal = dispatched;
        }
        continue;
      }
      if (terminalForStart(outcome.refusal)) {
        return outcome.refusal; // the dialog/failure refusals are terminal — never retried
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
   * FIXED message `continue` -> the SAME acceptance watch (PURE
   * OBSERVATION — PR #6 review 5124829301 requirement 6: the recovery
   * does NOT require a persistent in-memory session across
   * service-worker restarts — the request itself carries the
   * Worker/Work-Item/tab correlation and the governed sequence runs
   * from it; a registry entry that CONTRADICTS the request still
   * fails closed STALE_REFERENCE, but a LOST registry no longer
   * refuses — the operator's SESSION_UNKNOWN run is the motivating
   * evidence). Bounded; every required transition is verified or the
   * recovery fails closed as a governance hold. The acceptance is
   * the SAME start signal as Start (the new `continue` turn landing
   * with the Stop control corroborating — the agent resumed working).
   * CONTINUATION 22 (the frozen Work Order's dialog law): a dialog
   * visible at ANY point of the recovery fails closed UNKNOWN_DIALOG
   * (the bounded popup recovery applies only to submission — never
   * a blind keypress, never an Enter).
   */
  async function recoverHungWorker({ worker, workItem, tabId }) {
    const registered = sessions.get(worker) ?? null;
    // The exact correlation: Worker + Work Item + browser session. A
    // registry entry that CONTRADICTS the request fails closed; a
    // LOST registry (service-worker restart) proceeds on the
    // request's own correlation (5124829301, requirement 6).
    if (registered && (registered.workItem !== workItem || registered.tabId !== tabId)) {
      return failure(
        "STALE_REFERENCE",
        `contradictory session reference: the active correlation is worker '${registered.worker}' / work item '${registered.workItem}' / tab ${registered.tabId}`
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
      // Start returns when the start signal is observed, which can
      // PRECEDE... the queued-but-not-yet-active generation shows the
      // send control with no Stop. The precondition's bounded wait
      // WAITS for the Stop-visible interval to OPEN (or a decidable
      // alternative to appear — the post-response surface, a composer
      // holding text, or a decisive failure surface) within the same
      // bounded settle budget.
      const observed = await settle(tabId, [], (f) => {
        const c = classifySession(f, registered, "recovery", { authMarkersBaseline: (registered?.mode ?? "agent") === "chat" });
        if (
          ["authentication-required", "human-verification-required", "provider-error", "unexpected-dialog", "expected-blocking-dialog", "ambiguous"].includes(
            c.state
          )
        ) {
          return true; // a decisive failure or dialog surface ends the wait immediately
        }
        // The precondition's decidable outcomes: the generation ACTIVE
        // (Stop visible — both computed label states), the
        // post-response surface (the Regenerate control — the
        // generation already ended), or the composer holding text (the
        // prompt present — no active generation to recover).
        // CONTINUATION 22: a visible dialog is a decisive failure
        // surface here (the bounded popup recovery applies only to
        // submission).
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
      const precheck = classifySession(observed.facts, registered, "recovery", { authMarkersBaseline: (registered?.mode ?? "agent") === "chat" });
      if (precheck.state === "authentication-required") {
        return failure("AUTHENTICATION_INTERRUPTED", `authentication was required during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "human-verification-required") {
        // CONTINUATION 23 (the chat-tab baseline): the interactive
        // human-verification gate during recovery — the typed
        // operator gate (never Enter, never the known popup, never
        // a retry).
        return failure("HUMAN_VERIFICATION_REQUIRED", `the provider demanded interactive human verification during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "provider-error") {
        return failure("PROVIDER_ERROR", `the provider surfaced an error during recovery: ${precheck.detail}`);
      }
      if (precheck.state === "unexpected-dialog" || precheck.state === "expected-blocking-dialog") {
        // CONTINUATION 22 (the frozen Work Order's dialog law): the
        // bounded popup recovery applies ONLY to submission — a
        // dialog during recovery fails closed UNKNOWN_DIALOG (never
        // a blind keypress, never an Enter).
        return failure(
          "UNKNOWN_DIALOG",
          `a dialog or ambiguous surface is visible during recovery — the bounded popup recovery applies only to submission: ${precheck.detail}`
        );
      }
      if (precheck.state === "ambiguous") {
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
          `the hung precondition (generation in progress) is not established — the provider Stop control is not visible: ${controlDetail}, and the bounded wait did not observe the generation become active. A Start result carrying generation:"working" records the start signal itself, whose generation can complete between observations; invoke the recovery while the provider is actively generating (the Stop control visibly present — both computed label states are handled), not after the generation has ended`
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
      if (registered) {
        registered.wasWorking = false;
      }

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
      // 4. The continue-send: the Send control is clicked when the
      //    composer action slot renders it — there is NO Enter
      //    fallback at the send step (the frozen Work Order reserves
      //    Enter for the OBSERVED known popup during submission alone).
      //    When the slot renders the Stop control the generation is
      //    already (re) active — the watch's acceptance signal decides.
      //    A send click that fails leaves the fixed message verified
      //    present; the watch observes (pure observation) and the
      //    bounded budget fails closed. Never popup recognition, never
      //    dialog inspection, never a blind keypress.
      if (controlStateOf(readBack.facts) === "send") {
        const clicked = await send(tabId);
        if (!clicked.ok) {
          lastRefusal = clicked;
        }
      }

      // 5. THE ACCEPTANCE WATCH — the SAME start signal as Start (PURE
      //    OBSERVATION): the bounded watch for the new `continue` turn
      //    landing (the conversation state advancing past this
      //    readBack's baseline with the exact text) with the Stop
      //    control corroborating (the agent resumed working on the
      //    fixed message) and the composer decisively empty, combined
      //    with the chat state at the continue-dispatch (an existing
      //    chat — the recovery's session — is already at a chat route,
      //    so the conjunct is vacuous; a fresh surface requires the
      //    chat object), with the SAME bounded fail-closed window.
      //    A dropped row never advances the count and fails the
      //    recovery closed. CONTINUATION 22: the recovery's watch
      //    passes NO popupRecovery — every dialog in this flow fails
      //    closed UNKNOWN_DIALOG (the bounded popup recovery applies
      //    only to submission).
      //
      //    The watch's EXHAUSTION deliberately does NOT loop into a
      //    fresh recovery attempt: a retry would re-Stop a RESUMED
      //    generation and re-send `continue` — the duplicate the
      //    frozen no-duplicate law exists to prevent. The typed
      //    refusal routes the operator instead.
      const outcome = await watchAgentStart(
        tabId,
        ZAI_RECOVERY_MESSAGE,
        chatObjectCreatedOf(readBack.facts) === true,
        userTurnCountOf(readBack.facts) ?? 0,
        { authMarkersBaseline: (registered?.mode ?? "agent") === "chat" }
      );
      if (outcome.started) {
        const record = registered ?? {
          worker,
          workItem,
          tabId,
          prompt: null,
          attempts: 0,
          composeReestablishments: 0,
          submittedAt: now(),
          wasWorking: false,
          recoveries: 0,
        };
        record.wasWorking = true;
        record.recoveries = (record.recoveries ?? 0) + 1;
        sessions.set(worker, record);
        return {
          ok: true,
          recovered: {
            attempts,
            message: ZAI_RECOVERY_MESSAGE,
            acceptance: "agent-start",
            generation: "working",
          },
          session: { worker, workItem, tabId },
        };
      }
      if (outcome.reestablished) {
        // The input state was discarded around the continue-send; the
        // typed refusal routes. No re-Stop loop (a fresh attempt would
        // re-Stop whatever generation state the surface is now in).
        return outcome.refusal;
      }
      // The watch's exhaustion refusal (the unsubmitted `continue`
      // still in the composer; the landed-but-unobserved resume; the
      // post-response surface; the untrustworthy readings) — each
      // fail-closed and routed by its typed diagnosis. One specific
      // refinement for the recovery context: when the composer still
      // holds the fixed message, the guidance names the wrong re-Stop
      // hazard explicitly.
      if (
        !outcome.refusal.ok &&
        outcome.refusal.error?.code === "PAGE_MALFORMED" &&
        (outcome.refusal.error?.message?.includes("the exact text remains in the composer") ||
          outcome.refusal.error?.message?.includes("returned the exact text to the composer"))
      ) {
        return failure(
          "PAGE_MALFORMED",
          "the agent-start watch exhausted its bounded window without the start signal — the fixed recovery message 'continue' remains in the composer (the provider did not consume it). Do NOT re-invoke the recovery immediately: a fresh attempt would re-Stop whatever generation state the surface is in and resend the message. Observe the session (a start signal may follow late), or re-Start the worker session when the surface is ready"
        );
      }
      return outcome.refusal;
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
    // CONTINUATION 23: the session's mode carries the
    // authentication posture (a CHAT reference session treats the
    // auth markers as its accepted baseline; an AGENT session keeps
    // the authenticated contract).
    const authMarkersBaseline = session?.mode === "chat";
    const facts = await settle(tabId, [], (f) =>
      classifySession(f, session ?? null, "idle", { authMarkersBaseline }).state !== "ambiguous"
    );
    if (!facts.ok) {
      return { state: "ambiguous", detail: facts.error.message };
    }
    return classifySession(facts.facts, session ?? null, "idle", { authMarkersBaseline });
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
