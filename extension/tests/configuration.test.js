/**
 * Configuration model and store tests (CTRL-012): immutable updates,
 * duplicate refusal, corrupt-store fail-closed, storage round-trip.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIGURATION_SCHEMA_VERSION,
  ConfigurationStore,
  emptyConfiguration,
  registerArchitect,
  registerWorker,
  selectRepository,
  validateConfiguration,
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
