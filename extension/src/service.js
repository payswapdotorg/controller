/**
 * The background service worker — the CTRL-012 message router.
 *
 * Every extension surface (the popup, and later provider-adapter
 * surfaces) talks to the extension ONLY through the typed message
 * boundary (messages.js). This module is the single place a request is
 * validated and routed:
 *
 *   1. validate the request form (unknown/malformed -> typed refusal,
 *      nothing touched — acceptance criterion 7);
 *   2. route to the owning module (configuration, authority client, or
 *      tab discovery) — each module applies its own strict validation
 *      and returns typed values;
 *   3. persist configuration changes only AFTER full validation, and
 *      swap the in-memory reference only after the store write commits
 *      (no partial writes, no drift on failure);
 *   4. catch anything unexpected as INTERNAL_ERROR — fail closed, never
 *      guess.
 *
 * The service holds no repository-mutation capability of any kind: the
 * content client is GET-only, so no message, malformed or not, can
 * mutate authoritative repository state.
 */

import { ControllerContentClient } from "./controllerClient.js";
import {
  ConfigurationStore,
  emptyConfiguration,
  registerArchitect,
  registerWorker,
  selectRepository,
} from "./configuration.js";
import { projectAuthorityState } from "./authority.js";
import { validateRequest } from "./messages.js";
import { discoverProviderTabs, openProviderTab } from "./tabDiscovery.js";
import { failure } from "./errors.js";

/**
 * Build the controller service (fully injectable for offline tests).
 *
 * @param {{ storage: object, fetchImpl: Function, tabsApi: object,
 *           apiRoot?: string, rawRoot?: string }} wiring
 */
export function createControllerService({ storage, fetchImpl, tabsApi, apiRoot, rawRoot }) {
  const store = new ConfigurationStore({ storage });
  const client = new ControllerContentClient({ fetchImpl, ...(apiRoot ? { apiRoot } : {}), ...(rawRoot ? { rawRoot } : {}) });
  let configuration = null; // null until start() loads; never a guess
  let started = false;

  async function start() {
    const loaded = await store.load();
    configuration = loaded.ok ? (loaded.configuration ?? emptyConfiguration()) : null;
    started = true;
    return loaded;
  }

  /**
   * Handle one validated-boundary message.
   *
   * @param {unknown} request
   * @returns {Promise<{ ok: true } | { ok: false, error: object }>}
   */
  async function handleMessage(request) {
    try {
      const validated = validateRequest(request);
      if (!validated.ok) {
        return validated;
      }
      if (!started) {
        return failure("INTERNAL_ERROR", "service has not started (configuration not loaded)");
      }
      if (store.isCorrupt()) {
        // A corrupt configuration store is a fail-closed state for
        // EVERY request — including authority reads (the selected
        // repository lives in the refused store, so nothing honest can
        // be queried). Manual recovery is documented; the store never
        // silently resets itself.
        return failure(
          "CONFIGURATION_CORRUPT",
          `extension configuration store is corrupt: ${store.corruptionReason()} (manual recovery is documented in extension/README.md)`
        );
      }
      const configurationForRequest = configuration ?? emptyConfiguration();

      switch (validated.request.kind) {
        case "GetConfiguration":
          return { ok: true, configuration: configurationForRequest };

        case "RegisterWorker": {
          const next = registerWorker(configurationForRequest, validated.request);
          if (!next.ok) {
            return next;
          }
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "RegisterArchitect": {
          const next = registerArchitect(configurationForRequest, validated.request);
          if (!next.ok) {
            return next;
          }
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "SelectRepository": {
          const next = selectRepository(configurationForRequest, validated.request.repository);
          if (!next.ok) {
            return next;
          }
          const persisted = await store.persist(next.configuration);
          if (!persisted.ok) {
            return persisted;
          }
          configuration = next.configuration;
          return { ok: true, configuration };
        }

        case "GetAuthorityState": {
          const repository = configurationForRequest.repository;
          if (repository === null) {
            return failure(
              "REPOSITORY_NOT_SELECTED",
              "no repository is selected; select a controlled repository first"
            );
          }
          const projected = await projectAuthorityState({ client, repository });
          return projected;
        }

        case "OpenProviderTab":
        case "DiscoverProviderTabs": {
          const role = validated.request.role;
          const name = validated.request.name;
          const list = role === "worker" ? configurationForRequest.workers : configurationForRequest.architects;
          const registration = list.find((entry) => entry.name === name);
          if (registration === undefined) {
            return failure(
              "REGISTRATION_NOT_FOUND",
              `no ${role} named '${name}' is registered`
            );
          }
          if (validated.request.kind === "OpenProviderTab") {
            const opened = await openProviderTab(tabsApi, registration.providerUrl);
            return opened.ok ? { ok: true, opened: opened.opened } : opened;
          }
          const discovered = await discoverProviderTabs(tabsApi, registration.providerUrl);
          return discovered.ok ? { ok: true, tabs: discovered.tabs } : discovered;
        }

        default:
          // Unreachable: validateRequest admits only REQUEST_KINDS.
          return failure("UNKNOWN_MESSAGE", `unhandled request kind '${validated.request.kind}'`);
      }
    } catch (err) {
      return failure("INTERNAL_ERROR", `unexpected service failure: ${err}`);
    }
  }

  return { start, handleMessage, store };
}

// Browser wiring: construct the service over the real chrome surfaces
// and register the single message listener. Test environments (node)
// import createControllerService directly and never execute this block.
/* global chrome */
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  const service = createControllerService({
    storage: chrome.storage.local,
    fetchImpl: globalThis.fetch.bind(globalThis),
    tabsApi: chrome.tabs,
  });
  // Messages that arrive while the configuration load is still in
  // flight wait for it (the store read is async); start() never
  // rejects — a malformed store resolves as the corrupt fail-closed
  // state.
  const ready = service.start();
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    ready
      .then(() => service.handleMessage(request))
      .then(sendResponse, (err) => {
        sendResponse({ ok: false, error: { code: "INTERNAL_ERROR", message: String(err) } });
      });
    return true; // the response is async
  });
}
