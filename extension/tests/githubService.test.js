/**
 * GitHub service-integration tests (CTRL-013).
 *
 * Pins the message-boundary routing end-to-end over injected fakes:
 * the device-flow connection lifecycle (Connect -> pending code ->
 * background completion -> persisted METADATA only), the local
 * no-session mutation refusal, the accessibility-gated repository
 * selection, unauthenticated public observation, the authenticated
 * authority projection (token attached to GET-only content reads), and
 * the proof that no token ever reaches storage or a message payload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createControllerService } from "../src/service.js";
import { createGitHubIdentity } from "../src/githubIdentity.js";
import {
  fakeStorage,
  fakeTabsApi,
  fakeDeviceFlowEndpoints,
  fakeIdentity,
  fakeAuthorityFetch,
  fixtureMachineState,
  fixtureWorkOrder,
  jsonResponse,
  fakeRepositoryPayload,
  fakePullRequestPayload,
} from "./fixtures.js";

const CLIENT_ID = "Ov23cliEntId0123456789";
const SESSION_TOKEN = "gho_sessiontokenAAAAAAAAAAAAAAAA";
const REPOSITORY = "pectoraux/controller";

function buildAuthorityFetch() {
  return fakeAuthorityFetch({
    machineState: fixtureMachineState(),
    workOrder: fixtureWorkOrder(),
  });
}

/**
 * A full service wiring: the REAL identity over the fake device-flow
 * endpoints (deterministic clock), the real app client over an
 * injectable API handler, and the authority content client over the
 * CTRL-012 fake.
 */
function buildService({ apiHandler, authorityFetch = buildAuthorityFetch(), storage = fakeStorage(), deviceFlow = fakeDeviceFlowEndpoints({ pendingRounds: 0 }), identityOverride = null } = {}) {
  const tabs = fakeTabsApi();
  const identity =
    identityOverride ??
    createGitHubIdentity({
      fetchImpl: async (url, options = {}) => {
        const target = String(url);
        if (target.startsWith("https://github.com/login/")) {
          return deviceFlow.fetchImpl(url, options);
        }
        return apiHandler ? apiHandler(target, options) : jsonResponse(404, {});
      },
      getClientId: () => CLIENT_ID,
      sleep: async () => {},
      now: () => 0,
      openTab: async (url) => {
        await tabs.create({ url, active: true });
      },
    });
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    requests.push({
      url: target,
      method: options.method ?? "GET",
      headers: { ...(options.headers ?? {}) },
      body: options.body ?? null,
    });
    if (target.startsWith("https://api.github.com/")) {
      return apiHandler ? apiHandler(target, options) : jsonResponse(404, {});
    }
    if (target.startsWith("https://github.com/login/")) {
      return deviceFlow.fetchImpl(url, options);
    }
    return authorityFetch.fetchImpl(url, options);
  };
  const service = createControllerService({
    storage,
    fetchImpl,
    tabsApi: tabs,
    identity,
  });
  return { service, storage, identity, requests, tabs };
}

async function started(service) {
  await service.start();
  return service;
}

test("ConnectGitHub returns the pending device code and opens the verification tab", async () => {
  const deviceFlow = fakeDeviceFlowEndpoints({ userCode: "WXYZ-9999", pendingRounds: 0 });
  const storage = fakeStorage();
  const tabs = fakeTabsApi();
  const service = createControllerService({
    storage,
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.startsWith("https://github.com/login/")) {
        return deviceFlow.fetchImpl(url, options);
      }
      if (target === "https://api.github.com/user") {
        return jsonResponse(200, { login: "pectoraux", name: "Pectoraux", avatar_url: null });
      }
      return jsonResponse(404, {});
    },
    tabsApi: tabs,
    getClientId: () => CLIENT_ID,
    sleep: async () => {},
    now: () => 0,
  });
  await service.start();
  const response = await service.handleMessage({ kind: "ConnectGitHub" });
  assert.equal(response.ok, true);
  assert.equal(response.pending, true);
  assert.equal(response.userCode, "WXYZ-9999");
  assert.equal(response.verificationUri, "https://github.com/login/device");
  assert.equal(tabs._created().length, 1);
  assert.equal(tabs._created()[0].url, "https://github.com/login/device");
  // A second Connect while pending re-presents the same flow (no second
  // device code, no refusal).
  const again = await service.handleMessage({ kind: "ConnectGitHub" });
  assert.equal(again.ok, true);
  assert.equal(again.userCode, "WXYZ-9999");
  assert.equal(deviceFlow.requests.filter((request) => request.url === "https://github.com/login/device/code").length, 1);
});

