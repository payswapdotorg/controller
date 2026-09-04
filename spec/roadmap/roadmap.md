# Controller Roadmap — Authoritative

This file is the human-readable implementation roadmap. Changes to sequencing, scope, dependencies or acceptance criteria require an explicit architecture/work-order change before implementation.

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

## Sequencing rule

CTRL-001 is the only currently eligible implementation item. Later items remain planned until their predecessor is complete and machine state is reconciled. No worker may begin a planned item merely because its code appears useful.

## Completion definition

The Controller roadmap is complete when the automated loop can safely take a repository-authorized READY work item from dispatch through Z.ai implementation, PR/CI, Architect review/change iteration, approval, merge, post-merge reconciliation and deterministic selection of the next eligible item, including restart recovery and a successful dogfood run.

## Explicit exclusions

- Do not import WorkflowOS's roadmap or implementation into this repository.
- Do not rebuild WorkflowOS's workflow engine or authoring system.
- Do not let controller runtime state supersede the controlled repository's state.
- Do not automate merge on insufficient evidence or unresolved architectural contradiction.
