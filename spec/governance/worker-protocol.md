# Worker Protocol

## Dispatch

A worker receives only repository-resolved inputs: repository, work-item ID, exact base SHA, work-order path, acceptance criteria, forbidden surfaces, required checks, and the PR branch name.

## Worker duties

1. Read the work order and architecture.
2. Verify the base SHA and clean starting state.
3. Implement only the assigned item.
4. Run required checks and record evidence.
5. Open or update exactly one PR for the item.
6. If review requests changes, apply the findings and rerun checks.
7. Continue until the work-order predicates are satisfied or an explicit escalation condition occurs.

## Worker cannot

Merge, approve its own PR, rewrite frozen authority, suppress failing checks, alter acceptance criteria, or claim success without evidence.

## Review iteration input

The controller supplies an immutable review packet containing PR SHA, review iteration, finding IDs, severity, affected paths and required changes. The worker acknowledges the packet, implements the requested changes, and pushes a new commit to the same PR.

## Stop/escalate conditions

Escalate on architecture contradiction, roadmap/state contradiction, base drift requiring authority changes, repeated identical review failure, forbidden-surface conflict, missing required credentials, or an external failure that cannot be deterministically classified.
