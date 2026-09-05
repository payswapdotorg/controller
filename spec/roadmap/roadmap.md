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
                  |
                  v
           CTRL-011 Production Controller Runtime
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
        ↓ CTRL-011 Production Controller Runtime
```

Stage 7 is the accepted governance capability boundary. CTRL-011 is the production-runtime packaging/integration work that made the accepted Stage-7 boundaries directly runnable as an operator/service process; it does not redefine the Stage-7 governance semantics.

## Sequencing rule

CTRL-001 through CTRL-011 are complete and reconciled. CTRL-011 was the sole authorized successor after CTRL-010 and is now complete. No later Work Item is authorized by this roadmap.

## Human-operator progression

The human remains product/architecture authority and exception handler. The routine mechanical orchestration role is transferred to the Controller, but policy changes, semantic Architect review where required, contradiction handling, and safety intervention remain human responsibilities.

## Completion definition

The Controller roadmap's Stage-7 governance definition is satisfied by the accepted CTRL-009 recovery/idempotency and CTRL-010 end-to-end dogfood evidence. CTRL-011 completes the production-runtime surface needed to operate those accepted capabilities as a continuously usable Controller process; that implementation has now been reviewed, merged and reconciled.

## Explicit exclusions

- Do not import WorkflowOS's roadmap or implementation into this repository.
- Do not rebuild WorkflowOS's workflow engine or authoring system.
- Do not let controller runtime state supersede the controlled repository's state.
- Do not automate merge on insufficient evidence or unresolved architectural contradiction.
- Do not silently change lifecycle, merge, review, or evidence predicates while implementing CTRL-011.
- Do not introduce authoritative controller persistence.
- No later Work Item is implied by CTRL-011 completion; future capability requires an explicit roadmap/architecture extension.
