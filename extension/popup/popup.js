/* Controller popup logic — classic script (no modules needed at this size). */

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError; // typed refusals come back in the payload
      resolve(response ?? { ok: false, error: "no response from the background service" });
    });
  });

function renderStatus(payload) {
  const { status, config, log } = payload;
  document.getElementById("repo").textContent = config?.github?.owner
    ? `${config.github.owner}/${config.github.repo} · every ${config.loop.intervalMinutes} min · ${config.loop.enabled ? "running" : "stopped"}`
    : "not configured";
  document.getElementById("st-main").textContent = (status?.mainHead ?? "—").toString().slice(0, 7);
  document.getElementById("st-cycles").textContent = status?.cycles ?? "—";
  document.getElementById("st-prs").textContent = status?.openPullRequests ?? "—";
  document.getElementById("st-issues").textContent = status?.openIssues ?? "—";
  document.getElementById("st-action").textContent = status?.lastAction ?? "—";
  document.getElementById("st-driver").textContent = config?.intelligence?.driver ?? "—";

  const logList = document.getElementById("log");
  logList.textContent = "";
  for (const entry of [...(log ?? [])].reverse().slice(0, 30)) {
    const li = document.createElement("li");
    li.className = entry.level ?? "info";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = (entry.at ?? "").slice(11, 19);
    li.appendChild(t);
    li.appendChild(document.createTextNode(`${entry.kind ?? "?"} — ${entry.message ?? ""}`));
    logList.appendChild(li);
  }
}

async function refresh() {
  renderStatus(await send({ type: "controller:status" }));
}

document.getElementById("start").addEventListener("click", async () => {
  await send({ type: "controller:start" });
  refresh();
});
document.getElementById("stop").addEventListener("click", async () => {
  await send({ type: "controller:stop" });
  refresh();
});
document.getElementById("tick").addEventListener("click", async () => {
  await send({ type: "controller:tick" });
  setTimeout(refresh, 1500);
});
document.getElementById("attach").addEventListener("click", async () => {
  const result = await send({ type: "controller:chat:attach" });
  alert(result.ok ? `chat tab attached (#${result.tabId}${result.reused ? ", reused" : ", fresh"})` : `attach failed: ${result.error}`);
  refresh();
});
document.getElementById("test-chat").addEventListener("click", async () => {
  const result = await send({ type: "controller:chat:test" });
  alert(result.ok ? `driver round-trip ok:\n${result.text.slice(0, 300)}` : `driver failed: ${result.error}`);
  refresh();
});
document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("open-options").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 5000);
