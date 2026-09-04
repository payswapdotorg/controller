# CTRL-007 — Architect Review Loop

Status: `COMPLETE`

## Objective

Implement the Controller's governed Architect-review loop over the already-accepted domain, GitHub, Z.ai, CTRL-005 orchestration, and CTRL-006 CI/evidence boundaries. The loop must reconstruct repository authority, observe the exact governed PR/review state, preserve the Architect's semantic authority, produce a durable machine-readable review packet for `REQUEST_CHANGES`, and hand off the same-worker/same-PR change iteration without inventing review decisions or bypassing merge gates.

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

## In scope

1. Define a typed review-loop contract over the accepted GitHub review evidence and CTRL-005/CTRL-006 orchestration/evidence boundaries.
2. Reconstruct repository authority first and operate only on the active Work Order and its exactly correlated PR.
3. Observe Architect review evidence by the exact PR number/head SHA and distinguish the latest authoritative Architect decision from unrelated, stale, or foreign reviews.
4. On `REQUEST_CHANGES`, construct a durable review packet containing the exact work item, PR, head/base SHA, iteration, decision, stable finding IDs, severity, affected paths, acceptance criterion, and specific required changes, without rewriting or inventing semantic findings.
5. Deliver that exact packet to the existing worker/resume boundary for the same governed worker and same PR; refusal on identity drift, base/head drift, missing packet fields, or ambiguous review evidence must fail closed.
6. Preserve the Architect boundary: the loop may transport, normalize, persist for handoff, and re-observe Architect decisions, but it may not invent, infer, or self-authorize `APPROVE`, `REQUEST_CHANGES`, or `ESCALATE` decisions.
7. Preserve the one-step lifecycle discipline and existing lifecycle semantics. `REQUEST_CHANGES` may lead to the already-authorized `CHANGES_REQUESTED` / `IMPLEMENTING` iteration; approval remains separate from merge execution.
8. Keep runtime state disposable/reconstructible. Durable review-loop evidence must live on the repository/GitHub review surface, not in an authoritative Controller database, hidden cache, scheduler, or queue.
9. Add deterministic offline tests covering exact-head review correlation, stale/foreign review refusal, packet completeness and stable finding IDs, same-PR/same-worker handoff, iteration/repeat behavior, restart reconstruction, and fail-closed contradictions.

## Explicit non-goals

- No autonomous semantic Architect review or model-generated approval policy.
- No ability for the Controller or Z.ai to author an Architect decision.
- No merge execution or post-merge reconciliation (CTRL-008).
- No CI/retry classification or retry execution beyond consuming the accepted CTRL-006 evidence/retry boundary.
- No recovery/idempotency feature set beyond deterministic review-loop reconstruction required here (CTRL-009).
- No new lifecycle states, transition rules, authority sources, workflow engine, scheduler, queue, or durable Controller database.
- No replacement GitHub/Z.ai transport; reuse CTRL-003/CTRL-004 adapters and CTRL-005 orchestration vocabulary.
- No credentials or secrets in repository state.
- No rewriting of frozen roadmap, architecture, or acceptance criteria by runtime code.

## Acceptance criteria

### AC1 — Authority reconstruction

Every review-loop evaluation begins from current repository machine state, roadmap/work-order authority, and accepted domain model. Missing, malformed, stale, or contradictory authority fails closed before any review-packet publication or worker resume routing.

### AC2 — Exact review correlation

Every authoritative review decision is correlated to the active Work Item, governed PR number, and exact current PR head SHA. A review for another PR, another Work Item, or an older head is not accepted as the current Architect decision. Ambiguous or contradictory evidence fails closed.

### AC3 — Architect authority preservation

The loop never creates or infers a semantic Architect decision. Only an observed Architect review can authorize the corresponding packet/transition handling. `APPROVE`, `REQUEST_CHANGES`, and `ESCALATE` remain distinct decisions; `APPROVE` is not a merge command.

### AC4 — Durable review packet

For `REQUEST_CHANGES`, the loop produces a durable machine-readable packet matching `spec/governance/review-protocol.md`, preserving stable finding IDs, severity, affected paths, criterion, and exact required changes. Findings are never silently dropped or rewritten.

### AC5 — Same-worker/same-PR handoff

A `REQUEST_CHANGES` packet can be handed off only when the worker/session identity, PR number, base SHA, and current head SHA are exactly reconstructible. Session/PR/base/head drift fails closed. The loop never dispatches an alternate worker or creates a new PR for the iteration.

### AC6 — Deterministic iteration control

The loop performs at most one governed lifecycle step per cycle. Re-observing the same review evidence is idempotent; a new iteration requires a new current PR head and a new authoritative review packet. Existing frozen transitions remain the only lifecycle authority.

### AC7 — Runtime non-authority and restart safety

No authoritative in-memory review state, packet registry, or durable Controller database is introduced. Restart reconstruction uses repository authority plus GitHub review evidence and the durable review packet surface only.

### AC8 — Testability and safety audit

Offline deterministic tests cover success/approval observation without merge, exact-head `REQUEST_CHANGES`, stale/foreign review refusal, packet completeness, stable finding IDs, same-worker/same-PR handoff, iteration behavior, restart determinism, adapter failures, and unsupported-decision refusal. No forbidden downstream surface is introduced.

## Implementation constraints

- Build only on merged CTRL-001 through CTRL-006 foundations; do not alter their frozen semantics.
- Reuse the existing `GithubReview` evidence, `OrchestrationReferences`, CTRL-005 worker/session identity, CTRL-006 evidence outputs, and accepted adapter transports.
- Treat GitHub's Architect review evidence and repository machine state as authoritative inputs; runtime packet projections are disposable unless persisted on the governed review surface.
- Preserve one active Work Order and one governed PR per item.
- Use deterministic ordering for multiple reviews/findings and fail closed on ambiguity.
- Do not claim Stage 4 or any later automation stage merely because the review loop exists; stage progression requires accepted repository evidence and reconciliation.
- The implementation PR must contain only CTRL-007 scope, target the exact activation base, and preserve one PR per Work Order.

## Handoff

Architect defined and froze CTRL-007 as the sole READY item after CTRL-006 reconciliation. Z.ai implemented only this Work Order from the exact activation base `a02cfdb4f253f63375e81d88581f7a27807ae672` in PR #20. The implementation resolved Architect findings FZ-CTRL007-001 through FZ-CTRL007-006 on the same PR, returned a durable evidence transcript, and did not redefine authority or claim completion. The reviewed head `5a43adfc8f270f5be37ba206ff33a45ad579d961` was Architect-approved and merged.

## Merge / reconciliation evidence

Complete and reconciled. PR #20 (`CTRL-007 — Architect review loop (durable review packets, exact decision correlation)`) targeted `main`, with dispatch/activation base `a02cfdb4f253f63375e81d88581f7a27807ae672`. Architect approval was recorded against exact head `5a43adfc8f270f5be37ba206ff33a45ad579d961` after resolution of FZ-CTRL007-001..006 and validation evidence of 433 passing tests, strict mypy clean, ruff/format clean, `controller validate` and `controller domain` green, no-external-I/O guard green, and `scripts/audit_ctrl_007.sh a02cfdb` PASS. The PR was merged at `a0392aa0e07772518638f506d755bd9d90d9dc4e` with expected-head protection. This reconciliation records CTRL-007 as complete, adds it to machine-state `completed`, and leaves CTRL-008 as the next planned item without defining or activating it. Stage 1 remains active; completion of CTRL-007 does not silently advance the automation stage.
