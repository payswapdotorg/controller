/**
 * The operator live-test harness request plumbing (CTRL-014
 * live-evidence invocation work order, PR #6 comment 5553979616).
 *
 * This module is the PURE, provider-agnostic core of the
 * developer/operator live-test harness: it builds exactly the frozen
 * CTRL-014 message forms (messages.js — ObserveZaiSession /
 * StartZaiWorkerSession / RecoverZaiHungWorker), extracts the exact
 * session correlation a governed start result reported, and formats
 * the deterministic, copyable evidence records the Architect reviews.
 *
 * Discipline (frozen by the work order):
 *   - NO provider knowledge: no Z.ai locator, no provider origin, no
 *     provider interpretation — the harness only carries the frozen
 *     message forms; every provider fact stays in zaiAdapter.js;
 *   - the `prompt` of StartZaiWorkerSession is the operator-supplied
 *     EXACT Controller-generated governed prompt, carried VERBATIM —
 *     this module never authors, rewrites, normalizes, trims, or
 *     substitutes prompt text (the only refusal is the boundary's own
 *     empty/whitespace-only rule: nothing honest to submit);
 *   - the recovery `tabId` is the EXACT browser-session correlation
 *     the governed start result reported — never guessed, defaulted,
 *     or repaired (a response that does not report a well-formed
 *     session correlation yields null, and the operator types the
 *     correlation explicitly);
 *   - DOM-free, chrome-free, network-free: the page script
 *     (harness/harness.js) owns all DOM and the single
 *     chrome.runtime.sendMessage channel; this module is pure data
 *     plumbing, fully testable under node;
 *   - evidence records are DETERMINISTIC: fixed key order, one JSON
 *     line per invocation, the request recorded verbatim (the exact
 *     governed prompt included — it is Controller-generated governed
 *     text, never a credential) and the typed response recorded
 *     verbatim (the typed vocabulary carries no credential or
 *     provider token by construction, errors.js doctrine). Never
 *     logged: credentials, provider tokens, cookies — none exist on
 *     this surface.
 *
 * This harness is a TEST surface only: it adds no production popup
 * control, no runtime orchestration (CTRL-016 scope), no new recovery
 * semantics, no provider automation. The manifest does not reference
 * it and the popup does not link it.
 */

import { failure } from "./errors.js";

/** The frozen request kinds the harness may invoke (exactly these). */
export const HARNESS_REQUEST_KINDS = Object.freeze([
  "ObserveZaiSession",
  "StartZaiWorkerSession",
  "RecoverZaiHungWorker",
]);

/**
 * Build the frozen ObserveZaiSession request form.
 *
 * @param {{ worker: unknown }} input
 * @returns {{ ok: true, request: { kind: "ObserveZaiSession", worker: string } } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function buildObserveRequest(input) {
  const checked = requirePlainInput(input);
  if (!checked.ok) {
    return checked;
  }
  const { worker } = checked.input;
  if (typeof worker !== "string" || worker.length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness ObserveZaiSession: the registered Worker name is required"
    );
  }
  return { ok: true, request: Object.freeze({ kind: "ObserveZaiSession", worker }) };
}

/**
 * Build the frozen StartZaiWorkerSession request form. The prompt is
 * the operator-supplied EXACT Controller-generated governed prompt,
 * carried VERBATIM — never rewritten, trimmed, or substituted.
 *
 * @param {{ worker: unknown, workItem: unknown, prompt: unknown }} input
 * @returns {{ ok: true, request: { kind: "StartZaiWorkerSession", worker: string, workItem: string, prompt: string } } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function buildStartRequest(input) {
  const checked = requirePlainInput(input);
  if (!checked.ok) {
    return checked;
  }
  const { worker, workItem, prompt } = checked.input;
  if (typeof worker !== "string" || worker.length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness StartZaiWorkerSession: the registered Worker name is required"
    );
  }
  if (typeof workItem !== "string" || workItem.length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness StartZaiWorkerSession: the exact Work Item identity is required"
    );
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness StartZaiWorkerSession: the exact Controller-generated governed prompt is required — paste it verbatim (the harness never authors or rewrites prompt text)"
    );
  }
  return {
    ok: true,
    request: Object.freeze({ kind: "StartZaiWorkerSession", worker, workItem, prompt }),
  };
}

/**
 * Build the frozen RecoverZaiHungWorker request form. The `tabId` is
 * the EXACT browser-session correlation the governed start result
 * reported — a positive integer, never defaulted or guessed here.
 *
 * @param {{ worker: unknown, workItem: unknown, tabId: unknown }} input
 * @returns {{ ok: true, request: { kind: "RecoverZaiHungWorker", worker: string, workItem: string, tabId: number } } |
 *           { ok: false, error: { code: string, message: string } }}
 */