test("the background completion persists ONLY connection metadata — no token in storage, ever", async () => {
  const deviceFlow = fakeDeviceFlowEndpoints({ pendingRounds: 0 });
  const apiRequests = [];
  const { service, storage } = buildService({
    apiHandler: (url, options) => {
      apiRequests.push({ url, headers: { ...(options.headers ?? {}) } });
      if (url === "https://api.github.com/user") {
        return jsonResponse(200, { login: "pectoraux", name: "Pectoraux", avatar_url: null });
      }
      return jsonResponse(404, {});
    },
    deviceFlow,
  });
  await service.start();
  const response = await service.handleMessage({ kind: "ConnectGitHub" });
  assert.equal(response.ok, true);
  // Drain the detached completion (device-flow poll -> token -> /user
  // -> persist metadata) deterministically.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const dump = storage._dump();
  const stored = dump["pectoraux.controller.configuration"];
  assert.equal(stored.schemaVersion, "0.2");
  assert.deepEqual(stored.githubConnection, { login: "pectoraux", name: "Pectoraux", avatarUrl: null });
  const serialized = JSON.stringify(dump);
  assert.doesNotMatch(serialized, /gho_/);
  assert.doesNotMatch(serialized, /token/i);
  // The account observation carried the transient token header only.
  const userRequest = apiRequests.find((request) => request.url === "https://api.github.com/user");
  assert.equal(userRequest.headers.Authorization, "Bearer gho_testtokenvalue111111111111111111");
  // The typed ConnectGitHub response never carries the token either.
  assert.doesNotMatch(JSON.stringify(response), /gho_testtokenvalue/);
  void deviceFlow;
});

test("GetGitHubConnection reports metadata, session authorization, and pending state", async () => {
  const identityOverride = fakeIdentity({ token: null });
  const { service } = buildService({ identityOverride });
  await service.start();
  const disconnected = await service.handleMessage({ kind: "GetGitHubConnection" });
  assert.equal(disconnected.ok, true);
  assert.equal(disconnected.connection, null);
  assert.equal(disconnected.authorized, false);
  assert.equal(disconnected.pending, null);
  identityOverride._setToken(SESSION_TOKEN);
  const connected = await service.handleMessage({ kind: "GetGitHubConnection" });
  assert.equal(connected.authorized, true);
});

test("DisconnectGitHub invalidates the session and clears the metadata", async () => {
  const { service, storage, identity } = buildService({
    deviceFlow: fakeDeviceFlowEndpoints({ pendingRounds: 0 }),
    apiHandler: (url) => {
      if (url === "https://api.github.com/user") {
        return jsonResponse(200, { login: "pectoraux", name: null, avatar_url: null });
      }
      if (url === "https://api.github.com/repos/pectoraux/controller") {
        return jsonResponse(200, fakeRepositoryPayload("pectoraux/controller"));
      }
      return jsonResponse(404, {});
    },
  });
  await service.start();
  await service.handleMessage({ kind: "ConnectGitHub" });
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.notEqual(identity.currentToken(), null);
  const select = await service.handleMessage({ kind: "SelectRepository", repository: REPOSITORY });
  assert.equal(select.ok, true);
  const response = await service.handleMessage({ kind: "DisconnectGitHub" });
  assert.equal(response.ok, true);
  assert.equal(response.configuration.githubConnection, null);
  assert.equal(identity.currentToken(), null);
  assert.equal(storage._dump()["pectoraux.controller.configuration"].githubConnection, null);
});

test("mutations are refused locally without a live session token (no network)", async () => {
  const { service, requests } = buildService();
  await service.start();
  for (const request of [
    { kind: "CreateBranch", repository: REPOSITORY, branch: "ctrl-013-x", fromSha: "a".repeat(40) },
    {
      kind: "OpenPullRequest",
      repository: REPOSITORY, branch: "ctrl-013-x", baseBranch: "main",
      baseSha: "b".repeat(40), title: "t", body: "b",
    },
    { kind: "MergePullRequest", repository: REPOSITORY, prNumber: 38, workItem: "CTRL-013", baseRef: "main", baseSha: "b".repeat(40), headSha: "a".repeat(40) },
  ]) {
    const response = await service.handleMessage(request);
    assert.equal(response.ok, false, request.kind);
    assert.equal(response.error.code, "AUTHORIZATION_REQUIRED", request.kind);
    assert.match(response.error.message, /connect GitHub/i);
  }
  assert.equal(requests.filter((request) => request.method === "POST").length, 0);
});

