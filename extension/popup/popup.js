/* Controller popup logic — classic script (no modules needed at this size). */

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError; // typed refusals come back in the payload
      resolve(response ?? { ok: false, error: "no response from the background service" });
    });
  });

function renderSources(sources) {
  const list = document.getElementById("sources");
  list.textContent = "";
  if (!Array.isArray(sources) || sources.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "no chain (single-driver mode)";
    list.appendChild(li);
    return;
  }
  for (const source of sources) {
    const li = document.createElement("li");
    li.className = !source.enabled || !source.usable ? "off" : source.benchedUntil ? "warn" : "ok";
    const bits = [source.id, source.kind];
    if (source.url) bits.push(source.url.replace(/^https?:\/\//, ""));
    let suffix = "";
    if (!source.enabled) suffix = " (off)";
    else if (!source.usable) suffix = " (no url)";
    else if (source.benchedUntil) suffix = ` (benched until ${String(source.benchedUntil).slice(11, 16)})`;
    else if (source.answered > 0) suffix = ` (answered ${source.answered})`;
    else if (source.lastError) suffix = ` (last: ${String(source.lastError).slice(0, 60)})`;
    li.textContent = bits.join(" · ") + suffix;
    list.appendChild(li);
  }
}

function renderStatus(payload) {
  const { status, config, log, sources } = payload;
  document.getElementById("repo").textContent = config?.github?.owner
    ? `${config.github.owner}/${config.github.repo} · every ${config.loop.intervalMinutes} min · ${config.loop.enabled ? "running" : "stopped"}`
    : "not configured";
  document.getElementById("st-main").textContent = (status?.mainHead ?? "—").toString().slice(0, 7);
  document.getElementById("st-cycles").textContent = status?.cycles ?? "—";
  document.getElementById("st-prs").textContent = status?.openPullRequests ?? "—";
  document.getElementById("st-issues").textContent = status?.openIssues ?? "—";
  document.getElementById("st-action").textContent = status?.lastAction ?? "—";
  document.getElementById("st-driver").textContent = config?.intelligence?.driver ?? "—";
  renderSources(sources);

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
document.getElementById("test-intelligence").addEventListener("click", async () => {
  const button = document.getElementById("test-intelligence");
  button.disabled = true;
  button.textContent = "testing…";
  const result = await send({ type: "controller:intelligence:test" });
  button.disabled = false;
  button.textContent = "test";
  const lines = (result?.results ?? []).map(
    (r) => `${r.source}: ${r.ok ? `ok — ${String(r.text ?? "").slice(0, 60)}` : r.skipped ? "skipped" : `fail — ${r.error}`}`,
  );
  alert(`intelligence probe (${result?.mode ?? "?"})\n\n${lines.join("\n") || "no sources"}`);
  refresh();
});
document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("open-options").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 5000);
