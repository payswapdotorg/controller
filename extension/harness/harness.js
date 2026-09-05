/**
 * The operator live-test harness page script (CTRL-014 live-evidence
 * invocation work order, PR #6 comment 5553979616).
 *
 * This page is a developer/operator TEST surface ONLY — deliberately
 * outside the production popup and outside any runtime composition
 * (CTRL-016 scope). It does exactly three things:
 *
 *   1. list the registered Workers through the EXISTING GetConfiguration
 *      message (provider-agnostic — the service router gates the
 *      provider and fails closed with a typed refusal);
 *   2. invoke the EXISTING frozen CTRL-014 message kinds
 *      (ObserveZaiSession / StartZaiWorkerSession / RecoverZaiHungWorker)
 *      through chrome.runtime.sendMessage — the single message
 *      boundary, exactly like the popup speaks; the harness adds NO
 *      new kind, NO new recovery semantics, NO orchestration;
 *   3. record one deterministic JSON evidence line per invocation
 *      (harnessCore.js — fixed key order: sequence, timestamp, exact
 *      request kind, the request verbatim, the typed response
 *      verbatim, the tab/session correlation) in this page's memory
 *      only, with a copy-to-clipboard control for the Architect
 *      review.
 *
 * Prompt discipline: the StartZaiWorkerSession prompt is the
 * operator-supplied EXACT Controller-generated governed prompt — this
 * page reads the textarea value and hands it to harnessCore VERBATIM;
 * it never authors, rewrites, normalizes, trims, or substitutes text,
 * and it displays the verbatim character count as the readback.
 *
 * Recovery discipline: the RecoverZaiHungWorker tabId is prefilled
 * from the EXACT session correlation the last SUCCESSFUL governed
 * start result reported (harnessCore.startResultCorrelation); a
 * failed or malformed result never prefills anything — the operator
 * then types the exact correlation. The value is never guessed.
 *
 * Single-boundary discipline (same as the popup): this page touches
 * NO storage, NO fetch, NO chrome.tabs — its ONLY extension API is
 * chrome.runtime.sendMessage with the frozen forms. No credential,
 * provider token, or cookie can appear on this surface: none exists
 * in the typed vocabulary, and this page reads none.
 */

/* global chrome, document, navigator */

import {
  buildObserveRequest,
  buildStartRequest,
  buildRecoverRequest,
  buildEvidenceRecord,
  formatEvidenceLog,
  startResultCorrelation,
} from "../src/harnessCore.js";

const $ = (id) => document.getElementById(id);

/** In-page harness state: the evidence log (memory only) + sequence. */
const state = {
  records: [],
  sequence: 0,
};

/** Send ONE typed request through the message boundary. */
function send(request) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(request, (response) => resolve(response));
  });
}

/**
 * Invoke one frozen kind: build the request (typed refusal on
 * malformed operator input — never sent), send it, record the typed
 * response verbatim, and return the response for panel handling.
 */
async function invoke(builder, input) {
  const built = builder(input);
  if (!built.ok) {
    // Malformed operator input never reaches the boundary; the typed
    // refusal is recorded as the response of this attempt.
    await record(built.request ?? null, built, input.kind ?? "(unavailable)");
    return built;
  }
  const response = await send(built.request);
  await record(built.request, response, built.request.kind);
  return response;
}

/** Append ONE deterministic evidence record for an invocation. */
async function record(request, response, fallbackKind) {
  state.sequence += 1;
  const built = buildEvidenceRecord({
    sequence: state.sequence,
    timestamp: new Date().toISOString(),
    request: request ?? { kind: fallbackKind },
    response,
  });
  if (!built.ok) {
    // A record that cannot be built honestly is itself displayed —
    // never silently dropped (fail-closed display doctrine).
    state.records.push({
      seq: state.sequence,
      timestamp: new Date().toISOString(),
      requestKind: fallbackKind,
      request: request ?? null,
      response: { ok: false, error: built.error },
    });
  } else {
    state.records.push(built.record);
  }
  $("evidence-log").textContent = formatEvidenceLog(state.records);
}

