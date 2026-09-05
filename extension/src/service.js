/**
 * The background service worker — the CTRL-012/CTRL-013 message router.
 *
 * Every extension surface (the popup, and later provider-adapter
 * surfaces) talks to the extension ONLY through the typed message
 * boundary (messages.js). This module is the single place a request is
 * validated and routed:
 *
 *   1. validate the request form (unknown/malformed -> typed refusal,
 *      nothing touched — acceptance criterion 7);
 *   2. route to the owning module (configuration, authority client, tab
 *      discovery, GitHub identity, or the GitHub app client) — each
 *      module applies its own strict validation and returns typed
 *      values;
 *   3. persist configuration changes only AFTER full validation, and
 *      swap the in-memory reference only after the store write commits
 *      (no partial writes, no drift on failure);
 *   4. catch anything unexpected as INTERNAL_ERROR — fail closed, never
 *      guess.
 *
 * CTRL-013 routing doctrine:
 *   - the GitHub OAuth token is SESSION-ONLY (identity closure): it is
 *     attached to API requests transiently and never crosses the
 *     message boundary — message payloads carry only typed results and
 *     connection *metadata* (login/name/avatar);
 *   - discovery and the three mutations require a live session token
 *     (refused locally with AUTHORIZATION_REQUIRED before any network
 *     call when absent);
 *   - MergePullRequest is the TRANSPORT of an ALREADY-ISSUED runtime
 *     merge authorization (review iteration 2) — never an authorization
 *     substitute, and never a policy evaluator. The message boundary
 *     validates ONLY the closed transport form (the exact field set
 *     and types the accepted `MergeAuthorization` value defines; the
 *     frozen merge method is not message-carried) and fails closed on
 *     malformed or fabricated input. The extension NEVER interprets a
 *     governance fact — review state, active-work-item eligibility,
 *     required checks, mergeability, draft state, lifecycle: the
 *     complete merge predicate is the Controller runtime's
 *     (`controller/github.py`, `_require_merge_policy`), re-proven by
 *     the runtime at execution time. The channel through which the
 *     runtime would hand this extension an authorization it has issued
 *     is NOT composed in CTRL-013 (runtime composition is CTRL-016
 *     scope): there is deliberately no second authorization mechanism
 *     here, so the message-surface route fails closed
 *     RUNTIME_AUTHORIZATION_UNAVAILABLE with ZERO network — a live
 *     session plus a fully-populated fabricated identity can never
 *     make the merge POST reachable from a message;
 *   - the transport client (`githubClient.js`) carries only the exact
 *     target identity and exact-head safety (GitHub's own `sha`
 *     parameter) with the frozen merge method — no
 *     review/check/lifecycle predicate lives in it;
 *   - observations of public repositories work unauthenticated (the
 *     controlled MVP repositories are public); private repositories
 *     fail closed as REPOSITORY_INACCESSIBLE until a connection with
 *     the required access exists — access is never implicitly
 *     broadened;
 *   - SelectRepository keeps its CTRL-012 identity-form semantics when
 *     no connection exists, and adds the accessibility gate (GET
 *     /repos) when one does — an unauthorized repository is refused,
 *     never silently substituted;
 *   - the authority projection (GetAuthorityState) attaches the session
 *     token to its GET-only content reads when present, so private
 *     controlled repositories are readable exactly when the operator's
 *     connection permits them.
 */

import { ControllerContentClient } from "./controllerClient.js";
import {
  ConfigurationStore,
  clearGitHubConnection,
  emptyConfiguration,
  registerArchitect,
  registerWorker,
  selectRepository,
  setGitHubConnection,
} from "./configuration.js";
import { projectAuthorityState } from "./authority.js";
import { validateRequest } from "./messages.js";
import { discoverProviderTabs, openProviderTab } from "./tabDiscovery.js";
import { createGitHubIdentity } from "./githubIdentity.js";
import { createGitHubClient } from "./githubClient.js";
import { validateRepositoryIdentity } from "./repository.js";
import { failure } from "./errors.js";

