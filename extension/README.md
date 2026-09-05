# Pectoraux Controller — Browser Operator Surface (CTRL-012 + CTRL-013)

This directory is the Browser Control Surface Foundation (CTRL-012)
plus the GitHub browser-app integration (CTRL-013): a Chromium browser
extension that acts as the Controller's **operator/client surface**.
It registers Workers and Architects, connects GitHub through a
supported OAuth authorization (no pasted tokens), selects the
controlled GitHub repository, and presents the repository-derived
Controller authority state and repository evidence.

The extension is **non-authoritative by construction**. Repository
authority always wins: roadmap, work orders, machine state, lifecycle,
review, and merge policy live in the controlled repository and the
Controller core (`controller/`), never in extension state. The
extension exposes only the repository mutations the accepted
Controller runtime already authorizes — as a typed transport surface
for the future runtime composition, with no popup control to invoke
them.

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
- **GitHub connection (CTRL-013)**: `Connect GitHub` starts GitHub's
  OAuth **device flow** — the supported authorization path for browser
  extensions. The extension requests a device code, opens
  `github.com/login/device`, and the **human** authenticates at GitHub
  and enters the code. The access token lives only in the service
  worker's session memory: it is never stored, logged, or put in a
  message, and it is discarded on service-worker restart or on any
  401 (fail-closed `AUTHORIZATION_REQUIRED`; reconnect). Only the
  account **metadata** (login/name/avatar) persists, as closed-form
  non-authoritative configuration.
- **Repository discovery**: lists the repositories the connected
  account is permitted to access (canonical `owner/name`, default
  branch, visibility; deterministic order; explicit truncation marker
  beyond a bounded page walk). Selecting from the list is one click.
  With a live connection, repository selection is **gated on observed
  access** — an unauthorized repository is refused, never silently
  substituted.
- **Repository evidence (read-only)**: typed observations of the
  default branch + head SHA, pull requests (head/base/state/draft/
  merged/mergeable), reviews, comments, and combined commit status —
  the same evidence the Controller core consumes, normalized the same
  way, returned to the boundary without evaluating any governance
  predicate. Includes the governed branch/PR **correlation** as typed
  outcomes (`correlated` / `no-open-pr` / `ambiguous` / `base-drift` /
  `head-drift`) for the future runtime composition.
- **The three authorized mutations (transport only)**: the message
  boundary carries exactly the three mutations the accepted Python
  adapter exposes — `CreateBranch` (explicit base SHA, never a
  default), `OpenPullRequest` (one-PR rule + base identity gates), and
  `MergePullRequest` (the identity-binding transport of a
  runtime-issued authorization: open/unmerged, exact base ref+SHA,
  exact head, merge method frozen to `merge`). No predicate is
evaluated here; no popup control invokes these.

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
   identity is displayed. (Typing the identity manually works for
   public repositories without a GitHub connection; see the next
   section for discovery-based selection.)
3. Press **Refresh state** under **Controller state**. The popup shows
   the repository-derived projection: repository, active work item,
   lifecycle status, automation stage, completed ledger, next action,
   and the exact `ref@sha` the projection was observed at.

The extension talks to GitHub exactly the way the Controller's
repository authority defines it: `GET /repos/{owner}/{name}` (default
branch), `GET /repos/{owner}/{name}/commits/{branch}` (HEAD SHA), then
the machine-state JSON and the work-order markdown fetched from
`raw.githubusercontent.com` **at that SHA**. When GitHub is connected,
these reads carry the session authorization (so private controlled
repositories are readable exactly when the connection permits them);
without a connection they are unauthenticated public reads.

To also connect the governed runtime itself (dispatch, cycles,
recording), run the Python CLI against a checkout — see the root
`README.md`, "Operating the Controller". The extension and the runtime
read the same repository authority; the extension never substitutes
for it.

## Connect GitHub (OAuth device flow — one-time operator setup)

The extension authorizes through GitHub's **OAuth device flow** — the
mechanism GitHub documents for public clients such as browser
extensions, which cannot keep a client secret. There is **no PAT input
field anywhere**, and no secret is ever embedded in the package.

### One-time: create the GitHub OAuth App

