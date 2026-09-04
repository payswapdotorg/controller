# CTRL-005 — Orchestrator

Status: `COMPLETE`

## Objective

Implement the Controller's deterministic orchestration boundary over the already-accepted domain, GitHub adapter, and Z.ai adapter. The orchestrator must reconstruct repository authority, enforce the one-active-work-item policy, drive only repository-authorized lifecycle transitions, correlate GitHub and Z.ai evidence to the exact active Work Order, and hand off semantic review/merge decisions without becoming an authority source or prematurely implementing downstream automation stages.

## Authority

- `spec/architecture/controller-architecture.md`
- `spec/roadmap/roadmap.md`
- `spec/state/controller-program-state.json`
- `spec/operations/controller-build-process.md`
- `spec/governance/review-protocol.md`
- `spec/governance/worker-protocol.md`
- `spec/work-items/CTRL-001.md`
- `spec/work-items/CTRL-002.md`
- `spec/work-items/CTRL-003.md`
- `spec/work-items/CTRL-004.md`

## In scope

1. Define a typed orchestrator contract that reconstructs authoritative repository state and coordinates one active governed Work Order at a time.
2. Consume the existing domain/state model, GitHub adapter, and Z.ai adapter rather than creating parallel lifecycle, GitHub, or provider models.
3. Reconcile observed GitHub state to the exact active Work Order/PR correlation and refuse to guess when repository authority and observed remote state contradict.
4. Drive only lifecycle transitions already authorized by the frozen transition table, including dispatch, implementation, PR observation, and handoff to review; do not introduce new transition semantics.
5. Dispatch Z.ai using repository-derived exact Work Order/context and resume the same governed worker/PR context when the existing adapter contract permits it.
6. Produce deterministic orchestration decisions/outcomes that a future CI/evidence gate and review-loop implementation can consume without embedding those downstream policies prematurely.
7. Keep runtime state disposable and reconstructible from repository authority plus GitHub/provider evidence; no authoritative controller database, local session store, or opaque cache.
8. Add comprehensive deterministic offline tests using injected GitHub/Z.ai fakes plus operational documentation for restart reconstruction, correlation, idempotent observation, and fail-closed contradiction behavior.

## Explicit non-goals

- No CI/evidence/retry policy implementation beyond exposing the observations/outcomes required by future CTRL-006.
- No autonomous Architect semantic-review implementation or approval policy (CTRL-007).
- No merge/reconciliation automation beyond existing adapter/policy contracts (CTRL-008).
- No recovery/idempotency feature set beyond deterministic single-run orchestration and restart reconstruction required here (CTRL-009).
- No end-to-end dogfood implementation (CTRL-010).
- No new lifecycle states, transition rules, authority sources, workflow engine, scheduler, queue, or durable orchestration database.
- No GitHub or Z.ai transport reimplementation; use the accepted CTRL-003/CTRL-004 boundaries.
- No roadmap, architecture, or Work Order mutation from the orchestration runtime.
- No credentials or secrets in repository state.

## Acceptance criteria

### AC1 — Authority reconstruction

Every orchestration run begins from current repository machine state, frozen roadmap/work-order authority, and the existing domain model. Missing, malformed, stale, or contradictory authority fails closed before remote mutation.

### AC2 — Exact active-item correlation

The orchestrator operates on exactly the active eligible Work Order identified by repository state. GitHub PRs, branches, commits, and Z.ai worker/session context must be correlated to that same work-item identity; foreign or ambiguous correlation is refused.

### AC3 — Adapter coordination

The orchestrator coordinates the accepted GitHub and Z.ai adapters without duplicating their transport concerns. Start/resume calls carry the exact repository-derived context and preserve the same governed worker/PR identity across a change iteration.

### AC4 — Deterministic lifecycle control

Only frozen domain transitions are requested, and observed evidence is mapped to those transitions without inventing new lifecycle semantics. The orchestrator is deterministic for identical repository/remote evidence.

### AC5 — Fail-closed contradiction handling

Repository authority outranks runtime projections and remote observations. Any contradiction in Work Order status, machine state, PR identity/base/head, or worker/session correlation causes a safe stop with a typed contradiction outcome; no guessed recovery or alternate-item dispatch is permitted.

### AC6 — Runtime non-authority

No database, local cache, provider session, or in-memory process state becomes authoritative. Restarting the process and reconstructing from repository/GitHub/provider evidence yields the same governed decision for the same evidence.

### AC7 — Downstream policy boundary

The orchestrator exposes the observations/handoffs required by future CI/evidence, Architect review, merge/reconciliation, and recovery work, but does not implement those later policies or claim later automation stages.

### AC8 — Testability and safety audit

Offline deterministic tests cover ready dispatch, exact PR/worker correlation, repeated observation, restart reconstruction, stale/foreign correlation, authority contradiction, adapter failures, and refusal of unsupported downstream actions. No forbidden downstream surface is introduced.

## Implementation constraints

- Build only on the merged CTRL-001 through CTRL-004 foundations; do not alter their frozen authority or semantics.
- Reuse existing typed domain, authority, GitHub, and Z.ai abstractions.
- Keep all remote I/O behind accepted adapters and inject fakes for tests.
- Treat repository machine state as authoritative; controller runtime state is a disposable projection only.
- Maintain one active governed Work Order unless an explicit future roadmap change permits parallelism.
- Do not mutate roadmap, architecture, or Work Order definitions from orchestration runtime.
- Do not claim Stage 2, Stage 3, or later automation merely because orchestration exists; stage progression requires the corresponding accepted repository evidence and reconciliation.
- The implementation PR must contain only CTRL-005 scope, target the exact activation base, and preserve one PR per Work Order.

## Handoff

Worker verified the exact activation base `039177b27a3cdf38ec4ceed033ab7420c13c152c`, implemented CTRL-005 in PR #14 only, resolved Architect findings FZ-CTRL005-001 and FZ-CTRL005-002 on the same PR, and returned a validation transcript reporting 305 tests passed, strict mypy clean, ruff clean, CLI validate/domain clean, external-I/O guards green, and the CTRL-005 scope audit passing. The Architect approved reviewed head `3275198ef44c6589288814f3dedcaeebe6462c30` and merged PR #14 with expected-head protection.

## Merge / reconciliation evidence

Complete and reconciled. PR #14 (`CTRL-005 — Orchestrator`) was merged at `3e5ad4bc35186aaec5548cc1e06d6f27b7534a17` from reviewed head `3275198ef44c6589288814f3dedcaeebe6462c30` against activation base `039177b27a3cdf38ec4ceed033ab7420c13c152c`. The implementation remains within the frozen CTRL-005 scope; no CTRL-006+ implementation was introduced. Repository machine state records CTRL-005 as complete and includes it in `completed`; CTRL-006 remains planned but undefined and ineligible until a separate governance definition/activation.
