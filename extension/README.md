# Pectoraux Controller — Browser Operator Surface (CTRL-012)

This directory is the Browser Control Surface Foundation: a Chromium
browser extension that acts as the Controller's **operator/client
surface**. It registers Workers and Architects, selects the controlled
GitHub repository, and presents the repository-derived Controller
authority state.

The extension is **non-authoritative by construction**. Repository
authority always wins: roadmap, work orders, machine state, lifecycle,
review, and merge policy live in the controlled repository and the
Controller core (`controller/`), never in extension state. The
extension holds no repository-mutation capability at all — its GitHub
client is GET-only.

## What it does

- **Worker/Architect registration** (non-authoritative local
  configuration): name + provider kind + provider URL. The MVP Worker
  is Z.ai (`https://chat.z.ai`); the MVP Architect is ChatGPT
  (`https://chatgpt.com`). Registration validates strictly against the
  closed provider registry (exact https origin, role capability,
  closed field set — a `password`/`token`/`cookie` field is a
  malformed form, refused before persistence).
- **Provider tabs**: open a provider URL in a new tab for **human**
  authentication (the extension never requests or stores provider
  credentials), and discover whether provider tabs are already open
  (URL-origin matching only — no DOM access, no content scripts; the
  Z.ai/ChatGPT adapters arrive with CTRL-014/CTRL-015).
- **Repository selection**: canonical `owner/name` identity, strictly
  validated (ambiguous forms fail closed).
- **Controller state display**: reads the two repository authority
  surfaces — `spec/state/controller-program-state.json` and the active
  work order's `Status:` line — through supported GitHub REST/content
  endpoints (never page-clicking), **pinned to one observed commit
  SHA** so the two surfaces can never come from different commits. A
  missing, malformed, stale, or contradictory authority result is an
  explicit fail-closed UI state, never an inferred fallback.

## Prerequisites

- A Chromium-based browser (Chrome/Chromium/Edge/Brave — any browser
  supporting Manifest V3).
- Node.js >= 18 **only if you want to run the tests** (the extension
  itself has no build step and no runtime dependency).

## Load the extension (unpacked)

No build step — load the sources directly:

1. Open `chrome://extensions` (or your browser's equivalent).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select this `extension/` directory (the one containing
   `manifest.json`).
5. The **Pectoraux Controller** action icon appears in the toolbar —
   open the popup from it.

To reload after source changes, use the reload icon on the extension's
card in `chrome://extensions`.

## Connect to the Controller runtime

1. Open the popup and scroll to **Controlled repository**.
2. Enter the repository identity — for this repository:
   `pectoraux/controller` — and press **Select**. The canonical
   identity is displayed.
3. Press **Refresh state** under **Controller state**. The popup shows
   the repository-derived projection: repository, active work item,
   lifecycle status, automation stage, completed ledger, next action,
   and the exact `ref@sha` the projection was observed at.

The extension talks to GitHub exactly the way the Controller's
repository authority defines it: `GET /repos/{owner}/{name}` (default
branch), `GET /repos/{owner}/{name}/commits/{branch}` (HEAD SHA), then
the machine-state JSON and the work-order markdown fetched from
`raw.githubusercontent.com` **at that SHA**. For CTRL-012 these reads
are unauthenticated public-repository reads (the controlled repository
is public); GitHub App authentication for private repositories and for
mutation surfaces arrives with CTRL-013 — the extension never accepts
or stores a token.

To also connect the governed runtime itself (dispatch, cycles,
recording), run the Python CLI against a checkout — see the root
`README.md`, "Operating the Controller". The extension and the runtime
read the same repository authority; the extension never substitutes
for it.

## Register the MVP providers

- **Worker**: Name `Z.ai`, Provider `Z.ai`, URL `https://chat.z.ai`.
- **Architect**: Name `ChatGPT`, Provider `ChatGPT`, URL
  `https://chatgpt.com`.

Press **Open** to open the provider site for human authentication
(authenticate in the provider's own UI; the extension neither needs
nor accepts your credentials). Press **Tabs** to see whether provider
tabs are already open (display-only observation).

## The typed message boundary

