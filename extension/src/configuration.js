/**
 * The extension's non-authoritative configuration model (CTRL-012).
 *
 * The configuration holds exactly: registered Workers, registered
 * Architects, and the selected repository identity. It persists ONLY as
 * extension-local configuration (chrome.storage.local) and confers no
 * authority: "Extension configuration is never authoritative over
 * roadmap, work-order, machine-state, lifecycle, or merge policy"
 * (work order, "GitHub repository").
 *
 * Discipline mirrored from the Controller core:
 *   - immutable updates: every mutation computes a NEW configuration
 *     and the caller swaps the reference only after the store write
 *     succeeds (no partial writes, no in-memory drift on failure);
 *   - validation before persistence: a refused input never reaches
 *     storage (the tests pin storage byte-identity on refusals);
 *   - storage is re-validated on load: a malformed store is an explicit
 *     fail-closed CONFIGURATION_CORRUPT state — never silently reset,
 *     defaulted, or guessed past.
 */

import { failure } from "./errors.js";
import {
  serializeRegistration,
  validateRegistration,
  validateRegistrationRecord,
} from "./registration.js";
import { validateRepositoryIdentity } from "./repository.js";

/** The configuration store's schema version. */
export const CONFIGURATION_SCHEMA_VERSION = "0.1";

/**
 * The empty configuration (no registrations, no selected repository).
 *
 * @returns {object} a fresh frozen configuration record
 */
export function emptyConfiguration() {
  return Object.freeze({
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    workers: Object.freeze([]),
    architects: Object.freeze([]),
    repository: null,
  });
}

/**
 * Validate a configuration value (deserialized storage round-trip).
 *
 * @param {unknown} value
 * @returns {{ ok: true, configuration: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateConfiguration(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("CONFIGURATION_CORRUPT", "stored configuration is not an object");
  }
  if (value.schemaVersion !== CONFIGURATION_SCHEMA_VERSION) {
    return failure(
      "CONFIGURATION_CORRUPT",
      `stored configuration schemaVersion '${String(value.schemaVersion)}' is not '${CONFIGURATION_SCHEMA_VERSION}'`
    );
  }
  for (const field of ["workers", "architects"]) {
    if (!Array.isArray(value[field])) {
      return failure("CONFIGURATION_CORRUPT", `stored configuration '${field}' is not a list`);
    }
  }
  const workers = [];
  for (const record of value.workers) {
    const validated = validateRegistrationRecord(record);
    if (!validated.ok) {
      return failure(
        "CONFIGURATION_CORRUPT",
        `stored worker registration is invalid: ${validated.error.message}`
      );
    }
    if (validated.registration.role !== "worker") {
      return failure("CONFIGURATION_CORRUPT", "stored worker registration declares a foreign role");
    }
    workers.push(validated.registration);
  }
  const architects = [];
  for (const record of value.architects) {
    const validated = validateRegistrationRecord(record);
    if (!validated.ok) {
      return failure(
        "CONFIGURATION_CORRUPT",
        `stored architect registration is invalid: ${validated.error.message}`
      );
    }
    if (validated.registration.role !== "architect") {
      return failure("CONFIGURATION_CORRUPT", "stored architect registration declares a foreign role");
    }
    architects.push(validated.registration);
  }
  let repository = null;
  if (value.repository !== null && value.repository !== undefined) {
    const identity = validateRepositoryIdentity(value.repository);
    if (!identity.ok) {
      return failure(
        "CONFIGURATION_CORRUPT",
        `stored repository identity is invalid: ${identity.error.message}`
      );
    }
    repository = identity.repository;
  } else if (!("repository" in value)) {
    return failure("CONFIGURATION_CORRUPT", "stored configuration omits 'repository'");
  } else if (value.repository !== null) {
    return failure("CONFIGURATION_CORRUPT", "stored 'repository' must be null or a canonical identity");
  }
  return {
    ok: true,
    configuration: Object.freeze({
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      workers: Object.freeze(workers),
      architects: Object.freeze(architects),
      repository,
    }),
  };
}

/**
 * Validate a registration form for `role` against the current
 * configuration (strict field validation + duplicate-name refusal).
 *
 * @returns {{ ok: true, registration: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateNewRegistration(configuration, role, input) {
  const validated = validateRegistration({ role, ...input });
  if (!validated.ok) {
    return validated;
  }
  const existing = role === "worker" ? configuration.workers : configuration.architects;
  if (existing.some((r) => r.name === validated.registration.name)) {
    return failure(
      "INVALID_REGISTRATION",
      `a ${role} named '${validated.registration.name}' is already registered`
    );
  }
  return validated;
}

/**
 * Register a Worker (immutable update: returns a NEW configuration).
 */
