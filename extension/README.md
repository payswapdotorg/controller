# Pectoraux Controller — Browser Operator Surface (CTRL-012 + CTRL-013 + CTRL-014)

This directory is the Browser Control Surface Foundation (CTRL-012),
the GitHub browser-app integration (CTRL-013), and the Z.ai browser
Worker adapter (CTRL-014): a Chromium browser extension that acts as
the Controller's **operator/client surface**. It registers Workers
and Architects, connects GitHub through a supported OAuth
authorization (no pasted tokens), selects the controlled GitHub
repository, presents the repository-derived Controller authority
state and repository evidence, and executes the governed Z.ai Worker
session sequence against an already-authenticated human chat.z.ai
session.

The extension is **non-authoritative by construction**. Repository
authority always wins: roadmap, work orders, machine state, lifecycle,
review, and merge policy live in the controlled repository and the
Controller core (`controller/`), never in extension state. The
extension exposes only the repository mutations the accepted
Controller runtime already authorizes — as a typed transport surface
for the future runtime composition, with no popup control to invoke
them.

## What it does

- **Worker/Architect registration** (non-authoritative local
  configuration): name + provider kind + provider URL. The MVP Worker
  is Z.ai (`https://chat.z.ai`); the MVP Architect is ChatGPT
  (`https://chatgpt.com`). Registration validates strictly against the
  closed provider registry (exact https origin, role capability,
  closed field set — a `password`/`token`/`cookie` field is a
  malformed form, refused before persistence).
- **Provider tabs**: open a provider URL in a new tab for **human**
  authentication (the extension never requests or stores provider
  credentials), and discover whether provider tabs are already open
  (URL-origin matching only — no DOM access, no content scripts; the
  Z.ai/ChatGPT adapters arrive with CTRL-014/CTRL-015).
- **Z.ai Worker adapter (CTRL-014)**: the governed provider-page
  execution surface for the Worker role at `chat.z.ai`. The adapter
  discovers/opens/focuses an **already-authenticated** chat.z.ai
  session (human authentication is out of band), runs the exact
  new-session sequence — `Agent` selection, `GLM-5.3` / model `5.3`
  selection (the live model selector is located through its
  live-observed generic candidates — the `Select a model`
  aria-label, else the `model-selector-*` id family — never a
  hardcoded model-specific id; the exact option is resolved by both
  its exact `GLM-5.3` text token and its `data-value`), verbatim
  governed-prompt entry, send, and OBSERVED
  submission confirmation — performs only the bounded known-popup
  `Enter` recovery (pressed ONLY when the known submission-blocking
  popup is OBSERVED, exactly once per retry attempt, with the
  dismissal verified by post-action observation) and then RESTARTS
  the full preparation sequence and re-sends the exact prompt
  (the frozen Work Order: after dismissal, restart from Agent
  selection, model selection, exact prompt entry, send and
  submission verification; an already-confirmed
  submission is never resent), and recovers a
  hung worker only through `Stop` -> verified stopped -> the fixed
  message `continue` -> verified acceptance. Every step is verified by
  post-action observation; unknown dialogs, authentication
  interruption, ambiguous surfaces and exhausted budgets fail closed
  typed. All Z.ai locators live in `src/zaiAdapter.js` alone.
- **Repository selection**: canonical `owner/name` identity, strictly
  validated (ambiguous forms fail closed).
- **Controller state display**: reads the two repository authority
  surfaces — `spec/state/controller-program-state.json` and the active
  work order's `Status:` line — through supported GitHub REST/content
  endpoints (never page-clicking), **pinned to one observed commit
  SHA** so the two surfaces can never come from different commits. A
  missing, malformed, stale, or contradictory authority result is an
  explicit fail-closed UI state, never an inferred fallback.
- **GitHub connection (CTRL-013)**: `Connect GitHub` starts GitHub's
  OAuth **device flow** — the supported authorization path for browser
  extensions. The extension requests a device code, opens
  `github.com/login/device`, and the **human** authenticates at GitHub
  and enters the code. The access token lives only in the service
  worker's session memory: it is never stored, logged, or put in a
  message, and it is discarded on service-worker restart or on any
  401 (fail-closed `AUTHORIZATION_REQUIRED`; reconnect). Only the
  account **metadata** (login/name/avatar) persists, as closed-form
  non-authoritative configuration.
- **Repository discovery**: lists the repositories the connected
  account is permitted to access (canonical `owner/name`, default
  branch, visibility; deterministic order; explicit truncation marker
  beyond a bounded page walk). Selecting from the list is one click.
  With a live connection, repository selection is **gated on observed
  access** — an unauthorized repository is refused, never silently
  substituted.
- **Repository evidence (read-only)**: typed observations of the
  default branch + head SHA, pull requests (head/base/state/draft/
  merged/mergeable), reviews, comments, and combined commit status —
  the same evidence the Controller core consumes, normalized the same
  way, returned to the boundary without evaluating any governance
  predicate. Includes the governed branch/PR **correlation** as typed
  outcomes (`correlated` / `no-open-pr` / `ambiguous` / `base-drift` /
  `head-drift`) for the future runtime composition.