/**
 * Build the controller service (fully injectable for offline tests).
 *
 * @param {{ storage: object, fetchImpl: Function, tabsApi: object,
 *           apiRoot?: string, rawRoot?: string,
 *           identity?: object, githubClient?: object,
 *           getClientId?: Function, getScopes?: Function,
 *           sleep?: Function, now?: Function }} wiring
 *        `identity`/`githubClient` override the built-ins in tests; the
 *        browser wiring builds the real device-flow identity (manifest
 *        client id/scopes) and the real app client; the optional
 *        getClientId/getScopes/sleep/now hooks let tests exercise the
 *        REAL identity offline with deterministic clocks.
 */
export function createControllerService({
  storage,
  fetchImpl,
  tabsApi,
  apiRoot,
  rawRoot,
  identity,
  githubClient,
  getClientId,
  getScopes,
  sleep,
  now,
}) {
  const store = new ConfigurationStore({ storage });
  const githubIdentity =
    identity ??
    createGitHubIdentity({
      fetchImpl,
      getClientId: getClientId ?? _manifestClientId,
      getScopes: getScopes ?? _manifestScopes,
      ...(sleep !== undefined ? { sleep } : {}),
      ...(now !== undefined ? { now } : {}),
      openTab: async (url) => {
        const opened = await openProviderTab(tabsApi, url);
        if (!opened.ok) {
          throw new Error(opened.error.message);
        }
      },
    });
  const github =
    githubClient ?? createGitHubClient({ fetchImpl, identity: githubIdentity, ...(apiRoot ? { apiRoot } : {}) });
  // The authority content client reads with the session token attached
  // when present (GET-only reads; private controlled repositories
  // become readable exactly when the connection permits them).
  const client = new ControllerContentClient({
    fetchImpl: (url, init) => {
      const token = githubIdentity.currentToken();
      if (token === null || typeof token !== "string" || token.length === 0) {
        return fetchImpl(url, init);
      }
      const headers = { ...(init?.headers ?? {}) };
      headers.Authorization = `Bearer ${token}`;
      return fetchImpl(url, { ...init, headers });
    },
    ...(apiRoot ? { apiRoot } : {}),
    ...(rawRoot ? { rawRoot } : {}),
  });
  let configuration = null; // null until start() loads; never a guess
  let started = false;
  let pendingConnection = null; // an in-flight device flow (session state, never persisted)

  async function start() {
    const loaded = await store.load();
    configuration = loaded.ok ? (loaded.configuration ?? emptyConfiguration()) : null;
    started = true;
    return loaded;
  }

  /**
   * Handle one validated-boundary message.
   *
   * @param {unknown} request
   * @returns {Promise<{ ok: true } | { ok: false, error: object }>}
   */
  async function handleMessage(request) {
    try {
      const validated = validateRequest(request);
      if (!validated.ok) {
        return validated;
      }
      if (!started) {
        return failure("INTERNAL_ERROR", "service has not started (configuration not loaded)");
      }
      if (store.isCorrupt()) {
        // A corrupt configuration store is a fail-closed state for
        // EVERY request — including authority reads (the selected
        // repository lives in the refused store, so nothing honest can
        // be queried). Manual recovery is documented; the store never
        // silently resets itself.
        return failure(
          "CONFIGURATION_CORRUPT",
          `extension configuration store is corrupt: ${store.corruptionReason()} (manual recovery is documented in extension/README.md)`
        );
      }
      const configurationForRequest = configuration ?? emptyConfiguration();

      switch (validated.request.kind) {
        case "GetConfiguration":
          return { ok: true, configuration: configurationForRequest };

        case "RegisterWorker": {
          const next = registerWorker(configurationForRequest, validated.request);
          if (!next.ok) {
            return next;
          }
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "RegisterArchitect": {
          const next = registerArchitect(configurationForRequest, validated.request);
          if (!next.ok) {
            return next;
          }
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "SelectRepository": {
          const next = selectRepository(configurationForRequest, validated.request.repository);
          if (!next.ok) {
            return next;
          }
          // With a live connection, selection is gated on observed
          // accessibility: an unauthorized or nonexistent repository is
          // refused — never silently substituted. Without a connection,
          // CTRL-012's identity-form semantics apply (public repos; a
          // private repo fails closed later at projection time).
          if (githubIdentity.currentToken() !== null) {
            const identity = validateRepositoryIdentity(validated.request.repository);
            if (!identity.ok) {
              return identity;
            }
            const observed = await github.getRepository(identity.owner, identity.name);
            if (!observed.ok) {
              if (observed.error.code === "REPOSITORY_INACCESSIBLE") {
                return failure(
                  "REPOSITORY_INACCESSIBLE",
                  `repository '${identity.repository}' is not accessible to the connected GitHub account: ${observed.error.message}`
                );
              }
              return observed;
            }
          }
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "GetAuthorityState": {
          const repository = configurationForRequest.repository;
          if (repository === null) {
            return failure(
              "REPOSITORY_NOT_SELECTED",
              "no repository is selected; select a controlled repository first"
            );
          }
          const projected = await projectAuthorityState({ client, repository });
          return projected;
        }

        case "OpenProviderTab":
        case "DiscoverProviderTabs": {
          const role = validated.request.role;
          const name = validated.request.name;
          const list = role === "worker" ? configurationForRequest.workers : configurationForRequest.architects;
          const registration = list.find((entry) => entry.name === name);
          if (registration === undefined) {
            return failure(
              "REGISTRATION_NOT_FOUND",
              `no ${role} named '${name}' is registered`
            );
          }
          if (validated.request.kind === "OpenProviderTab") {
            const opened = await openProviderTab(tabsApi, registration.providerUrl);
            return opened.ok ? { ok: true, opened: opened.opened } : opened;
          }
          const discovered = await discoverProviderTabs(tabsApi, registration.providerUrl);
          return discovered.ok ? { ok: true, tabs: discovered.tabs } : discovered;
        }

        // -- CTRL-013: GitHub connection --------------------------------

        case "ConnectGitHub": {
          if (pendingConnection !== null) {
            // A flow is already in flight: re-present it (no second
            // flow, no refusal — the operator finishes the one shown).
            return {
              ok: true,
              pending: true,
              userCode: pendingConnection.userCode,
              verificationUri: pendingConnection.verificationUri,
              expiresIn: pendingConnection.expiresIn,
            };
          }
          const begun = await githubIdentity.beginDeviceFlow();
          if (!begun.ok) {
            return begun;
          }
          pendingConnection = {
            deviceCode: begun.deviceCode,
            userCode: begun.userCode,
            verificationUri: begun.verificationUri,
            expiresIn: begun.expiresIn,
            interval: begun.interval,
          };
          await githubIdentity.openVerificationPage(begun.verificationUri);
          // Detached completion: poll to the token, then observe the
          // account and persist ONLY the connection metadata. The token
          // stays in the identity closure for this service-worker
          // session; nothing credential-shaped is ever persisted.
          void _completeConnection();
          return {
            ok: true,
            pending: true,
            userCode: begun.userCode,
            verificationUri: begun.verificationUri,
            expiresIn: begun.expiresIn,
          };
        }

        case "DisconnectGitHub": {
          githubIdentity.invalidate();
          pendingConnection = null;
          const next = clearGitHubConnection(configurationForRequest);
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "GetGitHubConnection": {
          return {
            ok: true,
            connection: configurationForRequest.githubConnection,
            authorized: githubIdentity.currentToken() !== null,
            pending: pendingConnection === null ? null : { userCode: pendingConnection.userCode, verificationUri: pendingConnection.verificationUri },
          };
        }

        // -- CTRL-013: repository discovery/access -----------------------

        case "DiscoverRepositories": {
          const connected = _requireSessionToken();
          if (!connected.ok) {
            return connected;
          }
          const listed = await github.listAccessibleRepositories();
          return listed.ok ? { ok: true, repositories: listed.repositories, truncated: listed.truncated } : listed;
        }

        case "VerifyRepositoryAccess": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const observed = await github.getRepository(identityResult.owner, identityResult.name);
          return observed.ok
            ? { ok: true, accessible: true, repository: observed.repository }
            : { ok: true, accessible: false, error: observed.error };
        }

        // -- CTRL-013: observations (evidence for the Controller boundary)

        case "ObserveRepository": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const observed = await github.getRepository(identityResult.owner, identityResult.name);
          return observed;
        }

        case "ObservePullRequests": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const listed = await github.listPullRequests(identityResult.owner, identityResult.name, {
            state: validated.request.state,
            headBranch: validated.request.headBranch,
          });
          return listed.ok ? { ok: true, pullRequests: listed.pullRequests } : listed;
        }

        case "ObservePullRequest": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const observed = await github.getPullRequest(identityResult.owner, identityResult.name, validated.request.prNumber);
          return observed;
        }

        case "ObserveReviews": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const observed = await github.getReviews(identityResult.owner, identityResult.name, validated.request.prNumber);
          return observed.ok ? { ok: true, reviews: observed.reviews } : observed;
        }

        case "ObserveComments": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const observed = await github.getComments(identityResult.owner, identityResult.name, validated.request.prNumber);
          return observed.ok ? { ok: true, comments: observed.comments } : observed;
        }

        case "ObserveCommitStatus": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const observed = await github.getCommitStatus(identityResult.owner, identityResult.name, validated.request.sha);
          return observed.ok ? { ok: true, status: observed.status } : observed;
        }

        case "CorrelateWorkPullRequest": {
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const correlated = await github.correlateWorkPullRequest(
            identityResult.owner,
            identityResult.name,
            { branch: validated.request.branch, baseSha: validated.request.baseSha, headSha: validated.request.headSha }
          );
          return correlated;
        }

        // -- CTRL-013: the three Controller-authorized mutations ---------
        // No popup control invokes these; they are the typed transport
        // surface for the future runtime composition, and each is
        // refused locally without a live session authorization.

        case "CreateBranch": {
          const connected = _requireSessionToken();
          if (!connected.ok) {
            return connected;
          }
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const created = await github.createBranch(identityResult.owner, identityResult.name, validated.request.branch, validated.request.fromSha);
          return created;
        }

        case "OpenPullRequest": {
          const connected = _requireSessionToken();
          if (!connected.ok) {
            return connected;
          }
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          const opened = await github.openPullRequest(identityResult.owner, identityResult.name, {
            branch: validated.request.branch,
            baseBranch: validated.request.baseBranch,
            baseSha: validated.request.baseSha,
            title: validated.request.title,
            body: validated.request.body,
          });
          return opened;
        }

        case "MergePullRequest": {
          // Mutation 3 — the TRANSPORT of an ALREADY-ISSUED runtime merge
          // authorization (review iteration 2). The boundary validates
          // ONLY the closed transport form (validateRequest above: the
          // exact field set and types; the frozen merge method is not
          // message-carried). This extension NEVER evaluates a
          // governance fact — review state, active-work-item
          // eligibility, required checks, mergeability, draft state,
          // lifecycle: the complete merge predicate is the Controller
          // runtime's (controller/github.py, _require_merge_policy),
          // re-proven by the runtime at execution time. The channel
          // through which the runtime would hand this extension an
          // authorization it has issued is not composed in CTRL-013
          // (runtime composition is CTRL-016 scope), and there is
          // deliberately NO second authorization mechanism here — so
          // the route fails closed NOW, with zero network: a live
          // session plus a fully-populated fabricated identity can
          // never make the merge POST reachable from a message.
          const connected = _requireSessionToken();
          if (!connected.ok) {
            return connected;
          }
          const identityResult = validateRepositoryIdentity(validated.request.repository);
          if (!identityResult.ok) {
            return identityResult;
          }
          return failure(
            "RUNTIME_AUTHORIZATION_UNAVAILABLE",
            "MergePullRequest is the transport of a merge authorization the Controller runtime has " +
              "already issued through its merge-policy boundary; the runtime-authorization handoff is " +
              "not composed yet (runtime composition is CTRL-016 scope), and this extension refuses to " +
              "invent a second authorization mechanism: a message payload — even a well-formed one with " +
              "a live session — is not an authorization, so the merge POST is unreachable here with zero " +
              "network"
          );
        }

        default:
          // Unreachable: validateRequest admits only REQUEST_KINDS.
          return failure("UNKNOWN_MESSAGE", `unhandled request kind '${validated.request.kind}'`);
      }
    } catch (err) {
      return failure("INTERNAL_ERROR", `unexpected service failure: ${err}`);
    }
  }

  /** @private — the local no-session refusal (no network). */
  function _requireSessionToken() {
    if (githubIdentity.currentToken() === null) {
      return failure(
        "AUTHORIZATION_REQUIRED",
        "no live GitHub session authorization: connect GitHub first (the token is session-only and is lost when the service worker restarts)"
      );
    }
    return { ok: true };
  }

  /** @private — complete the in-flight device flow, then persist metadata. */
  async function _completeConnection() {
    const flow = pendingConnection;
    try {
      const completed = await githubIdentity.completeDeviceFlow({
        deviceCode: flow.deviceCode,
        expiresIn: flow.expiresIn,
        interval: flow.interval,
      });
      if (!completed.ok) {
        return; // typed; the operator sees it on the next GetGitHubConnection/poll
      }
      const user = await github.getAuthenticatedUser();
      if (!user.ok) {
        githubIdentity.invalidate();
        return;
      }
      const next = setGitHubConnection(configuration ?? emptyConfiguration(), {
        login: user.user.login,
        name: user.user.name,
        avatarUrl: user.user.avatarUrl,
      });
      if (!next.ok) {
        githubIdentity.invalidate();
        return;
      }
      const persisted = await store.persist(next.configuration);
      if (persisted.ok) {
        configuration = next.configuration;
      }
    } finally {
      if (pendingConnection === flow) {
        pendingConnection = null;
      }
    }
  }

  return { start, handleMessage, store };
}

