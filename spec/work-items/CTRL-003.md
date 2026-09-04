# CTRL-003 — GitHub adapter

Status: `READY`

## Objective

Implement the Controller's repository-safe GitHub adapter boundary required by the frozen architecture. The adapter must observe and, only where explicitly authorized by the controller's existing policy boundary, represent GitHub branches, pull requests, commits, CI/check status, reviews, comments, and merge execution for the single active governed Work Order. CTRL-003 is the first external adapter and must preserve repository authority, deterministic reconstruction, fail-closed behavior, and the worker/Architect role boundaries.

## Authority

- `spec/architecture/controller-architecture.md`
- `spec/roadmap/roadmap.md`
- `spec/state/controller-program-state.json`
- `spec/operations/controller-build-process.md`
- `spec/governance/review-protocol.md`
- `spec/governance/worker-protocol.md`

## In scope

1. Define a typed GitHub adapter interface for the active governed work item.
2. Support read/observation operations needed to correlate repository-authorized work with GitHub branches, commits, PRs, reviews/comments, and CI/check evidence.
3. Define explicit typed results/errors for not-found, ambiguous, contradictory, stale-base, and remote-operation failures; fail closed rather than guessing.
4. Preserve exact base/head SHA identity and one-PR-per-Work-Order correlation requirements.
5. Provide deterministic normalization of GitHub responses into domain-consumable values without making GitHub the source of product/work-order authority.
6. Implement only the minimal remote mutations required by the frozen architecture and current build process; worker branches/PRs and governed merge operations must remain policy-gated and may not bypass the existing architecture boundaries.
7. Keep Z.ai dispatch/resume out of this Work Order; no Z.ai API/client implementation.
8. Add comprehensive tests using deterministic fakes/fixtures; no live credentials or network-dependent tests are required for acceptance.
9. Update operational documentation only where needed to document the adapter contract, error semantics, and test strategy.

## Explicit non-goals

- No Z.ai API/client/dispatch/resume implementation (CTRL-004).
- No Architect semantic-review implementation or autonomous approval policy (CTRL-007).
- No CI/evidence retry engine beyond exposing normalized observation data needed by later work.
- No autonomous end-to-end orchestration (CTRL-005+).
- No new authoritative database, queue, cache, or local persistence layer.
- No rewrite of the frozen architecture or roadmap sequencing.
- No bypass of the existing policy/safety gate, merge predicate, or workerCannotMerge rule.
- No credentials committed to the repository; tests must use fakes, fixtures, or environment-independent dependency injection.

## Acceptance criteria

### AC1 — Adapter boundary

A typed GitHub adapter contract exists with explicit request/response types and clear separation between observation, remote mutation, and controller policy decisions.

### AC2 — Deterministic observation

Branches, commits, PR metadata, reviews/comments, and CI/check evidence can be normalized into deterministic typed values. Equivalent GitHub observations produce equivalent normalized results.

### AC3 — Work-Order correlation

The adapter can correlate the active Work Order with its expected repository, branch/PR identity, and exact base/head SHAs. Ambiguous or conflicting matches fail closed.

### AC4 — Fail-closed remote errors

Authentication/configuration failures, missing resources, malformed responses, rate/transport errors, contradictory GitHub/repository state, and stale SHA conditions are surfaced as explicit typed adapter errors. No silent fallback, guessing, or fabricated evidence is permitted.

### AC5 — Repository authority boundary

The adapter never treats runtime cache, GitHub metadata, or local persistence as authoritative over repository roadmap/work-order/machine-state authority. Contradictions stop the operation.

### AC6 — Mutation policy boundary

Any supported GitHub mutation is explicitly policy-gated and cannot bypass the frozen merge predicate, workerCannotMerge rule, one-PR-per-work-item rule, or fail-closed contradiction behavior. The adapter is not itself the architecture authority.

### AC7 — Testability

All adapter behavior is covered by deterministic unit tests with no required live GitHub access or credentials. Error paths and contradiction/stale-SHA cases are covered, not only happy paths.

### AC8 — Scope and safety audit

No Z.ai integration, persistence, autonomous review, unauthorized merge path, credential material, architecture mutation, or downstream Work Order implementation is introduced. The adapter remains minimal and compatible with CTRL-002 domain contracts.

## Implementation constraints

- Build on merged CTRL-001 and CTRL-002 primitives; do not duplicate lifecycle/eligibility policy.
- Reuse existing typed domain/state abstractions rather than inventing a second lifecycle model.
- Prefer standard-library/minimal dependencies and dependency injection for the GitHub transport.
- Keep all remote calls behind the adapter boundary; domain code must remain transport-independent.
- Preserve the one-active-work-item constraint.
- Do not broaden Stage 1/Stage 2 responsibilities silently; this Work Order prepares GitHub observation and adapter capability, not the full orchestrator.

## Handoff

Worker must create one PR from current `main`, run the full validation suite, provide an implementation transcript with base/head SHAs and evidence for every acceptance criterion, and wait for Architect review. Worker may not merge.