/** Load the registered Workers through GetConfiguration (provider-agnostic). */
async function refreshWorkers() {
  const response = await send({ kind: "GetConfiguration" });
  const error = $("worker-error");
  const select = $("worker-select");
  const previous = select.value;
  select.replaceChildren();
  if (
    typeof response !== "object" ||
    response === null ||
    response.ok !== true ||
    typeof response.configuration !== "object" ||
    response.configuration === null ||
    !Array.isArray(response.configuration.workers)
  ) {
    error.textContent = "FAIL-CLOSED: the configuration view is unavailable or malformed — type nothing; refresh or re-register through the popup.";
    error.classList.remove("hidden");
    return;
  }
  error.classList.add("hidden");
  for (const worker of response.configuration.workers) {
    if (typeof worker === "object" && worker !== null && typeof worker.name === "string") {
      const option = document.createElement("option");
      option.value = worker.name;
      option.textContent = worker.name;
      select.append(option);
    }
  }
  if (previous && [...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

/** The selected Worker name (empty string when none). */
function selectedWorker() {
  return $("worker-select").value ?? "";
}

/** Apply a successful governed start result to the recovery prefill. */
function applyStartResult(response) {
  const correlation = startResultCorrelation(response);
  if (correlation === null) {
    return; // A refusal or malformed result NEVER prefills anything.
  }
  $("recover-work-item").value = correlation.workItem;
  $("recover-tab-id").value = String(correlation.tabId);
}

/** Enable/disable every invoke control per the operator acknowledgment. */
function updateGate() {
  const armed = $("operator-ack").checked;
  for (const id of ["invoke-observe", "invoke-start", "invoke-recover"]) {
    $(id).disabled = !armed;
  }
  $("gate-hint").textContent = armed
    ? "Operator acknowledged — invocations enabled. The prompt must remain the exact Controller-generated governed prompt, pasted verbatim."
    : "Invocations are disabled until the operator acknowledgment above is checked.";
}

/** Verbatim prompt readback: character count only — never a rewrite. */
function updatePromptReadback() {
  const prompt = $("start-prompt").value;
  $("prompt-readback").textContent = `${prompt.length} characters — carried verbatim, never rewritten.`;
}

function wire() {
  $("operator-ack").addEventListener("change", updateGate);
  $("refresh-workers").addEventListener("click", () => void refreshWorkers());
  $("start-prompt").addEventListener("input", updatePromptReadback);

  $("invoke-observe").addEventListener("click", async () => {
    await invoke(buildObserveRequest, { kind: "ObserveZaiSession", worker: selectedWorker() });
  });

  $("invoke-start").addEventListener("click", async () => {
    const response = await invoke(buildStartRequest, {
      kind: "StartZaiWorkerSession",
      worker: selectedWorker(),
      workItem: $("start-work-item").value,
      prompt: $("start-prompt").value,
    });
    applyStartResult(response);
  });

  $("invoke-recover").addEventListener("click", async () => {
    const tabText = $("recover-tab-id").value.trim();
    await invoke(buildRecoverRequest, {
      kind: "RecoverZaiHungWorker",
      worker: selectedWorker(),
      workItem: $("recover-work-item").value,
      tabId: tabText.length === 0 ? null : Number(tabText),
    });
  });

  $("copy-evidence").addEventListener("click", async () => {
    const log = formatEvidenceLog(state.records);
    const result = $("copy-result");
    try {
      await navigator.clipboard.writeText(log);
      result.textContent = `Copied ${state.records.length} evidence line(s) to the clipboard.`;
    } catch (err) {
      result.textContent = `Copy failed (${err}) — select the log text below and copy manually.`;
    }
    result.classList.remove("hidden");
  });

  $("clear-evidence").addEventListener("click", () => {
    state.records = [];
    state.sequence = 0;
    $("evidence-log").textContent = "";
    $("copy-result").classList.add("hidden");
  });
}

async function main() {
  wire();
  updateGate();
  updatePromptReadback();
  await refreshWorkers();
}

void main();