- **The three authorized mutations (transport only)**: the message
  boundary carries exactly the three mutations the accepted Python
  adapter exposes — `CreateBranch` (explicit base SHA, never a
  default), `OpenPullRequest` (one-PR rule + base identity gates), and
  `MergePullRequest` (the transport of an ALREADY-ISSUED runtime merge
  authorization — review iteration 2). The merge message's closed
  transport form carries the `MergeAuthorization` identity fields —
  PR, work item, base ref+SHA, exact head; the merge method is the
  frozen transport constant (`merge`), deliberately not a message
  field. The boundary validates ONLY this closed form and fails
  closed on malformed or fabricated input; it NEVER interprets a
  governance fact (review state, active-work-item eligibility,
  required checks, mergeability, draft state, lifecycle), and no
  reviewer identity is hard-coded anywhere in the extension. The
  message payload is never itself an authorization: the Controller
  runtime obtains and revalidates the accepted `MergeAuthorization`
  through its existing merge-policy boundary (`controller/github.py`,
  `_require_merge_policy`), and the runtime-authorization handoff that
  would carry one into this extension is NOT composed in CTRL-013
  (runtime composition is CTRL-016 scope). Rather than invent a
  second authorization mechanism, the route fails closed
  `RUNTIME_AUTHORIZATION_UNAVAILABLE` with ZERO network — a live
  session plus a fully-populated fabricated identity can never make
  the merge POST reachable from a message. The transport client
  (`githubClient.js`) is a pure transport for that future runtime
  composition: structural identity completeness (the Python
  `_as_merge_request` discipline — well-typedness, no trust), exactly
  one merge POST with the frozen method and the exact-head `sha` pin,
  zero reads — a moved head, a closed/merged PR, or a non-mergeable
  PR is GitHub's own refusal, surfaced as the typed
  `MUTATION_REFUSED`. No popup control invokes any mutation.

## Prerequisites

- A Chromium-based browser (Chrome/Chromium/Edge/Brave — any browser
  supporting Manifest V3).
- Node.js >= 18 **only if you want to run the tests** (the extension
  itself has no build step and no runtime dependency).

## Load the extension (unpacked)

No build step — load the sources directly:

1. Open `chrome://extensions` (or your browser's equivalent).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this `extension/` directory (the one containing
   `manifest.json`).
5. The **Pectoraux Controller** action icon appears in the toolbar —
   open the popup from it.

To reload after source changes, use the reload icon on the extension's
card in `chrome://extensions`.

## Connect to the Controller runtime

1. Open the popup and scroll to **Controlled repository**.
2. Enter the repository identity — for this repository:
   `pectoraux/controller` — and press **Select**. The canonical
   identity is displayed. (Typing the identity manually works for
   public repositories without a GitHub connection; see the next
   section for discovery-based selection.)
3. Press **Refresh state** under **Controller state**. The popup shows
   the repository-derived projection: repository, active work item,
   lifecycle status, automation stage, completed ledger, next action,
   and the exact `ref@sha` the projection was observed at.

The extension talks to GitHub exactly the way the Controller's
repository authority defines it: `GET /repos/{owner}/{name}` (default
branch), `GET /repos/{owner}/{name}/commits/{branch}` (HEAD SHA), then
the machine-state JSON and the work-order markdown fetched from
`raw.githubusercontent.com` **at that SHA**. When GitHub is connected,
these reads carry the session authorization (so private controlled
repositories are readable exactly when the connection permits them);
without a connection they are unauthenticated public reads.

To also connect the governed runtime itself (dispatch, cycles,
recording), run the Python CLI against a checkout — see the root
`README.md`, "Operating the Controller". The extension and the runtime
read the same repository authority; the extension never substitutes
for it.

## Connect GitHub (OAuth device flow — one-time operator setup)

The extension authorizes through GitHub's **OAuth device flow** — the
mechanism GitHub documents for public clients such as browser
extensions, which cannot keep a client secret. There is **no PAT input
field anywhere**, and no secret is ever embedded in the package.

### One-time: create the GitHub OAuth App

1. As the repository operator, open GitHub -> **Settings -> Developer
   settings -> OAuth Apps -> New OAuth App**.
2. Application name/homepage: anything identifying this deployment
   (e.g. "Pectoraux Controller operator surface"). Authorization
   callback URL is unused by the device flow — any HTTPS URL is
   accepted.
