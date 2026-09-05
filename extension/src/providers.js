/**
 * The closed provider registry — the browser/provider abstraction
 * boundary of CTRL-012.
 *
 * This registry is the *only* place provider knowledge lives in the
 * Browser Control Surface. A provider is an execution endpoint for one
 * role (Worker or Architect) at one canonical web origin. The
 * MVP set is frozen by the work order and the fresh-session handoff:
 *
 *   Worker:    Z.ai    at https://chat.z.ai
 *   Architect: ChatGPT at https://chatgpt.com
 *
 * What deliberately does NOT live here (or anywhere in CTRL-012): any
 * provider-specific UI selectors, model-selection automation, prompt
 * submission automation, popup/hang recovery, or DOM observation.
 * Those belong to the provider adapters of CTRL-014 (Z.ai) and
 * CTRL-015 (ChatGPT). This module carries names, roles, and origins —
 * nothing else.
 */

import { failure } from "./errors.js";

/** The two operator roles a provider registration can serve. */
export const ROLES = Object.freeze(["worker", "architect"]);

/**
 * The frozen MVP provider registry.
 *
 * `roles` lists the roles the provider supports; `canonicalOrigin` is
 * the exact https origin the provider's registration URLs must match.
 */
export const PROVIDERS = Object.freeze({
  zai: Object.freeze({
    kind: "zai",
    label: "Z.ai",
    roles: Object.freeze(["worker"]),
    canonicalOrigin: "https://chat.z.ai",
  }),
  chatgpt: Object.freeze({
    kind: "chatgpt",
    label: "ChatGPT",
    roles: Object.freeze(["architect"]),
    canonicalOrigin: "https://chatgpt.com",
  }),
});

/**
 * Look up a provider by its kind identifier.
 *
 * @param {unknown} kind
 * @returns {{ ok: true, provider: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function lookupProvider(kind) {
  if (typeof kind !== "string" || !(kind in PROVIDERS)) {
    return failure(
      "INVALID_REGISTRATION",
      `unknown provider kind '${String(kind)}' (supported: ${Object.keys(PROVIDERS).join(", ")})`
    );
  }
  return { ok: true, provider: PROVIDERS[kind] };
}

/**
 * Whether `provider` supports `role`.
 *
 * @param {object} provider - a PROVIDERS value
 * @param {string} role - one of ROLES
 * @returns {boolean}
 */
export function providerSupportsRole(provider, role) {
  return provider.roles.includes(role);
}