1. As the repository operator, open GitHub -> **Settings -> Developer
   settings -> OAuth Apps -> New OAuth App**.
2. Application name/homepage: anything identifying this deployment
   (e.g. "Pectoraux Controller operator surface"). Authorization
   callback URL is unused by the device flow — any HTTPS URL is
   accepted.
3. After creating the app, open its settings and **enable Device
   Flow** (a checkbox in the app's settings page). This is required —
   without it GitHub refuses the flow and the extension fail-closes
   with `AUTHORIZATION_NOT_CONFIGURED` telling you exactly that.
4. Copy the **Client ID** (a public identifier — it is NOT a secret
   and GitHub documents it as safe to embed in client applications).
5. Replace the `oauth2.client_id` PLACEHOLDER in
   `extension/manifest.json` — the shipped value is the recognizable
   sentinel `PASTE-YOUR-GITHUB-OAUTH-CLIENT-ID-HERE` (Chrome refuses
   to load a manifest with an empty value, hence the sentinel) — with
   your client id, and reload the extension. The scope list stays
   `["public_repo"]` (see Permissions below).

Until this step is done, `Connect GitHub` fails closed with
`AUTHORIZATION_NOT_CONFIGURED` (the sentinel is treated exactly like
an unconfigured deployment) — the extension never guesses. A client id
GitHub does not recognize is typed the same way (404 -> check the
manifest value).

### Connect as the operator

1. Press **Connect GitHub**. The extension requests a device code and
   opens `https://github.com/login/device` in a new tab.
2. **Authenticate at GitHub yourself** and enter the displayed user
   code (the extension never sees your password — authentication
   happens entirely in GitHub's UI).
3. Authorize the requested scope when GitHub asks. The connection
   completes in the background (the popup's **Refresh** shows it); the
   account login appears in the GitHub section.

The access token is **session-only**: it lives in the service
worker's memory, is attached to API requests transiently, and is
discarded on service-worker restart, on `Disconnect`, or on any GitHub
401 (fail-closed `AUTHORIZATION_REQUIRED` — press Connect again;
GitHub device-flow tokens expire after 8 hours by GitHub policy).
Only the account metadata (login/name/avatar) persists, in the
closed-form configuration record — a record carrying any other field
(e.g. a token) is treated as a corrupt store.

### Select the MVP repository

Press **Discover repositories** and pick `pectoraux/smallapp` (or any
accessible repository) from the list — the canonical `owner/name`
identity is guaranteed by discovery. Manual entry stays available;
with a live connection, selection verifies observed accessibility and
refuses unauthorized repositories (`REPOSITORY_INACCESSIBLE` — never
a silent substitution).

## Permissions

- `storage` — the non-authoritative configuration (registrations,
  selected repository, GitHub connection metadata).
- `tabs` — opening provider tabs for human authentication, and the
  device-flow verification tab.
- Host `https://api.github.com/*` — GitHub REST API reads and the
  three authorized mutations.
- Host `https://raw.githubusercontent.com/*` — repository authority
  content at a pinned SHA.
- Host `https://github.com/*` — **only** the two OAuth device-flow
  endpoints (`/login/device/code`, `/login/oauth/access_token`). No
  content scripts, no scripting API, no GitHub page automation.
- OAuth scope `public_repo` — read/write access to public
  repositories: the minimum single scope that covers discovery,
  evidence reads, and the three authorized mutations on public
  repositories. It grants **no** private-repository access (a private
  repository fails closed as `REPOSITORY_INACCESSIBLE`). If a future
deployment must operate private repositories, change
  `oauth2.scopes` to `["repo"]` — a documented operator decision; the
  extension never broadens access on its own.

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
| `GetConfiguration` | — | `configuration` (workers, architects, repository, githubConnection) |
| `RegisterWorker` | `name`, `providerKind`, `providerUrl` | `configuration` |
| `RegisterArchitect` | `name`, `providerKind`, `providerUrl` | `configuration` |
| `SelectRepository` | `repository` | `configuration` |
| `GetAuthorityState` | — | `state` (active work item, lifecycle, stage, completed, next action, provenance) |
| `OpenProviderTab` | `role`, `name` | `opened` (tabId, url) |
| `DiscoverProviderTabs` | `role`, `name` | `tabs` (id, url, title) |
| `ConnectGitHub` | — | `pending`, `userCode`, `verificationUri`, `expiresIn` |
| `DisconnectGitHub` | — | `configuration` |
| `GetGitHubConnection` | — | `connection`, `authorized`, `pending` |
| `DiscoverRepositories` | — | `repositories`, `truncated` |
| `VerifyRepositoryAccess` | `repository` | `accessible`, `repository`/`error` |
| `ObserveRepository` | `repository` | `repository` (default branch, visibility, pushedAt) |
| `ObservePullRequests` | `repository`, `state`, `headBranch` (nullable) | `pullRequests` |
| `ObservePullRequest` | `repository`, `prNumber` | `pullRequest` |
| `ObserveReviews` | `repository`, `prNumber` | `reviews` |
| `ObserveComments` | `repository`, `prNumber` | `comments` |
| `ObserveCommitStatus` | `repository`, `sha` | `status` |
| `CorrelateWorkPullRequest` | `repository`, `branch`, `baseSha`, `headSha` (nullable) | typed outcome + evidence |
| `CreateBranch` | `repository`, `branch`, `fromSha` | `ref` (requires live session) |
| `OpenPullRequest` | `repository`, `branch`, `baseBranch`, `baseSha`, `title`, `body` | `pullRequest` (requires live session) |
| `MergePullRequest` | `repository`, `prNumber`, `workItem`, `baseRef`, `baseSha`, `headSha` | `merged`, `mergeCommitSha` (requires live session + exact-identity binding) |

The three mutation kinds are the complete mutation vocabulary — no
approve/comment/close/complete/advance kind exists. They are transport
for the runtime composition; the popup never invokes them.

Error codes: `UNKNOWN_MESSAGE`, `MALFORMED_MESSAGE`,
`INVALID_REGISTRATION`, `INVALID_REPOSITORY`, `REGISTRATION_NOT_FOUND`,
`REPOSITORY_NOT_SELECTED`, `CONFIGURATION_CORRUPT`,
`AUTHORITY_UNAVAILABLE`, `AUTHORITY_MISSING`, `AUTHORITY_MALFORMED`,
`AUTHORITY_CONTRADICTORY`, `TABS_UNAVAILABLE`,
`AUTHORIZATION_REQUIRED`, `AUTHORIZATION_FAILED`,
`AUTHORIZATION_NOT_CONFIGURED`, `REPOSITORY_INACCESSIBLE`,
`RATE_LIMITED`, `STALE_REFERENCE`, `MUTATION_REFUSED`,
`GITHUB_UNAVAILABLE`, `GITHUB_MALFORMED`, `GITHUB_NOT_FOUND`,
`INTERNAL_ERROR`.

## Source layout

```
extension/
  manifest.json          MV3 manifest: storage + tabs permissions, three
                         GitHub host permissions, oauth2 deployment
                         section (public client id + minimal scope)
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
    githubIdentity.js    the OAuth device-flow identity (session-only token)
    githubClient.js      the typed GitHub app API client (observations,
                         correlation outcomes, three gated mutations)
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
  closed forms have no such field, unknown fields are refused; the
  GitHub token is session-only memory, never storage, never a
  message, never a log line).
- No PAT entry field; no client secret in the package (the device
  flow needs none); the OAuth client id is a public identifier.
- No bypassing provider authentication, CAPTCHAs, anti-bot controls,
  or rate limits; no undocumented private provider APIs (rate limits
  fail closed as `RATE_LIMITED`).
- No provider page DOM automation (selectors, model selection, prompt
  submission, popup/hang recovery) — that is CTRL-014/CTRL-015 scope,
  inside provider adapters, not here.
- No GitHub page-click automation where supported APIs exist; the
  github.com host permission covers exactly the two OAuth endpoints.
- No second merge policy: the merge kind is the identity-binding
  transport of a runtime-issued authorization and evaluates no
  eligibility/review/check predicate. No mutation can run merely
  because a UI control exists — no popup mutation control exists.
- No merge, approval, completion, roadmap advancement, or lifecycle
  transitions initiated by the extension; no authoritative extension
  state; the extension never
  becomes a second source of truth.
