# CTRL-013 — GitHub Browser-App Integration

Status: `READY`

## Authorization

CTRL-013 is the sole currently executable Work Item. CTRL-012 — Browser Control Surface Foundation is complete and reconciled at main. This Work Order activates only the GitHub integration surface required by the browser MVP; CTRL-014 and later remain planned and inactive.

Automation stage: `STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP`.

## Objective

Integrate GitHub authentication and repository selection into the Chromium browser extension using supported GitHub authorization/application mechanisms, and add the GitHub observation/mutation surface required by the already-accepted Controller runtime without moving repository authority into extension state.

The extension is an operator/client surface. The controlled repository remains authoritative for roadmap, Work Orders, machine state, lifecycle, review and merge policy.

## Scope

- GitHub authentication/authorization initiation from the extension using supported GitHub mechanisms;
- durable representation of the authenticated GitHub account/installation as non-authoritative configuration/connection metadata;
- repository discovery and explicit repository selection for repositories the authenticated connection is permitted to access;
- canonical `owner/name` repository identity validation;
- supported GitHub API client methods needed to observe branches, commits, pull requests, checks/reviews and to perform only the existing Controller-authorized repository mutations required by later composition;
- safe request/response typing and strict error normalization for the extension GitHub boundary;
- separation between read/observation operations and mutation operations;
- tests using injected/offline fakes for authentication state, repository selection, malformed responses, permission denial, rate limiting, stale references, and zero-mutation fail-closed behavior;
- extension documentation for GitHub connection, repository selection and permissions.

## Required behavior

### GitHub connection

The extension must provide a `Connect GitHub` action that uses a supported authorization mechanism. The extension must not require the user to paste a personal access token into the UI.

The connection result must be treated as an external authorization reference, not as repository authority.

### Repository selection

The user must be able to enumerate/select an accessible repository and represent it canonically as `owner/name`.

At minimum the MVP flow must support `pectoraux/smallapp`.

Ambiguous, malformed, unauthorized or unavailable repository identities fail closed. The extension must never silently substitute another repository.

### GitHub observation

The integration must expose the observations needed by the existing Controller boundaries, using supported GitHub APIs:

- repository/default branch;
- branch head commit;
- governed branch/PR correlation;
- PR head/base/status/merge evidence;
- required CI/check results;
- Architect/PR review observations and comments where the existing review protocol requires them.

Do not re-implement lifecycle, merge or review predicates in the extension. Return observed evidence to the existing Controller/core boundary.

### GitHub mutation

The extension/API boundary may expose only the GitHub mutations already authorized by the existing Controller runtime for the current lifecycle step. No extension-local button or state may bypass the Controller's predicates.

In particular, do not create a second independent merge policy. Any merge must remain behind the existing exact-head merge/reconciliation predicate and runtime authorization.

## Security requirements

- no PAT entry field in operator UI;
- no raw provider credentials in extension storage;
- minimize OAuth/App scopes and document them;
- do not log access tokens or authorization codes;
- do not make access to one repository imply access to another;
- fail closed on authorization failure, rate limit ambiguity, stale references or malformed API responses;
- extension configuration remains non-authoritative.

## Forbidden

- GitHub page-click automation for operations available through supported APIs;
- copying the Controller lifecycle or merge/review predicates into extension code;
- automatic merge without an existing Controller authorization;
- accepting arbitrary repository URLs in place of canonical identity;
- storing user passwords, raw OAuth tokens, installation secrets or browser cookies as product state;
- silently broadening repository permissions;
- implementation of Z.ai-specific browser automation (CTRL-014);
- implementation of ChatGPT UI automation (CTRL-015);
- automatic activation of CTRL-014 or later.

## Acceptance criteria

1. A user can initiate supported GitHub authorization from the extension without pasting a PAT.
2. The extension can discover and select an accessible GitHub repository, including `pectoraux/smallapp`, represented canonically as `owner/name`.
3. Repository identity and authorization failures are typed and fail closed.
4. The extension can observe the GitHub evidence required by the existing Controller runtime without duplicating governance predicates.
5. GitHub mutation calls, where exposed, are restricted to existing Controller-authorized operations and cannot be invoked merely because a UI control is present.
6. No raw credentials/secrets are persisted or emitted in logs/telemetry.
7. Tests cover authorization/permission denial, malformed API responses, rate limiting, stale references and mutation gating.
8. Documentation is sufficient for a fresh session to install the extension, connect GitHub, select `pectoraux/smallapp`, inspect evidence and understand the permission model.

## Required evidence

- exact test commands/results;
- live or supported-environment evidence for the GitHub authorization flow;
- repository discovery/selection evidence including `pectoraux/smallapp`;
- scope/security audit proving no PAT UI, no credential persistence and no duplicated governance predicates;
- PR body identifies CTRL-013, exact dispatch base, changed surface and evidence.

## Handoff

Implementation starts from the exact current `main` SHA observed at dispatch. The worker creates exactly one governed implementation PR targeting `main`, does not merge or approve it, does not activate later Work Items, and does not rewrite repository authority except where explicitly required by this Work Order's implementation surface.

Fresh-session source of truth:

1. `spec/state/controller-program-state.json`
2. `spec/roadmap/roadmap.md`
3. `spec/architecture/controller-architecture.md`
4. `spec/operations/controller-build-process.md`
5. this Work Order
6. `spec/operations/fresh-session-handoff.md`
7. `AGENTS.md`

No conversation transcript is required to implement CTRL-013.