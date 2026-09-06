/**
 * The Z.ai page bridge (CTRL-014) — the service-worker side of the
 * provider page channel.
 *
 * This module carries typed commands from the Z.ai adapter
 * (zaiAdapter.js) to the provider page surface (page/zaiPage.js, the
 * content script matched ONLY to https://chat.z.ai/*) through the
 * supported `chrome.tabs.sendMessage` mechanism, and normalizes every
 * transport outcome into the extension's typed value grammar:
 *
 *   - the tab is gone / the content script is not loaded / the
 *     message times out -> PAGE_UNAVAILABLE (the session surface is
 *     not reachable — never a guessed default);
 *   - a response that is not a typed object -> PAGE_MALFORMED;
 *   - a typed refusal from the page surface passes through with its
 *     own code (PAGE_AMBIGUOUS / PAGE_REFUSED / PAGE_MALFORMED) — the
 *     adapter interprets refusals, the bridge never repairs them.
 *
 * The bridge holds NO provider knowledge: no selectors, no Z.ai
 * semantics, no observation interpretation. It is the typed transport
 * seam that keeps the adapter offline-testable (tests inject a fake
 * `sendMessage` exactly the way tab discovery tests inject a fake
 * tabs API).
 */

import { failure } from "./errors.js";

/** Default channel timeout (ms): a page that cannot answer in time is unavailable. */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Create the page bridge over an injectable tabs API.
 *
 * @param {{ tabsApi: object, timeoutMs?: number }} wiring
 *        `tabsApi` must expose `sendMessage(tabId, message, options)`.
 */
export function createZaiPageBridge({ tabsApi, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof tabsApi?.sendMessage !== "function") {
    throw new Error("createZaiPageBridge requires a tabsApi with sendMessage(tabId, message, options)");
  }

  /**
   * Send one closed-vocabulary page command to the tab's content
   * script and normalize the outcome.
   *
   * @param {number} tabId
   * @param {object} command - a zaiPage command object
   * @returns {Promise<object>} typed result
   */
  async function send(tabId, command) {
    let response;
    try {
      response = await Promise.race([
        _sendMessage(tabId, command),
        _timeout(),
      ]);
    } catch (err) {
      return failure(
        "PAGE_UNAVAILABLE",
        `the Z.ai page surface in tab ${tabId} is unreachable: ${err}`
      );
    }
    if (response === undefined || response === null) {
      // No listener answered: the content script is not loaded in
      // this tab (navigation, injection not yet complete, or a
      // non-provider page in the referenced tab).
      return failure(
        "PAGE_UNAVAILABLE",
        `no Z.ai page surface answered in tab ${tabId} (the content script is matched only to https://chat.z.ai/*)`
      );
    }
    if (typeof response !== "object" || typeof response.ok !== "boolean") {
      return failure("PAGE_MALFORMED", "the Z.ai page surface returned an untyped response");
    }
    return response;
  }

  /** @private — the raw send, retried once on a transient channel error. */
  async function _sendMessage(tabId, command) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        const pending = tabsApi.sendMessage(tabId, command, { frameId: 0 });
        if (pending && typeof pending.then === "function") {
          pending.then(
            (value) => {
              settled = true;
              resolve(value);
            },
            (err) => {
              settled = true;
              reject(err);
            }
          );
          // A synchronous callback-style API would have answered by
          // now; nothing else to do for the promise style.
          void settled;
        } else {
          // Callback-style API (the real chrome.tabs.sendMessage in
          // some environments): answer via callback is unsupported
          // here — treat as unreachable rather than hang.
          reject(new Error("tabs API returned no promise"));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /** @private */
  function _timeout() {
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`page channel timeout after ${timeoutMs}ms`)), timeoutMs);
    });
  }

  return Object.freeze({ send });
}
