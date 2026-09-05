/**
 * Strict closed-object validation primitives shared by every typed form
 * of the CTRL-012 Browser Control Surface.
 *
 * Doctrine: every typed form is a *closed* object — exactly the declared
 * field set, each field strictly typed. Unknown or extra fields are
 * refused, never ignored. This is what structurally guarantees the
 * work order's "no credentials in extension-managed product state"
 * clause: a registration carrying a `password`, `token`, or `cookie`
 * field is not a looser shape to tolerate — it is a malformed form and
 * fails closed before anything is persisted.
 */

import { failure } from "./errors.js";

/**
 * Assert `value` is a plain object (not an array, not null) and that its
 * own enumerable keys are EXACTLY `expectedFields` (as a set — order is
 * irrelevant, membership is not).
 *
 * @returns {{ ok: true, value: Record<string, unknown> } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function requireExactFields(value, expectedFields, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("MALFORMED_MESSAGE", `${context}: expected a JSON object`);
  }
  const present = Object.keys(value);
  const expected = [...expectedFields];
  const missing = expected.filter((field) => !(field in value));
  const extra = present.filter((field) => !expected.includes(field));
  if (missing.length > 0) {
    return failure(
      "MALFORMED_MESSAGE",
      `${context}: missing field(s): ${missing.join(", ")}`
    );
  }
  if (extra.length > 0) {
    return failure(
      "MALFORMED_MESSAGE",
      `${context}: unknown field(s) refused: ${extra.join(", ")} (closed form — nothing is silently ignored)`
    );
  }
  return { ok: true, value };
}

/**
 * A strict string field: must be a string of length >= 1 after the
 * caller-specified normalization is applied by the caller. Here we only
 * check type and emptiness; semantic rules live with their form.
 */
export function requireString(value, field, context) {
  if (typeof value !== "string" || value.length === 0) {
    return failure("MALFORMED_MESSAGE", `${context}: field '${field}' must be a non-empty string`);
  }
  return { ok: true, value };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
