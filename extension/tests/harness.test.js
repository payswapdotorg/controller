/**
 * Operator live-test harness tests (CTRL-014 live-evidence invocation
 * work order, PR #6 comment 5553979616): the pure request plumbing
 * (harnessCore.js) — the frozen request forms, the verbatim prompt
 * discipline, the exact-correlation extraction, the deterministic
 * evidence records, and the round-trip through the REAL message
 * boundary (every request the harness builds validates).
 *
 * The harness PAGE (harness/harness.js) is DOM/chrome glue over this
 * pure core and is exercised live by scripts/extension_load_probe_014.py.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HARNESS_REQUEST_KINDS,
  buildObserveRequest,
  buildStartRequest,
  buildRecoverRequest,
  buildEvidenceRecord,
  formatEvidenceLog,
  startResultCorrelation,
} from "../src/harnessCore.js";
import { validateRequest } from "../src/messages.js";

const GOVERNED_PROMPT = [
  "WORK ORDER — CTRL-014 live evidence",
  "",
  "Execute the governed sequence and report typed observations.",
  "  (indented line with trailing spaces   )",
].join("\n");

// --------------------------------------------------------------------
// The frozen harness vocabulary.
// --------------------------------------------------------------------

test("the harness invokes exactly the three frozen CTRL-014 kinds", () => {
  assert.deepEqual(HARNESS_REQUEST_KINDS, [
    "ObserveZaiSession",
    "StartZaiWorkerSession",
    "RecoverZaiHungWorker",
  ]);
});

// --------------------------------------------------------------------
// ObserveZaiSession request building.
// --------------------------------------------------------------------

test("buildObserveRequest emits the exact frozen form", () => {
  const built = buildObserveRequest({ worker: "Z.ai" });
  assert.equal(built.ok, true);
  assert.deepEqual(built.request, { kind: "ObserveZaiSession", worker: "Z.ai" });
});

test("buildObserveRequest refuses a missing/empty worker with a typed error", () => {
  for (const worker of ["", undefined, null, 7]) {
    const built = buildObserveRequest({ worker });
    assert.equal(built.ok, false, JSON.stringify(worker));
    assert.equal(built.error.code, "MALFORMED_MESSAGE");
  }
});

test("buildObserveRequest refuses non-object input", () => {
  for (const input of [null, undefined, "x", 7, []]) {
    const built = buildObserveRequest(input);
    assert.equal(built.ok, false);
    assert.equal(built.error.code, "MALFORMED_MESSAGE");
  }
});

// --------------------------------------------------------------------
// StartZaiWorkerSession request building — the verbatim prompt.
// --------------------------------------------------------------------

test("buildStartRequest carries the governed prompt VERBATIM (never rewritten)", () => {
  const built = buildStartRequest({
    worker: "Z.ai",
    workItem: "CTRL-014",
    prompt: GOVERNED_PROMPT,
  });
  assert.equal(built.ok, true);
  // Byte-for-byte identity: no trim, no normalization, no substitution.
  assert.equal(built.request.prompt, GOVERNED_PROMPT);
  assert.ok(built.request.prompt.startsWith("WORK ORDER — CTRL-014 live evidence\n"));
  assert.ok(built.request.prompt.endsWith("  (indented line with trailing spaces   )"));
  assert.deepEqual(built.request, {
    kind: "StartZaiWorkerSession",
    worker: "Z.ai",
    workItem: "CTRL-014",
    prompt: GOVERNED_PROMPT,
  });
  // The built request is frozen — downstream code cannot rewrite it.
  assert.ok(Object.isFrozen(built.request));
});

test("buildStartRequest preserves prompts with significant leading/trailing whitespace", () => {
  const prompt = "  exact governed text with intentional margins \n";
  const built = buildStartRequest({ worker: "Z.ai", workItem: "CTRL-014", prompt });
  assert.equal(built.ok, true);
  assert.equal(built.request.prompt, prompt);
});

test("buildStartRequest refuses an empty or whitespace-only prompt (the boundary's own rule)", () => {
  for (const prompt of ["", "   ", "\n\t ", undefined, null, 42]) {
    const built = buildStartRequest({ worker: "Z.ai", workItem: "CTRL-014", prompt });
    assert.equal(built.ok, false, JSON.stringify(prompt));
    assert.equal(built.error.code, "MALFORMED_MESSAGE");
    assert.match(built.error.message, /governed prompt/);
  }
});

test("buildStartRequest refuses a missing worker or work item", () => {
  for (const [worker, workItem] of [
    ["", "CTRL-014"],
    [undefined, "CTRL-014"],
    ["Z.ai", ""],
    ["Z.ai", undefined],
  ]) {
    const built = buildStartRequest({ worker, workItem, prompt: "prompt" });
    assert.equal(built.ok, false, JSON.stringify([worker, workItem]));
    assert.equal(built.error.code, "MALFORMED_MESSAGE");
  }
});

// --------------------------------------------------------------------
// RecoverZaiHungWorker request building — the exact correlation.
// --------------------------------------------------------------------

test("buildRecoverRequest emits the exact frozen form with the reported tabId", () => {
  const built = buildRecoverRequest({ worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
  assert.equal(built.ok, true);
  assert.deepEqual(built.request, {
    kind: "RecoverZaiHungWorker",
    worker: "Z.ai",
    workItem: "CTRL-014",
    tabId: 7,
  });
  assert.ok(Object.isFrozen(built.request));
});

test("buildRecoverRequest refuses a tabId that is not a positive integer", () => {
  for (const tabId of [0, -1, 1.5, "7", null, undefined, Number.NaN]) {
    const built = buildRecoverRequest({ worker: "Z.ai", workItem: "CTRL-014", tabId });
    assert.equal(built.ok, false, JSON.stringify(tabId));
    assert.equal(built.error.code, "MALFORMED_MESSAGE");
    assert.match(built.error.message, /correlation/);
  }
});

// --------------------------------------------------------------------
// The round-trip: every request the harness builds validates at the
// REAL message boundary (the harness emits exactly the frozen forms).
// --------------------------------------------------------------------

test("every harness-built request validates at the real message boundary", () => {
  for (const built of [
    buildObserveRequest({ worker: "Z.ai" }),
    buildStartRequest({ worker: "Z.ai", workItem: "CTRL-014", prompt: GOVERNED_PROMPT }),
    buildRecoverRequest({ worker: "Z.ai", workItem: "CTRL-014", tabId: 7 }),
  ]) {
    assert.equal(built.ok, true);
    const validated = validateRequest(built.request);
    assert.equal(validated.ok, true, JSON.stringify(validated));
    assert.equal(validated.request, built.request);
  }
});

// --------------------------------------------------------------------
// startResultCorrelation — the exact correlation a governed start
// result reported (never guessed, completed, or repaired).
// --------------------------------------------------------------------

test("startResultCorrelation extracts the exact session a successful start reported", () => {
  const correlation = startResultCorrelation({
    ok: true,
    session: { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 },
    // CONTINUATION 22: the frozen FOUR-FIELD submitted record (attempts,
    // popupDismissals, composeReestablishments, generation — the pre-c13
    // invariant restored with the known-popup recovery).
    submitted: { attempts: 1, popupDismissals: 0, composeReestablishments: 0, generation: "working" },
  });
  assert.deepEqual(correlation, { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
});

test("startResultCorrelation extracts the correlation of an idempotent already-active start", () => {
  const correlation = startResultCorrelation({
    ok: true,
    alreadyActive: true,
    session: { worker: "Z.ai", workItem: "CTRL-014", tabId: 9 },
    observation: { state: "working", tabId: 9 },
  });
  assert.deepEqual(correlation, { worker: "Z.ai", workItem: "CTRL-014", tabId: 9 });
});

test("startResultCorrelation yields null on refusals and malformed results", () => {
  for (const response of [
    null,
    undefined,
    "x",
    { ok: false, error: { code: "AUTHORIZATION_REQUIRED", message: "no" } },
    { ok: true },
    { ok: true, session: null },
    { ok: true, session: { worker: "Z.ai", workItem: "CTRL-014" } },
    { ok: true, session: { worker: "Z.ai", workItem: "CTRL-014", tabId: "7" } },
    { ok: true, session: { worker: "", workItem: "CTRL-014", tabId: 7 } },
    { ok: false, session: { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 } },
  ]) {
    assert.equal(startResultCorrelation(response), null, JSON.stringify(response));
  }
});

// --------------------------------------------------------------------
// Evidence records — deterministic, fixed key order, verbatim.
// --------------------------------------------------------------------

test("buildEvidenceRecord produces the deterministic record with fixed key order", () => {
  const request = buildStartRequest({ worker: "Z.ai", workItem: "CTRL-014", prompt: GOVERNED_PROMPT }).request;
  const response = {
    ok: true,
    session: { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 },
    submitted: { attempts: 2, popupDismissals: 1, composeReestablishments: 1, generation: "working" },
  };
  const built = buildEvidenceRecord({
    sequence: 1,
    timestamp: "2026-09-05T18:42:52.123Z",
    request,
    response,
  });
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.record), [
    "seq",
    "timestamp",
    "requestKind",
    "request",
    "response",
    "correlation",
  ]);
  assert.equal(built.record.seq, 1);
  assert.equal(built.record.timestamp, "2026-09-05T18:42:52.123Z");
  assert.equal(built.record.requestKind, "StartZaiWorkerSession");
  // The request (with the exact governed prompt) and the typed
  // response are recorded VERBATIM.
  assert.equal(built.record.request, request);
  assert.equal(built.record.response, response);
  assert.deepEqual(built.record.correlation, { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
  assert.ok(Object.isFrozen(built.record));
});

test("an observation evidence record correlates by the observed tabId", () => {
  const request = buildObserveRequest({ worker: "Z.ai" }).request;
  const response = { ok: true, observation: { state: "authentication-required", tabId: 12, worker: "Z.ai" } };
  const built = buildEvidenceRecord({ sequence: 2, timestamp: "2026-09-05T18:43:01.000Z", request, response });
  assert.equal(built.ok, true);
  assert.deepEqual(built.record.correlation, { worker: "Z.ai", workItem: null, tabId: 12 });
});

test("a refused recovery keeps the operator-supplied correlation as evidence", () => {
  const request = buildRecoverRequest({ worker: "Z.ai", workItem: "CTRL-014", tabId: 7 }).request;
  const response = { ok: false, error: { code: "SESSION_UNKNOWN", message: "no active session" } };
  const built = buildEvidenceRecord({ sequence: 3, timestamp: "2026-09-05T18:43:30.500Z", request, response });
  assert.equal(built.ok, true);
  assert.deepEqual(built.record.correlation, { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 });
  assert.equal(built.record.response.error.code, "SESSION_UNKNOWN");
});

test("buildEvidenceRecord refuses non-harness request kinds and malformed inputs", () => {
  for (const input of [
    { sequence: 0, timestamp: "2026-09-05T18:42:52Z", request: buildObserveRequest({ worker: "Z.ai" }).request, response: { ok: true } },
    { sequence: "1", timestamp: "2026-09-05T18:42:52Z", request: buildObserveRequest({ worker: "Z.ai" }).request, response: { ok: true } },
    { sequence: 1, timestamp: "", request: buildObserveRequest({ worker: "Z.ai" }).request, response: { ok: true } },
    { sequence: 1, timestamp: "2026-09-05T18:42:52Z", request: { kind: "GetConfiguration" }, response: { ok: true } },
    { sequence: 1, timestamp: "2026-09-05T18:42:52Z", request: null, response: { ok: true } },
    { sequence: 1, timestamp: "2026-09-05T18:42:52Z", request: buildObserveRequest({ worker: "Z.ai" }).request, response: null },
    null,
  ]) {
    const built = buildEvidenceRecord(input);
    assert.equal(built.ok, false, JSON.stringify(input));
    assert.equal(built.error.code, "MALFORMED_MESSAGE");
  }
});

// --------------------------------------------------------------------
// The evidence log — JSONL, deterministic, copyable.
// --------------------------------------------------------------------

test("formatEvidenceLog emits one JSON line per record with a trailing newline", () => {
  const request = buildObserveRequest({ worker: "Z.ai" }).request;
  const records = [
    buildEvidenceRecord({
      sequence: 1,
      timestamp: "2026-09-05T18:42:52.123Z",
      request,
      response: { ok: true, observation: { state: "ready-for-input", tabId: 7, worker: "Z.ai" } },
    }).record,
    buildEvidenceRecord({
      sequence: 2,
      timestamp: "2026-09-05T18:43:10.456Z",
      request: buildRecoverRequest({ worker: "Z.ai", workItem: "CTRL-014", tabId: 7 }).request,
      response: { ok: true, recovered: { attempts: 1, message: "continue", acceptance: "conversation-evidence", generation: "working" }, session: { worker: "Z.ai", workItem: "CTRL-014", tabId: 7 } },
    }).record,
  ];
  const log = formatEvidenceLog(records);
  const lines = log.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2);
  assert.ok(log.endsWith("\n"));
  assert.deepEqual(lines.map((line) => JSON.parse(line).seq), [1, 2]);
  assert.deepEqual(JSON.parse(lines[1]).response.recovered, {
    attempts: 1,
    message: "continue",
    acceptance: "conversation-evidence",
    generation: "working",
  });
  // Deterministic: the same records always format identically.
  assert.equal(formatEvidenceLog(records), log);
});

test("formatEvidenceLog is empty for no records and ignores non-record entries", () => {
  assert.equal(formatEvidenceLog([]), "");
  assert.equal(formatEvidenceLog(null), "");
  assert.equal(formatEvidenceLog([null, 7, "x"]), "");
});