test("DiscoverRepositories is refused locally without a session token", async () => {
  const { service } = buildService();
  await service.start();
  const response = await service.handleMessage({ kind: "DiscoverRepositories" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "AUTHORIZATION_REQUIRED");
});

test("DiscoverRepositories routes through the app client with the session token", async () => {
  const identityOverride = fakeIdentity({ token: null });
  const { service, requests } = buildService({
    identityOverride,
    apiHandler: (url) => {
      if (url.startsWith("https://api.github.com/user/repos")) {
        return jsonResponse(200, [fakeRepositoryPayload("pectoraux/smallapp"), fakeRepositoryPayload("pectoraux/controller")], {});
      }
      return jsonResponse(404, {});
    },
  });
  await service.start();
  identityOverride._setToken(SESSION_TOKEN);
  const response = await service.handleMessage({ kind: "DiscoverRepositories" });
  assert.equal(response.ok, true);
  assert.deepEqual(
    response.repositories.map((repository) => repository.repository),
    ["pectoraux/controller", "pectoraux/smallapp"]
  );
  assert.equal(response.truncated, false);
  const discoveryRequest = requests.find((request) => request.url.startsWith("https://api.github.com/user/repos"));
  assert.equal(discoveryRequest.headers.Authorization, `Bearer ${SESSION_TOKEN}`);
});

test("SelectRepository keeps CTRL-012 semantics without a connection (public repo, no network)", async () => {
  const { service, requests } = buildService();
  await service.start();
  const response = await service.handleMessage({ kind: "SelectRepository", repository: REPOSITORY });
  assert.equal(response.ok, true);
  assert.equal(response.configuration.repository, REPOSITORY);
  // No GitHub API call happened for the selection itself.
  assert.equal(requests.some((request) => request.url.startsWith("https://api.github.com/repos/")), false);
});

test("SelectRepository with a connection is gated on observed accessibility", async () => {
  const identityOverride = fakeIdentity({ token: null });
  const { service } = buildService({
    identityOverride,
    apiHandler: (url) => {
      if (url === "https://api.github.com/repos/pectoraux/smallapp") {
        return jsonResponse(200, fakeRepositoryPayload("pectoraux/smallapp"));
      }
      return jsonResponse(404, {});
    },
  });
  await service.start();
  identityOverride._setToken(SESSION_TOKEN);
  const allowed = await service.handleMessage({ kind: "SelectRepository", repository: "pectoraux/smallapp" });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.configuration.repository, "pectoraux/smallapp");
  const denied = await service.handleMessage({ kind: "SelectRepository", repository: "pectoraux/no-access" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "REPOSITORY_INACCESSIBLE");
  // The refused selection was not persisted.
  const select = await service.handleMessage({ kind: "GetConfiguration" });
  assert.equal(select.configuration.repository, "pectoraux/smallapp");
});

test("ObservePullRequests works unauthenticated on a public repository", async () => {
  const { service } = buildService({
    apiHandler: (url) => {
      if (url.startsWith("https://api.github.com/repos/pectoraux/controller/pulls")) {
        return jsonResponse(200, [fakePullRequestPayload(38)]);
      }
      return jsonResponse(404, {});
    },
  });
  await service.start();
  const response = await service.handleMessage({ kind: "ObservePullRequests", repository: REPOSITORY, state: "open", headBranch: null });
  assert.equal(response.ok, true);
  assert.equal(response.pullRequests.length, 1);
  assert.equal(response.pullRequests[0].number, 38);
});

test("Observe* kinds route through the app client with strict repository validation", async () => {
  const { service } = buildService();
  await service.start();
  const invalid = await service.handleMessage({ kind: "ObservePullRequest", repository: "not canonical", prNumber: 1 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_REPOSITORY");
});

test("CorrelateWorkPullRequest returns the typed outcome through the boundary", async () => {
  const { service } = buildService({
    apiHandler: (url) => {
      if (url.includes("/pulls?")) {
        return jsonResponse(200, [fakePullRequestPayload(38)]);
      }
      return jsonResponse(404, {});
    },
  });
  await service.start();
  const response = await service.handleMessage({
    kind: "CorrelateWorkPullRequest",
    repository: REPOSITORY,
    branch: "ctrl-012-browser-control-surface",
    baseSha: "b".repeat(40),
    headSha: "a".repeat(40),
  });
  assert.equal(response.ok, true);
  assert.equal(response.outcome, "correlated");
  assert.equal(response.pullRequest.number, 38);
});

test("GetAuthorityState attaches the session token to GET-only content reads when connected", async () => {
  const authorityRequests = [];
  const base = buildAuthorityFetch();
  const authorityFetch = {
    fetchImpl: async (url, options = {}) => {
      authorityRequests.push({ url: String(url), headers: { ...(options.headers ?? {}) } });
      return base.fetchImpl(url, options);
    },
  };
  const { service } = buildService({
    authorityFetch,
    identityOverride: fakeIdentity({ token: SESSION_TOKEN }),
    apiHandler: (url, options) => {
      // The app-client accessibility gate reads the repository summary.
      if (url === "https://api.github.com/repos/pectoraux/controller") {
        return jsonResponse(200, fakeRepositoryPayload("pectoraux/controller"));
      }
      // The content client's branch-head read.
      return authorityFetch.fetchImpl(url, options);
    },
  });
  await service.start();
  const response = await service.handleMessage({ kind: "SelectRepository", repository: REPOSITORY });
  assert.equal(response.ok, true);
  const state = await service.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(state.ok, true);
  assert.equal(state.state.activeWorkItem, "CTRL-012");
  const rawReads = authorityRequests.filter((request) => request.url.startsWith("https://raw.githubusercontent.com/"));
  assert.equal(rawReads.length, 2);
  assert.ok(rawReads.every((request) => request.headers.Authorization === `Bearer ${SESSION_TOKEN}`));
});

test("GetAuthorityState stays unauthenticated without a connection", async () => {
  const authorityRequests = [];
  const base = buildAuthorityFetch();
  const authorityFetch = {
    fetchImpl: async (url, options = {}) => {
      authorityRequests.push({ url: String(url), headers: { ...(options.headers ?? {}) } });
      return base.fetchImpl(url, options);
    },
  };
  const { service } = buildService({
    authorityFetch,
    apiHandler: (url, options) => authorityFetch.fetchImpl(url, options),
  });
  await service.start();
  await service.handleMessage({ kind: "SelectRepository", repository: REPOSITORY });
  const state = await service.handleMessage({ kind: "GetAuthorityState" });
  assert.equal(state.ok, true);
  const rawReads = authorityRequests.filter((request) => request.url.startsWith("https://raw.githubusercontent.com/"));
  assert.ok(rawReads.every((request) => !("Authorization" in request.headers)));
});

test("unknown/malformed CTRL-013 messages fail closed and mutate nothing", async () => {
  const { service, storage } = buildService();
  await service.start();
  const before = JSON.stringify(storage._dump());
  for (const bad of [
    { kind: "Merge", repository: REPOSITORY, prNumber: 1, baseRef: "main", baseSha: "b".repeat(40), headSha: "a".repeat(40) },
    { kind: "MergePullRequest", repository: REPOSITORY, prNumber: 0, workItem: "X", baseRef: "main", baseSha: "b".repeat(40), headSha: "a".repeat(40) },
    { kind: "MergePullRequest", repository: REPOSITORY, prNumber: 1, workItem: "X", baseRef: "main", baseSha: "not-a-sha", headSha: "a".repeat(40) },
    { kind: "CreateBranch", repository: REPOSITORY, branch: "x", fromSha: "short" },
    { kind: "ObservePullRequests", repository: REPOSITORY, state: "bogus", headBranch: null },
    { kind: "ObservePullRequests", repository: REPOSITORY, state: "open" },
    { kind: "OpenPullRequest", repository: REPOSITORY, branch: "b", baseBranch: "main", baseSha: "b".repeat(40), title: "t", body: "b", secret: "smuggled" },
  ]) {
    const response = await service.handleMessage(bad);
    assert.equal(response.ok, false, JSON.stringify(bad));
    assert.ok(["UNKNOWN_MESSAGE", "MALFORMED_MESSAGE"].includes(response.error.code), JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(storage._dump()), before);
});

test("a corrupt store refuses the GitHub kinds like every other kind", async () => {
  const storage = fakeStorage({ "pectoraux.controller.configuration": { schemaVersion: "0.2", workers: "not-a-list" } });
  const { service } = buildService({ storage });
  await service.start();
  const response = await service.handleMessage({ kind: "ConnectGitHub" });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "CONFIGURATION_CORRUPT");
});
