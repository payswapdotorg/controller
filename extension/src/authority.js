/**
 * The repository-derived authority projection (CTRL-012).
 *
 * This module reads EXACTLY the two authority surfaces the Controller
 * core (controller/authority.py, CTRL-001) itself reads:
 *
 *   1. spec/state/controller-program-state.json  (machine state)
 *   2. spec/work-items/<activeWorkItem>.md        (the work order's
 *      `Status:` line)
 *
 * …and performs presentation-level validation only:
 *   - structural validation of the machine-state JSON (the same field
 *     vocabulary, the same 0.1 schema, the frozen lifecycle state set);
 *   - the two-surface agreement check the runtime's verify_authority
 *     performs (machine-state status must equal the work order's
 *     Status line; the work-order heading must match the active item);
 *   - repository identity agreement (the machine state's `repository`
 *     field must equal the selected owner/name).
 *
 * It deliberately does NOT re-implement governance predicates: no
 * REQUIRED_RULES evaluation, no eligibility computation, no lifecycle
 * transitions, no merge policy (acceptance criterion 6 — the extension
 * presents what authority says; the Controller core owns every
 * predicate).
 *
 * Fail-closed semantics ("State display"): missing (404), malformed
 * (unparseable/shape-invalid), or contradictory (surface disagreement)
 * results are typed errors — never an inferred fallback.
 *
 * Staleness is prevented structurally: both surfaces are fetched at one
 * observed commit SHA (the projection's provenance), so a mixed-commit
 * read cannot occur; each refresh re-observes the branch head, and the
 * projection always reports which SHA it was derived from.
 */

import { failure } from "./errors.js";
import { validateRepositoryIdentity } from "./repository.js";

/** Machine-state location, relative to the repository root (frozen). */
export const STATE_FILE_PATH = "spec/state/controller-program-state.json";

/** Work-order directory, relative to the repository root (frozen). */
export const WORK_ITEMS_DIR = "spec/work-items";

/** The only machine-state schema version this surface understands. */
export const SUPPORTED_SCHEMA_VERSION = "0.1";

/**
 * The frozen lifecycle state vocabulary (verbatim from
 * controller/states.py — the frozen architecture's state machine).
 */
export const LIFECYCLE_STATES = Object.freeze([
  "READY",
  "DISPATCHED",
  "IMPLEMENTING",
  "PR_OPEN",
  "CI_PENDING",
  "REVIEW_PENDING",
  "CHANGES_REQUESTED",
  "APPROVED",
  "MERGING",
  "MERGED",
  "RECONCILING",
  "COMPLETE",
  "NEXT_READY",
  "BLOCKED",
  "ESCALATED",
  "CANCELLED",
]);

const REQUIRED_STRING_FIELDS = Object.freeze([
  "schemaVersion",
  "repository",
  "roadmap",
  "architecture",
  "buildProcess",
  "activeWorkItem",
  "status",
  "automationStage",
  "nextAction",
]);

const WORK_ORDER_HEADING_PATTERN = /^#\s+([A-Z0-9]+-\d+)\b/m;
const WORK_ORDER_STATUS_PATTERN = /^Status:\s*`([A-Z_]+)`\s*$/m;

