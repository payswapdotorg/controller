/**
 * The GitHub authorization identity (CTRL-013).
 *
 * Supported mechanism: the GitHub OAuth **device flow** (RFC 8628) — the
 * documented GitHub authorization path for public clients such as
 * browser extensions, which cannot keep a client secret. This is
 * deliberately NOT a pasted personal access token (forbidden by the
 * Work Order), NOT chrome.identity.getAuthToken (Google-provider-only),
 * and NOT the web redirect flow (whose code exchange requires embedding
 * the client secret in the package — forbidden).
 *
 * Flow (all endpoints are GitHub's documented public OAuth endpoints):
 *
 *   1. POST https://github.com/login/device/code  (client_id, scope)
 *      -> { device_code, user_code, verification_uri, expires_in, interval }
 *   2. The extension opens `verification_uri` (https://github.com/login/device)
 *      in a normal browser tab. The HUMAN authenticates at GitHub and
 *      enters the user_code — authentication happens entirely inside
 *      the provider UI, never inside the extension (work order,
 *      "GitHub connection"; handoff doctrine).
 *   3. The extension polls POST https://login/oauth/access_token
 *      (client_id, device_code, grant_type=urn:ietf:params:oauth:
 *      grant-type:device_code) until GitHub returns the token or a
 *      terminal error, bounded by `expires_in`.
 *
 * Token security (work order, security requirements — all pinned by
 * tests):
 *   - the access token lives ONLY in this module's closure for the
 *     service-worker session: it is never written to storage, never
 *     placed in a message, never included in an error string, and
 *     never logged;
 *   - `invalidate()` discards it (used when GitHub answers 401);
 *   - the service worker restarting loses it by construction — the
 *     next authorized call fail-closes with AUTHORIZATION_REQUIRED and
 *     the operator reconnects. Durable state is the connection
 *     *metadata* (account login) only, persisted by configuration.js.
 *
 * Everything is injectable (fetch, clock, sleep, client id, scopes,
 * tab opener) so the whole flow is testable offline under node --test.
 */

import { failure } from "./errors.js";

/** GitHub's device-flow endpoints (frozen, documented public OAuth URLs). */
export const DEVICE_CODE_URL = "https://github.com/login/device/code";
export const DEVICE_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * The shipped client-id PLACEHOLDER. Chrome refuses to load a manifest
 * whose `oauth2.client_id` is empty, so an unconfigured deployment
 * ships this recognizable sentinel instead: the identity treats it
 * exactly like an empty id (AUTHORIZATION_NOT_CONFIGURED, never a
 * guess), and the operator replaces it with their GitHub OAuth App's
 * public client id (a documented setup step in extension/README.md).
 */
export const UNCONFIGURED_CLIENT_ID = "PASTE-YOUR-GITHUB-OAUTH-CLIENT-ID-HERE";

/** The device-flow grant type (RFC 8628 §3.5, GitHub-documented). */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * GitHub device-flow poll errors that are terminal for the attempt.
 * `authorization_pending`/`slow_down` are the two retryable signals.
 */
const TERMINAL_POLL_ERRORS = Object.freeze([
  "expired_token",
  "unsupported_grant_type",
  "incorrect_client_credentials",
  "incorrect_device_code",
  "access_denied",
  "device_flow_disabled",
]);

/**
 * Build the GitHub identity.
 *
 * @param {{ fetchImpl: Function, getClientId: Function,
 *           getScopes?: Function, openTab?: Function,
 *           sleep?: Function, now?: Function,
 *           codeUrl?: string, tokenUrl?: string }} wiring
 */
