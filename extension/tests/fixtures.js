/**
 * Deterministic offline fixtures for the CTRL-012 extension tests.
 *
 * Everything here is synthetic but shape-faithful to the real authority
 * surfaces: the same machine-state schema (0.1), the same frozen
 * lifecycle vocabulary, the same work-order grammar. No network, no
 * credentials, no Chrome APIs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The extension root (for manifest-referenced-file checks).
 */
export const EXTENSION_ROOT = join(here, "..");

/**
 * A synthetic machine state mirroring the live repository's shape at
 * the CTRL-012 activation (activeWorkItem CTRL-012, READY, Stage 7,
 * completed x11).
 */
export const FIXTURE_REPOSITORY = "pectoraux/controller";
export const FIXTURE_SHA = "398c0e8c06c2bae4cb4a864990b36cb0fd47b88f";
export const FIXTURE_BRANCH = "main";

export function fixtureMachineState(overrides = {}) {
  return JSON.stringify({
    schemaVersion: "0.1",
    repository: FIXTURE_REPOSITORY,
    roadmap: "spec/roadmap/roadmap.md",
    architecture: "spec/architecture/controller-architecture.md",
    buildProcess: "spec/operations/controller-build-process.md",
    activeWorkItem: "CTRL-012",
    status: "READY",
    automationStage: "STAGE-7-END-TO-END-AUTONOMOUS-GOVERNED-LOOP",
    completed: [
      "CTRL-001", "CTRL-002", "CTRL-003", "CTRL-004", "CTRL-005",
      "CTRL-006", "CTRL-007", "CTRL-008", "CTRL-009", "CTRL-010", "CTRL-011",
    ],
    rules: {
      repositoryIsSourceOfTruth: true,
      controllerRuntimeStateIsReconstructible: true,
      onePrPerWorkItem: true,
      workerCannotMerge: true,
      failClosedOnContradiction: true,
      humanOperatorIsTemporaryMechanicalController: false,
      architectMustAnnounceAutomationStage: true,
    },
    nextAction:
      "CTRL-012 is READY and authorized. Dispatch it from the exact current main SHA.",
    ...overrides,
  });
}

export function fixtureWorkOrder(overrides = {}) {
  return [
    "# CTRL-012 — Browser Control Surface Foundation",
    "",
    "Status: `READY`",
    "",
    "## Authorization",
    "",
    "Synthetic fixture work order (shape-faithful to the real grammar).",
    "",
    ...overrides.lines ?? [],
  ].join("\n");
}

/**
 * A deterministic fake fetch implementing exactly the four GET shapes
 * the content client issues: repository lookup, branch head, machine
 * state at SHA, work order at SHA. Records every requested URL so
 * tests can pin the pinned-SHA read discipline.
 */
export function fakeAuthorityFetch({ machineState = fixtureMachineState(), workOrder = fixtureWorkOrder(), repository = FIXTURE_REPOSITORY, branch = FIXTURE_BRANCH, sha = FIXTURE_SHA, repositoryStatus = 200, stateStatus = 200, workOrderStatus = 200, transportFailures = [] } = {}) {
  const requested = [];
  const pendingFailures = [...transportFailures];
  const fetchImpl = async (url, _options) => {
    requested.push(String(url));
    if (pendingFailures.length > 0) {
      throw pendingFailures.shift();
    }
    const text = String(url);
    if (text === `https://api.github.com/repos/${repository}`) {
      if (repositoryStatus !== 200) {
        return fakeResponse(repositoryStatus);
      }
      return fakeResponse(200, JSON.stringify({ default_branch: branch, full_name: repository }));
    }
    if (text === `https://api.github.com/repos/${repository}/commits/${branch}`) {
      return fakeResponse(200, JSON.stringify({ sha }));
    }
    if (text === `https://raw.githubusercontent.com/${repository}/${sha}/spec/state/controller-program-state.json`) {
      if (stateStatus !== 200) {
        return fakeResponse(stateStatus);
      }
      return fakeResponse(200, machineState);
    }
    const workOrderMatch = text.match(
      /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/spec\/work-items\/([A-Za-z0-9-]+)\.md$/
    );
    if (workOrderMatch) {
      if (workOrderStatus !== 200) {
        return fakeResponse(workOrderStatus);
      }
      return fakeResponse(200, workOrder);
    }
    return fakeResponse(404);
  };
  return { fetchImpl, requested };
}

export function fakeResponse(status, body = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

/**
 * A deterministic in-memory chrome.storage.local fake.
 */
export function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(structuredClone(initial)));
  const written = [];
  return {
    async get(key) {
      if (typeof key === "string") {
        return { [key]: structuredClone(data.get(key)) };
      }
      const out = {};
      for (const k of key) {
        out[k] = structuredClone(data.get(k));
      }
      return out;
    },
    async set(items) {
      written.push(structuredClone(items));
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    },
    /** Test-only: the raw current data (for byte-identity proofs). */
    _dump() {
      return Object.fromEntries(data);
    },
    _written() {
      return written;
    },
  };
}

/**
 * A deterministic chrome.tabs fake.
 */
export function fakeTabsApi({ tabs = [], createFailure = null, queryFailure = null } = {}) {
  const created = [];
  const queries = [];
  return {
    async query(pattern) {
      queries.push(pattern);
      if (queryFailure) {
        throw queryFailure;
      }
      return tabs.filter((tab) => typeof tab.url === "string" && tab.url.startsWith(String(pattern.url).replace(/\*$/, "")));
    },
    async create(options) {
      if (createFailure) {
        throw createFailure;
      }
      const tab = { id: tabs.length + 101, ...options };
      tabs.push(tab);
      created.push(options);
      return tab;
    },
    _created() {
      return created;
    },
    _queries() {
      return queries;
    },
  };
}

/**
 * Read and parse the extension manifest (for the manifest tests).
 */
export function loadManifest() {
  return JSON.parse(readFileSync(join(EXTENSION_ROOT, "manifest.json"), "utf-8"));
}

/**
 * Read a text file relative to the extension root.
 */
export function readExtensionFile(relativePath) {
  return readFileSync(join(EXTENSION_ROOT, relativePath), "utf-8");
}
