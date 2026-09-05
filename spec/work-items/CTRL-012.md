# CTRL-012 — Browser Control Surface Foundation

Status: `READY`

## Authorization

CTRL-012 is the sole currently executable Work Item. It follows the reviewed, merged and reconciled CTRL-011 Production Controller Runtime. The authoritative roadmap and machine state are the source of truth for activation and sequencing.

Automation stage: `STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP`.

Target product direction: Pectoraux Browser Controller MVP. The MVP uses GitHub as the controlled-repository execution surface and a browser extension as the operator/execution surface for provider websites. No local product checkout, VS Code extension, desktop daemon, or hosted web application is in scope for CTRL-012.

## Objective

Create the browser-extension foundation that can host the Controller as an operator/client surface and prepare the explicit provider-adapter boundary used by later Work Items. The extension must be able to register Workers and Architects, connect/select a controlled GitHub repository through repository-backed configuration, query authoritative Controller state, and present the active Work Item/lifecycle state.

CTRL-012 must establish the browser/provider abstraction without implementing Z.ai- or ChatGPT-specific UI selectors or recovery logic. Those are owned by CTRL-014 and CTRL-015.

## Scope

- browser extension package/shell for a supported Chromium-based browser;
- extension manifest, build/load instructions, and minimal operator UI;
- Controller-to-extension message/API boundary with typed request/response forms;
- non-authoritative local registration for Workers and Architects (name, provider kind, supported URL, display metadata);
- browser tab discovery primitives sufficient for later provider adapters;
- selected GitHub repository configuration and repository identity display;
- invocation of existing Controller authority/status surfaces without duplicating governance predicates;
- display of active Work Item, lifecycle position, automation stage, and governance/error holds;
- tests for extension message validation, provider registration validation, malformed input rejection, and authority/state presentation;
- documentation that a fresh developer can load the extension unpacked and connect it to the existing Controller runtime.

## Required behavior

### Worker registration

The extension must support adding a Worker with at least:

- human-readable name;
- provider kind;
- provider URL.

For the MVP, the first Worker is `Z.ai` at `https://chat.z.ai`.

The extension may open the provider URL for human authentication. Authentication happens directly in the provider UI; the extension must never request or store provider passwords.

### Architect registration

The extension must support adding an Architect with the same minimum fields. The MVP Architect is `ChatGPT` at `https://chatgpt.com`.

The extension may open the provider URL for human authentication. It must not treat opening the URL as proof of an Architect decision or as a programmatic provider session.

### GitHub repository

The extension must represent a controlled repository by its canonical `owner/name` identity and local display metadata. Repository authority continues to come from the controlled repository itself. Extension configuration is never authoritative over roadmap, work-order, machine-state, lifecycle, or merge policy.

### State display

For a selected repository, the extension must be able to present the repository-derived active Work Item and lifecycle state. A missing, malformed, stale or contradictory authority result is an explicit fail-closed UI state, not an inferred fallback.

## Forbidden

- provider-specific Z.ai selectors, model-selection automation, prompt submission automation, popup recovery, or hang recovery — these belong to CTRL-014;
- ChatGPT UI automation or Architect decision extraction — CTRL-015;
- GitHub page-click automation when supported GitHub APIs can be used;
- local product-repository checkout or local filesystem authority;
- storing provider passwords, raw session cookies, API tokens, or credentials in extension-managed product state;
- changing lifecycle/merge/review/evidence predicates;
- automatic merge, approval, completion, or roadmap advancement;
- making extension-local state authoritative;
- bypassing provider authentication, CAPTCHAs, anti-bot controls, rate limits, or other protective mechanisms;
- undocumented private provider APIs.

## Acceptance criteria

1. A supported Chromium-based browser can load the extension unpacked from the repository using documented steps.
2. The extension provides a minimal operator surface showing configured Worker(s), Architect(s), selected repository, active Work Item and lifecycle state.
3. Worker and Architect registrations validate strictly and persist only as non-authoritative extension configuration.
4. Provider URLs can be opened for human authentication without requesting provider credentials through the extension.
5. Repository identity is represented as canonical `owner/name`; invalid or ambiguous repository identity fails closed.
6. Repository state is obtained through the existing Controller authority/runtime boundary; the extension does not reimplement lifecycle or merge policy.
7. Malformed/unknown extension messages fail closed and cannot mutate authoritative repository state.
8. Unit/automated tests cover the extension's typed message/configuration boundary and fail-closed cases.
9. Documentation is sufficient for a fresh session to build, load, inspect and understand the extension without this conversation.

## Required evidence

- exact test command and passing output;
- extension manifest/build/load evidence;
- scope audit showing no provider-specific implementation beyond generic browser primitives;
- concise implementation transcript in the PR;
- PR body identifies the exact Work Item `CTRL-012`, base SHA, changed surface and evidence.

## Handoff

Implementation starts from the exact `main` SHA observed when this Work Item is dispatched. The worker must create exactly one governed PR for CTRL-012 and must not merge or approve it. Later Work Items remain inactive until CTRL-012 is complete/reconciled and explicitly activated.

The fresh-session source of truth is:

1. `spec/state/controller-program-state.json`
2. `spec/roadmap/roadmap.md`
3. `spec/architecture/controller-architecture.md`
4. `spec/operations/controller-build-process.md`
5. this Work Order
6. `spec/operations/fresh-session-handoff.md`

No conversation transcript is required to understand or implement this Work Item.
