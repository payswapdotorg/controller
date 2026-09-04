# CTRL-008 — Merge + Reconciliation

Status: `COMPLETE`

## Objective

Implement the Controller's governed merge and post-merge reconciliation boundary over the already-accepted CTRL-001 through CTRL-007 foundations. The implementation must consume repository authority plus exact GitHub/CI/evidence/review outputs, enforce the frozen merge predicate, perform no merge when evidence is stale, contradictory, incomplete, or architecturally blocked, and reconcile the repository machine state only from an observed successful merge. The boundary must remain deterministic and fail closed across restart without introducing a controller database, scheduler, queue, or alternate authority source.

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
- `spec/work-items/CTRL-006.md`
- `spec/work-items/CTRL-007.md`

## In scope

1. Define a typed merge/reconciliation contract over the accepted GitHub adapter, CTRL-006 evidence gate, CTRL-007 Architect-review outcome, and CTRL-005 refs.
2. Reconstruct repository authority first and operate only on the currently active Work Item and its exactly correlated PR.
3. Re-establish the full frozen merge predicate from repository/work-item authority and observed evidence before any merge mutation: intended `main` base, exact active Work Item identity, one governed PR, exact PR head, terminal-success required CI/evidence, no unresolved blocking review/change state, and an Architect `APPROVE` bound to that exact head.
4. Make merge authorization explicit, typed, deterministic, and non-forgeable at execution time. A stale, foreign, missing, ambiguous, or contradictory authorization must fail closed; an approval never implies merge without the remaining predicates.
5. Execute at most one merge attempt for one exact authorized head and refuse execution when the observed PR head/base/evidence has drifted since authorization.
6. Treat the GitHub merge result as external execution evidence: only an observed successful merge may advance the repository to post-merge reconciliation.
7. Reconstruct and reconcile repository machine state from the successful merge evidence, recording the completed Work Item, exact merge SHA, and deterministic next eligible Work Item according to the authoritative roadmap without silently changing the automation stage.
8. Make post-merge reconciliation restart-safe and idempotent: repeating reconciliation against the same successful merge evidence must not create duplicate completion records or conflicting authority.
9. Keep the Controller free of authoritative persistence, scheduler/queue behavior, and alternate lifecycle semantics. Reuse the frozen CTRL-002 transition table and existing adapter/evidence vocabularies.
10. Add deterministic offline tests for merge-predicate failures, exact-head authorization, execution-time drift refusal, successful merge observation, reconciliation/idempotency, restart reconstruction, adapter failures, and forbidden mutation paths.

## Explicit non-goals

- No new lifecycle states, transition rules, roadmap sequencing, or authority hierarchy.
- No autonomous semantic Architect review or decision authoring.
- No Z.ai provider execution or review-loop implementation; CTRL-007 remains the accepted review boundary.
- No CI classification/retry execution beyond consuming accepted CTRL-006 evidence.
- No recovery feature set beyond deterministic reconciliation/idempotency required here (CTRL-009).
- No new workflow engine, scheduler, queue, controller database, registry, or hidden persistence.
- No replacement GitHub/Z.ai transport and no new credentials or secrets.
- No rewrite of frozen architecture, roadmap, or previously completed Work Orders.

## Acceptance criteria

### AC1 — Authority-first merge evaluation

Every merge evaluation begins by reconstructing current repository authority and the active Work Item. A lifecycle position outside the merge boundary, malformed/missing authority, or contradiction fails closed before any GitHub merge mutation.

### AC2 — Exact merge correlation

The merge target is exactly the active governed Work Item's single PR on intended `main`, with exact current base/head SHAs. Foreign, stale, ambiguous, or missing PR correlation fails closed.

### AC3 — Complete frozen merge predicate

Merge authorization is granted only when every repository-defined predicate is true: intended base, exact active Work Item identity, clean work-item scope, terminal-success required CI/evidence, no unresolved blocking review/change state, and Architect `APPROVE` bound to the exact current PR head. `APPROVE` alone is insufficient.

### AC4 — Execution-time drift protection

The merge operation re-proves all execution-critical predicates immediately before mutation, including exact PR/base/head identity and the approved head. Any drift since authorization prevents the merge. The worker cannot merge its own work.

### AC5 — External merge evidence

Only the observed GitHub merge result establishes `MERGED`. A failed, partial, contradictory, or unobserved merge result does not advance repository authority or fabricate completion.

### AC6 — Deterministic post-merge reconciliation

After confirmed merge, reconciliation records the exact merge SHA and updates the repository's machine state and Work Order to `COMPLETE`, while selecting the next roadmap-eligible item deterministically. Existing frozen lifecycle semantics remain authoritative.

### AC7 — Restart/idempotency safety

Reconciliation derives its result from repository authority plus persisted/observed merge evidence and is idempotent across repeated evaluation or process restart. No controller-side authoritative state is introduced.

### AC8 — Testability and safety audit

Offline deterministic tests cover successful merge, each merge-predicate refusal class, exact-head binding, execution drift, worker-merge prohibition, merge-result handling, reconciliation idempotency/restart, adapter failures, and absence of forbidden persistence/queue/scheduler surfaces.

## Implementation constraints

- Build only on merged/reconciled CTRL-001 through CTRL-007 foundations; do not alter their frozen semantics.
- Reuse the CTRL-003 GitHub adapter merge authorization/evidence vocabulary and the accepted `GithubPullRequest` / status / review evidence types.
- Consume CTRL-006 terminal-success evidence and CTRL-007 Architect approval; do not duplicate their semantic decision logic.
- Preserve the authority hierarchy: repository roadmap/work orders > repository machine state > GitHub PR/CI/review/merge evidence > runtime projection/cache.
- Preserve one active Work Item and one governed PR per item.
- Use exact SHA identity and deterministic ordering; fail closed on ambiguity or drift.
- Implementation must target the exact governance activation base and contain only CTRL-008 scope.
- The worker must not merge, approve, redefine authority, or claim completion; merge and reconciliation are the governed responsibilities of this Work Item.

## Handoff

Architect defined and froze CTRL-008 as the sole READY item after CTRL-007 reconciliation. Z.ai implemented only this Work Order from the exact activation base `f55f5190a82a0fb774285a03347e6df71163cbd5` in PR #23. The implementation resolved Architect finding FZ-CTRL008-001 on the same PR, returned durable validation evidence, and did not redefine authority or claim completion. The final PR branch was reconciled with current `main` and merged as PR #23 at commit `e733e37a1ecf7a86c12e3baac0fd325c5806aaa4`.

## Merge / reconciliation evidence

Complete and reconciled. PR #23 (`CTRL-008 — Merge + reconciliation boundary (frozen predicate, one authorized attempt, deterministic idempotent reconciliation)`) was Architect-approved after resolution of FZ-CTRL008-001. Worker validation evidence was 480 passing tests + 167 subtests, strict mypy clean, ruff/format clean, `controller validate` and `controller domain` green, no-external-I/O guard green, and `scripts/audit_ctrl_008.sh f55f519...` PASS. The implementation branch was reconciled with the current `main` history before merge. PR #23 was then merged with expected-head protection at `e733e37a1ecf7a86c12e3baac0fd325c5806aaa4`. This reconciliation records CTRL-008 as complete, adds it to machine-state `completed`, preserves `STAGE-1-STATE-MACHINE-AUTOMATION`, and leaves CTRL-009 as the next planned roadmap item without defining or activating it. The exact merge SHA is the observed GitHub merge evidence; no silent stage change occurred.
