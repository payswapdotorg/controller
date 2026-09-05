# Controller Architecture — Frozen v0.2

## Purpose

The Controller automates governed software-delivery execution. It is an orchestration/control-plane product, not a replacement for the controlled product's architecture and not a workflow-authoring engine.

## Authority hierarchy

1. Controlled repository roadmap and work orders — product intent and scope.
2. Controlled repository machine state — eligibility and lifecycle state.
3. GitHub — PR, CI, review and merge execution evidence.
4. Controller runtime state — disposable projection/cache only; it must be reconstructible.

No controller database may become authoritative over the controlled repository.

## Components

- **Roadmap/eligibility reader:** parses roadmap, work orders, dependencies and machine state.
- **Orchestrator:** deterministic state machine for one active work item at a time unless the roadmap explicitly permits safe parallelism.
- **Worker adapters:** start/resume implementation workers through an explicitly selected provider interface.
- **Architect adapters:** carry review packets to an explicitly selected Architect interface and normalize the resulting decision.
- **GitHub adapter:** branches, repository files, PRs, CI status, reviews, comments and merge operations.
- **Reconciliation engine:** after merge, verifies the merged SHA, updates repository machine state through an explicit governed commit, and recomputes eligibility.
- **Policy/safety gate:** fail-closed checks for roadmap drift, base SHA drift, forbidden surfaces, repeated failures, conflicting state, and unsafe automation.
- **Browser control surface:** an optional operator/client surface that controls supported third-party provider web UIs through explicit browser-provider adapters. It is not authoritative and must not bypass provider authentication, anti-bot controls, rate limits, CAPTCHAs, or other protective measures.

## State machine

`READY → DISPATCHED → IMPLEMENTING → PR_OPEN → CI_PENDING → REVIEW_PENDING → CHANGES_REQUESTED → IMPLEMENTING → REVIEW_PENDING → APPROVED → MERGING → MERGED → RECONCILING → COMPLETE → NEXT_READY`

Terminal exception states: `BLOCKED`, `ESCALATED`, `CANCELLED`.

## Authority and execution surfaces

The controlled repository remains the durable authority. The browser extension, browser tabs, provider sessions and controller runtime are execution/projection surfaces only. No provider UI state can override repository machine state, Work Order scope, roadmap sequencing, or merge predicates.

The MVP uses GitHub as the sole product-repository execution surface: repository files, branches, PRs, CI, reviews and merges are performed through GitHub APIs where available. No local repository checkout or local filesystem is required for the MVP.

## Browser-provider boundary

A browser provider is an execution adapter for a specific provider web UI. Provider-specific DOM/accessibility locators, tab discovery, interaction order, submission confirmation and recovery behavior belong inside the provider adapter, not in the Controller core.

Provider adapters must expose typed observations and actions sufficient for the Controller to distinguish at least:

- authenticated / authentication required;
- target session discovered / session missing;
- ready for input;
- working / waiting / stopped;
- prompt submitted / submission unconfirmed;
- expected blocking dialog present;
- unexpected or ambiguous UI state;
- provider-side error.

Unknown or contradictory provider state fails closed. A browser click is never treated as evidence of success without a post-action observation that establishes the expected resulting state.

### Z.ai browser worker — MVP contract

The Z.ai browser worker operates `chat.z.ai` in an already-authenticated browser session. Authentication itself is performed by the human in the provider UI; the Controller does not collect provider passwords or authentication secrets.

For a fresh work session, the adapter must:

1. discover or open `chat.z.ai`;
2. verify the authenticated state;
3. select the `Agent` tab;
4. select model `GLM-5.3` / provider model identifier `5.3`;
5. place the Controller-generated governed prompt into the message composer;
6. send the prompt;
7. verify that the prompt was actually accepted by the UI before reporting successful submission.

A failed first submission is recoverable only through the bounded retry procedure: re-establish `Agent`, re-establish `GLM-5.3`, re-enter the exact same governed prompt, send again, then verify. If the provider presents the known submission-blocking popup, the adapter may press `Enter` to dismiss it and retry from the beginning of this preparation sequence. An unknown popup, authentication interruption, or ambiguous UI state fails closed rather than blindly pressing keys.

For an existing worker session, a hung worker is recovered only by: detect the configured hang condition; activate the provider's `Stop` control; verify that generation stopped; submit the fixed recovery message `continue`; verify that the recovery message was accepted. The adapter must not invent alternative recovery prose. Recovery is bounded; exhausting the configured attempts without a confirmed state transition fails closed.

### ChatGPT browser Architect — MVP contract

The ChatGPT Architect adapter operates `chatgpt.com` in an already-authenticated browser session. Human authentication is out of band. The adapter receives a Controller-generated review packet and must deliver it to the selected Architect conversation, then observe and normalize an Architect decision. The adapter may return only a typed `APPROVE`, `REQUEST_CHANGES`, or explicit exception/unknown outcome. It must not manufacture an approval from absence of a response.

The exact ChatGPT UI interaction sequence and reliable decision-observation mechanism are a provider-adapter implementation concern and must be established from the live supported UI during CTRL-015; no guessed selectors or undocumented internal endpoints are authority.

## Browser-extension responsibilities

The browser extension is an operator/client surface. It may:

- register Workers and Architects by name and supported provider URL;
- open provider tabs for human authentication;
- show connection and provider observations;
- connect GitHub and select a controlled repository;
- query authoritative repository state;
- display the active Work Item and lifecycle position;
- request an authorized Controller action such as `Start Work`;
- show provider/CI/review/reconciliation activity.

It must not:

- become a second source of truth;
- directly mutate the roadmap or architecture outside governed Work Item activation;
- bypass Controller lifecycle predicates;
- approve or merge on its own;
- store provider passwords or raw authentication tokens;
- treat DOM text, browser state, or extension-local state as authoritative over repository evidence.

## Worker boundary

Workers may inspect the controlled repository, modify their assigned Work Item surface, run tests, push their implementation branch, open/update the one Work Item PR and respond to review findings. Workers may not merge, approve their own work, rewrite roadmap/architecture/work-order authority, fabricate evidence, or self-authorize completion.

## Architect boundary

The Architect reviews semantic correctness against the frozen architecture and Work Order. A review must identify the exact acceptance criteria assessed and any required changes. `APPROVE` is only valid when CI/evidence and scope predicates are satisfied.

## Merge predicate

Merge is permitted only when: the PR targets the intended base; Work Item scope is clean; required CI is terminal-success; no unresolved blocking review finding remains; the Architect decision is `APPROVE`; and repository machine state still identifies the Work Item as the active eligible item.

## Recovery

Every Controller operation is idempotent. On restart, reconstruct from repository files and GitHub. Never infer progress from an absent local process. If repository state contradicts GitHub state, stop and escalate rather than guessing. Browser-provider execution references are non-authoritative and must be re-established after restart.

## Non-goals

The Controller does not reimplement WorkflowOS, product workflow engines, product business logic, or agent authoring. It does not bypass provider security controls or operate undocumented private APIs merely to avoid supported UI interaction. It does not require a local product-repository checkout for the MVP.
