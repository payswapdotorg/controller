# Controller Roadmap — Authoritative

This file is the human-readable implementation roadmap. Changes to sequencing, scope, dependencies or acceptance criteria require an explicit architecture/work-order change before implementation.

The repository is the sole source of truth. The bootstrap and automation-stage operating process is defined in `spec/operations/controller-build-process.md`; that document governs how responsibility moves from the human operator to the Controller as roadmap work is accepted.

## Graph

```text
CTRL-001 Foundation & repository authority
        |
        v
CTRL-002 Domain/state model
        |
        +--------------------+
        |                    |
        v                    v
CTRL-003 GitHub adapter   CTRL-004 Z.ai adapter
        |                    |
        +---------+----------+
                  v
           CTRL-005 Orchestrator
                  |
                  v
           CTRL-006 CI/evidence gate
                  |
                  v
           CTRL-007 Architect review loop
                  |
                  v
           CTRL-008 Merge + reconciliation
                  |
                  v
           CTRL-009 Recovery/idempotency
                  |
                  v
           CTRL-010 End-to-end dogfood
```

## Automation-stage mapping

```text
Stage 0  Manual controller / bootstrap
        ↓ CTRL-001
Stage 1  State-machine automation
        ↓ CTRL-003 + CTRL-004
Stage 2  GitHub observation automation
        ↓ CTRL-004 + CTRL-005
Stage 3  Z.ai dispatch/resume automation
        ↓ CTRL-006 + CTRL-007
Stage 4  Review/change-loop automation
        ↓ CTRL-006
Stage 5  CI/evidence/retry automation
        ↓ CTRL-008
Stage 6  Merge/reconciliation automation
        ↓ CTRL-009 + CTRL-010
Stage 7  End-to-end autonomous governed loop
```

The stage mapping is an operational interpretation of the roadmap, not permission to reorder Work Orders. The Controller may only claim a stage after the corresponding accepted work has been merged and the machine state has been reconciled.

## Sequencing rule

CTRL-001 and CTRL-002 are complete and reconciled: accepted and merged via PR #1 and PR #4 and recorded in machine state `completed`. The next planned items are CTRL-003 (GitHub adapter) and CTRL-004 (Z.ai adapter); they become eligible only once the Architect defines and freezes their work orders (`spec/work-items/CTRL-003.md`, `spec/work-items/CTRL-004.md`) and machine state marks the next item `READY`; until then no implementation item is eligible for dispatch. Later items remain planned until their predecessor is complete and machine state is reconciled. No worker may begin a planned item merely because its code appears useful.

## Human-operator progression

During Stage 0, the human operator performs the Controller's mechanical orchestration: routing Work Orders to Z.ai, bringing PR/CI state to the Architect, relaying durable review findings back to Z.ai, and performing currently-authorized merge/post-merge actions.

As each automation stage is reached, the Architect must explicitly report what manual duties have been removed. The operator must never be expected to infer an automation transition from implementation alone.

## Completion definition

The Controller roadmap is complete when the automated loop can safely take a repository-authorized READY work item from dispatch through Z.ai implementation, PR/CI, Architect review/change iteration, approval, merge, post-merge reconciliation and deterministic selection of the next eligible item, including restart recovery and a successful dogfood run.

## Explicit exclusions

- Do not import WorkflowOS's roadmap or implementation into this repository.
- Do not rebuild WorkflowOS's workflow engine or authoring system.
- Do not let controller runtime state supersede the controlled repository's state.
- Do not automate merge on insufficient evidence or unresolved architectural contradiction.
- Do not silently transfer human responsibilities between automation stages; stage transitions require accepted repository evidence.
