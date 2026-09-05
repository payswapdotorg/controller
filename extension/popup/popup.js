/**
 * The popup operator UI (CTRL-012).
 *
 * The popup speaks ONLY through the typed message boundary
 * (chrome.runtime.sendMessage -> src/service.js) — it never touches
 * storage, fetch, or tabs directly (single-boundary discipline, audited
 * structurally). Every response is rendered defensively: an unexpected
 * shape is an explicit fail-closed panel, never a guessed render.
 */

/* global chrome */

const $ = (id) => document.getElementById(id);

/**
 * Send one typed request through the message boundary.
 *
 * @returns {Promise<object>} the typed response
 */
function send(request) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(request, (response) => resolve(response));
  });
}

/**
 * Require a response to be a typed success carrying `field` of type
 * `type` — otherwise a fail-closed display error.
 */
function requireSuccessField(response, field, type) {
  if (
    typeof response !== "object" ||
    response === null ||
    response.ok !== true ||
    typeof response[field] !== type
  ) {
    return {
      ok: false,
      error: { code: "MALFORMED_MESSAGE", message: "the service returned an untyped response shape" },
    };
  }
  return { ok: true };
}

function showFormError(elementId, error) {
  const node = $(elementId);
  node.textContent = `${error.code}: ${error.message}`;
  node.classList.remove("hidden");
}

function clearFormError(elementId) {
  $(elementId).classList.add("hidden");
}

function renderAuthorityState(state) {
  const panel = $("authority-state");
  const errorPanel = $("authority-error");
  const rows = [
    ["repository", state.repository],
    ["active work item", state.activeWorkItem],
    ["lifecycle status", state.lifecycleStatus],
    ["automation stage", state.automationStage],
    ["completed", `${state.completed.length} item(s): ${state.completed.join(", ")}`],
    ["next action", state.nextAction],
    ["observed at", `${state.provenance.ref}@${state.provenance.sha.slice(0, 12)}`],
  ];
  panel.innerHTML = "";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "row";
    const labelSpan = document.createElement("span");
    labelSpan.className = "label";
    labelSpan.textContent = `${label}: `;
    const valueSpan = document.createElement("span");
    valueSpan.className = "value";
    valueSpan.textContent = String(value);
    row.append(labelSpan, valueSpan);
    panel.append(row);
  }
  panel.classList.remove("hidden");
  errorPanel.classList.add("hidden");
}

function renderAuthorityError(error) {
  $("authority-state").classList.add("hidden");
  $("authority-error-text").textContent = `FAIL-CLOSED (${error.code}): ${error.message}`;
  $("authority-error").classList.remove("hidden");
}

function renderTabs(tabs) {
  const panel = $("tab-discovery-result");
  if (tabs.length === 0) {
    panel.textContent = "no provider tabs open";
    return;
  }
  panel.replaceChildren();
  for (const tab of tabs) {
    const line = document.createElement("div");
    line.textContent = `tab ${tab.id}: ${tab.title ?? "(no title)"} — ${tab.url ?? "(no url)"}`;
    panel.append(line);
  }
}

function makeRegistrationButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderRegistrations(role, listElementId) {
  const list = $(listElementId);
  list.replaceChildren();
  const registrations = currentConfiguration?.[role === "worker" ? "workers" : "architects"] ?? [];
  if (registrations.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = `no ${role}s registered`;
    list.append(empty);
    return;
  }
  for (const registration of registrations) {
    const item = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = `${registration.name} (${registration.provider.label})`;
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = registration.providerUrl;
    meta.append(name, detail);
    const openButton = makeRegistrationButton("Open", async () => {
      const response = await send({ kind: "OpenProviderTab", role, name: registration.name });
      if (response?.ok) {
        renderTabs([{ id: response.opened.tabId, title: "(opened for human authentication)", url: response.opened.url }]);
      }
    });
    const tabsButton = makeRegistrationButton("Tabs", async () => {
      const response = await send({ kind: "DiscoverProviderTabs", role, name: registration.name });
      const checked = requireSuccessField(response, "tabs", "object");
      if (checked.ok && Array.isArray(response.tabs)) {
        renderTabs(response.tabs);
      } else if (response?.ok === false) {
        renderTabs([{ id: "-", title: `FAIL-CLOSED (${response.error.code})`, url: response.error.message }]);
      }
    });
    item.append(meta, openButton, tabsButton);
    list.append(item);
  }
}

