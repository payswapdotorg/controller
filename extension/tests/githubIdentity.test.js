/**
 * GitHub OAuth device-flow identity tests (CTRL-013).
 *
 * Pins the authorization mechanism's fail-closed discipline end-to-end
 * with injected endpoints: the happy flow (pending -> slow_down ->
 * token), denial classes, expiry bounds, the not-configured deployment
 * state, malformed endpoint responses, and — critically — that the
 * token never leaves the identity closure (no message, no error
 * string, no persistence surface exists to carry it).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createGitHubIdentity, UNCONFIGURED_CLIENT_ID } from "../src/githubIdentity.js";
import { fakeDeviceFlowEndpoints, fakeResponse } from "./fixtures.js";

function buildIdentity(overrides = {}) {
  const flow = fakeDeviceFlowEndpoints();
  const identity = createGitHubIdentity({
    fetchImpl: overrides.fetchImpl ?? flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    getScopes: () => ["public_repo"],
    openTab: async () => {},
    sleep: async () => {},
    now: () => 0,
    ...overrides.wiring,
  });
  return { identity, flow };
}

test("the happy device flow: code -> pending -> slow_down -> token", async () => {
  const flow = fakeDeviceFlowEndpoints({ pendingRounds: 1, slowDownRounds: 1, interval: 5 });
  let clock = 0;
  const identity = createGitHubIdentity({
    fetchImpl: flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    openTab: async () => {},
    sleep: async () => {
      clock += 1;
    },
    now: () => clock * 1000,
  });
  const begun = await identity.beginDeviceFlow();
  assert.equal(begun.ok, true);
  assert.equal(begun.userCode, "ABCD-1234");
  assert.equal(begun.verificationUri, "https://github.com/login/device");
  const completed = await identity.completeDeviceFlow(begun);
  assert.equal(completed.ok, true);
  assert.equal(completed.scope, "public_repo");
  // The token is held for this session only.
  assert.equal(typeof identity.currentToken(), "string");
  assert.notEqual(identity.currentToken(), null);
});

test("invalidate discards the session token (the 401 fail-closed path)", async () => {
  const { identity } = buildIdentity();
  const begun = await identity.beginDeviceFlow();
  await identity.completeDeviceFlow(begun);
  assert.notEqual(identity.currentToken(), null);
  identity.invalidate();
  assert.equal(identity.currentToken(), null);
  identity.invalidate(); // idempotent
  assert.equal(identity.currentToken(), null);
});

test("no client id configured fails closed as AUTHORIZATION_NOT_CONFIGURED", async () => {
  for (const clientId of ["", UNCONFIGURED_CLIENT_ID, null]) {
    const identity = createGitHubIdentity({
      fetchImpl: fakeDeviceFlowEndpoints().fetchImpl,
      getClientId: () => clientId,
      openTab: async () => {},
    });
    const begun = await identity.beginDeviceFlow();
    assert.equal(begun.ok, false, String(clientId));
    assert.equal(begun.error.code, "AUTHORIZATION_NOT_CONFIGURED");
    assert.match(begun.error.message, /manifest/);
  }
});

test("an unrecognized client id (GitHub 404) is a typed deployment problem", async () => {
  const identity = createGitHubIdentity({
    fetchImpl: async () => fakeResponse(404, JSON.stringify({ error: "Not Found" })),
    getClientId: () => "Ov23wrongclientid0000000000",
    openTab: async () => {},
  });
  const begun = await identity.beginDeviceFlow();
  assert.equal(begun.ok, false);
  assert.equal(begun.error.code, "AUTHORIZATION_NOT_CONFIGURED");
  assert.match(begun.error.message, /client id/);
});

test("user denial (access_denied) is a typed AUTHORIZATION_FAILED", async () => {
  const { identity } = buildIdentity({ wiring: {} });
  const flow = fakeDeviceFlowEndpoints({ tokenOutcome: "access_denied", pendingRounds: 0 });
  const denied = createGitHubIdentity({
    fetchImpl: flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    sleep: async () => {},
    now: () => 0,
  });
  const begun = await denied.beginDeviceFlow();
  const completed = await denied.completeDeviceFlow(begun);
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "AUTHORIZATION_FAILED");
  assert.match(completed.error.message, /access_denied/);
  assert.equal(denied.currentToken(), null);
  void identity;
});

test("device flow disabled on the OAuth App is AUTHORIZATION_NOT_CONFIGURED", async () => {
  const flow = fakeDeviceFlowEndpoints({ tokenOutcome: "device_flow_disabled", pendingRounds: 0 });
  const identity = createGitHubIdentity({
    fetchImpl: flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    sleep: async () => {},
    now: () => 0,
  });
  const begun = await identity.beginDeviceFlow();
  const completed = await identity.completeDeviceFlow(begun);
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "AUTHORIZATION_NOT_CONFIGURED");
  assert.match(completed.error.message, /device flow/i);
});

test("expiry is bounded: the poll never outlives expires_in", async () => {
  const flow = fakeDeviceFlowEndpoints({ pendingRounds: 1000, expiresIn: 5, interval: 1 });
  let clock = 0;
  const identity = createGitHubIdentity({
    fetchImpl: flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    sleep: async () => {
      clock += 1;
    },
    now: () => clock * 1000,
  });
  const begun = await identity.beginDeviceFlow();
  const completed = await identity.completeDeviceFlow(begun);
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "AUTHORIZATION_FAILED");
  assert.match(completed.error.message, /expired/i);
});

test("a malformed device-code response fails closed as GITHUB_MALFORMED", async () => {
  for (const badBody of [
    "not json",
    JSON.stringify({ user_code: "ABCD-1234" }), // missing device_code/verification_uri
    JSON.stringify({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device", expires_in: "900" }),
    JSON.stringify({ device_code: "d", user_code: "u", verification_uri: "https://github.com/login/device", expires_in: 0 }),
  ]) {
    const identity = createGitHubIdentity({
      fetchImpl: async () => fakeResponse(200, badBody),
      getClientId: () => "Ov23cliEntId0123456789",
    });
    const begun = await identity.beginDeviceFlow();
    assert.equal(begun.ok, false, badBody);
    assert.equal(begun.error.code, "GITHUB_MALFORMED", badBody);
  }
});

test("an unreachable authorization endpoint fails closed as AUTHORIZATION_FAILED", async () => {
  const identity = createGitHubIdentity({
    fetchImpl: async () => {
      throw new TypeError("network down");
    },
    getClientId: () => "Ov23cliEntId0123456789",
  });
  const begun = await identity.beginDeviceFlow();
  assert.equal(begun.ok, false);
  assert.equal(begun.error.code, "AUTHORIZATION_FAILED");
  // The error message never carries a request body.
  assert.doesNotMatch(begun.error.message, /client_id/);
});

test("a token-endpoint 429 is a typed RATE_LIMITED, not a hang", async () => {
  const identity = createGitHubIdentity({
    fetchImpl: async () => fakeResponse(429, ""),
    getClientId: () => "Ov23cliEntId0123456789",
    sleep: async () => {},
    now: () => 0,
  });
  const begun = await identity.beginDeviceFlow();
  const completed = await identity.completeDeviceFlow(begun);
  assert.equal(completed.ok, false);
  assert.equal(completed.error.code, "RATE_LIMITED");
});

test("the verification page opens through the injectable tab primitive", async () => {
  const openedUrls = [];
  const identity = createGitHubIdentity({
    fetchImpl: fakeDeviceFlowEndpoints().fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    openTab: async (url) => {
      openedUrls.push(url);
    },
  });
  await identity.openVerificationPage("https://github.com/login/device");
  assert.deepEqual(openedUrls, ["https://github.com/login/device"]);
  // A failing tab open never throws (best effort; the URI is shown too).
  const throwing = createGitHubIdentity({
    fetchImpl: fakeDeviceFlowEndpoints().fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    openTab: async () => {
      throw new Error("no tabs");
    },
  });
  await throwing.openVerificationPage("https://github.com/login/device");
});

test("the token never appears in any typed result or error string", async () => {
  const flow = fakeDeviceFlowEndpoints({ pendingRounds: 0 });
  const identity = createGitHubIdentity({
    fetchImpl: flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    sleep: async () => {},
    now: () => 0,
  });
  const begun = await identity.beginDeviceFlow();
  const completed = await identity.completeDeviceFlow(begun);
  assert.equal(completed.ok, true);
  // The typed results expose NO token field at all...
  assert.equal("token" in completed, false);
  assert.equal("accessToken" in completed, false);
  assert.equal("access_token" in completed, false);
  // ...and no serialization of them contains it.
  assert.doesNotMatch(JSON.stringify(completed), /gho_testtokenvalue/);
  assert.doesNotMatch(JSON.stringify(begun), /gho_testtokenvalue/);
});

test("the device-code request carries exactly the public client id and scope", async () => {
  const flow = fakeDeviceFlowEndpoints();
  const identity = createGitHubIdentity({
    fetchImpl: flow.fetchImpl,
    getClientId: () => "Ov23cliEntId0123456789",
    getScopes: () => ["public_repo"],
  });
  await identity.beginDeviceFlow();
  const codeRequest = flow.requests.find((request) => request.url === "https://github.com/login/device/code");
  assert.deepEqual(Object.keys(codeRequest.params).sort(), ["client_id", "scope"]);
  assert.equal(codeRequest.params.client_id, "Ov23cliEntId0123456789");
  assert.equal(codeRequest.params.scope, "public_repo");
});
