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

Static/type checks (where configured, via `pyproject.toml`):

```sh
mypy
ruff check controller tests
ruff format --check controller tests
```

The test suite exercises: happy-path lifecycle transitions (deterministic), invalid transitions (fail closed), restart/state reconstruction from repository authority, contradictory authority rejection, domain construction/eligibility/serialization/idempotency, and a forbidden-surface guard (no network/subprocess/persistence imports in the controller package). No external service or credential is required to run any of the above.
