# Pectoraux Controller

The Controller is the orchestration runtime for governed software delivery across Pectoraux repositories.

It does **not** replace WorkflowOS, does not own product architecture, and does not become a second source of truth. The repository contains the controller's frozen architecture, implementation roadmap, machine state, work orders, and worker/reviewer contracts.

## Mission

Automate the mechanical loop:

`READY work item → dispatch Z.ai → implementation PR → CI → Architect review → change loop → approval → merge → post-merge reconciliation → next eligible work item`

The controlled repository remains authoritative for roadmap, work-item scope, acceptance criteria, and program state. GitHub is the execution/event surface. Z.ai is the implementation worker. The Architect is the semantic review gate.

## First implementation rule

The Controller itself is built using the same governed work-item process it will eventually automate. No implementation work should bypass the repository roadmap or work-order contract.

## Bootstrap rule

The Controller does not exist yet, so the human operator initially performs its mechanical orchestration role. Automation is introduced incrementally; the Architect must explicitly announce each automation stage and tell the operator which manual duties have been removed. See `spec/operations/controller-build-process.md` for the exact bootstrap loop and stage-by-stage responsibility transition.

See:

- `spec/architecture/controller-architecture.md`
- `spec/governance/worker-protocol.md`
- `spec/governance/review-protocol.md`
- `spec/operations/controller-build-process.md`
- `spec/roadmap/roadmap.md`
- `spec/work-items/CTRL-001.md`
- `spec/state/controller-program-state.json`

## Development

The controller package is pure Python standard library (Python >= 3.10, no runtime dependencies, no network access, no credentials). All commands run from the repository root.

Run the test suite:

```sh
python -m unittest discover -s tests -t .
```

Validate repository authority and reconstruct controller state (offline smoke test):

```sh
python -m controller validate --repo .
```

Reconstruct and inspect the governed work-item domain model (identity, lifecycle position, authority-derived dispatch eligibility):

```sh
python -m controller domain --repo .
```

### Domain model (CTRL-002)

`controller/domain.py` defines the typed domain model for the single active governed work item: `WorkItemIdentity` (repository-resolved identity), `AuthorityContext` (governing documents and automation stage), `DispatchEligibility` (authority-derived dispatch verdict with an auditable basis), `GovernedWorkItem` (the immutable aggregate), and `DomainCommand`/`DomainEvent` (the domain-level command/event contracts with deterministic `serialize()`/`deserialize()` for future GitHub and Z.ai adapters — no transport is implemented). The domain layer delegates all lifecycle semantics to the CTRL-001 frozen transition table and never redefines transition policy. Dispatch eligibility requires the active work item to be READY with machine state and its work order in agreement, and not already recorded in `completed`; anything else fails closed with typed errors. The model is a pure projection of repository authority: no database, cache, or runtime state.

### GitHub adapter (CTRL-003)