/** @private — the manifest OAuth client id (public identifier, not a secret). */
function _manifestClientId() {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getManifest !== "function") {
    return "";
  }
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest?.oauth2?.client_id;
  return typeof clientId === "string" ? clientId : "";
}

/** @private — the manifest OAuth scopes (the documented minimal grant). */
function _manifestScopes() {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.getManifest !== "function") {
    return ["public_repo"];
  }
  const manifest = chrome.runtime.getManifest();
  const scopes = manifest?.oauth2?.scopes;
  return Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string" && scope.length > 0)
    ? scopes
    : ["public_repo"];
}

// Browser wiring: construct the service over the real chrome surfaces
// and register the single message listener. Test environments (node)
// import createControllerService directly and never execute this block.
/* global chrome */
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  const service = createControllerService({
    storage: chrome.storage.local,
    fetchImpl: globalThis.fetch.bind(globalThis),
    tabsApi: chrome.tabs,
  });
  // Messages that arrive while the configuration load is still in
  // flight wait for it (the store read is async); start() never
  // rejects — a malformed store resolves as the corrupt fail-closed
  // state.
  const ready = service.start();
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    ready
      .then(() => service.handleMessage(request))
      .then(sendResponse, (err) => {
        sendResponse({ ok: false, error: { code: "INTERNAL_ERROR", message: String(err) } });
      });
    return true; // the response is async
  });
}