export function registerWorker(configuration, input) {
  return _register(configuration, "worker", input);
}

/**
 * Register an Architect (immutable update: returns a NEW configuration).
 */
export function registerArchitect(configuration, input) {
  return _register(configuration, "architect", input);
}

/** @private */
function _register(configuration, role, input) {
  const validated = validateNewRegistration(configuration, role, input);
  if (!validated.ok) {
    return validated;
  }
  const list = role === "worker" ? configuration.workers : configuration.architects;
  const next = [...list, serializeRegistration(validated.registration)];
  return {
    ok: true,
    configuration: Object.freeze({
      schemaVersion: configuration.schemaVersion,
      workers: Object.freeze(role === "worker" ? next : [...configuration.workers]),
      architects: Object.freeze(role === "architect" ? next : [...configuration.architects]),
      repository: configuration.repository,
    }),
  };
}

/**
 * Select the controlled repository (immutable update).
 *
 * @returns {{ ok: true, configuration: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function selectRepository(configuration, repository) {
  const identity = validateRepositoryIdentity(repository);
  if (!identity.ok) {
    return identity;
  }
  return {
    ok: true,
    configuration: Object.freeze({
      schemaVersion: configuration.schemaVersion,
      workers: Object.freeze([...configuration.workers]),
      architects: Object.freeze([...configuration.architects]),
      repository: identity.repository,
    }),
  };
}

/**
 * The storage-backed configuration store.
 *
 * `storage` is injected (chrome.storage.local in the browser, a
 * deterministic fake in tests). Writes happen ONLY through here, and
 * only after full validation — the no-partial-write seam.
 */
export class ConfigurationStore {
  /**
   * @param {{ storage: object, key?: string }} options
   */
  constructor({ storage, key = "pectoraux.controller.configuration" }) {
    this._storage = storage;
    this._key = key;
    this._loaded = null; // null = not yet loaded; false = corrupt; object = valid
    this._corruption = null;
  }

  /**
   * Load and validate the stored configuration. A malformed store is
   * recorded as corruption (fail-closed), never defaulted.
   *
   * @returns {Promise<{ ok: true, configuration: object | null } |
   *                     { ok: false, error: object }>}
   */
  async load() {
    let stored;
    try {
      stored = await this._storage.get(this._key);
    } catch (err) {
      this._loaded = false;
      this._corruption = `storage read failed: ${err}`;
      return failure("CONFIGURATION_CORRUPT", this._corruption);
    }
    const value = stored && stored[this._key];
    if (value === undefined) {
      this._loaded = null;
      this._corruption = null;
      return { ok: true, configuration: null };
    }
    const validated = validateConfiguration(value);
    if (!validated.ok) {
      this._loaded = false;
      this._corruption = validated.error.message;
      return validated;
    }
    this._loaded = validated.configuration;
    this._corruption = null;
    return { ok: true, configuration: validated.configuration };
  }

  /**
   * Whether the store failed validation (fail-closed marker).
   *
   * @returns {boolean}
   */
  isCorrupt() {
    return this._loaded === false;
  }

  /**
   * The corruption explanation (operator telemetry).
   *
   * @returns {string | null}
   */
  corruptionReason() {
    return this._corruption;
  }

  /**
   * Persist a validated configuration. The write is the commit point:
   * callers swap in-memory state only after this resolves ok.
   *
   * @returns {Promise<{ ok: true } | { ok: false, error: object }>}
   */
  async persist(configuration) {
    if (this.isCorrupt()) {
      // A corrupt store is never written past: the operator resolves it
      // explicitly (documented recovery) — silent self-repair would be
      // an inferred fallback.
      return failure(
        "CONFIGURATION_CORRUPT",
        `configuration store is corrupt and refuses writes: ${this._corruption}`
      );
    }
    try {
      await this._storage.set({ [this._key]: configuration });
    } catch (err) {
      return failure("INTERNAL_ERROR", `configuration store write failed: ${err}`);
    }
    this._loaded = configuration;
    return { ok: true };
  }
}