3. After creating the app, open its settings and **enable Device
   Flow** (a checkbox in the app's settings page). This is required —
   without it GitHub refuses the flow and the extension fail-closes
   with `AUTHORIZATION_NOT_CONFIGURED` telling you exactly that.
4. Copy the **Client ID** (a public identifier — it is NOT a secret
   and GitHub documents it as safe to embed in client applications).
5. Replace the `oauth2.client_id` PLACEHOLDER in
   `extension/manifest.json` — the shipped value is the recognizable
   sentinel `PASTE-YOUR-GITHUB-OAUTH-CLIENT-ID-HERE` (Chrome refuses
   to load a manifest with an empty value, hence the sentinel) — with
   your client id, and reload the extension. The scope list stays
   `["public_repo"]` (see Permissions below).

Until this step is done, `Connect GitHub` fails closed with
`AUTHORIZATION_NOT_CONFIGURED` (the sentinel is treated exactly like
an unconfigured deployment) — the extension never guesses. A client id
GitHub does not recognize is typed the same way (404 -> check the
manifest value).

### Connect as the operator

1. Press **Connect GitHub**. The extension requests a device code and
   opens `https://github.com/login/device` in a new tab.
2. **Authenticate at GitHub yourself** and enter the displayed user
   code (the extension never sees your password — authentication
   happens entirely in GitHub's UI).
3. Authorize the requested scope when GitHub asks. The connection
   completes in the background (the popup's **Refresh** shows it); the
   account login appears in the GitHub section.

The access token is **session-only**: it lives in the service
worker's memory, is attached to API requests transiently, and is
discarded on service-worker restart, on `Disconnect`, or on any GitHub
401 (fail-closed `AUTHORIZATION_REQUIRED` — press Connect again;
GitHub device-flow tokens expire after 8 hours by GitHub policy).
Only the account metadata (login/name/avatar) persists, in the
closed-form configuration record — a record carrying any other field
(e.g. a token) is treated as a corrupt store.

### Select the MVP repository

Press **Discover repositories** and pick `pectoraux/smallapp` (or any
accessible repository) from the list — the canonical `owner/name`
identity is guaranteed by discovery. Manual entry stays available;
with a live connection, selection verifies observed accessibility and
refuses unauthorized repositories (`REPOSITORY_INACCESSIBLE` — never
a silent substitution).

## Permissions

- `storage` — the non-authoritative configuration (registrations,
  selected repository, GitHub connection metadata).
- `tabs` — opening provider tabs for human authentication, and the
  device-flow verification tab.
- Host `https://api.github.com/*` — GitHub REST API reads and the
  three authorized mutations.
- Host `https://raw.githubusercontent.com/*` — repository authority
  content at a pinned SHA.
- Host `https://github.com/*` — **only** the two OAuth device-flow
  endpoints (`/login/device/code`, `/login/oauth/access_token`). No
  content scripts, no scripting API, no GitHub page automation.
- Host `https://chat.z.ai/*` — **only** the CTRL-014 Z.ai Worker
  adapter's page surface: exactly one declared content script
  (`page/zaiPage.js`, `document_idle`) exposing the closed DOM
  primitive vocabulary (probe/click/clickIndex/type/pressEnter) to
  the adapter's typed bridge. No `scripting` API, no dynamic
  injection, no cookies, no webRequest. ChatGPT has NO host
  permission and NO content script until CTRL-015 is explicitly
  activated.
- OAuth scope `public_repo` — read/write access to public
  repositories: the minimum single scope that covers discovery,
  evidence reads, and the three authorized mutations on public
  repositories. It grants **no** private-repository access (a private
  repository fails closed as `REPOSITORY_INACCESSIBLE`). If a future
deployment must operate private repositories, change
  `oauth2.scopes` to `["repo"]` — a documented operator decision; the
  extension never broadens access on its own.

## Register the MVP providers

- **Worker**: Name `Z.ai`, Provider `Z.ai`, URL `https://chat.z.ai`.
- **Architect**: Name `ChatGPT`, Provider `ChatGPT`, URL
  `https://chatgpt.com`.

Press **Open** to open the provider site for human authentication
(authenticate in the provider's own UI; the extension neither needs
nor accepts your credentials). Press **Tabs** to see whether provider
tabs are already open (display-only observation).

## The Z.ai browser Worker adapter (CTRL-014)

The adapter is the Worker-role execution surface at
`https://chat.z.ai`. It is exercised through the typed message
boundary (`ObserveZaiSession`, `StartZaiWorkerSession`,
`RecoverZaiHungWorker`); no popup control drives it (runtime
composition is CTRL-016 scope).

### Prerequisites (human steps, out of band)

1. Chromium with this extension loaded unpacked.
2. Register a Worker with provider `Z.ai` (`zai` /
   `https://chat.z.ai`) through the popup.
3. Open `https://chat.z.ai` in a normal browser tab and **sign in as
   the human operator**. The extension never sees, stores, or enters
   credentials; authentication is entirely yours. One authenticated
   tab is the supported configuration (zero tabs: the adapter opens
   one and fail-closes `AUTHORIZATION_REQUIRED` until you
   authenticate; two or more tabs without an active session: the
   adapter fail-closes `AMBIGUOUS_STATE` — close or focus exactly one).
4. Validate the locators for your session with
   `ObserveZaiSession`: an authenticated session must report
   `ready-for-input` (or `working` while generating). Any
   `ambiguous` / `unexpected-dialog` result means the provider surface
   differs from the adapter's declared locators — stop there and fix
   the adapter before dispatching work (that is the documented
   first-authenticated-use verification).

### The governed sequence (exactly this order)

`StartZaiWorkerSession { worker, workItem, prompt }`:

1. find/open/focus the authenticated `chat.z.ai` tab;
2. verify the authenticated state (fail-closed otherwise);
3. select the `Agent` control — the sidebar mode-toggle Agent pill
   (LIVE-OBSERVED structure; resolved structurally, clicked once,
   and verified ONLY by the pill becoming the active mode pill —
   `data-active="true"`; an already-active pill issues no click);
4. select model `GLM-5.3` (provider model identifier `5.3`,
   surface-encoded by the provider as the option-row `data-value`
   `glm-5.3`): the live model selector trigger is located through
   its live-observed generic candidates (the `aria-label="Select a
   model"` trigger, else the `model-selector-*` id family — the
   trigger id embeds the SELECTED model and changes with the
   selection, so it is never hardcoded), the exact `GLM-5.3`
   option is resolved by BOTH its exact leading text token and its
   `data-value`, and the selection is verified ONLY by the trigger
   displaying the `GLM-5.3` label AND carrying the selected-model
   id (`#model-selector-glm-5_3-button`) — a click is never
   evidence, and an already-`GLM-5.3` surface issues no trigger
   click;
5. enter the exact governed prompt **verbatim** (byte-identical
   read-back before any send — a rewritten prompt is never
   submitted);
5b. **pre-send gate** (continuation 6): a FRESH decisive composer
   read immediately before the send — the exact prompt must STILL be
   present, verbatim. An unreadable, empty, or rewritten composer is
   NEVER sent: the provider can discard the input state between the
   read-back and the send, and a send click on an empty composer
   (the operator-observed failure) is refused before it happens;
6. send;
7. verify ACTUAL submission from the resulting provider state —
   MESSAGE-EXCLUSIVE evidence only: an exact user-message row or
   containment in the `[role="log"]` message region, with a
   DECISIVELY empty composer (an absent or ambiguous composer read
   is never "cleared"). Broad region matches (`main`,
   class-scan surfaces) are NEVER acceptance evidence — a
   sidebar/history surface whose text contains the prompt proved
   nothing in the live false positive this continuation corrects. A
   send click alone is never evidence of success.

### Bounded recovery

- **The discarded input state** (the continuation-6 second observed
  failure mode): after a send attempt the composer can read
  decisively empty while the submission is NOT confirmed by message
  evidence (the operator's captured post-run DOM: an empty
  `#chat-input` and a disabled `#send-message-button` — the prompt
  never entered). The adapter then re-establishes the input state
  through the provider's Agent/compose UI control — the
  operator-described circular control, structurally resolved as the
  unique `data-active` button of the composer form containing
  `#chat-input` (LIVE-OBSERVED: that form renders exactly three
  buttons — upload, the compose toggle, and send). The control must
  resolve to exactly one element (never a blind click); the click is
  verified only by the composer becoming a visible enabled input.
  The next bounded attempt re-types the exact prompt
  byte-for-byte, re-reads it byte-for-byte, and only then resends —
  a second bounded submission-recovery path alongside the popup
  path, never a blind resend, and never a duplicate of an
  already-confirmed submission (when the message evidence already
  holds the exact prompt with a decisively-empty composer, nothing
  is re-typed or resent).
- **Known submission-blocking popup** (a modal dialog observed while
  verifying a submission, matching the known shape and carrying no
  auth/error text): the adapter presses `Enter` once for the current
  attempt, verifies dismissal, and then RESTARTS THE FULL
  PREPARATION SEQUENCE — the frozen Work Order's explicit recovery:
  "After dismissal it must restart from Agent selection, model
  selection, exact prompt entry, send and submission verification."
  The idempotent re-selection re-establishes every governed ground
  truth the popup interaction may have disturbed; when the composer
  still holds the exact prompt (the popup blocked the submission) it
  is sent as-is, and when the popup consumed it the prompt is
  re-typed with the byte-identical read-back re-verified before the
  resend. When the
  dismissed popup reveals the submission already landed (the
  conversation holds the exact prompt, the composer is cleared)
  NO resend happens — the governed prompt is never submitted twice.
  The REAL known popup (the provider's "Currently in peak hours"
  capacity modal, LIVE-OBSERVED in the operator's captured run)
  materializes only when the ASYNCHRONOUS chat-completion error
  arrives — after the optimistic landing — so the acceptance is
  additionally held through a bounded async-outcome window (a popup
  or the provider's prompt-restore observed in the window re-opens
  the bounded recovery; a quiet window records the acceptance).
  Default budget: 3 attempts. Auth-shaped or error-shaped dialogs,
  dialogs at any other time (including hung-worker recovery),
  multiple simultaneous dialogs, or an
  exhausted budget fail closed (`AUTHENTICATION_INTERRUPTED` /
  `PROVIDER_ERROR` / `UNKNOWN_DIALOG` / `RETRY_EXHAUSTED`) — the
  adapter never blindly presses keys (no key is ever issued on a
  timer) and never pretends submission
  succeeded. The absence of a popup is NEVER acceptance evidence:
  acceptance is always the verified provider-state confirmation
  (the conversation state advancing past the dispatch baseline with
  the exact prompt landed as a user-message row, the Send->Stop
  action-control transition corroborating, the composer decisively
  cleared — and, on a fresh session, the chat object created).
- **Hung worker** (`RecoverZaiHungWorker { worker, workItem, tabId }`):
  verify generation is in progress, activate the provider `Stop`
  control, VERIFY generation stopped, submit the FIXED message
  `continue` (no alternate wording exists), and verify acceptance:
  the acceptance signal is the conversation state advancing past the
  continue-dispatch baseline with the exact fixed `continue` landed
  as a user-message row AND the provider's working state
  corroborating (the Stop control returning with the composer
  decisively cleared — the agent resumed working on the fixed
  message). A generation that visibly resumes while the `continue`
  row never lands fails closed (a foreign generation is not our
  recovery); a recovery whose message lands without the resumed
  working state is held to the bounded observation window and fails
  closed at its exhaustion. No key is ever pressed in this flow (a
  dialog visible during recovery fails closed
  `UNKNOWN_DIALOG` — the bounded popup recovery applies only to
  submission). Default budget: 2
  attempts. Any unverified transition is a typed governance hold.

### Typed observations

`ObserveZaiSession { worker }` reports the frozen twelve-state
vocabulary: `authentication-required`, `session-missing`,
`ready-for-input`, `working`, `waiting`, `stopped`,
`prompt-submitted`, `prompt-unconfirmed`,
`expected-blocking-dialog`, `unexpected-dialog`, `ambiguous`,
`provider-error` — each with the observed tab id.

### Provider observations (locator provenance)

LIVE-OBSERVED on the real provider surface (2026-09-05, unauthenticated
landing state — verified live by the worker probe):

| Surface | Locator | Observed |
|---|---|---|
| Composer | `#chat-input` (textarea, placeholder "How can I help you today?" unauthenticated / "Send a Message" on the authenticated Agent surface) | visible on the landing page; the id is the stable locator (the placeholder varies by surface/mode) |
| Send control | `#send-message-button` (`type="submit"`, `aria-label="Send Message"` on the authenticated surface) | disabled until the composer has text; activated only after the verified prompt read-back |
| Model selector trigger | `button[aria-label="Select a model"]`, else `button[id^="model-selector-"][id$="-button"]` | LIVE-OBSERVED 2026-09-06 (closed state AND opened menu): exactly one trigger; its id embeds the SELECTED model's `data-value` with `.`->`_` (live unauthenticated: `#model-selector-x-preview-l-button`, text `GLM-5.3-Flash`; operator's authenticated Agent surface: `#model-selector-glm-5_2-button`, GLM-5.2 displayed) — the id is NOT a stable locator and is never hardcoded |
| Model options | `button[aria-label="model-item"]` carrying `data-value` | LIVE-OBSERVED 2026-09-06 (menu open): rows `x-preview-l` / `glm-5.3` / `glm-5.2`; the exact GLM-5.3 row = `button[aria-label="model-item"][data-value="glm-5.3"]` (leading text token exactly `GLM-5.3`); GLM-5.3 and GLM-5.2 are disabled unauthenticated, enabled authenticated |
| Selected-model trigger id | `#model-selector-glm-5_3-button` | the trigger id the live surface carries once GLM-5.3 is selected (the id-family ground truth for post-selection verification, with the trigger displaying the `GLM-5.3` label) |
| Auth markers | buttons with exact text `Sign in` / `Log in` / `Sign up` | present unauthenticated |
| Modal dialogs | `[role="dialog"], dialog` | the modal overlay containers |
| Sidebar shell | `#sidebar` | the app sidebar root (both sidebar states) |
| Mode toggle (both sidebar states) | `#sidebar button[data-active]:not([id]):nth-of-type(2):last-of-type` | EXACTLY ONE match — the Agent pill, second of the two-button pill pair (LIVE-OBSERVED 2026-09-06: resolves to exactly one element on the real surface) |
| Mode-pill active marker | `#sidebar button[data-active="true"]:not([id]):nth-of-type(2):last-of-type` | zero matches while Chat is active; flips to exactly one when Agent mode activates |
| Mode-pill pair | two `<button>` pills, Chat first, Agent second | both ALWAYS carry `data-active` (`"true"`/`"false"`); expanded sidebar renders the labels `Chat`/`Agent` (the provider's own i18n renders `Agent_Mode` as `Agent`); the collapsed sidebar renders icon-only pills (empty text); the pills have no id, no aria-label, no role; clicking the Agent pill switches the app into Agent mode |

AUTHENTICATED-SURFACE-DECLARED (verified by the
first-authenticated-use step above; fail closed when absent or
ambiguous — a wrong declared locator can only produce a typed
refusal, never an incorrect action):

| Surface | Candidate locators |
|---|---|
| Stop control | `button[aria-label="Stop"]`, `button[title="Stop"]`, exact text `Stop` |
| Conversation log | `[role="log"]`, `[class*="conversation"]`, `[class*="message-list"]`, `main` |
| User messages | `[class*="user"][class*="message"]`, `[data-role="user"]`, `[class*="user-message"]` |

Agent-selection semantics (LIVE-OBSERVED 2026-09-06, after the
2026-09-05 operator live run exposed the pre-correction declared
locators as non-matching on the real authenticated surface): the
adapter resolves the sidebar mode-toggle Agent pill structurally
(the second-and-last button of the two-button `data-active` pill
pair inside `#sidebar` — works for both the expanded labeled
sidebar and the collapsed icon-only sidebar), falls back to the
unique sidebar mode pill whose exact text is `Agent` (the expanded
labeled state), and verifies the selection ONLY by the pill
becoming the active mode pill (`data-active="true"`) — a click is
never evidence of the mode switch, and an Agent pill that is
already active issues no click (clicking it would open a fresh
provider Agent-mode session for nothing).

### Known limitations

- The session registry is in-memory (service-worker lifetime). A
  service-worker restart loses it; later `RecoverZaiHungWorker`
  references fail closed `SESSION_UNKNOWN` (restart the session with
  `StartZaiWorkerSession`; the browser tab's conversation is
  unaffected — it is the human/provider's state, never ours). A
  registry entry whose correlated tab has closed, or whose tab
  navigated away from the provider origin, is a STALE reference:
  a same-correlation `StartZaiWorkerSession` fails closed
  `STALE_REFERENCE` (never `ok:true alreadyActive`) — the dead
  session is never re-reported as active and never silently
  re-established; the full governed sequence re-runs only after the
  in-memory registry is lost on service-worker restart.
- The authenticated-surface locators (Stop, conversation, user
  messages) were declared, not live-observed (human authentication
  is out of band for the worker). They are verified by the
  documented `ObserveZaiSession` check at first authenticated use,
  and every one of them fails closed rather than guessing. (The
  sidebar mode toggle — the Agent selection path — IS live-observed
  as of 2026-09-06, from the real origin in both sidebar states plus
  the provider's own front-end code; see the provenance table.)
- The adapter submits into the CURRENT conversation of the focused
  chat.z.ai tab; it does not create new chats (not part of the
  governed sequence).
- Settle budgets (polls per step, attempt counts, recovery counts)
  are constructor-injectable constants; the defaults are frozen in
  `src/zaiAdapter.js` (`DEFAULTS`).

### The operator live-test harness (CTRL-014 live evidence)

A **developer/operator TEST page only** — `harness/harness.html` —
exists to invoke the EXISTING CTRL-014 message boundary against the
real installed extension and record reproducible live evidence for
the Architect review (the live-evidence invocation work order, PR #6
comment 5553979616). It is deliberately outside the production
surface: the manifest does not declare it, the popup does not link
it, and it adds no runtime orchestration (that is CTRL-016 scope).

**Open it (operator, after the prerequisites above):**

1. Load the extension unpacked and register the `Z.ai` Worker (popup).
2. Authenticate `https://chat.z.ai` in a normal tab (human, out of band).
3. Find the extension id (`chrome://extensions` → Pectoraux Controller
   → ID) and open
   `chrome-extension://<extension-id>/harness/harness.html`.
4. Check the operator acknowledgment — invocations stay disabled
   until you do. You are declaring a deliberate live test with the
   exact Controller-generated governed prompt.

**Use it:**

- **ObserveZaiSession** — one button; the typed observation for the
  selected Worker is recorded as evidence.
- **StartZaiWorkerSession** — paste the Work Item identity and the
  EXACT Controller-generated governed prompt into the prompt field.
  The harness carries the prompt **verbatim** (a live character count
  is the readback; it never authors, rewrites, normalizes, or
  substitutes text). The result — submission confirmation with
  attempts/popup-dismissals/generation, an idempotent
  already-active report, or a typed refusal — is recorded verbatim.
- **RecoverZaiHungWorker** — the `tabId` is prefilled from the exact
  session correlation the last SUCCESSFUL start result reported (a
  refusal or malformed result never prefills anything; type the exact
  correlation yourself then). No new recovery semantics exist here —
  the page sends exactly the existing frozen request.
- **Evidence log** — one deterministic JSON line per invocation
  (fixed key order: `seq`, `timestamp`, `requestKind`, `request`
  verbatim including the prompt, `response` verbatim, `correlation`).
  The log lives in the page's memory only — never persisted, never
  sent anywhere; no credential or provider token can appear on this
  surface by construction. **Copy evidence (JSONL)** puts the whole
  log on your clipboard for the Architect review.

**Discipline (audited):** the harness page's only extension API is
`chrome.runtime.sendMessage` with the frozen message forms (the three
CTRL-014 kinds plus `GetConfiguration` for the Worker list); it
carries no provider locator, no provider origin, and no provider
interpretation (all provider knowledge stays in `src/zaiAdapter.js`);
it performs no network, storage, or tab access of its own. The pure
request/evidence plumbing is `src/harnessCore.js` (node-tested in
`tests/harness.test.js`; every request it builds validates at the
real message boundary).

## The typed message boundary

Every extension surface speaks through one closed vocabulary
(`src/messages.js`); responses are `{ ok: true, ... }` or
`{ ok: false, error: { code, message } }` with a code from the frozen
set (`src/errors.js`). Malformed/unknown requests are refused and
mutate nothing.

| Request | Fields | Response payload |
|---|---|---|
| `GetConfiguration` | — | `configuration` (workers, architects, repository, githubConnection) |
| `RegisterWorker` | `name`, `providerKind`, `providerUrl` | `configuration` |
| `RegisterArchitect` | `name`, `providerKind`, `providerUrl` | `configuration` |
| `SelectRepository` | `repository` | `configuration` |
| `GetAuthorityState` | — | `state` (active work item, lifecycle, stage, completed, next action, provenance) |
| `OpenProviderTab` | `role`, `name` | `opened` (tabId, url) |
| `DiscoverProviderTabs` | `role`, `name` | `tabs` (id, url, title) |
| `ConnectGitHub` | — | `pending`, `userCode`, `verificationUri`, `expiresIn` |
| `DisconnectGitHub` | — | `configuration` |
| `GetGitHubConnection` | — | `connection`, `authorized`, `pending` |
| `DiscoverRepositories` | — | `repositories`, `truncated` |
| `VerifyRepositoryAccess` | `repository` | `accessible`, `repository`/`error` |
| `ObserveRepository` | `repository` | `repository` (default branch, visibility, pushedAt) |
| `ObservePullRequests` | `repository`, `state`, `headBranch` (nullable) | `pullRequests` |
| `ObservePullRequest` | `repository`, `prNumber` | `pullRequest` |
| `ObserveReviews` | `repository`, `prNumber` | `reviews` |
| `ObserveComments` | `repository`, `prNumber` | `comments` |
| `ObserveCommitStatus` | `repository`, `sha` | `status` |
| `CorrelateWorkPullRequest` | `repository`, `branch`, `baseSha`, `headSha` (nullable) | typed outcome + evidence |
| `CreateBranch` | `repository`, `branch`, `fromSha` | `ref` (requires live session) |
| `OpenPullRequest` | `repository`, `branch`, `baseBranch`, `baseSha`, `title`, `body` | `pullRequest` (requires live session) |
| `MergePullRequest` | `repository`, `prNumber`, `workItem`, `baseRef`, `baseSha`, `headSha` | typed `RUNTIME_AUTHORIZATION_UNAVAILABLE` refusal (requires live session; the runtime-authorization handoff is not composed — CTRL-016 scope — so the merge POST is unreachable from the message surface with zero network) |
| `ObserveZaiSession` | `worker` | `observation` (typed session state, tabId) |
| `StartZaiWorkerSession` | `worker`, `workItem`, `prompt` | `session` (worker/workItem/tabId correlation) + `submitted` (attempts, popupDismissals, generation) |
| `RecoverZaiHungWorker` | `worker`, `workItem`, `tabId` | `recovered` (attempts, the fixed message, generation) + `session` |

The three mutation kinds are the complete mutation vocabulary — no
approve/comment/close/complete/advance kind exists. They are transport
for the runtime composition; the popup never invokes them.

Error codes: `UNKNOWN_MESSAGE`, `MALFORMED_MESSAGE`,
`INVALID_REGISTRATION`, `INVALID_REPOSITORY`, `REGISTRATION_NOT_FOUND`,
`REPOSITORY_NOT_SELECTED`, `CONFIGURATION_CORRUPT`,
`AUTHORITY_UNAVAILABLE`, `AUTHORITY_MISSING`, `AUTHORITY_MALFORMED`,
`AUTHORITY_CONTRADICTORY`, `TABS_UNAVAILABLE`,
`AUTHORIZATION_REQUIRED`, `AUTHORIZATION_FAILED`,
`AUTHORIZATION_NOT_CONFIGURED`, `REPOSITORY_INACCESSIBLE`,
`RATE_LIMITED`, `STALE_REFERENCE`, `MUTATION_REFUSED`,
`RUNTIME_AUTHORIZATION_UNAVAILABLE`,
`GITHUB_UNAVAILABLE`, `GITHUB_MALFORMED`, `GITHUB_NOT_FOUND`,
`PAGE_UNAVAILABLE`, `PAGE_MALFORMED`, `AUTHENTICATION_INTERRUPTED`,
`UNKNOWN_DIALOG`, `AMBIGUOUS_STATE`, `RETRY_EXHAUSTED`,
`SESSION_UNKNOWN`, `PROVIDER_ERROR`,
`INTERNAL_ERROR`.

## Source layout

```
extension/
  manifest.json          MV3 manifest: storage + tabs permissions, three
                         GitHub host permissions + the chat.z.ai
                         provider host, ONE content script
                         (page/zaiPage.js), oauth2 deployment
                         section (public client id + minimal scope)
  package.json           ES-module declaration for the Node test runner
                         (no build step, no dependencies)
  src/
    errors.js            the frozen error-code set
    forms.js             strict closed-object validation primitives
    providers.js         the closed provider registry (zai, chatgpt)
    registration.js      Worker/Architect registration validation
    repository.js        canonical owner/name identity validation
    messages.js          the typed request vocabulary + validation
    controllerClient.js  GET-only GitHub content client (injectable fetch)
    authority.js         machine-state/work-order parsing + projection
    configuration.js     the non-authoritative configuration model + store
    tabDiscovery.js      provider tab discovery/open primitives
    githubIdentity.js    the OAuth device-flow identity (session-only token)
    githubClient.js      the typed GitHub app API client (observations,
                         correlation outcomes, three gated mutations;
                         the merge transport is pure — one POST, zero
                         reads, frozen method, exact-head sha pin)
    service.js           the background service worker message router
    zaiAdapter.js        the Z.ai browser Worker adapter — the ONLY
                         place Z.ai provider knowledge lives (locators,
                         the governed new-session sequence, bounded
                         popup + hung-worker recovery, the in-memory
                         session registry)
    zaiPageBridge.js     the typed service-worker-to-tab channel
    harnessCore.js       the operator live-test harness PURE plumbing
                         (frozen request forms, exact-correlation
                         extraction, deterministic evidence records;
                         provider-agnostic, DOM-free, chrome-free)
  page/
    zaiPage.js           the single content script (matched only to
                         https://chat.z.ai/*): the closed-vocabulary
                         DOM primitive executor
  popup/
    popup.html/js/css    the operator UI (message-boundary only)
  harness/
    harness.html/js/css  the OPERATOR LIVE-TEST page (developer/test
                         surface only — not manifest-declared, not
                         popup-linked; invokes the frozen CTRL-014
                         message kinds and records the evidence log)
  tests/                 node --test suite (offline, deterministic)
```

All validation logic lives in pure modules with injected dependencies
(fetch, storage, tabs), which is what the Node test suite exercises;
`service.js` wires them to the real `chrome.*` surfaces exactly once.

## Run the tests

From the repository root:

```sh
node --test 'extension/tests/**/*.test.js'
```

Everything is offline and deterministic: GitHub responses, storage, and
tabs are injected fakes; no network, no credentials, no Chrome APIs.

## Recovery: a corrupt configuration store

If the popup reports `CONFIGURATION_CORRUPT`, the stored configuration
failed re-validation and every request is refused until the store is
explicitly cleared. The extension never silently resets it (that would
be an inferred fallback). To recover manually:

1. Go to `chrome://extensions`, find **Pectoraux Controller**, click
   **Inspect views: service worker**.
2. In the DevTools console, run
   `chrome.storage.local.clear()` then reload the extension.
3. Re-enter your registrations and repository selection.

## Safety boundaries (what this extension must never do)

- No provider passwords, raw session cookies, API tokens, or
  credentials — ever collected, stored, or sent (structurally: the
  closed forms have no such field, unknown fields are refused; the
  GitHub token is session-only memory, never storage, never a
  message, never a log line).
- No PAT entry field; no client secret in the package (the device
  flow needs none); the OAuth client id is a public identifier.
- No bypassing provider authentication, CAPTCHAs, anti-bot controls,
  or rate limits; no undocumented private provider APIs (rate limits
  fail closed as `RATE_LIMITED`).
- No provider page automation OUTSIDE the authorized adapters: the
  Z.ai Worker adapter (CTRL-014) is the only DOM-driving surface, its
  locators live in `src/zaiAdapter.js` alone, its page channel is the
  single closed-vocabulary content script (`page/zaiPage.js`, matched
  only to `https://chat.z.ai/*`), and ChatGPT remains un-automated
  until CTRL-015 is explicitly activated.
- No credential automation of provider sessions: human
  authentication is out of band; the adapter detects
  authentication-required surfaces and fails closed
  (`AUTHORIZATION_REQUIRED` / `AUTHENTICATION_INTERRUPTED`), never
  filling login forms, never storing cookies, never bypassing
  provider security controls.
- No GitHub page-click automation where supported APIs exist; the
  github.com host permission covers exactly the two OAuth endpoints.
- No second merge policy: `MergePullRequest` is the transport of an
  ALREADY-ISSUED runtime authorization, never an authorization
  substitute and never a policy evaluator — the boundary validates
  only the closed transport form, the extension interprets no
  governance fact (review state, active-work-item eligibility,
  required checks, mergeability, draft state, lifecycle) and
  hard-codes no reviewer identity, and the runtime-authorization
  handoff is deliberately NOT composed in CTRL-013 (CTRL-016 scope):
  the route fails closed `RUNTIME_AUTHORIZATION_UNAVAILABLE` with
  zero network, so a live session plus a fully-populated fabricated
  identity can never make the merge POST reachable from a message.
  The transport client performs only transport-level checks
  (structural identity completeness, the exact-head `sha` pin, the
  frozen merge method) — a moved head or an unmergeable PR is
  GitHub's own refusal, surfaced typed, never re-decided locally.
  No mutation can run merely because a UI control exists — no popup
  mutation control exists.
- No merge, approval, completion, roadmap advancement, or lifecycle
  transitions initiated by the extension; no authoritative extension
  state; the extension never
  becomes a second source of truth.
