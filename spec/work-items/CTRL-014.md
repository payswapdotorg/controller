# CTRL-014 — Z.ai Browser Worker Adapter

Status: `READY`

## Authorization

CTRL-014 is the sole currently executable Work Item. CTRL-013 — GitHub Browser-App Integration is complete and reconciled on `payswapdotorg/controller` main at the Architect-observed reconciliation merge. This Work Order explicitly activates only the Z.ai browser Worker adapter. CTRL-015 and later remain planned and inactive.

Automation stage: `STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP`.

Activation rule: implementation must start from the exact `main` SHA observed after the activation commit containing this Work Order and machine-state transition is merged.

## Objective

Implement the production browser Worker adapter for the MVP provider `https://chat.z.ai` using supported Chromium browser-extension mechanisms and live provider UI observations. Human authentication remains out of band. The adapter must carry an existing Controller-generated Work Item handoff into an already-authenticated Z.ai session, verify actual prompt submission, expose typed progress/terminal observations, and perform only the bounded recovery behaviors explicitly defined by repository authority.

The extension and provider tab remain execution surfaces. Repository machine state, Work Orders, lifecycle, review, merge policy and evidence remain authoritative in the Controller/repository.

## Scope

- provider-specific Z.ai browser adapter implementation inside the existing extension/provider boundary;
- authenticated-session discovery/open/focus for `chat.z.ai`;
- detection and typed reporting of authentication-required, target-session-missing, ready-for-input, working/waiting/stopped, prompt-submitted/unconfirmed, expected blocking-dialog, unexpected/ambiguous and provider-error observations;
- `Agent` tab selection and `GLM-5.3` / model `5.3` selection for new worker sessions;
- exact governed-prompt entry and post-send submission confirmation;
- bounded recovery from the known submission-blocking popup by pressing `Enter` and restarting the preparation sequence from Agent/model/prompt/send/verification;
- bounded hung-worker recovery using provider `Stop`, verified stopped state, fixed recovery message `continue`, and verified acceptance;
- preservation of Worker / Work Item / browser-session identity across retries and recovery;
- fail-closed handling for unknown dialogs, authentication interruption, ambiguous states, exhausted retry budget, stale or contradictory session references, and provider-side errors;
- provider-specific selector/locator logic contained entirely within the Z.ai adapter boundary;
- offline/injected tests for DOM/accessibility observation parsing, action sequencing, confirmation requirements, bounded retries, hang recovery, identity preservation, malformed/ambiguous observations and zero-progress fail-closed behavior;
- documentation of setup, human authentication precondition, supported browser expectations, provider observations, recovery behavior and known limitations.

## Required behavior

### New worker session

The adapter must perform this exact governed sequence:

1. find/open/focus an authenticated `chat.z.ai` session;
2. verify authenticated state;
3. select `Agent`;
4. select `GLM-5.3` / model `5.3`;
5. enter the exact Controller-generated governed prompt without rewriting it;
6. send the prompt;
7. verify that the prompt was actually accepted/submitted by observing the resulting provider state.

A send/click event alone is never sufficient evidence of submission.

### Known submission-popup recovery

When and only when the adapter observes the known submission-blocking popup, it may press `Enter` once for the current retry attempt. After dismissal it must restart from Agent selection, model selection, exact prompt entry, send and submission verification. Retries are bounded/configurable.

Unknown or differently-shaped dialogs must fail closed; the adapter must not blindly press keys or infer that a popup is harmless.

### Hung-worker recovery

When the configured no-progress/hung detector fires, the adapter must:

1. activate the provider `Stop` control;
2. verify generation has stopped;
3. submit the fixed message `continue`;
4. verify the recovery message was accepted.

No alternate recovery wording is permitted. Recovery attempts are bounded. Failure to confirm any required state transition produces a governance-hold/exception outcome.

### Identity and authority

The adapter must preserve the exact Worker, Work Item and browser-session correlation supplied by the Controller. Provider UI state may only produce observations/actions within the adapter boundary; it cannot mutate authoritative repository state or authorize lifecycle progression, review, approval or merge.

## Architecture constraints

- Use the existing browser-provider abstraction created by CTRL-012; do not create a second extension architecture.
- Do not move provider-specific DOM/selectors into Controller core code.
- Do not duplicate lifecycle, review, merge or evidence predicates.
- Do not add an authoritative database or make extension-local state authoritative.
- Do not collect or store provider passwords, raw credentials, authentication codes or browser cookies as product state.
- Do not bypass CAPTCHAs, anti-bot controls, rate limits, provider security mechanisms or other protective measures.
- Do not use undocumented private provider APIs merely to avoid supported browser interaction.
- Do not implement ChatGPT Architect automation; that belongs to CTRL-015.
- Do not compose the full runtime/lifecycle UI; that belongs to CTRL-016.
- Do not activate later Work Items.

## Acceptance criteria

1. A real Chromium browser extension session can discover/open an already-authenticated `chat.z.ai` tab and distinguish authenticated from authentication-required state.
2. A new worker session selects Agent and `GLM-5.3` / model `5.3`, enters the exact supplied governed prompt, sends it and confirms actual UI acceptance.
3. The known submission-blocking popup triggers only the bounded `Enter` recovery and a full re-establishment of Agent/model/prompt/send/verification.
4. Unknown dialogs, ambiguous UI, authentication interruption and exhausted retry budgets fail closed without pretending submission succeeded.
5. A deliberately hung worker can be recovered only through Stop → verified stopped → fixed `continue` → verified acceptance, with bounded attempts.
6. Provider-specific UI locators and interaction logic remain isolated to the Z.ai adapter; existing Controller lifecycle/merge/review predicates remain unchanged.
7. Worker/Work Item/session identity remains stable across normal operation and recovery; stale or contradictory identity fails closed.
8. Offline/injected tests cover successful paths and the required failure/recovery matrix, including confirmation-before-success and bounded retries.
9. Documentation is sufficient for a fresh session to understand the adapter boundary, human-authentication prerequisite, configuration, recovery behavior and limitations.

## Required evidence

- exact test commands/results for the adapter and full regression suite;
- live supported-environment evidence showing the actual Z.ai session interaction and submission confirmation;
- evidence for the known popup retry path and bounded-attempt behavior;
- evidence for deliberate hung-worker Stop + `continue` recovery;
- architecture/scope audit proving no Controller predicate duplication, credential persistence or provider-security bypass;
- PR body identifies CTRL-014, exact dispatch base, changed surface and evidence.

## Handoff

The worker must create exactly one governed implementation PR targeting `main`, starting from the exact activation-merge `main` SHA observed at dispatch. The worker may respond to review findings on that same PR but may not approve or merge it, alter repository roadmap/architecture authority, activate successor Work Items, or redefine the Z.ai contract.

Fresh-session source of truth:

1. `spec/state/controller-program-state.json`
2. `spec/roadmap/roadmap.md`
3. `spec/architecture/controller-architecture.md`
4. `spec/operations/controller-build-process.md`
5. this Work Order
6. `spec/operations/fresh-session-handoff.md`
7. `AGENTS.md`

No conversation transcript is required to implement CTRL-014.
