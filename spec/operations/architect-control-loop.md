# Architect Control Loop — Persistent Governance Operating Protocol

Status: `PROPOSED`

## Purpose

The Architect must operate as a persistent governed control loop rather than a manually stepped sequence. A worker return is an event that starts a complete governance cycle; the human operator must not be required to issue an additional `go`/`next` command between governance steps.

This protocol does not transfer semantic authority from the Architect or remove any fail-closed gate. It defines how the Architect/runtime should continue through already-authorized mechanical governance steps until it reaches a state requiring a new semantic Architect decision or a new implementation handoff.

## Trigger

A worker return is any repository-observable worker lifecycle signal or durable GitHub evidence showing that the active Work Item has advanced to the next governance boundary, including a new/updated implementation PR, CI/evidence completion, a review response, or a completed merge/reconciliation step.

The control loop must also be restart-safe: after restart it reconstructs its position from repository authority and GitHub evidence and continues from the first incomplete governed step.

## Continuous cycle

For the active Work Item, execute this cycle without waiting for a human prompt between steps:

```text
RECONSTRUCT AUTHORITY
        ↓
IDENTIFY ACTIVE GOVERNED WORK ITEM
        ↓
OBSERVE/RECONCILE WORKER + PR + CI/EVIDENCE STATE
        ↓
┌──────────────────────────────────────────────────────────────┐
│                    GOVERNANCE DECISION                       │
├──────────────────────────────┬───────────────────────────────┤
│ Semantic Architect review    │ Mechanical gate/operation     │
│ is required                  │ is already authorized        │
│                              │                               │
│ → review evidence            │ → continue automatically     │
│ → APPROVE / REQUEST_CHANGES  │   through all satisfied       │
│   / ESCALATE                 │   predicates                 │
└───────────────┬──────────────┴───────────────────────────────┘
                ↓
       REQUEST_CHANGES?
          /         \
        yes          no
         ↓            ↓
 build durable       APPROVE + all merge predicates?
 review packet          /                  \
         ↓             yes                 no
 submit same-PR         ↓                   ↓
 worker implementation  merge + reconcile   remain at current
 prompt/evidence to     + select next       observable gate
 repository             eligible item
         ↓                ↓
         └───────────────┘
                ↓
       dispatch next Work Order
                ↓
        return to OBSERVE
```

## Automatic continuation rules

1. **No manual stepping.** Once the control loop starts processing a worker return, it continues through every already-authorized governance action that is mechanically decidable.
2. **One Work Item at a time.** Never dispatch a second implementation item until the current item's merge/reconciliation is complete and repository authority selects the next eligible item.
3. **Same-worker change loop.** `REQUEST_CHANGES` is converted into the durable repository/GitHub review packet and the same worker/same PR resume handoff. Do not ask the human operator to relay the packet.
4. **Approval is not merge.** An observed Architect `APPROVE` immediately advances the loop to the complete merge predicate. The loop merges only when every frozen merge predicate is satisfied.
5. **Merge is followed immediately by reconciliation.** After an observed successful merge, perform the governed reconciliation and deterministically select the next eligible Work Item without requiring a second prompt.
6. **Next Work Item dispatch is automatic only after governance activation.** A planned item is not eligible merely because its predecessor completed. The loop may dispatch only an item that repository authority has explicitly defined, frozen, and marked `READY`.
7. **Repository is the durable checkpoint.** Every meaningful state boundary must be represented by existing repository machine state and/or GitHub evidence. No hidden controller memory may be required to know what step comes next.
8. **Fail closed.** Any contradiction, stale/foreign evidence, missing predicate, ambiguous review/PR/CI evidence, architecture contradiction, unsafe credential condition, or unsupported lifecycle transition stops the loop and produces a durable escalation/request-for-intervention record. It must not spin, guess, or silently retry across a governance boundary.
9. **Semantic decisions remain Architect-owned.** The loop may mechanically transport and execute a recorded Architect decision; it may never manufacture APPROVE, REQUEST_CHANGES, or ESCALATE.
10. **Human becomes exception handler.** The human is notified only when the loop reaches a genuine semantic/governance exception or when repository authority requires a new architecture/work-order decision. Routine `go`/`next` commands are not part of the steady-state protocol.

## Return conditions

The Architect/control process should return control to the human only at one of these durable boundaries:

- `REQUEST_CHANGES`: a worker-fix implementation prompt has been submitted through the governed repository/GitHub handoff and the active Work Item is waiting for the worker to act.
- `ESCALATED`: a contradiction, ambiguity, policy violation, or architecture issue requires human/Architect intervention beyond the frozen rules.
- `NEXT_READY`: the current item is fully reconciled and a newly defined/frozen Work Item is ready for implementation; the exact implementation handoff has been submitted through the repository.
- `BLOCKED`: required external evidence or capability is unavailable and cannot be safely resolved by existing policy.
- `COMPLETE`: there is no newly eligible Work Item under the current roadmap/authority.

A normal approval, merge, or reconciliation boundary is **not** a return condition by itself; the loop continues.

## Safety boundary

This protocol changes continuation behavior, not authority. Existing frozen Work Orders, lifecycle transitions, merge predicates, Architect review requirements, worker restrictions, repository source-of-truth rules, and fail-closed semantics remain authoritative.

The runtime implementation of this protocol must not introduce a controller-authoritative database, hidden queue, alternate lifecycle model, or autonomous semantic review policy.

## Bootstrap use

Until the Controller can execute this protocol itself, the Architect session may emulate the same loop when externally triggered by a worker return. The desired steady-state implementation is an event-driven controller runtime that observes GitHub/repository changes and invokes the same deterministic governance operations automatically.
