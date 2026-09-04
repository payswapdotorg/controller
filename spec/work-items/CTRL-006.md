# CTRL-006 — CI / Evidence Gate

Status: `COMPLETE`

## Objective

Implement the Controller's deterministic CI/evidence gate over the already-accepted domain, GitHub adapter, Z.ai adapter, and CTRL-005 orchestration boundary. The gate must reconstruct repository authority, observe the exact governed PR and required CI evidence, classify the observed result according to an explicit repository-defined policy, and expose or route only the outcomes permitted by that policy. It must remain fail-closed, restart-safe, non-authoritative, and bounded to exactly one active Work Order.

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
- `spec/work-items/CTRL-005.md`

## In scope

1. Define a typed CI/evidence-gate contract over the existing GitHub status/check observations and CTRL-005 orchestration outcomes.
2. Reconstruct repository authority first and operate only on the active Work Order selected by machine state and roadmap eligibility.
3. Correlate CI evidence to the exact governed PR, head SHA, and active Work Item; refuse missing, stale, foreign, ambiguous, or contradictory evidence rather than guessing.
4. Determine whether required evidence is terminal-success, still pending, or a terminal failure according to an explicit frozen gate policy; expose the evidence needed by later review/merge decisions.
5. Where policy explicitly permits an implementation retry, hand off a typed resume request to the existing Z.ai adapter/orchestrator boundary without implementing worker logic in the gate itself.
6. Preserve the one-step lifecycle discipline: request only transitions already authorized by the frozen domain model; do not add lifecycle states or transition semantics.
7. Keep all remote I/O behind the accepted GitHub/Z.ai adapters and keep runtime state disposable/reconstructible; no database, authoritative cache, scheduler, queue, or parallel work-item state.
8. Add deterministic offline tests and operational documentation covering success, pending, failure, stale/foreign evidence, retry-policy boundaries, restart reconstruction, idempotence, and fail-closed contradictions.

## Explicit non-goals

- No autonomous Architect semantic-review implementation or review authority (CTRL-007).
- No merge execution or post-merge reconciliation (CTRL-008).
- No recovery/idempotency feature set beyond the deterministic restart/idempotence needed for this gate (CTRL-009).
- No end-to-end dogfood implementation (CTRL-010).
- No new lifecycle states, transition rules, authority sources, workflow engine, scheduler, queue, or durable orchestration database.
- No GitHub or Z.ai transport reimplementation; use the accepted CTRL-003 / CTRL-004 adapters.
- No mutation of roadmap, architecture, or Work Order definitions by runtime code.
- No credentials or secrets in repository state.

## Acceptance criteria

### AC1 — Authority reconstruction

Every gate evaluation begins from current repository machine state, frozen roadmap/work-order authority, and the accepted domain model. Missing, malformed, stale, or contradictory authority fails closed before any remote mutation or retry routing.

### AC2 — Exact CI evidence correlation

Every observed check/status used by the gate is correlated to the active Work Order's governed PR and exact head SHA. Foreign, stale, ambiguous, missing, or contradictory evidence is rejected with a typed failure; no evidence is silently reassigned to another Work Order.

### AC3 — Deterministic evidence classification

The gate deterministically classifies observed evidence as pending, terminal-success, terminal-failure, or policy-blocked according to the frozen gate rules. Identical authority and GitHub evidence yield identical results.

### AC4 — Required-evidence policy

The gate identifies the required CI/evidence set for the governed Work Item and only treats the run as successful when all required evidence is terminal-success. Partial success, unrelated checks, or green evidence for a different head do not satisfy the gate.

### AC5 — Retry boundary

Retry/resume is permitted only when an explicit frozen policy classifies the observed failure as retryable and the exact governed worker/PR context can be reconstructed. Non-retryable, repeated, ambiguous, or contradictory failures are exposed for governance attention without guessed recovery.

### AC6 — Lifecycle boundary

The gate requests only frozen domain transitions already authorized by the CTRL-001/CTRL-002 model. It does not invent new lifecycle semantics and performs at most one governed lifecycle step per cycle.

### AC7 — Runtime non-authority

No database, durable local cache, authoritative provider session, scheduler, queue, or hidden process state is introduced. Restarting the controller reconstructs the same gate decision from repository authority plus GitHub/Z.ai evidence.

### AC8 — Testability and safety audit

Offline deterministic tests cover terminal success, pending evidence, terminal failure, stale/foreign/ambiguous evidence, retry-policy boundaries, restart reconstruction, idempotence, adapter failures, and refusal of unsupported downstream actions. No forbidden downstream surface is introduced.

## Implementation constraints

- Build only on the merged CTRL-001 through CTRL-005 foundations; do not alter their frozen authority or semantics.
- Reuse existing typed domain, authority, GitHub, Z.ai, and CTRL-005 orchestration abstractions.
- Keep all remote I/O behind accepted adapters and inject fakes for tests.
- Treat repository machine state as authoritative; runtime projections are disposable only.
- Maintain one active governed Work Order unless an explicit future roadmap change permits parallelism.
- Keep retry policy explicit, typed, deterministic, and repository-governed; never infer retryability from free text or timing heuristics.
- Do not claim Stage 3, Stage 4, or later automation merely because this gate exists; stage progression requires accepted repository evidence and reconciliation.
- The implementation PR must contain only CTRL-006 scope, target the exact activation base, and preserve one PR per Work Order.

## Handoff

Architect defined and froze CTRL-006 as the sole READY item. Z.ai implemented only this Work Order from the corrected exact implementation base `72a8459f4a153b8a7b58ee6ab7c40997bd71cd1b`, in PR #17. The worker resolved all Architect findings, returned a durable evidence transcript, and did not merge, approve, redefine authority, or claim completion.

## Merge / reconciliation evidence

Complete and reconciled. PR #17 (`CTRL-006 — CI/evidence gate`) was reviewed and approved at head `ec6155a41aad557105d63db8ac1768d8cad2a002` against base `72a8459f4a153b8a7b58ee6ab7c40997bd71cd1b`, then merged at `fbc4e41c0fab05f14fa1d4cb8f989a71d7c05ab5`. The worker reported 356 passing tests, strict mypy clean, ruff clean, CLI validation clean, external-I/O guards green, and the CTRL-006 scope audit passing. The reconciliation records CTRL-006 as complete, adds it to machine-state `completed`, and leaves CTRL-007 planned but undefined/ineligible until separately defined and frozen. Stage 1 remains active.
