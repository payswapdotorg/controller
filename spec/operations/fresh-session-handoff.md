# Fresh-Session Handoff — Pectoraux Controller

This document is authoritative only as a navigation/continuation aid. Repository roadmap, work orders, architecture and machine state remain the governing sources. A fresh Architect or implementation worker must be able to continue without conversation history.

## Current position

Repository: `pectoraux/controller`

Automation stage: `STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP`

Completed and reconciled: `CTRL-001` through `CTRL-012`.

Current active Work Item: `CTRL-013 — GitHub Browser-App Integration`.

Current Work Item status: `READY`.

Only CTRL-013 is executable. CTRL-014 through CTRL-020 are planned sequencing only; they require explicit activation after the preceding Work Item is complete and reconciled.

## Product decision

The MVP is a Chromium browser extension, not a VS Code extension, local daemon, desktop application, or standalone web app. The MVP does not require a local checkout of the controlled product repository. GitHub is the controlled-repository execution/evidence surface.

The browser extension exists because provider operations must occur through already-authenticated provider web UIs. Human authentication is performed directly at the provider site. The extension is responsible for operating supported provider pages after authentication; the Controller core remains the governance engine.

## Provider MVP

Worker: `Z.ai` at `https://chat.z.ai`.

Architect: `ChatGPT` at `https://chatgpt.com`.

### Z.ai operational behavior already decided by the Architect

For a new worker conversation:

1. open/focus `chat.z.ai`;
2. ensure authenticated state;
3. select `Agent`;
4. select `GLM-5.3` / model `5.3`;
5. enter the exact Controller-generated governed prompt;
6. send;
7. verify the prompt actually submitted.

Z.ai prompt submission is known to require repeated attempts. A failed submission may show the known blocking popup. When that expected popup is present, press `Enter`, then repeat from the beginning: re-select `Agent`, re-select `GLM-5.3`, re-enter the exact prompt, send and verify. Retries are bounded. An unexpected popup, authentication interruption or ambiguous UI state is fail-closed.

For a hung worker:

1. detect the configured no-progress/hung condition;
2. press `Stop`;
3. verify generation stopped;
4. send the fixed recovery message `continue`;
5. verify the message was accepted.

Do not invent alternate recovery prose. Recovery is bounded and preserves worker/work-item/session identity.

### ChatGPT operational behavior

Human authentication is out of band. The Architect adapter will later deliver the Controller-generated review packet into the selected ChatGPT conversation and normalize explicit `APPROVE` / `REQUEST_CHANGES` decisions. Exact UI selectors and observation strategy are intentionally deferred to CTRL-015 and must be based on the live supported UI rather than guessed selectors.

## CTRL-013 handoff

CTRL-013 owns the GitHub browser-app integration foundation for the extension. It must provide supported GitHub authorization, accessible repository discovery/selection, canonical `owner/name` identity, observation of the GitHub evidence required by the existing Controller boundaries, and only the existing Controller-authorized mutation surface. It must not duplicate lifecycle/merge/review predicates, introduce PAT entry, store raw credentials, use GitHub page-click automation for API-available operations, or activate provider-specific Worker/Architect UI automation.

The concrete MVP repository is `pectoraux/smallapp`. The extension must support selecting it, but repository authority is always read from the controlled repository itself.

## Governance invariants

- Controlled repository remains the durable source of truth.
- Machine state is reconstructible; no authoritative Controller database.
- One governed PR per Work Item.
- Worker cannot merge, approve, redefine architecture, or self-authorize completion.
- Architect semantic approval is separate from merge authorization.
- Merge uses the exact reviewed head plus fresh execution-time predicate re-proof.
- Contradictions and unknown provider states fail closed.
- Extension-local state, provider UI state, and browser session references are non-authoritative.
- Provider passwords and raw authentication secrets are never collected or stored by the extension.
- Do not bypass CAPTCHAs, anti-bot controls, rate limits, provider security mechanisms or undocumented private APIs.

## How to continue a fresh implementation session

1. Read `spec/state/controller-program-state.json`.
2. Read `spec/roadmap/roadmap.md`.
3. Read `spec/architecture/controller-architecture.md`.
4. Read `spec/operations/controller-build-process.md`.
5. Read the active Work Order under `spec/work-items/`.
6. Confirm the active Work Item status and exact repository `main` SHA.
7. Implement only the owned Work Item surface and open/update one PR.
8. Never rely on conversation history for scope, state, or authorization.

## Current next action

Dispatch `CTRL-013` from the exact current `main` SHA after its governance activation is merged. The worker owns only the GitHub Browser-App Integration scope defined in `spec/work-items/CTRL-013.md`. Do not pre-implement CTRL-014 through CTRL-020.