/**
 * Parse and structurally validate a machine-state JSON document.
 *
 * @param {string} text
 * @returns {{ ok: true, machineState: object } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function parseMachineState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return failure("AUTHORITY_MALFORMED", `machine state is not valid JSON (${err})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("AUTHORITY_MALFORMED", "machine state is not a JSON object");
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || value.length === 0) {
      return failure(
        "AUTHORITY_MALFORMED",
        `machine state field '${field}' must be a non-empty string`
      );
    }
  }
  if (raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return failure(
      "AUTHORITY_MALFORMED",
      `machine state schemaVersion '${raw.schemaVersion}' is not the supported '${SUPPORTED_SCHEMA_VERSION}'`
    );
  }
  if (!LIFECYCLE_STATES.includes(raw.status)) {
    return failure(
      "AUTHORITY_MALFORMED",
      `machine state status '${raw.status}' is not a known lifecycle state`
    );
  }
  if (!Array.isArray(raw.completed) || !raw.completed.every((id) => typeof id === "string")) {
    return failure("AUTHORITY_MALFORMED", "machine state 'completed' must be a list of work-item ids");
  }
  if (typeof raw.rules !== "object" || raw.rules === null || Array.isArray(raw.rules)) {
    return failure("AUTHORITY_MALFORMED", "machine state 'rules' must be an object");
  }
  // Note: rule VALUES are deliberately not evaluated here — the
  // governance rules predicate belongs to the Controller core.
  return { ok: true, machineState: raw };
}

/**
 * Parse a work order and return its declared Status state.
 *
 * @param {string} text - the work-order markdown
 * @param {string} expectedWorkItem - the machine state's activeWorkItem
 * @returns {{ ok: true, status: string } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function parseWorkOrderStatus(text, expectedWorkItem) {
  const heading = WORK_ORDER_HEADING_PATTERN.exec(text);
  if (heading === null) {
    return failure("AUTHORITY_MALFORMED", "work order has no 'WORK-ID — title' heading");
  }
  if (heading[1] !== expectedWorkItem) {
    return failure(
      "AUTHORITY_CONTRADICTORY",
      `work order heading declares '${heading[1]}' but machine state's active item is '${expectedWorkItem}'`
    );
  }
  const status = WORK_ORDER_STATUS_PATTERN.exec(text);
  if (status === null) {
    return failure("AUTHORITY_MALFORMED", "work order has no 'Status: `STATE`' line");
  }
  if (!LIFECYCLE_STATES.includes(status[1])) {
    return failure(
      "AUTHORITY_MALFORMED",
      `work order Status '${status[1]}' is not a known lifecycle state`
    );
  }
  return { ok: true, status: status[1] };
}

/**
 * Project the repository-derived authority state for one selected
 * repository. Both authority surfaces are read at ONE observed commit
 * SHA (coherent, non-stale by construction) and cross-checked.
 *
 * @param {{ client: object, repository: string }} input
 * @returns {Promise<{ ok: true, state: object } | { ok: false, error: object }>}
 */
export async function projectAuthorityState({ client, repository }) {
  const identity = validateRepositoryIdentity(repository);
  if (!identity.ok) {
    return identity;
  }
  const { owner, name } = identity;

  const branch = await client.repositoryDefaultBranch(owner, name);
  if (!branch.ok) {
    return branch;
  }
  const head = await client.branchHeadSha(owner, name, branch.defaultBranch);
  if (!head.ok) {
    return head;
  }
  const sha = head.sha;

  const stateFile = await client.rawFile(owner, name, sha, STATE_FILE_PATH);
  if (!stateFile.ok) {
    if (stateFile.error.code === "AUTHORITY_MISSING") {
      return failure(
        "AUTHORITY_MISSING",
        `no machine state at ${STATE_FILE_PATH} — '${repository}' does not look like a Controller repository`
      );
    }
    return stateFile;
  }
  const parsed = parseMachineState(stateFile.text);
  if (!parsed.ok) {
    return parsed;
  }
  const machineState = parsed.machineState;

  if (machineState.repository !== identity.repository) {
    return failure(
      "AUTHORITY_CONTRADICTORY",
      `machine state declares repository '${machineState.repository}' but the selected repository is '${identity.repository}'`
    );
  }

  const workOrderPath = `${WORK_ITEMS_DIR}/${machineState.activeWorkItem}.md`;
  const workOrderFile = await client.rawFile(owner, name, sha, workOrderPath);
  if (!workOrderFile.ok) {
    if (workOrderFile.error.code === "AUTHORITY_MISSING") {
      return failure(
        "AUTHORITY_MISSING",
        `machine state names active work item '${machineState.activeWorkItem}' but ${workOrderPath} is absent`
      );
    }
    return workOrderFile;
  }
  const orderStatus = parseWorkOrderStatus(workOrderFile.text, machineState.activeWorkItem);
  if (!orderStatus.ok) {
    return orderStatus;
  }
  if (orderStatus.status !== machineState.status) {
    return failure(
      "AUTHORITY_CONTRADICTORY",
      `contradictory authority: machine state says ${machineState.activeWorkItem} is ${machineState.status}, but its work order says ${orderStatus.status}`
    );
  }

  return {
    ok: true,
    state: Object.freeze({
      repository: machineState.repository,
      activeWorkItem: machineState.activeWorkItem,
      lifecycleStatus: machineState.status,
      automationStage: machineState.automationStage,
      completed: Object.freeze([...machineState.completed]),
      nextAction: machineState.nextAction,
      provenance: Object.freeze({
        owner,
        name,
        ref: branch.defaultBranch,
        sha,
      }),
    }),
  };
}