`controller/github.py` is the typed GitHub adapter boundary. `GithubAdapter` takes an injected `GithubTransport` (Protocol); `UrllibGithubTransport` is the only network component in the package and receives its token strictly as a constructor argument (never from repository files or defaults, never logged). Observations (branches, commits, PRs, reviews, comments, commit statuses) normalize into frozen typed values deterministically — lists sorted by stable IDs, timestamps preserved as ISO strings, reviews carry the exact reviewed commit (`commit_id`), malformed responses fail closed as `GithubMalformedResponseError`. Work-order correlation (`correlate_work_pull_request`) enforces the one-PR-per-work-item rule and exact base/head SHA identity (`GithubNotFoundError` / `GithubAmbiguityError` / `GithubStaleBaseError`). Mutations are policy-gated: `create_branch` requires an explicit authority-derived base SHA; `open_pull_request` refuses one-PR violations and base drift; `merge_pull_request` executes only after it **independently re-establishes the complete merge-policy proof** (FZ-CTRL003-004A, the Architect-accepted execution-time re-proof path). `authorize_merge` evaluates the frozen merge predicate — the intended base *ref and SHA*, exact head, clean mergeability, one-PR, terminal-success required checks, an Architect APPROVE **bound to the exact reviewed head SHA** (`commit_id` must match; an approval of an older commit does not survive a head change) with no later CHANGES_REQUESTED, and the CTRL-002 authority-derived `DispatchEligibility` identifying exactly the work item as the active eligible item — and returns a `MergeAuthorization`, which is a merge *request* (target identity), never evidence: `merge_pull_request(authorization, eligibility=…, architect_reviewer=…, required_checks=…)` re-evaluates that same predicate *in full* from live GitHub state plus fresh execution-time inputs immediately before the remote mutation, and requires the presented authorization to be field-identical to what the gate would issue right now (policy parameters are deliberately not carried in the authorization, so nothing in the presented object can weaken the re-proof). Possession of a fabricated, altered, or incomplete authorization therefore cannot bypass policy (`GithubAuthorizationForgedError` for structurally invalid or non-identical requests; the predicate's typed refusals otherwise — always with zero remote mutations): a caller with access to every public and module symbol can construct the value, but the merge only executes when the re-proven predicate — including the Architect APPROVE on the exact head — actually holds. The predicate lives in a single private method shared by both paths, so gate and execution can never drift apart. Authorizations are in-process values and are never serialized or reconstructed from external data. The adapter treats GitHub as evidence, never authority; all authority facts are caller inputs. The test suite exercises the adapter exclusively through deterministic fakes (`tests/github_fakes.py`) — no network or credentials are needed.

### Z.ai worker adapter (CTRL-004)

`controller/zai.py` is the typed Z.ai implementation-worker adapter boundary. `ZaiAdapter` takes an injected `ZaiTransport` (Protocol); `UrllibZaiTransport` is the only Z.ai-provider network component in the package and receives its API root and token strictly as constructor arguments (never from repository files or defaults, never logged). The adapter exposes exactly two operations — `start_worker(context)` and `resume_worker(context, session_id)` — and deliberately has **no merge, approval, completion, or architecture-mutation capability** (worker safety boundary, AC6). Every request is bound to the caller-supplied `ZaiWorkerContext`: the exact repository identity, Work Order path (and optional content), active work-item identity, base SHA (40-hex), and PR/head identity for a change iteration — validated in full *before any provider I/O*; a missing, contradictory, or stale identity fails closed (`ZaiContextMismatchError`). A fresh start carries no review packet; a resume propagates the caller's review findings **verbatim** in the instruction payload and must match the named session's reported work item, repository, base, and PR identity exactly — a mismatched session (a silent fork) or a different reported session id refuses the operation (`ZaiContextMismatchError` / `ZaiContradictionError`). Worker instructions are *constructed* by the adapter from typed repository-derived facts plus the frozen worker-role contract (may/may-not lists from the architecture's Z.ai boundary); there is no free-text instruction channel, so only controller-approved instructions can ever be sent, and a defense-in-depth payload policy fails closed on unknown fields or token-like material (`ZaiPolicyViolationError`). Provider responses normalize deterministically into frozen `ZaiWorkerSession` values (session id, bound work identity, PR context, status and ISO timestamp preserved verbatim); malformed responses fail closed (`ZaiMalformedResponseError`). The session identifier is an explicit, non-authoritative execution reference the controller may carry — the adapter keeps no registry, cache, or persistence, never reads repository files, and never treats provider state as authoritative over repository machine state (`ZaiAdapterError` family: configuration, auth, rate limit, transport, rejected request, malformed, missing session, context mismatch, contradiction, policy violation). The test suite exercises the adapter exclusively through deterministic fakes (`tests/zai_fakes.py`) — no network or credentials are needed.

### Orchestrator (CTRL-005)

`controller/orchestrator.py` is the deterministic orchestration boundary coordinating the accepted domain model, GitHub adapter, and Z.ai adapter for exactly one active governed Work Order. `Orchestrator(github=…, zai=…)` holds only the two injected adapters — no database, local session store, cache, or runtime state — so a restart reconstructs the same governed decision from the same repository authority, remote evidence, and caller-carried references: `run_cycle(repo_root, references)` is a pure deterministic function of its inputs (restart reconstruction, AC6). Every cycle begins from a full authority reconstruction (`reconstruct_domain`): missing, malformed, stale, or contradictory machine state, roadmap, or work-order authority fails closed with typed errors *before any remote action* (AC1). The cycle then performs exactly one governed step — one transition already authorized by the frozen table, derived from observed evidence, or one pure observation that issues no command (AC4); repeated observation of non-terminal evidence is idempotent. Correlation (AC2): the governed facts that live outside repository authority are supplied by the caller as `OrchestrationReferences` (governed branch, dispatch base SHA, the **typed `ZaiWorkerSession` request** naming the worker execution, architect reviewer identity) — non-authoritative carried inputs, cross-validated against authority and remote evidence, never guessed and never stored; a missing reference fails closed (`OrchestrationMissingReferenceError`), and a carried session whose binding (repository, active Work Item, dispatch base SHA) contradicts reconstructed authority fails closed with `OrchestrationContradictionError` *before any lifecycle event or remote call* — a bare session-id string is not an accepted carried form. The `DISPATCHED → IMPLEMENTING` transition additionally re-establishes **provenance** from live provider state (FZ-CTRL005-002): `start_worker` with the exact repository-derived context *identifies* the worker execution for that exact Work Order (an existing accepted CTRL-004 contract), and the provider-identified session must be the very session the caller carried — the fork guard mirrors the adapter's own resume fork refusal — so a session value constructed by hand, however structurally exact, cannot advance the lifecycle without the provider identifying it right now; no PR identity is invented while still DISPATCHED. GitHub PR correlation enforces the exact work-item/PR identity through the CTRL-003 adapter (branch + base SHA, one-PR rule); the Z.ai start context is constructed exclusively from repository authority (work order path/content, exact base SHA observed from the base branch) and the resume context preserves the same governed worker/PR identity across a change iteration, re-observing the review packet from GitHub on every cycle and propagating it verbatim (AC3). Contradictions fail closed (AC5): repository authority outranks remote observation — a lifecycle position that records a PR-open-or-later position with no governed PR observed, or a CHANGES_REQUESTED position whose latest architect-review evidence no longer matches, stops the run with `OrchestrationContradictionError`; there is no guessed recovery and no alternate-item dispatch. The downstream boundary (AC7) is explicit: merge, reconciliation, and advancement positions return a typed `DownstreamHandoff` naming the owning future stage (CTRL-006+); the orchestrator never merges, approves, reconciles, or advances, and its only remote mutations are `start_worker` / `resume_worker` — and only after the governed command validates. The test suite exercises the orchestrator exclusively through the deterministic GitHub/Z.ai fakes (`tests/test_orchestrator.py`) — no network or credentials are needed.

### Error semantics

Every failure raises a typed `ControllerError`: `SpecError` / `ContradictionError` / `InvalidTransitionError` / `DomainError` family (authority, lifecycle, domain), the `GithubAdapterError` family (transport, auth, rate limit, not found, malformed, ambiguity, stale base, contradiction, merge blocked, forged authorization), the `ZaiAdapterError` family (configuration, auth, rate limit, transport, rejected request, malformed response, missing session, context mismatch, contradiction, policy violation), and the `OrchestrationError` family (authority/remote contradiction, missing carried reference). All failures stop the operation; nothing is guessed, repaired silently, or retried implicitly.

Static/type checks (where configured, via `pyproject.toml`):

```sh
mypy
ruff check controller tests
ruff format --check controller tests
```

The test suite exercises: happy-path lifecycle transitions (deterministic), invalid transitions (fail closed), restart/state reconstruction from repository authority, contradictory authority rejection, domain construction/eligibility/serialization/idempotency, adapter correlation and policy gates (GitHub, Z.ai), full orchestration cycles for every lifecycle position (ready dispatch, PR correlation, CI observation, review mapping, worker resume, downstream handoff), repeated/idempotent observation, restart-decision reconstruction, stale/foreign correlation refusal, and a forbidden-surface guard (no network/subprocess/persistence imports in the controller package). No external service or credential is required to run any of the above.