export function buildRecoverRequest(input) {
  const checked = requirePlainInput(input);
  if (!checked.ok) {
    return checked;
  }
  const { worker, workItem, tabId } = checked.input;
  if (typeof worker !== "string" || worker.length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness RecoverZaiHungWorker: the registered Worker name is required"
    );
  }
  if (typeof workItem !== "string" || workItem.length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness RecoverZaiHungWorker: the exact Work Item identity is required"
    );
  }
  if (!isPositiveInteger(tabId)) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness RecoverZaiHungWorker: field 'tabId' must be the positive-integer browser-session correlation the governed start result reported"
    );
  }
  return {
    ok: true,
    request: Object.freeze({ kind: "RecoverZaiHungWorker", worker, workItem, tabId }),
  };
}

/**
 * Extract the EXACT session correlation a successful governed start
 * result reported — { worker, workItem, tabId } — for the recovery
 * prefill. Anything else (a refusal, a malformed or partial shape)
 * yields null: the harness never guesses, completes, or repairs a
 * correlation; the operator then supplies the exact values.
 *
 * @param {unknown} response
 * @returns {{ worker: string, workItem: string, tabId: number } | null}
 */
export function startResultCorrelation(response) {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return null;
  }
  if (response.ok !== true) {
    return null;
  }
  const session = response.session;
  if (typeof session !== "object" || session === null || Array.isArray(session)) {
    return null;
  }
  if (
    typeof session.worker !== "string" ||
    session.worker.length === 0 ||
    typeof session.workItem !== "string" ||
    session.workItem.length === 0 ||
    !isPositiveInteger(session.tabId)
  ) {
    return null;
  }
  return { worker: session.worker, workItem: session.workItem, tabId: session.tabId };
}

/**
 * Build ONE deterministic evidence record for a harness invocation.
 * Fixed key order: seq, timestamp, requestKind, request (verbatim,
 * including the exact governed prompt), response (the typed response,
 * verbatim), correlation.
 *
 * @param {{ sequence: unknown, timestamp: unknown, request: unknown, response: unknown }} input
 * @returns {{ ok: true, record: object } | { ok: false, error: { code: string, message: string } }}
 */
export function buildEvidenceRecord(input) {
  const checked = requirePlainInput(input);
  if (!checked.ok) {
    return checked;
  }
  const { sequence, timestamp, request, response } = checked.input;
  if (!isPositiveInteger(sequence)) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness evidence record: 'sequence' must be a positive integer"
    );
  }
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness evidence record: 'timestamp' must be an ISO-8601 string"
    );
  }
  const kind = requestKindOf(request);
  if (kind === null) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness evidence record: 'request' must be one of the frozen harness kinds"
    );
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return failure(
      "MALFORMED_MESSAGE",
      "harness evidence record: 'response' must be the typed response object"
    );
  }
  const record = {
    seq: sequence,
    timestamp,
    requestKind: kind,
    request,
    response,
    correlation: correlationOf(request, response),
  };
  return { ok: true, record: Object.freeze(record) };
}

/**
 * Format the evidence log deterministically: one JSON line per record
 * (JSONL), newline-terminated, records in sequence order.
 *
 * @param {unknown[]} records
 * @returns {string}
 */
export function formatEvidenceLog(records) {
  if (!Array.isArray(records)) {
    return "";
  }
  const lines = [];
  for (const record of records) {
    if (typeof record === "object" && record !== null) {
      lines.push(JSON.stringify(record));
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** @private — the request's frozen kind, or null when not a harness kind. */
function requestKindOf(request) {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return null;
  }
  return HARNESS_REQUEST_KINDS.includes(request.kind) ? request.kind : null;
}

/**
 * @private — the evidence correlation: the session the typed response
 * reported when it reports one; else the tabId an observation
 * reported; else the request's own correlation attempt. Fixed key
 * order: worker, workItem, tabId. Never guessed beyond these.
 */
function correlationOf(request, response) {
  const fromSession = startResultCorrelation(response);
  if (fromSession !== null) {
    return { worker: fromSession.worker, workItem: fromSession.workItem, tabId: fromSession.tabId };
  }
  let tabId = null;
  if (typeof response === "object" && response !== null && response.ok === true) {
    const observation = response.observation;
    if (typeof observation === "object" && observation !== null && isPositiveInteger(observation.tabId)) {
      tabId = observation.tabId;
    }
  }
  if (tabId === null && request.kind === "RecoverZaiHungWorker" && isPositiveInteger(request.tabId)) {
    tabId = request.tabId;
  }
  const workItem =
    request.kind === "ObserveZaiSession" ? null : typeof request.workItem === "string" ? request.workItem : null;
  return {
    worker: typeof request.worker === "string" ? request.worker : null,
    workItem,
    tabId,
  };
}

/** @private */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @private — reject non-object input the same way the boundary does. */
function requirePlainInput(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failure("MALFORMED_MESSAGE", "harness: the input must be a plain object");
  }
  return { ok: true, input: value };
}
