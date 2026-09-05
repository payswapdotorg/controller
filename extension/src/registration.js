/**
 * Worker/Architect registration validation (CTRL-012).
 *
 * A registration is NON-AUTHORITATIVE extension configuration: a name,
 * a provider kind, and the provider URL. It is display/connection
 * metadata only — it confers no authority over the controlled
 * repository, the roadmap, work orders, machine state, lifecycle, or
 * merge policy (spec/work-items/CTRL-012.md, "GitHub repository" and
 * the architecture's browser-extension responsibilities).
 *
 * Validation is strict and total:
 *   - `name` is a non-empty trimmed string of 1..64 visible characters;
 *   - `providerKind` must be in the closed provider registry and must
 *     support the requested role (Worker registrations need a
 *     worker-capable provider; Architect registrations an
 *     architect-capable one);
 *   - `providerUrl` must be an https URL with no userinfo whose origin
 *     is EXACTLY the provider's canonical origin — http, lookalike
 *     hosts, embedded credentials, or any other origin is refused.
 *
 * The extension never requests or stores provider passwords: the closed
 * form has no field for a secret, and unknown fields are refused by the
 * forms layer before this module even runs.
 */

import { failure } from "./errors.js";
import { lookupProvider, providerSupportsRole, ROLES } from "./providers.js";

const NAME_MAX_LENGTH = 64;

/**
 * Validate one registration record for `role`.
 *
 * @param {{ role: string, name: unknown, providerKind: unknown, providerUrl: unknown }} input
 * @returns {{ ok: true, registration: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateRegistration({ role, name, providerKind, providerUrl }) {
  const context = `${role} registration`;
  if (!ROLES.includes(role)) {
    return failure("INVALID_REGISTRATION", `unknown role '${String(role)}'`);
  }
  if (typeof name !== "string") {
    return failure("INVALID_REGISTRATION", `${context}: 'name' must be a string`);
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    return failure(
      "INVALID_REGISTRATION",
      `${context}: 'name' must be 1..${NAME_MAX_LENGTH} characters (after trimming)`
    );
  }
  if (trimmed !== name) {
    return failure(
      "INVALID_REGISTRATION",
      `${context}: 'name' has leading/trailing whitespace`
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return failure("INVALID_REGISTRATION", `${context}: 'name' contains control characters`);
  }

  const providerResult = lookupProvider(providerKind);
  if (!providerResult.ok) {
    return providerResult;
  }
  const provider = providerResult.provider;
  if (!providerSupportsRole(provider, role)) {
    return failure(
      "INVALID_REGISTRATION",
      `${context}: provider '${provider.kind}' does not serve the ${role} role (roles: ${provider.roles.join(", ")})`
    );
  }

  if (typeof providerUrl !== "string" || providerUrl.length === 0) {
    return failure("INVALID_REGISTRATION", `${context}: 'providerUrl' must be a non-empty string`);
  }
  let url;
  try {
    url = new URL(providerUrl);
  } catch {
    return failure("INVALID_REGISTRATION", `${context}: 'providerUrl' is not a parseable URL`);
  }
  if (url.protocol !== "https:") {
    return failure(
      "INVALID_REGISTRATION",
      `${context}: 'providerUrl' must use https (got '${url.protocol}')`
    );
  }
  if (url.username !== "" || url.password !== "") {
    return failure("INVALID_REGISTRATION", `${context}: 'providerUrl' carries embedded credentials`);
  }
  if (url.origin !== provider.canonicalOrigin) {
    return failure(
      "INVALID_REGISTRATION",
      `${context}: 'providerUrl' origin '${url.origin}' does not match the provider's canonical origin '${provider.canonicalOrigin}'`
    );
  }

  return {
    ok: true,
    registration: Object.freeze({
      role,
      name,
      provider: Object.freeze({
        kind: provider.kind,
        label: provider.label,
        canonicalOrigin: provider.canonicalOrigin,
      }),
      providerUrl,
    }),
  };
}

/**
 * The closed serialization form of a registration record (exactly these
 * fields — the persisted configuration round-trips this shape).
 *
 * @param {object} registration - a validated registration
 * @returns {object} a frozen plain record
 */
export function serializeRegistration(registration) {
  return Object.freeze({
    role: registration.role,
    name: registration.name,
    provider: Object.freeze({
      kind: registration.provider.kind,
      label: registration.provider.label,
      canonicalOrigin: registration.provider.canonicalOrigin,
    }),
    providerUrl: registration.providerUrl,
  });
}

/**
 * Re-validate a deserialized registration record (storage round-trip).
 *
 * @param {unknown} value
 * @returns {{ ok: true, registration: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateRegistrationRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("CONFIGURATION_CORRUPT", "registration record is not an object");
  }
  const record = value;
  for (const field of ["role", "name", "provider", "providerUrl"]) {
    if (!(field in record)) {
      return failure("CONFIGURATION_CORRUPT", `registration record omits '${field}'`);
    }
  }
  const provider = record.provider;
  if (
    typeof provider !== "object" ||
    provider === null ||
    Array.isArray(provider) ||
    typeof provider.kind !== "string" ||
    typeof provider.label !== "string" ||
    typeof provider.canonicalOrigin !== "string"
  ) {
    return failure("CONFIGURATION_CORRUPT", "registration record carries a malformed provider");
  }
  if (typeof record.providerUrl !== "string") {
    return failure("CONFIGURATION_CORRUPT", "registration record 'providerUrl' is not a string");
  }
  // Re-derive against the live registry: a stored registration must
  // still satisfy every strict rule (the registry may have moved on).
  const revalidated = validateRegistration({
    role: record.role,
    name: record.name,
    providerKind: provider.kind,
    providerUrl: record.providerUrl,
  });
  if (!revalidated.ok) {
    // A stored record failing live validation is corruption, not an
    // operator input error — the store is refused as a whole.
    return failure("CONFIGURATION_CORRUPT", `stored registration no longer validates: ${revalidated.error.message}`);
  }
  return { ok: true, registration: revalidated.registration };
}
