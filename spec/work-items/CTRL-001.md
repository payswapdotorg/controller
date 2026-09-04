# CTRL-001 — Foundation & Repository Authority

Status: `COMPLETE`

Completed via PR #1 (merge commit `0f8e3a749d4dde587c4c81c8b4d250ae2205ff37`); machine state reconciled per `spec/operations/controller-build-process.md` (exact construction loop, step 12).

## Objective
Create the minimal executable/controller-repository foundation without implementing downstream integrations.

## Scope
- establish package/runtime layout;
- load and validate controller repository specification/state;
- define typed lifecycle states and fail-closed transitions;
- define a deterministic command/event boundary suitable for later GitHub and Z.ai adapters;
- add unit tests for state transitions and invalid transitions;
- document local development and test commands.

## Forbidden
- GitHub mutations;
- Z.ai integration;
- automatic merging;
- product-repository changes;
- WorkflowOS reimplementation;
- roadmap or architecture mutation;
- external service credentials or secrets.

## Acceptance criteria
1. Repository has a runnable controller package and documented test command.
2. Controller state can be reconstructed from repository authority without a persistent controller database.
3. Valid lifecycle transitions are deterministic; invalid transitions fail closed.
4. Tests cover happy path, invalid transition, restart/reconstruction and contradictory state.
5. No external integration is required to run the test suite.
6. Changes remain within CTRL-001's declared surface.

## Required evidence
- static/type/lint checks where configured;
- deterministic unit-test output;
- forbidden-surface audit;
- concise implementation transcript in the PR.

## Handoff
Implementation starts from the exact main SHA from which CTRL-001 is activated. The worker must open one PR and must not merge it. Architect review and merge are external gates.