Every extension surface speaks through one closed vocabulary
(`src/messages.js`); responses are `{ ok: true, ... }` or
`{ ok: false, error: { code, message } }` with a code from the frozen
set (`src/errors.js`). Malformed/unknown requests are refused and
mutate nothing.

| Request | Fields | Response payload |
|---|---|---|
| `GetConfiguration` | — | `configuration` (workers, architects, repository) |
| `RegisterWorker` | `name`, `providerKind`, `providerUrl` | `configuration` |
| `RegisterArchitect` | `name`, `providerKind`, `providerUrl` | `configuration` |
| `SelectRepository` | `repository` | `configuration` |
| `GetAuthorityState` | — | `state` (active work item, lifecycle, stage, completed, next action, provenance) |
| `OpenProviderTab` | `role`, `name` | `opened` (tabId, url) |
| `DiscoverProviderTabs` | `role`, `name` | `tabs` (id, url, title) |

Error codes: `UNKNOWN_MESSAGE`, `MALFORMED_MESSAGE`,
`INVALID_REGISTRATION`, `INVALID_REPOSITORY`, `REGISTRATION_NOT_FOUND`,
`REPOSITORY_NOT_SELECTED`, `CONFIGURATION_CORRUPT`,
`AUTHORITY_UNAVAILABLE`, `AUTHORITY_MISSING`, `AUTHORITY_MALFORMED`,
`AUTHORITY_CONTRADICTORY`, `TABS_UNAVAILABLE`, `INTERNAL_ERROR`.

## Source layout

```
extension/
  manifest.json          MV3 manifest: storage + tabs permissions,
                         exactly two GitHub host permissions
  package.json           ES-module declaration for the Node test runner
                         (no build step, no dependencies)
  src/
    errors.js            the frozen error-code set
    forms.js             strict closed-object validation primitives
    providers.js         the closed provider registry (zai, chatgpt)
    registration.js      Worker/Architect registration validation
    repository.js        canonical owner/name identity validation
    messages.js          the typed request vocabulary + validation
    controllerClient.js  GET-only GitHub content client (injectable fetch)
    authority.js         machine-state/work-order parsing + projection
    configuration.js     the non-authoritative configuration model + store
    tabDiscovery.js      provider tab discovery/open primitives
    service.js           the background service worker message router
  popup/
    popup.html/js/css    the operator UI (message-boundary only)
  tests/                 node --test suite (offline, deterministic)
```

All validation logic lives in pure modules with injected dependencies
(fetch, storage, tabs), which is what the Node test suite exercises;
`service.js` wires them to the real `chrome.*` surfaces exactly once.

## Run the tests

From the repository root:

```sh
node --test 'extension/tests/**/*.test.js'
```

Everything is offline and deterministic: GitHub responses, storage, and
tabs are injected fakes; no network, no credentials, no Chrome APIs.

## Recovery: a corrupt configuration store

If the popup reports `CONFIGURATION_CORRUPT`, the stored configuration
failed re-validation and every request is refused until the store is
explicitly cleared. The extension never silently resets it (that would
be an inferred fallback). To recover manually:

1. Go to `chrome://extensions`, find **Pectoraux Controller**, click
   **Inspect views: service worker**.
2. In the DevTools console, run
   `chrome.storage.local.clear()` then reload the extension.
3. Re-enter your registrations and repository selection.

## Safety boundaries (what this extension must never do)

- No provider passwords, raw session cookies, API tokens, or
  credentials — ever collected, stored, or sent (structurally: the
  closed forms have no such field, unknown fields are refused).
- No bypassing provider authentication, CAPTCHAs, anti-bot controls,
  or rate limits; no undocumented private provider APIs.
- No provider page DOM automation (selectors, model selection, prompt
  submission, popup/hang recovery) — that is CTRL-014/CTRL-015 scope,
  inside provider adapters, not here.
- No GitHub page-click automation where supported APIs exist; no
  repository mutation of any kind (GET-only client).
- No merge, approval, completion, roadmap advancement, or lifecycle
  transitions; no authoritative extension state; the extension never
  becomes a second source of truth.
