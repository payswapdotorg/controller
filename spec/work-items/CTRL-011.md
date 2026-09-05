# CTRL-011 — Production Controller Runtime

Status: `COMPLETE`

## Intent

Add the production runtime that turns the accepted Stage-7 orchestration boundaries into a continuously usable Controller process without introducing a second authority model.

## Scope

Implement a runnable Controller runtime and CLI entrypoint that:

- loads repository authority before every governed cycle;
- reconstructs the active Work Item and lifecycle state from repository/GitHub evidence;
- invokes the accepted orchestration, evidence, review, merge/reconciliation, and recovery boundaries without reimplementing their predicates;
- supports a deterministic one-cycle execution mode for inspection and safe manual invocation;
- supports a long-running mode driven by repository/GitHub change observation with bounded polling/backoff;
- carries non-authoritative execution references in memory only and reconstructs them after restart;
- obtains GitHub/Z.ai credentials only from externally supplied process configuration, never repository authority or committed files;
- exits or pauses fail-closed on contradiction, unavailable mandatory dependency, or ambiguous state;
- exposes clear structured operator output suitable for logs and service supervision;
- preserves the existing worker/Architect/merge safety boundaries.

The runtime may orchestrate existing adapters and boundaries, but it must not introduce a controller database, alternate roadmap, alternate lifecycle policy, autonomous architecture decisions, or a worker-side merge capability.

## Non-goals

- No web UI.
- No replacement for WorkflowOS or a product workflow engine.
- No new persistence layer for authoritative controller state.
- No automatic creation of successor Work Items.
- No relaxation of exact-head, CI/evidence, Architect-approval, or repository-authority merge predicates.
- No provider-specific instruction bypass around the Z.ai adapter.

## Acceptance criteria

1. `python -m controller --help` exposes the supported runtime commands.
2. A one-shot cycle command can be invoked against a controlled repository and always reconstructs repository authority before taking action.
3. The runtime can execute the accepted one-step orchestration path and route downstream outcomes to the owning boundary without duplicating policy.
4. A long-running mode repeatedly evaluates the controlled repository with bounded polling/backoff and does not busy-loop on unchanged non-terminal evidence.
5. Restarting the runtime reconstructs state from repository/GitHub evidence and does not require a local durable session database.
6. GitHub and Z.ai credentials are supplied externally and are never loaded from repository files or emitted in logs/instructions.
7. Contradictions, malformed authority, stale correlation, provider failures, and ambiguous state fail closed with observable non-zero/error outcomes.
8. The runtime preserves the one-Work-Item/one-PR rule and never grants the worker merge, approval, completion, or architecture-mutation authority.
9. Existing tests remain green; new runtime tests cover one-shot execution, unchanged-state polling, restart reconstruction, credential isolation, and fail-closed behavior.
10. Operator documentation explains exactly how to install, configure, run, supervise, and stop the Controller for a real governed repository.

## Evidence required

- exact implementation PR and head SHA;
- complete runtime test/validation output;
- CLI help/output examples;
- proof of credential isolation;
- proof that restart reconstructs from repository/GitHub evidence;
- proof that no existing frozen governance boundary was reimplemented or bypassed.

## Owned surface

Primarily `controller/runtime.py`, `controller/__main__.py` and runtime-specific tests/docs. Changes to frozen architecture, existing lifecycle policy, roadmap semantics, or earlier Work Item surfaces require explicit Architect review and are outside this Work Item's default authority.

## Acceptance / completion record

CTRL-011 implementation was delivered in PR #36 from the exact dispatched base `0c6727dc189fb0ae277416a676cf43a12062eeaa`. Architect review iteration 1 identified a recorder split-surface hazard; the worker corrected it in `6f5aa1b`, then delivered the exact reviewed head `6a7719498cb4fd508a05c34df83fca093133fba6` on the same governed PR. Architect approval was recorded on that exact head; PR #36 was merged as `31b4596ce233cd7a0e367de537e885ed4c9cbeef`.

The accepted implementation provides the runnable `cycle` one-shot and bounded `run` process, offline `status`, environment-only provider credentials, restart reconstruction without an authoritative local session store, guarded two-surface authority recording, structured operator output, bounded polling/backoff, and fail-closed behavior. The two explicitly flagged base-coherence corrections were accepted during Architect review: the Stage-7-derived expectation for `humanOperatorIsTemporaryMechanicalController`, with `REQUIRED_RULES` membership unchanged, and the frozen Work Order `Status:` grammar normalization.

Validation evidence accepted with the implementation: 651 tests + 209 subtests, `mypy --strict` clean in 38 files, Ruff clean, `controller validate`/`domain`/`status` clean, external-I/O guard 8/8, and `scripts/audit_ctrl_011.sh 0c6727dc189fb0ae277416a676cf43a12062eeaa` PASS (8/8). No worker merge/approval authority, no authoritative controller persistence, no roadmap/stage mutation, and no new lifecycle or governance predicate were introduced.

## Merge / reconciliation evidence

- Implementation PR: #36
- Exact reviewed implementation head: `6a7719498cb4fd508a05c34df83fca093133fba6`
- Implementation merge commit: `31b4596ce233cd7a0e367de537e885ed4c9cbeef`
- Review correction commit: `6f5aa1b` on the same PR
- Stage: `STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP`
- Current roadmap successor policy: no later Work Item is authorized by the current roadmap; future capability requires an explicit Architect-governed roadmap/architecture extension.
