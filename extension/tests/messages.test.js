/**
 * Typed message-boundary validation tests (CTRL-012).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRequest, REQUEST_KINDS } from "../src/messages.js";

test("the request vocabulary is the frozen seven", () => {
  assert.deepEqual([...REQUEST_KINDS], [
    "GetConfiguration",
    "RegisterWorker",
    "RegisterArchitect",
    "SelectRepository",
    "GetAuthorityState",
    "OpenProviderTab",
    "DiscoverProviderTabs",
  ]);
});

test("each happy request form validates", () => {
  const happy = [
    { kind: "GetConfiguration" },
    { kind: "RegisterWorker", name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" },
    { kind: "RegisterArchitect", name: "ChatGPT", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" },
    { kind: "SelectRepository", repository: "pectoraux/controller" },
    { kind: "GetAuthorityState" },
    { kind: "OpenProviderTab", role: "worker", name: "Z.ai" },
    { kind: "DiscoverProviderTabs", role: "architect", name: "ChatGPT" },
  ];
  for (const request of happy) {
    const result = validateRequest(request);
    assert.equal(result.ok, true, JSON.stringify(request));
    assert.equal(result.request.kind, request.kind);
  }
});

test("non-objects and arrays are MALFORMED_MESSAGE", () => {
  for (const bad of [null, undefined, 42, "GetConfiguration", [], [{}], true]) {
    const result = validateRequest(bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MALFORMED_MESSAGE");
  }
});

test("unknown kinds are UNKNOWN_MESSAGE, never guessed", () => {
  for (const kind of ["Merge", "Approve", "CompleteWorkItem", "setRepository", "", "getconfiguration"]) {
    const result = validateRequest({ kind });
    assert.equal(result.ok, false, kind);
    assert.equal(result.error.code, "UNKNOWN_MESSAGE", kind);
  }
  // No merge/approval/completion vocabulary exists at all.
  assert.equal(REQUEST_KINDS.includes("Merge"), false);
  assert.equal(REQUEST_KINDS.includes("Approve"), false);
});

test("missing fields are MALFORMED_MESSAGE", () => {
  const result = validateRequest({ kind: "RegisterWorker", name: "Z.ai" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MALFORMED_MESSAGE");
  const result2 = validateRequest({ kind: "SelectRepository" });
  assert.equal(result2.error.code, "MALFORMED_MESSAGE");
});

test("extra fields are refused — the closed form tolerates nothing undeclared", () => {
  const smuggled = validateRequest({
    kind: "RegisterWorker",
    name: "Z.ai",
    providerKind: "zai",
    providerUrl: "https://chat.z.ai",
    password: "hunter2",
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.error.code, "MALFORMED_MESSAGE");
  assert.match(smuggled.error.message, /password/);

  const token = validateRequest({
    kind: "SelectRepository",
    repository: "pectoraux/controller",
    token: "ghp_xxxxxxxxxxxx",
  });
  assert.equal(token.ok, false);
  assert.equal(token.error.code, "MALFORMED_MESSAGE");

  const cookie = validateRequest({ kind: "GetConfiguration", cookie: "session=..." });
  assert.equal(cookie.ok, false);
  assert.equal(cookie.error.code, "MALFORMED_MESSAGE");
});

test("wrongly-typed fields are MALFORMED_MESSAGE", () => {
  const cases = [
    { kind: "RegisterWorker", name: 42, providerKind: "zai", providerUrl: "https://chat.z.ai" },
    { kind: "RegisterWorker", name: "Z.ai", providerKind: null, providerUrl: "https://chat.z.ai" },
    { kind: "RegisterArchitect", name: "ChatGPT", providerKind: "chatgpt", providerUrl: [] },
    { kind: "SelectRepository", repository: 7 },
    { kind: "OpenProviderTab", role: "supervisor", name: "Z.ai" },
    { kind: "DiscoverProviderTabs", role: "worker", name: "" },
  ];
  for (const request of cases) {
    const result = validateRequest(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error.code, "MALFORMED_MESSAGE", JSON.stringify(request));
  }
});

test("empty strings are refused for string fields", () => {
  const result = validateRequest({ kind: "RegisterWorker", name: "", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MALFORMED_MESSAGE");
});
