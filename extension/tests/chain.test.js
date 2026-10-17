/**
 * The rotating intelligence chain — the owner's recovery requirement:
 * another chat.z.ai session -> local muse spark agent -> local GitHub
 * Copilot bridge -> any other HTTP agent. Tested over injected fakes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createChainDriver, createDriverFromConfig, createLocalHttpDriver } from "../src/intelligence.js";
import { fakeLog } from "./fixtures.js";

function okDriver(text, kind = "fake") {
  return { kind, async ask() { return { ok: true, text, driver: kind }; } };
}
function failDriver(kind, error = "dead") {
  return { kind, async ask() { return { ok: false, error, driver: kind }; } };
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

test("the chain rotates: chatzai fails -> the local muse spark endpoint answers", async () => {
  const { log, entries } = fakeLog();
  let chatAsked = 0;
  const chain = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
      { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: true },
    ],
    {
      chatDriverFactory: () => ({ kind: "chatzai-web", async ask() { chatAsked += 1; return { ok: false, error: "no live chat tab (resurrect disabled)", driver: "chatzai-web" }; } }),
      fetchImpl: async () => jsonResponse({ reply: "WAIT: muse spark acknowledged" }),
      failureThreshold: 2,
      cooldownMs: 60_000,
      log,
    },
  );
  const reply = await chain.ask({ kind: "dispatch", brief: "b" });
  assert.equal(reply.ok, true);
  assert.equal(reply.driver, "muse-spark"); // attribution names the answering source
  assert.equal(chatAsked, 1);
  assert.ok(entries.some((e) => /source "muse-spark" answered/.test(e.message)));
});

test("the chain benches a source after the failure threshold and rotates without it", async () => {
  let clock = 1_000_000;
  const chain = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
      { id: "copilot", kind: "local-http", url: "http://127.0.0.1:8789/", enabled: true },
    ],
    {
      chatDriverFactory: () => failDriver("chatzai-web", "tab dead"),
      fetchImpl: async () => jsonResponse({ reply: "APPROVE" }),
      failureThreshold: 2,
      cooldownMs: 60_000,
      log: () => {},
      now: () => clock,
    },
  );

  // Ask 1: chatzai fails once, copilot answers.
  assert.equal((await chain.ask({ kind: "review", brief: "b" })).driver, "copilot");
  // Ask 2: chatzai fails a second time -> benched.
  assert.equal((await chain.ask({ kind: "review", brief: "b" })).driver, "copilot");
  let health = chain.health().find((s) => s.id === "chatzai-web");
  assert.equal(health.consecutiveFailures, 2);
  assert.equal(health.benchedUntil !== null, true);

  // Ask 3: chatzai is benched — the chain must NOT call it (fail fast).
  let chatCalls = 0;
  // Rebuild the same chain with a counting chat driver to observe skipping.
  const chain2 = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
      { id: "copilot", kind: "local-http", url: "http://127.0.0.1:8789/", enabled: true },
    ],
    {
      chatDriverFactory: () => ({ kind: "chatzai-web", async ask() { chatCalls += 1; return { ok: false, error: "x", driver: "chatzai-web" }; } }),
      fetchImpl: async () => jsonResponse({ reply: "APPROVE" }),
      failureThreshold: 1,
      cooldownMs: 60_000,
      log: () => {},
      now: () => clock,
    },
  );
  await chain2.ask({ kind: "review", brief: "b" }); // fails once -> benched
  const callsAfterFirst = chatCalls;
  await chain2.ask({ kind: "review", brief: "b" }); // benched — not called
  assert.equal(chatCalls, callsAfterFirst);
  health = chain2.health().find((s) => s.id === "chatzai-web");
  assert.equal(health.consecutiveFailures, 1);
});

test("a benched source returns to rotation after the cooldown with a clean slate", async () => {
  let clock = 1_000_000;
  const chatScript = [false, false, true]; // fail, fail, then succeed
  const chain = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
      { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: true },
    ],
    {
      chatDriverFactory: () => ({
        kind: "chatzai-web",
        async ask() {
          const next = chatScript.shift();
          return next ? { ok: true, text: "APPROVE", driver: "chatzai-web" } : { ok: false, error: "dead", driver: "chatzai-web" };
        },
      }),
      fetchImpl: async () => jsonResponse({ reply: "WAIT: local acknowledged" }),
      failureThreshold: 2,
      cooldownMs: 60_000,
      log: () => {},
      now: () => clock,
    },
  );
  assert.equal((await chain.ask({ kind: "review", brief: "b" })).driver, "muse-spark"); // chatzai fail 1
  assert.equal((await chain.ask({ kind: "review", brief: "b" })).driver, "muse-spark"); // chatzai fail 2 -> benched
  clock += 61_000; // cooldown elapses
  const reply = await chain.ask({ kind: "review", brief: "b" }); // chatzai back, succeeds
  assert.equal(reply.driver, "chatzai-web");
  const health = chain.health().find((s) => s.id === "chatzai-web");
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.benchedUntil, null);
  assert.equal(health.answered, 1);
});

test("all sources failing is an honest typed failure naming every source", async () => {
  const chain = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
      { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: true },
      { id: "copilot", kind: "local-http", url: "http://127.0.0.1:8789/", enabled: true },
    ],
    {
      chatDriverFactory: () => failDriver("chatzai-web", "tab dead"),
      fetchImpl: async () => jsonResponse({ error: "no" }, 500),
      failureThreshold: 10,
      cooldownMs: 60_000,
      log: () => {},
    },
  );
  const reply = await chain.ask({ kind: "dispatch", brief: "b" });
  assert.equal(reply.ok, false);
  assert.equal(reply.driver, "chain");
  assert.match(reply.error, /chatzai-web/);
  assert.match(reply.error, /muse-spark/);
  assert.match(reply.error, /copilot/);
});

test("disabled and unusable sources are skipped; an empty chain fails honestly", async () => {
  const chain = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: false },
      { id: "no-url-agent", kind: "local-http", url: "", enabled: true },
    ],
    { chatDriverFactory: () => failDriver("chatzai-web"), fetchImpl: async () => jsonResponse({ reply: "x" }), log: () => {} },
  );
  const reply = await chain.ask({ kind: "dispatch", brief: "b" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /no usable source enabled/);
  const usable = chain.health().map((s) => s.usable);
  assert.deepEqual(usable, [false, false]);
});

test("health() reports per-source state for the popup", async () => {
  const chain = createChainDriver(
    [
      { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
      { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: true },
    ],
    {
      chatDriverFactory: () => failDriver("chatzai-web", "tab dead"),
      fetchImpl: async () => jsonResponse({ reply: "WAIT: ok" }),
      failureThreshold: 2,
      cooldownMs: 60_000,
      log: () => {},
    },
  );
  await chain.ask({ kind: "dispatch", brief: "b" });
  const health = Object.fromEntries(chain.health().map((s) => [s.id, s]));
  assert.equal(health["chatzai-web"].lastError, "tab dead");
  assert.equal(health["chatzai-web"].answered, 0);
  assert.equal(health["muse-spark"].answered, 1);
  assert.notEqual(health["muse-spark"].lastOkAt, null);
});

test("local-http asks are bounded by the timeout", async () => {
  const driver = createLocalHttpDriver(
    "http://127.0.0.1:8788/",
    () => new Promise(() => {}), // never settles
    80,
  );
  const reply = await driver.ask({ kind: "review", brief: "b" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /unreachable/);
});

test("driver selection: chain mode composes the rotating chain", async () => {
  const driver = createDriverFromConfig(
    {
      intelligence: {
        driver: "chain",
        timeoutSeconds: 10,
        failureThreshold: 1,
        cooldownMinutes: 1,
        chain: [
          { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
          { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: true },
        ],
      },
    },
    failDriver("chatzai-web", "tab dead"),
    async () => jsonResponse({ reply: "APPROVE" }),
  );
  assert.equal(driver.kind, "chain");
  const reply = await driver.ask({ kind: "review", brief: "b" });
  assert.equal(reply.ok, true);
  assert.equal(reply.driver, "muse-spark");
  assert.equal(typeof driver.health, "function");
});

test("a success resets the consecutive-failure counter", async () => {
  let clock = 1_000_000;
  const script = [false, true, false, false]; // fail, succeed, fail, fail
  const chain = createChainDriver(
    [{ id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true }],
    {
      chatDriverFactory: () => ({
        kind: "chatzai-web",
        async ask() {
          const next = script.shift();
          return next ? { ok: true, text: "APPROVE", driver: "chatzai-web" } : { ok: false, error: "flaky", driver: "chatzai-web" };
        },
      }),
      failureThreshold: 2,
      cooldownMs: 60_000,
      log: () => {},
      now: () => clock,
    },
  );
  await chain.ask({ kind: "review", brief: "b" }); // fail 1
  await chain.ask({ kind: "review", brief: "b" }); // success -> reset
  await chain.ask({ kind: "review", brief: "b" }); // fail 1 again (not benched)
  const health = chain.health()[0];
  assert.equal(health.consecutiveFailures, 1);
  assert.equal(health.benchedUntil, null);
});

void okDriver;
