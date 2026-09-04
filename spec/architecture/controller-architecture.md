# Controller Architecture — Frozen v0.1

## Purpose

The Controller automates governed software-delivery execution. It is an orchestration/control-plane product, not a replacement for the controlled product's architecture and not a workflow-authoring engine.

## Authority hierarchy

1. Controlled repository roadmap and work orders — product intent and scope.
2. Controlled repository machine state — eligibility and lifecycle state.
3. GitHub — PR, CI, review and merge execution evidence.
4. Controller runtime state — disposable projection/cache only; it must be reconstructible.

No controller database may become authoritative over the repository.

## Components

- **Roadmap/eligibility reader:** parses frozen roadmap, work orders, dependencies and machine state.
- **Orchestrator:** deterministic state machine for one active work item at a time unless the roadmap explicitly permits safe parallelism.
- **Z.ai adapter:** starts/resumes an implementation worker with a precise work-order contract and review findings.
- **GitHub adapter:** branches, PRs, CI status, reviews, comments and merge operations.
- **Architect reviewer:** semantic review service. It may recommend APPROVE or REQUEST_CHANGES; merge authority is a separate policy gate.
- **Reconciliation engine:** after merge, verifies the merged SHA, updates repository machine state through an explicit governed commit, and recomputes eligibility.
- **Policy/safety gate:** fail-closed checks for roadmap drift, base SHA drift, forbidden surfaces, repeated failures, conflicting state, and unsafe automation.

## State machine

`READY → DISPATCHED → IMPLEMENTING → PR_OPEN → CI_PENDING → REVIEW_PENDING → CHANGES_REQUESTED → IMPLEMENTING → REVIEW_PENDING → APPROVED → MERGING → MERGED → RECONCILING → COMPLETE → NEXT_READY`

Terminal exception states: `BLOCKED`, `ESCALATED`, `CANCELLED`.

## Z.ai boundary

Z.ai may inspect the repository, modify its assigned work-item surface, run tests, push its branch, open/update its PR and respond to review findings. It may not merge, rewrite the frozen roadmap, change architectural authority, fabricate evidence, or self-authorize completion.

## Architect boundary

The Architect reviews semantic correctness against the frozen architecture and work order. A review must identify the exact acceptance criteria assessed and any required changes. APPROVE is only valid when CI/evidence and scope predicates are satisfied.

## Merge predicate

Merge is permitted only when: the PR targets the intended base; work-item scope is clean; required CI is terminal-success; no unresolved blocking review finding remains; the Architect decision is APPROVE; and repository machine state still identifies the work item as the active eligible item.

## Recovery

Every controller operation is idempotent. On restart, reconstruct from repository files and GitHub. Never infer progress from an absent local process. If repository state contradicts GitHub state, stop and escalate rather than guessing.

## Non-goals

The Controller does not reimplement WorkflowOS, product workflow engines, product business logic, or agent authoring. It only discovers/installs capability bindings and starts/observes existing workflow capabilities where a controlled repository explicitly requires that integration.
