/**
 * The chatzai-web intelligence driver (background side).
 *
 * Owns the attached chat.z.ai tab: validates liveness, sends briefs through
 * the content-script boundary, and RESURRECTS dead sessions — when the
 * attached tab is gone (closed, navigated away, crashed), it opens a fresh
 * chat.z.ai tab, waits for the composer, replays the standing directive so
 * the session picks the loop back up, and re-pins the tab id in config.
 * This is the "without me even needing to enter a continue button" surface.
 */

export function createChatzaiWebDriver(deps) {
  const {
    tabs, // chrome.tabs-like: query, get, create, sendMessage, waitUntil
    messaging, // sendToTab(tabId, message) -> Promise<response>
    config, // live config provider () => config
    log,
    now = () => new Date().toISOString(),
  } = deps;

  const CHAT_URL = "https://chat.z.ai/";
  const RESURRECT_WAIT_MS = 30_000;

  async function pingTab(tabId) {
    return messaging.sendToTab(tabId, { type: "chatzai:ping" });
  }

  async function liveChatTab() {
    const chatConfig = config().chat;
    if (typeof chatConfig.tabId === "number") {
      const tab = await tabs.get(chatConfig.tabId).catch(() => null);
      if (tab && /^https?:\/\/(chat\.z\.ai|[^/]*\.z\.ai)\//.test(tab.url ?? "")) {
        const pong = await pingTab(tab.id).catch(() => null);
        if (pong?.ok && pong.ready) return tab;
      }
    }
    // Discovery: any pinned/normal chat.z.ai tab already open.
    const found = await tabs.query({ url: "https://chat.z.ai/*" }).catch(() => []);
    for (const tab of found ?? []) {
      const pong = await pingTab(tab.id).catch(() => null);
      if (pong?.ok && pong.ready) return tab;
    }
    return null;
  }

  async function openFreshSession() {
    const tab = await tabs.create({ url: CHAT_URL, active: false });
    const deadline = Date.now() + RESURRECT_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const pong = await pingTab(tab.id).catch(() => null);
      if (pong?.ok && pong.ready) return tab;
    }
    return tab; // may not be ready yet — the ask() below will report honestly.
  }

  return {
    kind: "chatzai-web",
    /** Attach a chat tab now (used by the popup "attach" button). */
    async attach() {
      const tab = await liveChatTab();
      if (tab) return { ok: true, tabId: tab.id, reused: true };
      const fresh = await openFreshSession();
      return { ok: true, tabId: fresh.id, reused: false };
    },
    async ask(input) {
      let tab = await liveChatTab();
      if (!tab) {
        if (!config().chat.resurrect) {
          return { ok: false, error: "no live chat.z.ai tab (resurrect disabled)", driver: "chatzai-web" };
        }
        log({ at: now(), kind: "resurrect", level: "info", message: "chat tab dead — opening a fresh session and replaying the standing directive" });
        tab = await openFreshSession();
        if (!tab) return { ok: false, error: "failed to open a chat.z.ai tab", driver: "chatzai-web" };
        const directive = config().chat.directive;
        const seeded = await messaging
          .sendToTab(tab.id, { type: "chatzai:send", text: directive })
          .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
        if (!seeded?.ok) {
          return { ok: false, error: `session resurrection incomplete (directive send failed: ${seeded?.error ?? "unknown"})`, driver: "chatzai-web" };
        }
      }
      const response = await messaging
        .sendToTab(tab.id, { type: "chatzai:send", text: input.brief })
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
      if (!response?.ok) {
        return { ok: false, error: response?.error ?? "chat tab did not answer", driver: "chatzai-web" };
      }
      return { ok: true, text: response.text, driver: "chatzai-web" };
    },
  };
}
