/**
 * Config normalization for the v1.1 intelligence chain: validation, legacy
 * migration (v1 single-driver configs keep their behavior), watchdog timing
 * clamps, and the honest refusal posture.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, DEFAULT_CONFIG, DEFAULT_CHAIN } from "../src/config.js";
import { fakeStorage } from "./fixtures.js";
import { loadConfig, saveConfig } from "../src/config.js";

test("a fresh config defaults to the rotating chain with the owner's source order", () => {
  const { config, issues } = normalizeConfig({});
  assert.equal(issues.length, 0);
  assert.equal(config.intelligence.driver, "chain");
  assert.deepEqual(
    config.intelligence.chain.map((s) => [s.id, s.kind, s.enabled]),
    DEFAULT_CHAIN.map((s) => [s.id, s.kind, s.enabled]),
  );
  assert.equal(config.chat.watchdogIntervalSeconds, 30);
  assert.equal(config.chat.idleContinueAfterSeconds, 45);
});

test("chain entries are validated: malformed entries are dropped with issues", () => {
  const { config, issues } = normalizeConfig({
    intelligence: {
      driver: "chain",
      chain: [
        { id: "ok-agent", kind: "local-http", url: "http://127.0.0.1:9000/", enabled: true },
        { kind: "local-http", url: "http://x/", enabled: true }, // no id
        { id: "bad-kind", kind: "telepathy", url: "http://x/", enabled: true }, // refused kind
        "junk", // not an object
        { id: "no-url", kind: "local-http", url: "", enabled: true }, // kept but disabled
      ],
    },
  });
  const ids = config.intelligence.chain.map((s) => s.id);
  assert.deepEqual(ids, ["ok-agent", "no-url"]);
  assert.equal(config.intelligence.chain.find((s) => s.id === "no-url").enabled, false);
  assert.ok(issues.some((i) => /\[1\]\.id is empty/.test(i)));
  assert.ok(issues.some((i) => /"telepathy" refused/.test(i)));
  assert.ok(issues.some((i) => /\[3\] is not an object/.test(i)));
  assert.ok(issues.some((i) => /"no-url" has no url/.test(i)));
});

test("duplicate chain ids are renamed; the chain is capped at 8 entries", () => {
  const entries = [];
  for (let i = 0; i < 10; i += 1) entries.push({ id: "agent", kind: "local-http", url: `http://127.0.0.1:9${i}00/`, enabled: false });
  const { config, issues } = normalizeConfig({ intelligence: { driver: "chain", chain: entries } });
  assert.equal(config.intelligence.chain.length, 8);
  assert.equal(new Set(config.intelligence.chain.map((s) => s.id)).size, 8);
  assert.ok(issues.some((i) => /duplicated/.test(i)));
  assert.ok(issues.some((i) => /truncated to 8/.test(i)));
});

test("chatzai-web entries ignore urls; legacy configs migrate without changing behavior", () => {
  // v1 chatzai-web config: no chain field -> chain materializes with chatzai on.
  const chatzai = normalizeConfig({ intelligence: { driver: "chatzai-web", localEndpoint: "http://127.0.0.1:8765" } });
  assert.equal(chatzai.config.intelligence.driver, "chatzai-web");
  assert.equal(chatzai.config.intelligence.chain[0].id, "chatzai-web");
  assert.equal(chatzai.config.intelligence.chain[0].enabled, true);

  // v1 local-http config: the legacy endpoint becomes the first enabled source.
  const local = normalizeConfig({ intelligence: { driver: "local-http", localEndpoint: "http://127.0.0.1:8765" } });
  assert.equal(local.config.intelligence.driver, "local-http");
  assert.equal(local.config.intelligence.chain[0].id, "local-endpoint");
  assert.equal(local.config.intelligence.chain[0].url, "http://127.0.0.1:8765");
  assert.equal(local.config.intelligence.chain[0].enabled, true);

  // chatzai-web url is meaningless — cleared with an issue.
  const cleared = normalizeConfig({
    intelligence: { driver: "chain", chain: [{ id: "chatzai-web", kind: "chatzai-web", url: "http://x/", enabled: true }] },
  });
  assert.equal(cleared.config.intelligence.chain[0].url, "");
  assert.ok(cleared.issues.some((i) => /ignores its url/.test(i)));
});

test("chain mode with nothing enabled records the honest refusal", () => {
  const { config, issues } = normalizeConfig({
    intelligence: { driver: "chain", chain: [{ id: "chatzai-web", kind: "chatzai-web", url: "", enabled: false }] },
  });
  assert.equal(config.intelligence.driver, "chain");
  assert.ok(issues.some((i) => /no source is enabled/.test(i)));
});

test("threshold / cooldown / timeout / watchdog timings clamp into range", () => {
  const { config } = normalizeConfig({
    intelligence: { driver: "chain", timeoutSeconds: 9999, failureThreshold: 0, cooldownMinutes: 0 },
    chat: { watchdogIntervalSeconds: 0, idleContinueAfterSeconds: 100000 },
  });
  assert.equal(config.intelligence.timeoutSeconds, 600);
  assert.equal(config.intelligence.failureThreshold, 1);
  assert.equal(config.intelligence.cooldownMinutes, 1);
  assert.equal(config.chat.watchdogIntervalSeconds, 1);
  assert.equal(config.chat.idleContinueAfterSeconds, 600);
});

test("storage round-trip preserves the full chain", async () => {
  const storage = fakeStorage();
  const { config } = await saveConfig(storage, {
    intelligence: {
      driver: "chain",
      chain: [
        { id: "chatzai-web", kind: "chatzai-web", enabled: true },
        { id: "muse-spark", kind: "local-http", url: "http://127.0.0.1:8788/", enabled: true },
        { id: "copilot", kind: "local-http", url: "http://127.0.0.1:8789/", enabled: false },
      ],
    },
  });
  const reloaded = await loadConfig(storage);
  assert.deepEqual(reloaded.intelligence.chain, config.intelligence.chain);
  assert.equal(reloaded.intelligence.driver, "chain");
});

test("invalid driver values still refuse honestly (chain vocabulary)", () => {
  const { config, issues } = normalizeConfig({ intelligence: { driver: "skynet" } });
  assert.equal(config.intelligence.driver, DEFAULT_CONFIG.intelligence.driver);
  assert.ok(issues.some((i) => /"skynet" refused/.test(i)));
});
