# Pectoraux Controller — Agent Continuation Contract

This repository is the durable source of truth. Do not rely on conversation history, prior prompts, or unstated assumptions.

## First read order

Before implementing anything, read:

1. `spec/state/controller-program-state.json`
2. `spec/roadmap/roadmap.md`
3. `spec/architecture/controller-architecture.md`
4. `spec/operations/controller-build-process.md`
5. the Work Order named by `activeWorkItem`
6. `spec/operations/fresh-session-handoff.md`

Then inspect the live GitHub `main` SHA and any existing PRs/branches relevant to the active Work Item.

## Current authorization

The current active Work Item is `CTRL-013 — GitHub Browser-App Integration` and its repository status is `READY`.

Only the active Work Item is executable. Do not implement CTRL-014 or later until the repository explicitly activates them by updating authoritative machine state and the corresponding Work Order.

## Controller governance

- One Work Item corresponds to one governed PR.
- The worker does not merge or approve its own PR.
- The worker does not rewrite roadmap/architecture authority or self-authorize completion.
- Repository authority outranks browser/provider state and runtime state.
- Contradictions, unknown provider states and stale correlations fail closed.
- Merge requires the full existing merge predicate and exact-head re-proof.
- No authoritative Controller database may be introduced.

## MVP product direction

The Controller MVP is a Chromium browser extension. It does not require a local product checkout, VS Code extension, desktop daemon, or hosted web app.

GitHub is used as the controlled-repository execution/evidence surface through supported APIs.

Provider websites are operated through provider-specific browser adapters after the human authenticates directly with the provider.

MVP Worker: Z.ai at `https://chat.z.ai`.

MVP Architect: ChatGPT at `https://chatgpt.com`.

### Z.ai behavior that must survive into implementation

New session:

`open/focus → authenticated → Agent tab → GLM-5.3/model 5.3 → exact governed prompt → Send → verify acceptance`.

Known failed submission recovery:

`detect expected popup → press Enter → repeat Agent → model 5.3 → re-enter exact prompt → Send → verify`, with bounded retries.

Hung worker recovery:

`detect hang → Stop → verify stopped → send fixed message "continue" → verify acceptance`, with bounded attempts.

Unexpected popup, authentication interruption, ambiguous state, exhausted retry budget or identity contradiction must fail closed.

Provider-specific DOM/selectors belong inside provider adapters, not the Controller core.

## CTRL-013 handoff

CTRL-013 owns the GitHub Browser-App Integration foundation. Use supported GitHub authorization/application mechanisms without requiring a PAT in the extension UI. Support accessible repository discovery/selection, canonical `owner/name` identity, observation of the GitHub evidence required by existing Controller boundaries, and only existing Controller-authorized mutation operations. Do not duplicate lifecycle/merge/review predicates or perform GitHub page-click automation where supported APIs are available. The concrete MVP target repository is `pectoraux/smallapp`.

## Fresh-session expectation

A fresh implementation session must be able to determine all scope, authority, dependencies, current state, provider behavior and next action from repository files plus live GitHub evidence. Conversation context is not an input.
