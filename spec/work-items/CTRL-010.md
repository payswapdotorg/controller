# CTRL-010 — End-to-End Dogfood

Status: `COMPLETE`

## Objective

Prove the assembled Controller can execute one complete governed Work Item loop end-to-end using the accepted CTRL-001 through CTRL-009 boundaries, including deterministic restart recovery, without introducing a parallel lifecycle, weakening any frozen predicate, changing roadmap semantics, or transferring semantic authority away from the Architect.

CTRL-010 is an integration/dogfood proof item. It must exercise the real composition of repository authority, lifecycle/domain reconstruction, GitHub observation, Z.ai dispatch/resume, CI/evidence handling, Architect review/change-loop handling, merge/reconciliation, and CTRL-009 recovery. Any failure or contradiction must remain fail-closed and visible rather than being repaired by dogfood-specific shortcuts.

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
- `spec/work-items/CTRL-009.md`

## In scope

1. Define one deterministic end-to-end dogfood scenario that starts from a repository-authorized READY Work Item and exercises the accepted lifecycle boundaries in sequence.
2. Exercise exact Work Item, governed branch, PR, base SHA, head SHA, worker-session, Architect-review, CI/evidence, and merge/reconciliation identity correlation across the composed loop.
3. Exercise at least one restart/interruption boundary where CTRL-009 reconstructs the first incomplete governed boundary from durable authority and observed evidence and resumes only already-authorized mechanical work.
4. Demonstrate the same-worker/same-PR change-loop behavior when Architect `REQUEST_CHANGES` is introduced, preserving semantic Architect ownership of the review decision.
5. Demonstrate the approved merge path with the existing CTRL-008 merge predicate and exact-head merge boundary; no dogfood-specific merge shortcut is permitted.
6. Demonstrate post-merge reconciliation and deterministic selection/activation behavior using the repository's existing authority files.
7. Preserve all frozen CTRL-001 through CTRL-009 contracts and prove the dogfood scenario does not introduce alternate lifecycle states, predicates, persistence, queues, schedulers, or provider-specific recovery behavior.
8. Provide deterministic offline/integration coverage for the composition wherever the accepted adapters/fakes make this possible, plus an explicit execution record for the governed dogfood run.
9. Record sufficient evidence for a future Architect to determine whether the roadmap's Stage 6 prerequisites are satisfied; CTRL-010 itself must not silently advance the automation stage.

## Explicit non-goals

- No new lifecycle states or transitions.
- No replacement or modification of the CTRL-001..CTRL-009 frozen predicates solely to make the dogfood pass.
- No new merge/reconciliation semantics.
- No autonomous semantic Architect approval, REQUEST_CHANGES, or ESCALATE generation.
- No new controller database, queue, scheduler, hidden registry, or authoritative cache.
- No new GitHub/Z.ai transport, credentials, or provider protocol.
- No hard-coded success path that bypasses actual boundary validation.
- No mutation of the roadmap ordering.
- No silent transition to Stage 6 or Stage 7.

## Acceptance criteria

### AC1 — Full governed loop composition

Starting from a repository-authorized READY Work Item, the dogfood execution traverses the accepted lifecycle from dispatch through implementation, governed PR/CI evidence, Architect review, change iteration where exercised, approval, merge, and post-merge reconciliation. Each transition is performed by the existing owning boundary and is supported by observed evidence.

### AC2 — Exact identity preservation

Throughout the run, the exact Work Item identity, governed branch, PR identity, base/head SHAs, worker-session identity, Architect reviewer identity, required evidence, and observed merge SHA remain correlated. Any foreign, stale, ambiguous, or contradictory identity causes a typed fail-closed outcome.

### AC3 — Restart/interruption proof

At a deliberately selected interruption point, the process is restarted with no hidden controller state. CTRL-009 reconstructs the first incomplete governed boundary solely from repository authority, carried references, and observed GitHub evidence, and the resumed work continues only through the existing boundary's frozen predicate. No duplicate worker start, merge retry, fabricated decision, or hidden state may be used to complete the run.

### AC4 — Change-loop proof

At least one Architect `REQUEST_CHANGES` cycle is exercised. The same governed PR and worker context are resumed with the exact durable findings; no new PR is created, and the worker cannot author the semantic decision.

### AC5 — Merge/reconciliation proof

The final approval and merge use the accepted CTRL-008 predicate and exact-head execution boundary. The observed merge result establishes `MERGED`; reconciliation records the exact merge evidence and updates authoritative repository state without inventing completion or next-item identity.

