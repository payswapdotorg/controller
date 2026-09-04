# CTRL-002 — Domain/state model

Status: `READY`

## Objective

Define and implement the controller's domain-level model for governed work-item execution on top of the accepted CTRL-001 lifecycle foundation. The model must represent repository-authoritative work-item identity, eligibility, lifecycle state, commands/events, and deterministic state reconstruction without introducing a new authoritative persistence layer.

## Authority

- `spec/architecture/controller-architecture.md`
- `spec/roadmap/roadmap.md`
- `spec/state/controller-program-state.json`
- `spec/operations/controller-build-process.md`

## In scope

1. Define typed domain objects for a single active work item and its governed execution context.
2. Define explicit representations for work-item identity, eligibility, lifecycle position, and the evidence/state required to drive deterministic orchestration.
3. Define deterministic projection/reconstruction of the domain model from repository authority and the existing CTRL-001 state-machine primitives.
4. Define validation and fail-closed behavior for missing, malformed, contradictory, or ineligible domain state.
5. Define the domain-level command/event contracts needed by later GitHub and Z.ai adapters without implementing those adapters.
6. Preserve idempotency and restart reconstruction semantics.
7. Add comprehensive unit tests for valid domain construction, eligibility, invalid/contradictory authority, deterministic reconstruction, and command/event behavior.
8. Update development documentation only where needed to explain the new domain model and validation commands.

## Explicit non-goals

- No GitHub API/client/mutation code.
- No Z.ai API/client/dispatch code.
- No automatic merge implementation.
- No CI/evidence automation beyond local deterministic validation required by this Work Order.
- No autonomous Architect review.
- No persistent controller database, queue, cache, or other authoritative side channel.
- No implementation of CTRL-003 or CTRL-004 functionality.
- No changes to the frozen architecture or roadmap sequencing.

## Acceptance criteria

### AC1 — Domain model

A typed, explicit domain model exists for one active governed work item and does not rely on untyped dictionaries as its public contract.

### AC2 — Authority-derived eligibility

Eligibility is derived from repository authority (roadmap/work order/machine state and their declared relationships), not from local mutable runtime state. An item that is not explicitly READY and eligible cannot be dispatched by the domain model.

### AC3 — Deterministic reconstruction

Equivalent repository authority reconstructs to equivalent domain state across process restarts and machines. No local persistence is required or treated as authoritative.

### AC4 — Fail closed

Malformed, missing, contradictory, or semantically invalid authority causes an explicit validation error. The implementation must not guess, repair silently, or select a fallback Work Order.

### AC5 — Lifecycle integration

The domain model integrates cleanly with the CTRL-001 lifecycle state machine without duplicating or redefining its transition policy.

### AC6 — Command/event boundary

Domain commands/events are explicit, deterministic, and serializable as values suitable for future adapters. No external transport or integration is implemented.

### AC7 — Idempotency

Repeated reconstruction/validation of unchanged authority produces the same domain result; repeated handling of an already-applied domain observation does not create divergent state.

### AC8 — Tests and validation

Tests cover the acceptance criteria, including negative/contradictory cases. All repository validation, type checking, linting, and formatting checks pass.

### AC9 — Scope audit

No forbidden integration, persistence, credentials, roadmap rewrite, architecture mutation, or downstream Work Order implementation is introduced.

## Implementation constraints

- Build on the merged CTRL-001 primitives; do not rewrite them unnecessarily.
- Prefer standard-library/minimal dependencies.
- Keep repository authority as the sole durable source of truth.
- Keep the one-active-work-item constraint.
- Do not create lifecycle transitions not explicitly authorized by the frozen architecture.

## Handoff

Worker must create one PR from current `main`, run the full validation suite, provide an implementation transcript with base/head SHAs and evidence for every acceptance criterion, and wait for Architect review. Worker may not merge.
