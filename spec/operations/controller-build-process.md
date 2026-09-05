# Controller Build Process — Bootstrap Through Automation

This document is an authoritative operational guide for building the Controller itself. The repository is the only durable source of truth; conversation history is not an implementation dependency.

## Roles

| Role | During bootstrap | After automation |
|---|---|---|
| Human operator | Performs only duties not yet automated; acts as temporary mechanical controller | Product/operator authority and exception handler; no routine message routing |
| Architect | Owns architecture, roadmap, acceptance, semantic review and policy | Same semantic authority; intervenes when judgment/policy is required |
| Z.ai worker | Implements exactly one governed Work Item, tests, opens/updates one PR | Same implementation role, dispatched/resumed by Controller |
| Controller | Capabilities are progressively added by accepted Work Items | Reads repository authority, dispatches/resumes workers, observes GitHub/CI, carries review packets, enforces gates, merges when authorized, reconciles state |
| GitHub/CI | Execution and evidence surface | Same |
| Repository | Sole durable authority | Sole durable authority |

## Automation stages

### Stage 0 — Manual controller / bootstrap

Human performs the full mechanical loop: Architect defines Work Order → human gives it to Z.ai → worker implements/tests/opens PR → human brings state to Architect → Architect reviews → human relays changes if needed → authorized merge → post-merge verification.

### Stage 1 — State-machine automation

The Controller reconstructs repository authority and executes deterministic local lifecycle transitions, but does not yet operate GitHub or Z.ai itself.

### Stage 2 — GitHub observation automation

The Controller observes branches, PRs, commits, reviews and CI and correlates them to the active Work Item.

Human duty removed: routine PR/CI observation and transcription.

### Stage 3 — Z.ai dispatch/resume automation

The Controller constructs repository-derived worker context and starts/resumes Z.ai against the exact Work Item and PR.

Human duty removed: copying Work Orders/prompts and mechanically deciding same-worker/same-PR resumption.

### Stage 4 — Review/change-loop automation

The Controller carries durable Architect review packets and resumes the worker on `REQUEST_CHANGES` while keeping the same Work Item and PR.

Human duty removed: manually relaying review findings. Semantic Architect review remains an authority function.

### Stage 5 — CI/evidence/retry automation

The Controller watches required checks, classifies retryable failures where policy permits, and routes implementation retries.

Human duty removed: routine CI polling, evidence collection and mechanical retry routing.

### Stage 6 — Merge/reconciliation automation

Only after all merge predicates are satisfied may the Controller perform the authorized merge and reconcile repository machine state.

Human duty removed: mechanical merge clicking and routine post-merge bookkeeping.

Human retains: product/architecture authority, policy changes, contradiction handling and exceptional intervention.

### Stage 7 — End-to-end autonomous governed loop

The Controller safely carries a repository-authorized READY Work Item through dispatch, implementation, PR/CI, Architect review/change iteration, approval, merge, post-merge reconciliation and selection of the next eligible Work Item, including restart recovery and deterministic resumption.

The accepted CTRL-010 dogfood record demonstrates this composed capability, including deliberate lost-state-write recovery, zero second merge mutation, deterministic reconciliation and fail-closed contradiction probes.

Stage 7 is the active governance stage. CTRL-011 is the production-runtime implementation layer that packages these accepted capabilities into a continuously usable process without redefining governance semantics.

## Normative transition report

At every accepted stage transition the Architect must report:

```text
Stage N active.
You still perform: <manual duties>.
You no longer need to perform: <automated duties>.
The next automation milestone is: <CTRL item or explicit stage-transition condition>.
```

Do not silently move between stages.

## Governed construction loop

The semantic governance order remains:

```text
1. Architect reads repository authority.
2. Identify the exact next eligible Work Item, if one exists.
3. Establish exact base SHA and worker context.
4. Worker implements only the owned surface and opens/updates one PR.
5. Observe PR, CI and evidence.
6. Architect reviews against architecture, roadmap, Work Item and evidence.
7. REQUEST_CHANGES => durable findings and same-worker/same-PR continuation.
8. APPROVE => evaluate the merge predicate independently.
9. Merge only against the exact expected head and only when every predicate is satisfied.
10. Reconcile repository machine state from observed GitHub/repository evidence.
11. Select the next eligible Work Item, if one exists.
```

Approval is not merge authorization by itself. A Work Item is not complete merely because a PR exists.

## Merge/reconciliation safety

The merge predicate requires, at minimum: intended base, exact Work Item identity, one governed PR, exact current head, terminal-success required CI/evidence, no unresolved blocking review/change, Architect approval for that exact head, and active machine state still eligible for merge.

Merge must use the exact expected head and execute at most one mutation attempt. Head drift or any contradiction fails closed. Only observed successful GitHub merge evidence establishes `MERGED`. Reconciliation follows immediately and must be idempotent.

Runtime state must be reconstructible from repository/GitHub evidence. No hidden controller database may become the authoritative source of truth.

## Current operating position

CTRL-001 through CTRL-010 are accepted, merged and reconciled. CTRL-011 — Production Controller Runtime is now the sole active READY Work Item under Stage 7.

Stage 7 active.
You still perform: product/architecture authority; policy definition/change; semantic Architect review where required; contradiction, safety and exception handling; and any future roadmap extension.
You no longer need to perform: routine mechanical orchestration, mechanical merge clicking or routine post-merge bookkeeping for governed Work Items covered by the accepted Controller capabilities.
The next automation milestone is: **CTRL-011 — Production Controller Runtime**. Its purpose is to provide the directly runnable one-shot and bounded long-running process around the already-accepted governance boundaries.