### AC6 — Deterministic evidence and repeatability

The dogfood scenario is reproducible from durable repository/GitHub evidence and produces the same classification/recovery decisions when the same evidence snapshot is replayed. Offline integration coverage must not depend on wall-clock time, randomness, or process-local controller state.

### AC7 — Frozen-boundary integrity

The dogfood implementation changes no frozen CTRL-001..CTRL-009 semantics and introduces no parallel lifecycle, policy, persistence, or mutation surface. Static/scope audit evidence must demonstrate that the dogfood layer composes the accepted boundaries rather than re-implementing their predicates.

### AC8 — Stage-transition evidence

The execution record explicitly states whether the roadmap prerequisites for Stage 6 are now satisfied. The implementation must not itself alter `automationStage`; any stage transition remains a separate Architect-governed state update supported by accepted evidence.

### AC9 — Safety and failure-path coverage

The dogfood evidence covers at least one contradiction or unsafe partial-operation case and demonstrates that the composed Controller fails closed rather than guessing or retrying across a governance boundary.

## Implementation constraints

- Build only on merged/reconciled CTRL-001 through CTRL-009 foundations.
- Reuse the accepted domain, lifecycle, GitHub, Z.ai, evidence, review, merge, and recovery contracts exactly.
- Keep repository authority above runtime projections and keep all durable state reconstructible.
- Preserve one active Work Item and one governed PR per Work Item.
- Preserve the semantic Architect review boundary.
- Preserve exact SHA identity and deterministic evidence ordering.
- Do not change `automationStage` merely because CTRL-010 is active or successful.
- The implementation PR must contain only CTRL-010 scope and target the exact governance activation base.

## Handoff

CTRL-009 is complete, merged, and reconciled. The roadmap defines CTRL-010 as its sole successor and describes it as the end-to-end dogfood milestone that, together with CTRL-009, provides the prerequisite evidence for the roadmap's Stage 6 Merge/reconciliation automation mapping. CTRL-010 is therefore defined and activated as the sole `READY` item for implementation. Z.ai may implement only this Work Order from the exact governance activation base recorded in machine state. The worker must not merge, approve, redefine authority, alter the roadmap, or advance the automation stage.

## Acceptance / completion record

CTRL-010 implementation was delivered in PR #30. The worker returned a green validation transcript on implementation head `8584be235ab26ebb9bc48dd2861bfeff69b7c9f2` and branch tip `02da00d19e9745f9f4a7cf11a1dea7305e9a66e3`: 591/591 tests + 202 subtests, strict mypy 0 issues, ruff check/format clean, `controller validate` and `domain` green, external-I/O guard 8/8 + 122 subtests, and `scripts/audit_ctrl_010.sh 3a53cff188dbc9ff1bdb0429df61f67ca8c71055 42ee91790c2a844b16b3790b4ccdec2b7630af3a` PASS (8/8). The committed `tests/dogfood_execution_record.json` replayed to equal value. Architect semantic approval was recorded durably as top-level comment `5547679506` because formal approval is unavailable when Architect and PR author share the GitHub identity. PR #30 was merged at `621847cba9dad92a0d45c13853b24ad66402284e`.

The accepted dogfood record demonstrates the complete 18-step composed lifecycle, one same-worker/same-PR `REQUEST_CHANGES` iteration, exact identity correlation across both implementation heads, one authorized merge mutation, deliberate lost-state-write interruption, CTRL-009 `EXTERNAL_COMPLETION_OBSERVED` recovery, zero second merge attempt and zero worker replay after restart, deterministic reconciliation, and fail-closed contradiction/partial-operation probes. The dogfood surface composes existing boundaries and introduces no new lifecycle state, predicate, persistence, queue, scheduler, transport, or semantic Architect authority. The automation stage remains `STAGE-1-STATE-MACHINE-AUTOMATION`.

## Merge / reconciliation evidence

- Implementation PR: #30
- Exact approved implementation head: `02da00d19e9745f9f4a7cf11a1dea7305e9a66e3`
- Implementation merge commit: `621847cba9dad92a0d45c13853b24ad66402284e`
- Reconciliation: this Work Order and authoritative machine state were updated from the observed merge in the reconciliation PR.
- Stage 6 prerequisite evidence: CTRL-009 + CTRL-010 have now been accepted, merged, reconciled, and exercised together by the deterministic dogfood execution record.
- Current recorded automation stage: `STAGE-1-STATE-MACHINE-AUTOMATION`; no silent stage transition is performed by CTRL-010.
- No successor Work Item is defined by the current roadmap.
