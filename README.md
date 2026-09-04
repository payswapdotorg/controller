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

`controller/github.py` is the typed GitHub adapter boundary. `GithubAdapter` takes an injected `GithubTransport` (Protocol); `UrllibGithubTransport` is the only network component in the package and receives its token strictly as a constructor argument (never from repository files or defaults, never logged). Observations (branches, commits, PRs, reviews, comments, commit statuses) normalize into frozen typed values deterministically — lists sorted by stable IDs, timestamps preserved as ISO strings, reviews carry the exact reviewed commit (`commit_id`), malformed responses fail closed as `GithubMalformedResponseError`. Work-order correlation (`correlate_work_pull_request`) enforces the one-PR-per-work-item rule and exact base/head SHA identity (`GithubNotFoundError` / `GithubAmbiguityError` / `GithubStaleBaseError`). Mutations are policy-gated: `create_branch` requires an explicit authority-derived base SHA; `open_pull_request` refuses one-PR violations and base drift; `merge_pull_request` executes only with a `MergeAuthorization` issued by `authorize_merge`, which evaluates the frozen merge predicate — the intended base *ref and SHA*, exact head, clean mergeability, one-PR, terminal-success required checks, an Architect APPROVE **bound to the exact reviewed head SHA** (`commit_id` must match; an approval of an older commit does not survive a head change) with no later CHANGES_REQUESTED, and the CTRL-002 authority-derived `DispatchEligibility` identifying exactly the work item as the active eligible item — and is re-verified (base ref, base SHA, head, PR state) at execution time. That "issued by `authorize_merge`" rule is enforced, not documentary (FZ-CTRL003-004): `MergeAuthorization` is an opaque capability carrying a module-private issuance proof that duplicates the issued field values — ordinary caller-created data cannot construct or alter a valid authorization (`GithubAuthorizationForgedError`, fail-closed before any remote call, re-verified as the first step of `merge_pull_request`). Authorizations are in-process values and are never serialized or reconstructed from external data. The adapter treats GitHub as evidence, never authority; all authority facts are caller inputs. The test suite exercises the adapter exclusively through deterministic fakes (`tests/github_fakes.py`) — no network or credentials are needed.

### Error semantics

Every failure raises a typed `ControllerError`: `SpecError` / `ContradictionError` / `InvalidTransitionError` / `DomainError` family (authority, lifecycle, domain), and the `GithubAdapterError` family (transport, auth, rate limit, not found, malformed, ambiguity, stale base, contradiction, merge blocked, forged authorization). All failures stop the operation; nothing is guessed, repaired silently, or retried implicitly.

Static/type checks (where configured, via `pyproject.toml`):

```sh
mypy
ruff check controller tests
ruff format --check controller tests
```

The test suite exercises: happy-path lifecycle transitions (deterministic), invalid transitions (fail closed), restart/state reconstruction from repository authority, contradictory authority rejection, domain construction/eligibility/serialization/idempotency, and a forbidden-surface guard (no network/subprocess/persistence imports in the controller package). No external service or credential is required to run any of the above.
