/* Controller options logic — includes the intelligence-chain editor. */

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response ?? { ok: false, error: "no response from the background service" });
    });
  });

const el = (id) => document.getElementById(id);

// ── the chain editor ────────────────────────────────────────────────────────

const chainBody = el("chain-body");

function chainRow(source = { id: "", kind: "local-http", url: "", enabled: false }) {
  const tr = document.createElement("tr");
  const tdId = document.createElement("td");
  const tdKind = document.createElement("td");
  const tdUrl = document.createElement("td");
  const tdOn = document.createElement("td");
  const tdDel = document.createElement("td");

  const inputId = document.createElement("input");
  inputId.type = "text";
  inputId.className = "src-id-input";
  inputId.value = source.id;
  inputId.placeholder = "agent-id";
  tdId.appendChild(inputId);

  const selectKind = document.createElement("select");
  for (const [value, label] of [
    ["local-http", "local-http"],
    ["chatzai-web", "chatzai-web"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    selectKind.appendChild(option);
  }
  selectKind.value = source.kind;
  tdKind.appendChild(selectKind);

  const inputUrl = document.createElement("input");
  inputUrl.type = "text";
  inputUrl.value = source.url;
  inputUrl.placeholder = "http://127.0.0.1:8788/";
  tdUrl.appendChild(inputUrl);

  const inputOn = document.createElement("input");
  inputOn.type = "checkbox";
  inputOn.checked = Boolean(source.enabled);
  tdOn.appendChild(inputOn);

  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "×";
  del.title = "remove this source";
  del.addEventListener("click", () => tr.remove());
  tdDel.appendChild(del);

  tr.append(tdId, tdKind, tdUrl, tdOn, tdDel);
  chainBody.appendChild(tr);
}

el("add-source").addEventListener("click", () => chainRow());

function readChain() {
  return [...chainBody.querySelectorAll("tr")].map((tr) => ({
    id: tr.querySelector(".src-id-input").value.trim(),
    kind: tr.querySelector("select").value,
    url: tr.querySelector('td input[type="text"]:not(.src-id-input)').value.trim(),
    enabled: tr.querySelector('td input[type="checkbox"]').checked,
  }));
}

// ── load / save ─────────────────────────────────────────────────────────────

async function load() {
  const response = await send({ type: "controller:config:get" });
  const config = response.config;
  if (!config) return;
  el("token").value = config.github.token;
  el("owner").value = config.github.owner;
  el("repo").value = config.github.repo;
  el("autoMerge").checked = config.github.autoMerge;
  el("mergeMethod").value = config.github.mergeMethod;
  el("driver").value = config.intelligence.driver;
  el("localEndpoint").value = config.intelligence.localEndpoint;
  el("timeoutSeconds").value = config.intelligence.timeoutSeconds;
  el("failureThreshold").value = config.intelligence.failureThreshold;
  el("cooldownMinutes").value = config.intelligence.cooldownMinutes;
  el("resurrect").checked = config.chat.resurrect;
  el("continuePrompt").value = config.chat.continuePrompt;
  el("watchdogIntervalSeconds").value = config.chat.watchdogIntervalSeconds;
  el("idleContinueAfterSeconds").value = config.chat.idleContinueAfterSeconds;
  el("directive").value = config.chat.directive;
  el("intervalMinutes").value = config.loop.intervalMinutes;
  el("requireGreenChecks").checked = config.safety.requireGreenChecks;
  el("requireIntelligenceReview").checked = config.safety.requireIntelligenceReview;
  el("prefixes").value = config.safety.onlyMergeBranchPrefixes.join(", ");
  chainBody.textContent = "";
  for (const source of config.intelligence.chain ?? []) chainRow(source);
}

el("save").addEventListener("click", async () => {
  const issuesEl = el("issues");
  issuesEl.textContent = "";
  const config = {
    github: {
      token: el("token").value.trim(),
      owner: el("owner").value.trim(),
      repo: el("repo").value.trim(),
      autoMerge: el("autoMerge").checked,
      mergeMethod: el("mergeMethod").value,
    },
    intelligence: {
      driver: el("driver").value,
      localEndpoint: el("localEndpoint").value.trim(),
      timeoutSeconds: Number(el("timeoutSeconds").value) || 120,
      failureThreshold: Number(el("failureThreshold").value) || 2,
      cooldownMinutes: Number(el("cooldownMinutes").value) || 5,
      chain: readChain(),
    },
    chat: {
      resurrect: el("resurrect").checked,
      continuePrompt: el("continuePrompt").value.trim() || "continue",
      directive: el("directive").value,
      watchdogIntervalSeconds: Number(el("watchdogIntervalSeconds").value) || 30,
      idleContinueAfterSeconds: Number(el("idleContinueAfterSeconds").value) || 45,
    },
    loop: {
      intervalMinutes: Number(el("intervalMinutes").value) || 2,
    },
    safety: {
      requireGreenChecks: el("requireGreenChecks").checked,
      requireIntelligenceReview: el("requireIntelligenceReview").checked,
      onlyMergeBranchPrefixes: el("prefixes")
        .value.split(",")
        .map((p) => p.trim())
        .filter((p) => p !== ""),
    },
  };
  const response = await send({ type: "controller:config:set", config });
  issuesEl.textContent = (response.issues ?? []).join("\n") || (response.ok ? "saved" : `save failed: ${response.error}`);
  setTimeout(() => (issuesEl.textContent = ""), 8000);
});

load();
