/**
 * Worker/Architect registration validation tests (CTRL-012).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRegistration, serializeRegistration, validateRegistrationRecord } from "../src/registration.js";
import { PROVIDERS, ROLES } from "../src/providers.js";

const worker = (input) => validateRegistration({ role: "worker", ...input });
const architect = (input) => validateRegistration({ role: "architect", ...input });

test("the MVP Worker registration validates (Z.ai at https://chat.z.ai)", () => {
  const result = worker({ name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(result.ok, true);
  assert.equal(result.registration.role, "worker");
  assert.equal(result.registration.provider.kind, "zai");
  assert.equal(result.registration.providerUrl, "https://chat.z.ai");
});

test("the MVP Architect registration validates (ChatGPT at https://chatgpt.com)", () => {
  const result = architect({ name: "ChatGPT", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" });
  assert.equal(result.ok, true);
  assert.equal(result.registration.role, "architect");
  assert.equal(result.registration.provider.kind, "chatgpt");
});

test("the provider registry is exactly the MVP pair with frozen roles", () => {
  assert.deepEqual(Object.keys(PROVIDERS), ["zai", "chatgpt"]);
  assert.deepEqual([...PROVIDERS.zai.roles], ["worker"]);
  assert.deepEqual([...PROVIDERS.chatgpt.roles], ["architect"]);
  assert.equal(PROVIDERS.zai.canonicalOrigin, "https://chat.z.ai");
  assert.equal(PROVIDERS.chatgpt.canonicalOrigin, "https://chatgpt.com");
  assert.deepEqual([...ROLES], ["worker", "architect"]);
});

test("role mismatch is refused: chatgpt cannot register as a Worker, zai as an Architect", () => {
  const asWorker = worker({ name: "Wrong", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" });
  assert.equal(asWorker.ok, false);
  assert.equal(asWorker.error.code, "INVALID_REGISTRATION");
  const asArchitect = architect({ name: "Wrong", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(asArchitect.ok, false);
  assert.equal(asArchitect.error.code, "INVALID_REGISTRATION");
});

test("unknown provider kinds are refused", () => {
  for (const kind of ["claude", "zai2", "", "CHATGPT", null, 42]) {
    const result = worker({ name: "X", providerKind: kind, providerUrl: "https://chat.z.ai" });
    assert.equal(result.ok, false, String(kind));
    assert.equal(result.error.code, "INVALID_REGISTRATION");
  }
});

test("URL origin must be EXACTLY the provider's canonical origin", () => {
  const badUrls = [
    "http://chat.z.ai",                       // not https
    "https://chat.z.ai.evil.com",             // lookalike host
    "https://evil.com",                       // foreign origin
    "https://chatgpt.com",                    // other provider's origin
    "https://user:pass@chat.z.ai",            // embedded credentials
    "https://chat.z.ai:8443",                 // non-default port
    "not-a-url",                              // unparseable
    "",                                       // empty
    "https://",                               // hostless
  ];
  for (const providerUrl of badUrls) {
    const result = worker({ name: "X", providerKind: "zai", providerUrl });
    assert.equal(result.ok, false, providerUrl);
    assert.equal(result.error.code, "INVALID_REGISTRATION", providerUrl);
  }
});

test("equivalent default-https origin is accepted (no path games)", () => {
  const result = worker({ name: "X", providerKind: "zai", providerUrl: "https://chat.z.ai/" });
  assert.equal(result.ok, true);
  const result2 = worker({ name: "X", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(result2.ok, true);
});

test("names are strictly validated", () => {
  const badNames = [
    "",                        // empty
    "   ",                     // whitespace-only
    " padded",                 // leading whitespace
    "padded ",                 // trailing whitespace
    "line\nbreak",             // control character
    "x".repeat(65),            // too long
  ];
  for (const name of badNames) {
    const result = worker({ name, providerKind: "zai", providerUrl: "https://chat.z.ai" });
    assert.equal(result.ok, false, JSON.stringify(name));
    assert.equal(result.error.code, "INVALID_REGISTRATION");
  }
  const ok = worker({ name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(ok.ok, true);
});

test("a 64-character name is the boundary maximum", () => {
  const name = "x".repeat(64);
  const result = worker({ name, providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(result.ok, true);
});

test("registrations are frozen (no downstream mutation)", () => {
  const result = worker({ name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.equal(Object.isFrozen(result.registration), true);
  assert.equal(Object.isFrozen(result.registration.provider), true);
});

test("stored-record re-validation reproduces the same registration", () => {
  const result = worker({ name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  const serialized = serializeRegistration(result.registration);
  const revalidated = validateRegistrationRecord(serialized);
  assert.equal(revalidated.ok, true);
  assert.deepEqual(revalidated.registration, result.registration);
});

test("corrupt stored records fail closed as CONFIGURATION_CORRUPT", () => {
  for (const bad of [
    null,
    42,
    "worker",
    { role: "worker" },
    { role: "worker", name: "X", provider: { kind: "zai" }, providerUrl: "https://chat.z.ai" },
    { role: "worker", name: "X", provider: "zai", providerUrl: "https://chat.z.ai" },
    { role: "worker", name: "X", provider: { kind: "claude", label: "C", canonicalOrigin: "https://c.com" }, providerUrl: "https://c.com" },
    { role: "worker", name: "X", provider: { kind: "zai", label: "Z.ai", canonicalOrigin: "https://chat.z.ai" }, providerUrl: "https://evil.com" },
  ]) {
    const result = validateRegistrationRecord(bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.code, "CONFIGURATION_CORRUPT", JSON.stringify(bad));
  }
});
