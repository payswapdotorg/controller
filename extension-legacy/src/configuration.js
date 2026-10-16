/**
 * The extension's non-authoritative configuration model (CTRL-012 +
 * CTRL-013).
 *
 * The configuration holds exactly: registered Workers, registered
 * Architects, the selected repository identity, and (CTRL-013) the
 * GitHub connection METADATA — the authenticated account's display
 * identity only. It persists ONLY as extension-local configuration
 * (chrome.storage.local) and confers no authority: "Extension
 * configuration is never authoritative over roadmap, work-order,
 * machine-state, lifecycle, or merge policy" (work order, "GitHub
 * repository").
 *
 * The GitHub connection record is deliberately credential-free: it
 * carries the account login/name/avatar for display. The OAuth access
 * token NEVER lives here — it is session-only memory inside the
 * service worker (githubIdentity.js), discarded on restart and on any
 * 401. A store that smuggles a token/secret/cookie field into the
 * connection record is CORRUPT and fails closed (the closed-form
 * discipline refuses unknown fields).
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
 *
 * Schema history: 0.1 (CTRL-012: registrations + repository), 0.2
 * (CTRL-013: + githubConnection). A 0.1 store loads as the 0.2 shape
 * with githubConnection null — the migration is additive and
 * in-memory only; the next explicit update persists the 0.2 form.
 */

import { failure } from "./errors.js";
import {
  serializeRegistration,
  validateRegistration,
  validateRegistrationRecord,
} from "./registration.js";
import { validateRepositoryIdentity } from "./repository.js";

/** The configuration store's schema version. */
export const CONFIGURATION_SCHEMA_VERSION = "0.2";

/** Schema versions a stored configuration may carry (legacy accepted). */
const ACCEPTED_SCHEMA_VERSIONS = Object.freeze(["0.1", "0.2"]);

/**
 * The empty configuration (no registrations, no selected repository, no
 * GitHub connection).
 *
 * @returns {object} a fresh frozen configuration record
 */
export function emptyConfiguration() {
  return Object.freeze({
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    workers: Object.freeze([]),
    architects: Object.freeze([]),
    repository: null,
    githubConnection: null,
  });
}

/**
 * Validate a stored GitHub connection record (closed form).
 *
 * Exactly { login, name, avatarUrl }: login a non-empty string (the
 * account identity for display), name/avatarUrl a string or null.
 * Unknown fields are refused — a record carrying `token`, `password`,
 * `secret`, `cookie`, or anything else fails closed as CORRUPT.
 *
 * @param {unknown} value
 * @returns {{ ok: true, connection: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateGitHubConnection(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("CONFIGURATION_CORRUPT", "stored GitHub connection is not an object");
  }
  const present = Object.keys(value);
  const expected = ["login", "name", "avatarUrl"];
  const extra = present.filter((field) => !expected.includes(field));
  if (extra.length > 0) {
    return failure(
      "CONFIGURATION_CORRUPT",
      `stored GitHub connection has unknown field(s): ${extra.join(", ")} (closed form — credential material must never live in the store)`
    );
  }
  if (typeof value.login !== "string" || value.login.length === 0) {
    return failure("CONFIGURATION_CORRUPT", "stored GitHub connection 'login' must be a non-empty string");
  }
  for (const field of ["name", "avatarUrl"]) {
    if (value[field] !== null && (typeof value[field] !== "string" || value[field].length === 0)) {
      return failure("CONFIGURATION_CORRUPT", `stored GitHub connection '${field}' must be a non-empty string or null`);
    }
  }
  return {
    ok: true,
    connection: Object.freeze({
      login: value.login,
      name: value.name === undefined ? null : value.name,
      avatarUrl: value.avatarUrl === undefined ? null : value.avatarUrl,
    }),
  };
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
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    return failure(
      "CONFIGURATION_CORRUPT",
      `stored configuration schemaVersion '${String(value.schemaVersion)}' is not one of ${ACCEPTED_SCHEMA_VERSIONS.join(", ")}`
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
  let githubConnection = null;
  if (value.schemaVersion === "0.2") {
    if (value.githubConnection !== null && value.githubConnection !== undefined) {
      const validated = validateGitHubConnection(value.githubConnection);
      if (!validated.ok) {
        return validated;
      }
      githubConnection = validated.connection;
    } else if (!("githubConnection" in value)) {
      return failure("CONFIGURATION_CORRUPT", "stored configuration omits 'githubConnection'");
    } else if (value.githubConnection !== null) {
      return failure("CONFIGURATION_CORRUPT", "stored 'githubConnection' must be null or a connection record");
    }
  } else if (value.githubConnection !== undefined) {
    // A 0.1 store must not carry connection data it never had.
    return failure(
      "CONFIGURATION_CORRUPT",
      "stored configuration declares schema 0.1 but carries 'githubConnection' data"
    );
  }
  return {
    ok: true,
    configuration: Object.freeze({
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      workers: Object.freeze(workers),
      architects: Object.freeze(architects),
      repository,
      githubConnection,
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
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      workers: Object.freeze(role === "worker" ? next : [...configuration.workers]),
      architects: Object.freeze(role === "architect" ? next : [...configuration.architects]),
      repository: configuration.repository,
      githubConnection: configuration.githubConnection,
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
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      workers: Object.freeze([...configuration.workers]),
      architects: Object.freeze([...configuration.architects]),
      repository: identity.repository,
      githubConnection: configuration.githubConnection,
    }),
  };
}

/**
 * Record the GitHub connection metadata (immutable update). The record
 * is the closed connection form — display identity only, never a
 * credential (validateGitHubConnection refuses unknown fields).
 *
 * @returns {{ ok: true, configuration: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function setGitHubConnection(configuration, connection) {
  const validated = validateGitHubConnection(connection);
  if (!validated.ok) {
    // A connection record that fails the closed form is corrupt-shaped
    // input, not configuration corruption: surface it as the same
    // typed refusal class so nothing malformed is ever persisted.
    return validated;
  }
  return {
    ok: true,
    configuration: Object.freeze({
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      workers: Object.freeze([...configuration.workers]),
      architects: Object.freeze([...configuration.architects]),
      repository: configuration.repository,
      githubConnection: validated.connection,
    }),
  };
}

/**
 * Clear the GitHub connection metadata (immutable update).
 *
 * @returns {{ ok: true, configuration: object }}
 */
export function clearGitHubConnection(configuration) {
  return {
    ok: true,
    configuration: Object.freeze({
      schemaVersion: CONFIGURATION_SCHEMA_VERSION,
      workers: Object.freeze([...configuration.workers]),
      architects: Object.freeze([...configuration.architects]),
      repository: configuration.repository,
      githubConnection: null,
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
