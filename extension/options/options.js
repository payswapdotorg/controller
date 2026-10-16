/* Controller options logic. */

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response ?? { ok: false, error: "no response from the background service" });
    });
  });

const el = (id) => document.getElementById(id);

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
  el("resurrect").checked = config.chat.resurrect;
  el("continuePrompt").value = config.chat.continuePrompt;
  el("directive").value = config.chat.directive;
  el("intervalMinutes").value = config.loop.intervalMinutes;
  el("requireGreenChecks").checked = config.safety.requireGreenChecks;
  el("requireIntelligenceReview").checked = config.safety.requireIntelligenceReview;
  el("prefixes").value = config.safety.onlyMergeBranchPrefixes.join(", ");
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
    },
    chat: {
      resurrect: el("resurrect").checked,
      continuePrompt: el("continuePrompt").value.trim() || "continue",
      directive: el("directive").value,
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
  setTimeout(() => (issuesEl.textContent = ""), 6000);
});

load();