let currentConfiguration = null;

function renderConfiguration() {
  const errorPanel = $("configuration-error");
  if (currentConfiguration === null) {
    $("configuration-error-text").textContent =
      "The extension configuration store is corrupt. Fail-closed: registrations and repository selection are refused. See extension/README.md for manual recovery.";
    errorPanel.classList.remove("hidden");
    $("worker-list").replaceChildren();
    $("architect-list").replaceChildren();
    $("selected-repository").textContent = "(configuration refused)";
    return;
  }
  errorPanel.classList.add("hidden");
  renderRegistrations("worker", "worker-list");
  renderRegistrations("architect", "architect-list");
  $("selected-repository").textContent = currentConfiguration.repository ?? "none selected";
}

async function refreshConfiguration() {
  const response = await send({ kind: "GetConfiguration" });
  const checked = requireSuccessField(response, "configuration", "object");
  if (!checked.ok) {
    currentConfiguration = null;
    renderConfiguration();
    return;
  }
  currentConfiguration = response.configuration;
  renderConfiguration();
}

async function refreshAuthorityState() {
  const response = await send({ kind: "GetAuthorityState" });
  if (typeof response !== "object" || response === null || response.ok !== true) {
    const error = response?.ok === false && response.error
      ? response.error
      : { code: "MALFORMED_MESSAGE", message: "the service returned an untyped response shape" };
    renderAuthorityError(error);
    return;
  }
  const state = response.state;
  if (
    typeof state !== "object" ||
    typeof state.repository !== "string" ||
    typeof state.activeWorkItem !== "string" ||
    typeof state.lifecycleStatus !== "string" ||
    typeof state.automationStage !== "string" ||
    !Array.isArray(state.completed) ||
    typeof state.nextAction !== "string" ||
    typeof state.provenance !== "object" ||
    state.provenance === null
  ) {
    renderAuthorityError({
      code: "MALFORMED_MESSAGE",
      message: "the authority projection has an unexpected shape",
    });
    return;
  }
  renderAuthorityState(state);
}

function wireRegistrationForm(formId, errorId, buildRequest) {
  $(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormError(errorId);
    const formData = new FormData(event.target);
    const request = buildRequest(formData);
    const response = await send(request);
    if (response?.ok === true) {
      currentConfiguration = response.configuration;
      renderConfiguration();
      event.target.reset();
    } else if (response?.ok === false) {
      showFormError(errorId, response.error);
    } else {
      showFormError(errorId, { code: "MALFORMED_MESSAGE", message: "untyped response" });
    }
  });
}

wireRegistrationForm("register-worker", "worker-form-error", (formData) => ({
  kind: "RegisterWorker",
  name: String(formData.get("name") ?? ""),
  providerKind: String(formData.get("providerKind") ?? ""),
  providerUrl: String(formData.get("providerUrl") ?? ""),
}));

wireRegistrationForm("register-architect", "architect-form-error", (formData) => ({
  kind: "RegisterArchitect",
  name: String(formData.get("name") ?? ""),
  providerKind: String(formData.get("providerKind") ?? ""),
  providerUrl: String(formData.get("providerUrl") ?? ""),
}));

wireRegistrationForm("select-repository", "repository-form-error", (formData) => ({
  kind: "SelectRepository",
  repository: String(formData.get("repository") ?? ""),
}));

$("refresh-state").addEventListener("click", () => {
  void refreshAuthorityState();
});

void refreshConfiguration();
