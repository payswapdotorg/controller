/**
 * The Controller-to-extension typed message boundary (CTRL-012).
 *
 * This is the closed request/response vocabulary every extension
 * surface speaks. Requests are JSON objects with a `kind`
 * discriminator and exactly the fields that kind declares; responses
 * are typed values: `{ ok: true, ...payload }` or
 * `{ ok: false, error: { code, message } }` with a code from the frozen
 * ERROR_CODES set.
 *
 * Fail-closed rules (acceptance criterion 7):
 *   - an unknown `kind` is UNKNOWN_MESSAGE;
 *   - a malformed shape (missing fields, wrong types, EXTRA fields) is
 *     MALFORMED_MESSAGE — unknown fields are refused, never ignored,
 *     so no surface can smuggle state through an undeclared field;
 *   - a refused request never mutates extension configuration or any
 *     authoritative repository state (the extension holds no
 *     repository-mutation capability at all in CTRL-012).
 *
 * Message vocabulary (frozen for CTRL-012):
 *
 *   GetConfiguration      {}                          -> configuration view
 *   RegisterWorker        { name, providerKind, providerUrl }
 *   RegisterArchitect     { name, providerKind, providerUrl }
 *   SelectRepository      { repository }
 *   GetAuthorityState     {}                          -> authority projection
 *   OpenProviderTab       { role, name }              -> opened tab
 *   DiscoverProviderTabs  { role, name }              -> matching tabs
 */

import { failure } from "./errors.js";
import { requireExactFields } from "./forms.js";
import { ROLES } from "./providers.js";

/** The closed request vocabulary. */
export const REQUEST_KINDS = Object.freeze([
  "GetConfiguration",
  "RegisterWorker",
  "RegisterArchitect",
  "SelectRepository",
  "GetAuthorityState",
  "OpenProviderTab",
  "DiscoverProviderTabs",
]);

/** Field sets per kind (closed forms — exactly these fields). */
const KIND_FIELDS = Object.freeze({
  GetConfiguration: [],
  RegisterWorker: ["name", "providerKind", "providerUrl"],
  RegisterArchitect: ["name", "providerKind", "providerUrl"],
  SelectRepository: ["repository"],
  GetAuthorityState: [],
  OpenProviderTab: ["role", "name"],
  DiscoverProviderTabs: ["role", "name"],
});

/**
 * Validate an inbound request against the closed vocabulary.
 *
 * @param {unknown} value - the raw message object
 * @returns {{ ok: true, request: { kind: string } & Record<string, unknown> } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function validateRequest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("MALFORMED_MESSAGE", "request must be a JSON object");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !REQUEST_KINDS.includes(kind)) {
    return failure(
      "UNKNOWN_MESSAGE",
      `unknown request kind ${JSON.stringify(kind)} (vocabulary: ${REQUEST_KINDS.join(", ")})`
    );
  }
  const shape = requireExactFields(value, ["kind", ...KIND_FIELDS[kind]], `request ${kind}`);
  if (!shape.ok) {
    // Distinguish "malformed field shape" from unknown-kind: the forms
    // layer reports under MALFORMED_MESSAGE, which is what this is.
    return shape;
  }
  if (kind === "RegisterWorker" || kind === "RegisterArchitect") {
    for (const field of KIND_FIELDS[kind]) {
      if (typeof value[field] !== "string" || value[field].length === 0) {
        return failure(
          "MALFORMED_MESSAGE",
          `request ${kind}: field '${field}' must be a non-empty string`
        );
      }
    }
  }
  if (kind === "SelectRepository") {
    if (typeof value.repository !== "string" || value.repository.length === 0) {
      return failure("MALFORMED_MESSAGE", "request SelectRepository: field 'repository' must be a non-empty string");
    }
  }
  if (kind === "OpenProviderTab" || kind === "DiscoverProviderTabs") {
    if (typeof value.role !== "string" || !ROLES.includes(value.role)) {
      return failure(
        "MALFORMED_MESSAGE",
        `request ${kind}: field 'role' must be one of ${ROLES.join(", ")}`
      );
    }
    if (typeof value.name !== "string" || value.name.length === 0) {
      return failure("MALFORMED_MESSAGE", `request ${kind}: field 'name' must be a non-empty string`);
    }
  }
  return { ok: true, request: value };
}