export function createGitHubIdentity({
  fetchImpl,
  getClientId,
  getScopes = () => ["public_repo"],
  openTab = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  codeUrl = DEVICE_CODE_URL,
  tokenUrl = DEVICE_TOKEN_URL,
}) {
  let token = null; // session-only; never persisted, never messaged, never logged

  return {
    /** The session token (for the API client's header assembly only). */
    currentToken() {
      return token;
    },

    /** Discard the session token (the 401 fail-closed path). */
    invalidate() {
      token = null;
    },

    /**
     * Phase 1 — request a device code. No polling, no token: this
     * returns exactly what the operator must see (user_code +
     * verification_uri) plus the poll parameters.
     *
     * @returns {Promise<{ ok: true, deviceCode: string, userCode: string,
     *                     verificationUri: string, expiresIn: number,
     *                     interval: number, scope: string } |
     *                   { ok: false, error: object }>}
     */
    async beginDeviceFlow() {
      const clientId = getClientId();
      if (
        typeof clientId !== "string" ||
        clientId.length === 0 ||
        clientId === UNCONFIGURED_CLIENT_ID
      ) {
        return failure(
          "AUTHORIZATION_NOT_CONFIGURED",
          "no GitHub OAuth client id is configured: replace the oauth2.client_id placeholder in the extension manifest with your GitHub OAuth App's client id (see extension/README.md — a documented operator step; the client id is a public identifier, not a secret)"
        );
      }
      const scope = (getScopes() ?? []).join(" ");
      const response = await _formPost(fetchImpl, codeUrl, {
        client_id: clientId,
        ...(scope.length > 0 ? { scope } : {}),
      });
      if (!response.ok) {
        return response;
      }
      const body = response.value;
      for (const field of ["device_code", "user_code", "verification_uri"]) {
        if (typeof body[field] !== "string" || body[field].length === 0) {
          return failure("GITHUB_MALFORMED", `device-code response omits '${field}'`);
        }
      }
      const expiresIn = body.expires_in;
      const interval = body.interval;
      if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        return failure("GITHUB_MALFORMED", "device-code response 'expires_in' is not a positive number");
      }
      if (interval !== undefined && (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0)) {
        return failure("GITHUB_MALFORMED", "device-code response 'interval' is not a positive number");
        }
      return {
        ok: true,
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresIn,
        interval: interval === undefined ? 5 : interval,
        scope,
      };
    },

    /**
     * Phase 2 — poll for the token until the flow resolves. Bounded by
     * the device code's `expires_in`; `slow_down` widens the interval by
     * 5s per GitHub's documented discipline. The resolved token never
     * crosses any boundary: it stays in this closure.
     *
     * @param {{ deviceCode: string, expiresIn: number, interval: number }} flow
     * @returns {Promise<{ ok: true, scope: string } | { ok: false, error: object }>}
     */
    async completeDeviceFlow(flow) {
      const clientId = getClientId();
      if (typeof clientId !== "string" || clientId.length === 0) {
        return failure("AUTHORIZATION_NOT_CONFIGURED", "the GitHub OAuth client id disappeared mid-flow");
      }
      const deadline = now() + flow.expiresIn * 1000;
      let interval = flow.interval * 1000;
      for (;;) {
        if (now() >= deadline) {
          return failure(
            "AUTHORIZATION_FAILED",
            "the GitHub device code expired before the authorization completed; connect again"
          );
        }
        await sleep(interval);
        if (now() >= deadline) {
          return failure(
            "AUTHORIZATION_FAILED",
            "the GitHub device code expired before the authorization completed; connect again"
          );
        }
        const response = await _formPost(fetchImpl, tokenUrl, {
          client_id: clientId,
          device_code: flow.deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        });
        if (!response.ok) {
          // Transport/HTTP failure during polling is terminal for the
          // attempt: fail closed, never retry past an uncertain state.
          return response;
        }
        const body = response.value;
        if (typeof body.access_token === "string" && body.access_token.length > 0) {
          token = body.access_token;
          return { ok: true, scope: typeof body.scope === "string" ? body.scope : "" };
        }
        const error = body.error;
        if (error === "authorization_pending") {
          continue;
        }
        if (error === "slow_down") {
          interval += 5000;
          continue;
        }
        if (error === "device_flow_disabled" || error === "unsupported_grant_type") {
          return failure(
            "AUTHORIZATION_NOT_CONFIGURED",
            `GitHub refused the device flow ('${error}'): enable Device Flow in the OAuth App settings (see extension/README.md)`
          );
        }
        if (typeof error === "string" && TERMINAL_POLL_ERRORS.includes(error)) {
          return failure(
            "AUTHORIZATION_FAILED",
            `GitHub denied the authorization ('${error}')` + (error === "expired_token" ? "; the device code expired — connect again" : "")
          );
        }
        return failure("GITHUB_MALFORMED", `the token endpoint returned neither a token nor a known error ('${String(error)}')`);
      }
    },

    /**
     * Open the verification page for the operator (human authentication
     * happens at GitHub, never in the extension).
     *
     * @returns {Promise<void>}
     */
    async openVerificationPage(verificationUri) {
      try {
        await openTab(verificationUri);
      } catch {
        // Best effort: the URI is returned to the operator regardless —
        // a closed popup or failed tab never silently aborts the flow.
      }
    },
  };
}

/** @private — a form-encoded POST expecting a JSON body. */
async function _formPost(fetchImpl, url, params) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    // Never include request/response bodies here — fail closed on the
    // transport class only.
    return failure("AUTHORIZATION_FAILED", `authorization endpoint unreachable (${_errClass(err)})`);
  }
  if (response.status === 429) {
    return failure("RATE_LIMITED", _rateLimitMessage(response));
  }
  if (response.status === 404) {
    // On the device-code endpoint GitHub answers 404 for a client id
    // it does not recognize — a deployment-configuration problem,
    // typed as such (never a guess).
    return failure(
      "AUTHORIZATION_NOT_CONFIGURED",
      "GitHub does not recognize the OAuth client id (404) — check oauth2.client_id in the extension manifest"
    );
  }
  if (response.status === 403 || response.status >= 500) {
    return failure(
      "AUTHORIZATION_FAILED",
      `authorization endpoint answered HTTP ${response.status} (is the endpoint URL correct?)`
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return failure("AUTHORIZATION_FAILED", `authorization endpoint response unreadable (${_errClass(err)})`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return failure("GITHUB_MALFORMED", `authorization endpoint response is not JSON (${_errClass(err)})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("GITHUB_MALFORMED", "authorization endpoint response is not a JSON object");
  }
  return { ok: true, value };
}

/** @private — the error's class name only, never its message/body. */
function _errClass(err) {
  return err && typeof err.name === "string" ? err.name : String(err);
}

/** @private — rate-limit explanation from headers (no token material exists in headers). */
function _rateLimitMessage(response) {
  const headers = typeof response.headers?.get === "function" ? response.headers : null;
  const retryAfter = headers ? headers.get("Retry-After") : null;
  const reset = headers ? headers.get("X-RateLimit-Reset") : null;
  if (retryAfter !== null && retryAfter !== undefined) {
    return `authorization endpoint rate limited (retry after ${retryAfter}s)`;
  }
  if (reset !== null && reset !== undefined) {
    return `authorization endpoint rate limited (resets at epoch ${reset})`;
  }
  return "authorization endpoint rate limited";
}
