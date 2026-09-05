/**
 * Configuration model and store tests (CTRL-012): immutable updates,
 * duplicate refusal, corrupt-store fail-closed, storage round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIGURATION_SCHEMA_VERSION,
  ConfigurationStore,
  clearGitHubConnection,
  emptyConfiguration,
  registerArchitect,
  registerWorker,
  selectRepository,
  setGitHubConnection,
  validateConfiguration,
  validateGitHubConnection,
} from "../src/configuration.js";
import { fakeStorage } from "./fixtures.js";

const ZAI = { name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" };
const CHATGPT = { name: "ChatGPT", providerKind: "chatgpt", providerUrl: "https://chatgpt.com" };

test("the empty configuration has the declared shape and schema version", () => {
  const empty = emptyConfiguration();
  assert.equal(empty.schemaVersion, CONFIGURATION_SCHEMA_VERSION);
  assert.deepEqual([...empty.workers], []);
  assert.deepEqual([...empty.architects], []);
  assert.equal(empty.repository, null);
});

test("worker registration is an immutable update", () => {
  const empty = emptyConfiguration();
  const result = registerWorker(empty, ZAI);
  assert.equal(result.ok, true);
  assert.equal(result.configuration.workers.length, 1);
  assert.equal(empty.workers.length, 0); // the original is untouched
  assert.equal(result.configuration.repository, null);
});

test("architect registration lands in the architect list only", () => {
  const withWorker = registerWorker(emptyConfiguration(), ZAI).configuration;
  const result = registerArchitect(withWorker, CHATGPT);
  assert.equal(result.ok, true);
  assert.equal(result.configuration.workers.length, 1);
  assert.equal(result.configuration.architects.length, 1);
});

test("duplicate names within a role are refused; the configuration is unchanged", () => {
  const once = registerWorker(emptyConfiguration(), ZAI).configuration;
  const twice = registerWorker(once, ZAI);
  assert.equal(twice.ok, false);
  assert.equal(twice.error.code, "INVALID_REGISTRATION");
  assert.match(twice.error.message, /already registered/);
  assert.equal(once.workers.length, 1);
});

test("same name across roles is allowed (distinct identities)", () => {
  const withWorker = registerWorker(emptyConfiguration(), ZAI).configuration;
  const result = registerArchitect(withWorker, { ...CHATGPT, name: "Z.ai" });
  assert.equal(result.ok, true);
});

test("repository selection is validated and immutable", () => {
  const base = emptyConfiguration();
  const ok = selectRepository(base, "pectoraux/controller");
  assert.equal(ok.ok, true);
  assert.equal(ok.configuration.repository, "pectoraux/controller");
  assert.equal(base.repository, null);
  const bad = selectRepository(base, "controller");
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "INVALID_REPOSITORY");
});

test("the store round-trips a full configuration", async () => {
  const storage = fakeStorage();
  const store = new ConfigurationStore({ storage });
  const loaded0 = await store.load();
  assert.equal(loaded0.ok, true);
  assert.equal(loaded0.configuration, null);

  const withWorker = registerWorker(emptyConfiguration(), ZAI).configuration;
  const withArchitect = registerArchitect(withWorker, CHATGPT).configuration;
  const withRepo = selectRepository(withArchitect, "pectoraux/controller").configuration;
  const persisted = await store.persist(withRepo);
  assert.equal(persisted.ok, true);

  const reloaded = new ConfigurationStore({ storage });
  const loaded = await reloaded.load();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.configuration, withRepo);
});

test("a corrupt store fails closed and refuses writes", async () => {
  const storage = fakeStorage({ "pectoraux.controller.configuration": { schemaVersion: "9.9" } });
  const store = new ConfigurationStore({ storage });
  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "CONFIGURATION_CORRUPT");
  assert.equal(store.isCorrupt(), true);

  const write = await store.persist(emptyConfiguration());
  assert.equal(write.ok, false);
  assert.equal(write.error.code, "CONFIGURATION_CORRUPT");
  // The corrupt bytes are still intact — no silent self-repair.
  assert.deepEqual(storage._dump(), {
    "pectoraux.controller.configuration": { schemaVersion: "9.9" },
  });
});

test("a store holding foreign-role registrations is corrupt", async () => {
  const workerRecord = registerWorker(emptyConfiguration(), ZAI).configuration.workers[0];
  const swapped = {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    workers: [workerRecord],
    architects: [{ ...workerRecord, role: "worker" }], // foreign role
    repository: null,
  };
  const storage = fakeStorage({ "pectoraux.controller.configuration": swapped });
  const store = new ConfigurationStore({ storage });
  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "CONFIGURATION_CORRUPT");
});

test("a store with an invalid repository identity is corrupt", async () => {
  const corrupted = {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    workers: [],
    architects: [],
    repository: "two/slashes/here",
  };
  const storage = fakeStorage({ "pectoraux.controller.configuration": corrupted });
  const store = new ConfigurationStore({ storage });
  const loaded = await store.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error.code, "CONFIGURATION_CORRUPT");
});

test("a storage write failure surfaces as INTERNAL_ERROR without state swap", async () => {
  const failing = {
    async get() {
      return {};
    },
    async set() {
      throw new Error("quota exceeded");
    },
  };
  const store = new ConfigurationStore({ storage: failing });
  await store.load();
  const write = await store.persist(emptyConfiguration());
  assert.equal(write.ok, false);
  assert.equal(write.error.code, "INTERNAL_ERROR");
});

test("validateConfiguration accepts the empty configuration", () => {
  const result = validateConfiguration(emptyConfiguration());
  assert.equal(result.ok, true);
  assert.deepEqual(result.configuration, emptyConfiguration());
});

// ---------------------------------------------------------------------------
// CTRL-013: the GitHub connection metadata and the 0.2 schema.
// ---------------------------------------------------------------------------

test("a 0.1 store migrates additively to the 0.2 shape in memory", () => {
  const legacy = {
    schemaVersion: "0.1",
    workers: [],
    architects: [],
    repository: "pectoraux/controller",
  };
  const validated = validateConfiguration(legacy);
  assert.equal(validated.ok, true);
  assert.equal(validated.configuration.schemaVersion, CONFIGURATION_SCHEMA_VERSION);
  assert.equal(validated.configuration.githubConnection, null);
  assert.equal(validated.configuration.repository, "pectoraux/controller");
});

test("a 0.1 store carrying connection data is corrupt (never guessed past)", () => {
  const legacy = {
    schemaVersion: "0.1",
    workers: [],
    architects: [],
    repository: null,
    githubConnection: { login: "x", name: null, avatarUrl: null },
  };
  const validated = validateConfiguration(legacy);
  assert.equal(validated.ok, false);
  assert.equal(validated.error.code, "CONFIGURATION_CORRUPT");
});

test("a 0.2 store requires the githubConnection field exactly once", () => {
  const missing = validateConfiguration({
    schemaVersion: "0.2", workers: [], architects: [], repository: null,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "CONFIGURATION_CORRUPT");

  const wrongType = validateConfiguration({
    schemaVersion: "0.2", workers: [], architects: [], repository: null,
    githubConnection: "connected",
  });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.error.code, "CONFIGURATION_CORRUPT");
});

test("a connection record carrying a token/secret/cookie field is corrupt", () => {
  for (const extra of [
    { login: "pectoraux", name: null, avatarUrl: null, token: "gho_x" },
    { login: "pectoraux", name: null, avatarUrl: null, password: "hunter2" },
    { login: "pectoraux", name: null, avatarUrl: null, cookie: "session=..." },
    { secret: "x", login: "pectoraux", name: null, avatarUrl: null },
  ]) {
    const validated = validateGitHubConnection(extra);
    assert.equal(validated.ok, false, JSON.stringify(extra));
    assert.equal(validated.error.code, "CONFIGURATION_CORRUPT", JSON.stringify(extra));
  }
  // And through the full configuration validation.
  const stored = validateConfiguration({
    schemaVersion: "0.2",
    workers: [],
    architects: [],
    repository: null,
    githubConnection: { login: "pectoraux", name: null, avatarUrl: null, token: "gho_x" },
  });
  assert.equal(stored.ok, false);
  assert.equal(stored.error.code, "CONFIGURATION_CORRUPT");
});

test("a valid connection record round-trips with nullable display fields", () => {
  const validated = validateGitHubConnection({ login: "pectoraux", name: "Pectoraux", avatarUrl: null });
  assert.equal(validated.ok, true);
  assert.deepEqual(validated.connection, { login: "pectoraux", name: "Pectoraux", avatarUrl: null });
  const viaConfiguration = validateConfiguration({
    schemaVersion: "0.2",
    workers: [],
    architects: [],
    repository: null,
    githubConnection: { login: "pectoraux", name: null, avatarUrl: "https://avatars.example/u/1.png" },
  });
  assert.equal(viaConfiguration.ok, true);
  assert.deepEqual(viaConfiguration.configuration.githubConnection, {
    login: "pectoraux",
    name: null,
    avatarUrl: "https://avatars.example/u/1.png",
  });
});

test("setGitHubConnection/clearGitHubConnection are immutable and validate", () => {
  const base = emptyConfiguration();
  const withWorker = registerWorker(base, { name: "Z.ai", providerKind: "zai", providerUrl: "https://chat.z.ai" });
  assert.ok(withWorker.ok);
  const set = setGitHubConnection(withWorker.configuration, { login: "pectoraux", name: null, avatarUrl: null });
  assert.equal(set.ok, true);
  assert.equal(set.configuration.githubConnection.login, "pectoraux");
  // The source configuration is untouched (immutable update).
  assert.equal(withWorker.configuration.githubConnection, null);
  assert.equal(set.configuration.workers.length, 1);

  const refused = setGitHubConnection(base, { login: "pectoraux", name: null, avatarUrl: null, token: "gho_x" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "CONFIGURATION_CORRUPT");

  const cleared = clearGitHubConnection(set.configuration);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.configuration.githubConnection, null);
  assert.equal(cleared.configuration.workers.length, 1);
  assert.equal(set.configuration.githubConnection.login, "pectoraux");
});
