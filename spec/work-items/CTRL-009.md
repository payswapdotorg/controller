# CTRL-009 — Recovery / Idempotency

Status: `READY`

## Objective

Implement the Controller's governed recovery boundary for restart, interruption, and partial-progress conditions using only repository authority and existing GitHub evidence. The recovery logic must reconstruct the first incomplete lifecycle step deterministically, resume only already-authorized mechanical work, fail closed on ambiguity or contradiction, and preserve the semantic Architect boundary. It must not introduce a controller database, hidden queue, alternate lifecycle semantics, or autonomous approval/review decisions.

## Authority

- `spec/architecture/controller-architecture.md`
- `spec/roadmap/roadmap.md`
- `spec/state/controller-program-state.json`
- `spec/operations/controller-build-process.md`
- `spec/operations/architect-control-loop.md`
- `spec/governance/review-protocol.md`
- `spec/governance/worker-protocol.md`
- `spec/work-items/CTRL-001.md`
- `spec/work-items/CTRL-002.md`
- `spec/work-items/CTRL-003.md`
- `spec/work-items/CTRL-004.md`
- `spec/work-items/CTRL-005.md`
- `spec/work-items/CTRL-006.md`
- `spec/work-items/CTRL-007.md`
- `spec/work-items/CTRL-008.md`

## In scope

1. Define a typed recovery contract over the existing lifecycle state, repository authority, carried orchestration references, GitHub PR/review/CI/merge evidence, and accepted adapter operations.
2. Reconstruct the repository/domain state first and identify the single active Work Item and first incomplete governed boundary without relying on process memory.
3. Detect and classify restart/interruption conditions at every existing lifecycle position, including durable evidence of work already performed but not yet reflected in machine state.
4. Resume only operations that are already authorized by the frozen lifecycle/merge/review/evidence predicates; never manufacture an Architect decision, worker identity, CI success, merge success, or completion.
5. Preserve exact identity across recovery: Work Item, governed branch, PR number, base SHA/ref, head SHA, worker session where required, Architect reviewer identity, and observed merge evidence.
6. Make recovery deterministic and idempotent: repeated reconstruction against unchanged authority/evidence produces the same outcome; already-completed external work is recorded rather than repeated; partially performed unauthorized work fails closed.
7. Handle partial external operations without guessing: an observed successful merge may continue to reconciliation; an unmerged or contradictory post-mutation observation must stop without retrying the mutation.
8. Keep semantic Architect review boundaries intact: recovery may transport/resume an already recorded decision but cannot create APPROVE, REQUEST_CHANGES, or ESCALATE.
9. Keep the Controller free of authoritative persistence, scheduler/queue behavior, alternate state machines, and provider-specific recovery semantics.
10. Add deterministic offline tests covering interruption at each existing lifecycle position, evidence-present/state-missing cases, stale/foreign evidence, duplicate/ambiguous evidence, restart equivalence, and zero-retry/fail-closed behavior.

## Explicit non-goals

- No new lifecycle states or transitions.
- No changes to roadmap ordering or automation-stage semantics.
- No autonomous semantic Architect review or decision generation.
- No new merge/reconciliation predicate; CTRL-008 remains the accepted merge boundary.
- No Z.ai provider protocol redesign or new worker execution semantics.
- No CI classification/retry policy redesign; consume accepted CTRL-006 evidence.
- No controller database, queue, scheduler, hidden registry, or authoritative cache.
- No replacement GitHub/Z.ai transport or credentials.
- No CTRL-010 end-to-end dogfood implementation.

## Acceptance criteria

### AC1 — Authority-first recovery

Every recovery evaluation reconstructs current repository authority and domain state before acting on external evidence. Missing, malformed, stale, or contradictory authority fails closed without mutation.

### AC2 — First-incomplete-step reconstruction

Given a restart/interruption snapshot, recovery deterministically identifies the active Work Item and the first lifecycle boundary that has not been durably established. The result is derived from repository authority plus observed GitHub evidence, not hidden runtime memory.

### AC3 — Evidence-correlated resume

Recovery resumes only when the exact Work Item, PR, base/head identity, required evidence, and any carried session/reviewer identities correlate. Foreign or stale evidence is history, not permission; ambiguous evidence is a contradiction.

### AC4 — No fabricated semantic decisions

Recovery may reuse an already observed Architect APPROVE/REQUEST_CHANGES decision and its durable packet, but it never authors or infers a semantic Architect decision. Missing semantic evidence stops the loop.

### AC5 — Partial-operation safety

A recovery observation after an external mutation distinguishes successful completion, failed completion, and unknown/contradictory outcome. A successful merge is accepted only from existing CTRL-008 merge evidence; an incomplete or ambiguous mutation is never retried automatically across a governance boundary.

### AC6 — Deterministic idempotency

Repeated recovery against unchanged repository/GitHub evidence returns the same typed outcome and performs no duplicate mutation. Recovery is safe across process restart because all required information is reconstructible from durable authority/evidence.

### AC7 — Existing lifecycle authority preserved

All resumed lifecycle transitions are validated through the existing CTRL-002/CTRL-001 transition model and existing CTRL-003/CTRL-006/CTRL-007/CTRL-008 predicates. CTRL-009 must not introduce a parallel lifecycle or alternate merge/review semantics.

### AC8 — Testability and safety audit

Offline deterministic tests cover each existing lifecycle position, completed-vs-incomplete evidence reconciliation, exact identity binding, duplicate/ambiguous evidence refusal, restart equivalence, zero unauthorized mutation, absence of provider/database/scheduler surfaces, and deterministic no-retry behavior.

## Implementation constraints

- Build only on merged/reconciled CTRL-001 through CTRL-008 foundations; do not alter their frozen semantics.
- Reuse existing domain/lifecycle transitions and accepted GitHub/Z.ai evidence types; do not invent parallel vocabularies.
- Preserve the authority hierarchy: repository roadmap/work orders > repository machine state > GitHub evidence > runtime projection/cache.
- Preserve one active Work Item and one governed PR per item.
- Use exact SHA identity and deterministic evidence ordering.
- Fail closed on missing, ambiguous, contradictory, or unsupported recovery conditions.
- No semantic Architect decision may be manufactured by recovery.
- Stage remains `STAGE-1-STATE-MACHINE-AUTOMATION` until the roadmap's stated prerequisites are accepted; activating CTRL-009 does not silently advance the stage.
- The implementation PR must contain only CTRL-009 scope and target the exact governance activation base.

## Handoff

Architect has completed CTRL-008 merge and reconciliation at PR #23 merge commit `e733e37a1ecf7a86c12e3baac0fd325c5806aaa4` and reconciliation PR #24 merge commit `51b683ee608abc300ddff3a7e32ca0323f8eab5e`. CTRL-009 is now defined and frozen as the sole next planned Work Item and is activated as `READY`. Z.ai may implement only this Work Order from the exact governance activation base recorded in machine state after this definition change. The worker must verify authority and base SHA, implement only CTRL-009, run the complete validation suite and scope/safety audit, create/update exactly one implementation PR, and return durable evidence. The worker may not merge, approve, redefine authority, or claim completion.

## Merge / reconciliation evidence

Not yet implemented. CTRL-009 has just been defined/frozen/activated as the sole `READY` item after CTRL-008 reconciliation. Stage 1 remains active; activating CTRL-009 does not silently advance the automation stage.
