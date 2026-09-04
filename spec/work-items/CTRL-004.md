# CTRL-004 — Z.ai adapter

Status: `COMPLETE`

## Objective

Implement the Controller's repository-safe Z.ai adapter boundary required by the frozen architecture. The adapter must start and resume the implementation worker against one repository-authorized Work Order, preserve exact work-item/PR identity and review context, and expose deterministic typed evidence to the future orchestrator without becoming an orchestration engine, source of authority, or persistence layer.

## Authority

- `spec/architecture/controller-architecture.md`
- `spec/roadmap/roadmap.md`
- `spec/state/controller-program-state.json`
- `spec/operations/controller-build-process.md`
- `spec/governance/review-protocol.md`
- `spec/governance/worker-protocol.md`

## In scope

1. Define a typed Z.ai adapter contract for starting and resuming one governed implementation worker.
2. Accept a repository-derived worker context containing the exact repository identity, Work Order path/content or resolved Work Order reference, active work-item identity, base/head SHA facts, and applicable review packet when resuming a change iteration.
3. Define explicit typed request/result values and typed errors for configuration/authentication failures, transport failures, rejected requests, malformed responses, stale/mismatched work context, missing worker/session identity, and contradictory remote state.
4. Provide deterministic normalization of provider responses into domain-consumable values without making the provider the source of repository authority.
5. Support start semantics that create or identify a worker execution for the exact Work Order and resume semantics that target the same governed worker/PR context rather than silently starting a different work item.
6. Enforce an explicit policy boundary: the adapter may only send controller-approved worker instructions and may not merge, approve, redefine architecture/roadmap, mark a Work Order complete, or invent acceptance evidence.
7. Keep provider credentials and secrets outside repository state; use dependency injection for all provider I/O and deterministic fakes/fixtures for tests.
8. Add comprehensive offline tests and operational documentation for the adapter contract, context binding, error behavior, and resume semantics.

## Explicit non-goals

- No GitHub adapter reimplementation or new GitHub mutation surface (CTRL-003).
- No autonomous orchestration/state-machine loop, scheduling, queue, retry engine, or persistence layer (CTRL-005+).
- No Architect semantic-review implementation or autonomous approval policy (CTRL-007).
- No CI/evidence gate or generalized retry policy beyond exposing typed adapter outcomes (CTRL-006).
- No merge or repository mutation capability through Z.ai; the worker must remain unable to approve or merge its own work.
- No architecture/roadmap/work-order rewriting from the worker provider.
- No credential material, tokens, secrets, local session database, or opaque authoritative cache committed to the repository.
- No arbitrary provider-specific workflow engine or provider lock-in in domain code; transport-specific details stay behind the adapter.

## Acceptance criteria

### AC1 — Adapter boundary

A typed `ZaiAdapter` contract exists with explicit start/resume request and result types. Provider transport concerns are separated from controller policy and repository authority.

### AC2 — Exact work context

Every start/resume request is bound to the exact repository, Work Order, active work-item identity, and repository-derived context supplied by the caller. A missing, contradictory, or stale identity is rejected before provider I/O.

### AC3 — Resume identity

Resume can target the same governed worker execution and exact PR/change context for a review iteration. The adapter must not silently fork to an unrelated worker/session or discard an applicable review packet.

### AC4 — Fail-closed provider errors

Authentication/configuration failures, transport failures, rejected requests, malformed responses, missing worker/session identifiers, and context mismatches surface as explicit typed errors. No silent fallback, fabricated success, or guessed identity is permitted.

### AC5 — Repository authority boundary

The adapter never treats provider/session state as authoritative over repository roadmap, Work Order, or machine state. Repository-derived authority facts remain explicit inputs, and contradiction stops execution.

### AC6 — Worker safety boundary

The adapter cannot approve or merge work, cannot mark a Work Order complete, and cannot authorize architecture changes. Worker instructions must preserve the frozen worker role and may include only the exact governed task and review findings authorized by the caller.

### AC7 — Testability and determinism

All adapter behavior is covered by deterministic offline unit tests using injected fake transports and canned responses. Start/resume success, malformed responses, provider failures, context mismatch, duplicate/fork refusal, and review-packet propagation are covered.

### AC8 — Scope and safety audit

No GitHub reimplementation, orchestration engine, persistence database/cache, CI retry engine, autonomous Architect behavior, credential material, or downstream Work Order implementation is introduced. Domain code remains provider-transport independent.

## Implementation constraints

- Build on merged CTRL-001, CTRL-002, and CTRL-003 primitives; do not create a second lifecycle or GitHub model.
- Reuse existing typed errors and repository/domain abstractions where applicable.
- Prefer standard-library/minimal dependencies and transport dependency injection.
- Keep provider/network calls behind `controller/zai.py` (or a comparably isolated adapter-owned module); do not broaden network access to unrelated modules.
- Do not persist provider session state locally. A provider/session identifier may be returned and carried by the controller as an explicit non-authoritative execution reference.
- The adapter may construct the worker instruction payload from caller-supplied repository facts, Work Order text/reference, and review findings, but it must not invent missing authority.
- Preserve one active governed Work Order and one PR correlation at a time.
- Do not claim Stage 2 or later automation merely because this adapter exists; stage progression occurs only after accepted repository evidence and reconciliation.

## Handoff

Worker must verify the current `main` SHA and authority state before implementation, implement only this Work Order's owned surface, run the full validation suite, create/update exactly one PR for CTRL-004, and provide an implementation transcript with base/head SHAs and evidence for every acceptance criterion. Worker may not merge and must return to `WAITING_FOR_ARCHITECT` for review.

## Merge / reconciliation evidence

- Implementation PR: #11
- Reviewed implementation head: `165fb959281619b0e635b603ef2660834a60571e`
- Implementation base: `af22a2ffea2535f927c9656bfe0273e28ae32c61`
- Merge commit: `c873b467fc7f4381f7c213723a69071eb9953168`
- Architect approval: durable PR comment `5541849354`
- Post-merge reconciliation: required repository-state transition from `READY` to `COMPLETE`; acceptance criteria and scope unchanged.
