/**
 * Config model tests: normalization refusals, defaults, persistence round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig } from "../src/config.js";
import { fakeStorage } from "./fixtures.js";

test("absent config -> defaults", () => {
  const { config, issues } = normalizeConfig(undefined);
  assert.deepEqual(issues, []);
  assert.equal(config.github.mergeMethod, DEFAULT_CONFIG.github.mergeMethod);
  assert.equal(config.intelligence.driver, "chatzai-web");
  assert.equal(config.loop.intervalMinutes, 2);
});

test("invalid merge method and driver are refused with recorded issues", () => {
  const { config, issues } = normalizeConfig({
    github: { mergeMethod: "explode" },
    intelligence: { driver: "skynet" },
  });
  assert.equal(config.github.mergeMethod, "squash");
  assert.equal(config.intelligence.driver, "chatzai-web");
  assert.equal(issues.length, 2);
});

test("interval clamped into [1, 120]", () => {
  assert.equal(normalizeConfig({ loop: { intervalMinutes: 0 } }).config.loop.intervalMinutes, 1);
  assert.equal(normalizeConfig({ loop: { intervalMinutes: 9999 } }).config.loop.intervalMinutes, 120);
  assert.equal(normalizeConfig({ loop: { intervalMinutes: "x" } }).config.loop.intervalMinutes, 2);
});

test("branch prefix list: strings only, empty list falls back to defaults", () => {
  const kept = normalizeConfig({ safety: { onlyMergeBranchPrefixes: ["work/", "  feat/ "] } }).config.safety.onlyMergeBranchPrefixes;
  assert.deepEqual(kept, ["work/", "feat/"]);
  const fallback = normalizeConfig({ safety: { onlyMergeBranchPrefixes: [42, ""] } }).config.safety.onlyMergeBranchPrefixes;
  assert.deepEqual(fallback, DEFAULT_CONFIG.safety.onlyMergeBranchPrefixes);
});

test("enabled loop without GitHub wiring records the honest refusal", () => {
  const { issues } = normalizeConfig({ loop: { enabled: true }, github: { token: "", owner: "", repo: "" } });
  assert.ok(issues.some((i) => i.includes("github token/owner/repo")));
});

test("storage round-trip: save then load yields the same normalized config", async () => {
  const storage = fakeStorage();
  const saved = await saveConfig(storage, { github: { token: "t", owner: "payswapdotorg", repo: "arena-2.0" } });
  assert.deepEqual(saved.issues, []);
  const loaded = await loadConfig(storage);
  assert.equal(loaded.github.owner, "payswapdotorg");
  assert.equal(loaded.github.repo, "arena-2.0");
});

test("chat tabId survives as a number; junk is refused to null", () => {
  assert.equal(normalizeConfig({ chat: { tabId: 77 } }).config.chat.tabId, 77);
  assert.equal(normalizeConfig({ chat: { tabId: "77" } }).config.chat.tabId, null);
});
