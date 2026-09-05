/**
 * Browser tab discovery primitives (CTRL-012).
 *
 * These are the generic primitives later provider adapters (CTRL-014
 * Z.ai, CTRL-015 ChatGPT) build on: discover whether a provider tab is
 * open, and open the provider's URL for HUMAN authentication.
 *
 * Deliberately generic:
 *   - discovery matches tabs by URL origin only — no DOM access, no
 *     content-script injection, no selectors, no provider page
 *     automation of any kind in CTRL-012;
 *   - opening a provider tab is offered for human authentication and is
 *     NEVER treated as proof of an authenticated session or of an
 *     Architect decision (work order, "Architect registration");
 *   - no provider host permissions are requested by the manifest: the
 *     extension does not read provider page content in CTRL-012.
 */

import { failure } from "./errors.js";

/**
 * Discover open tabs under a provider's origin (display-only
 * observation).
 *
 * @param {object} tabsApi - injected chrome.tabs surface
 * @param {string} providerUrl - a validated provider URL
 * @returns {Promise<{ ok: true, tabs: object[] } |
 *                    { ok: false, error: { code: string, message: string } }>}
 */
export async function discoverProviderTabs(tabsApi, providerUrl) {
  const origin = new URL(providerUrl).origin;
  let tabs;
  try {
    tabs = await tabsApi.query({ url: `${origin}/*` });
  } catch (err) {
    return failure("TABS_UNAVAILABLE", `tab discovery failed: ${err}`);
  }
  if (!Array.isArray(tabs)) {
    return failure("TABS_UNAVAILABLE", "tab discovery returned a non-list result");
  }
  return {
    ok: true,
    tabs: Object.freeze(
      tabs.map((tab) =>
        Object.freeze({
          id: tab.id,
          url: typeof tab.url === "string" ? tab.url : null,
          title: typeof tab.title === "string" ? tab.title : null,
        })
      )
    ),
  };
}

/**
 * Open a provider URL in a new tab for HUMAN authentication.
 *
 * The opened tab is a browser session reference — non-authoritative,
 * never proof of authentication, never a programmatic provider session.
 *
 * @param {object} tabsApi - injected chrome.tabs surface
 * @param {string} providerUrl - a validated provider URL
 * @returns {Promise<{ ok: true, opened: { tabId: number, url: string } } |
 *                    { ok: false, error: { code: string, message: string } }>}
 */
export async function openProviderTab(tabsApi, providerUrl) {
  let tab;
  try {
    tab = await tabsApi.create({ url: providerUrl, active: true });
  } catch (err) {
    return failure("TABS_UNAVAILABLE", `opening the provider tab failed: ${err}`);
  }
  if (typeof tab !== "object" || tab === null || typeof tab.id !== "number") {
    return failure("TABS_UNAVAILABLE", "opening the provider tab returned an unusable result");
  }
  return {
    ok: true,
    opened: Object.freeze({
      tabId: tab.id,
      url: typeof tab.url === "string" ? tab.url : providerUrl,
    }),
  };
}
