/**
 * Tab discovery primitive tests (CTRL-012): origin-scoped discovery,
 * tab opening for human authentication, typed failures.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverProviderTabs, openProviderTab } from "../src/tabDiscovery.js";
import { fakeTabsApi } from "./fixtures.js";

test("discovery matches only tabs under the provider origin", async () => {
  const tabsApi = fakeTabsApi({
    tabs: [
      { id: 1, url: "https://chat.z.ai/", title: "Z.ai" },
      { id: 2, url: "https://chat.z.ai/chat/abc", title: "Session" },
      { id: 3, url: "https://chatgpt.com/", title: "ChatGPT" },
      { id: 4, url: "https://github.com/", title: "GitHub" },
    ],
  });
  const result = await discoverProviderTabs(tabsApi, "https://chat.z.ai");
  assert.equal(result.ok, true);
  assert.deepEqual(result.tabs.map((t) => t.id), [1, 2]);
  assert.equal(tabsApi._queries().length, 1);
  assert.equal(tabsApi._queries()[0].url, "https://chat.z.ai/*");
});

test("discovery of an unopened provider returns an empty list (display-only)", async () => {
  const tabsApi = fakeTabsApi({ tabs: [] });
  const result = await discoverProviderTabs(tabsApi, "https://chatgpt.com");
  assert.equal(result.ok, true);
  assert.deepEqual([...result.tabs], []);
});

test("discovery failures are typed TABS_UNAVAILABLE", async () => {
  const tabsApi = fakeTabsApi({ queryFailure: new Error("tabs API unavailable") });
  const result = await discoverProviderTabs(tabsApi, "https://chat.z.ai");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TABS_UNAVAILABLE");
});

test("opening a provider tab creates a foreground tab with the provider URL", async () => {
  const tabsApi = fakeTabsApi({ tabs: [] });
  const result = await openProviderTab(tabsApi, "https://chat.z.ai");
  assert.equal(result.ok, true);
  assert.equal(typeof result.opened.tabId, "number");
  assert.equal(result.opened.url, "https://chat.z.ai");
  assert.deepEqual(tabsApi._created(), [{ url: "https://chat.z.ai", active: true }]);
});

test("tab-creation failures are typed TABS_UNAVAILABLE", async () => {
  const tabsApi = fakeTabsApi({ createFailure: new Error("window closed") });
  const result = await openProviderTab(tabsApi, "https://chat.z.ai");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TABS_UNAVAILABLE");
});

test("an unusable create result fails closed", async () => {
  const tabsApi = {
    async query() {
      return [];
    },
    async create() {
      return { no: "id" };
    },
  };
  const result = await openProviderTab(tabsApi, "https://chat.z.ai");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TABS_UNAVAILABLE");
});
