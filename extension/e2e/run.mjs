#!/usr/bin/env node
/**
 * Controller extension E2E (Chromium-class target — Opera/Chrome/Edge engine).
 *
 * REAL browser runs of the resident loop against mocked surfaces plus one
 * REAL local intelligence agent (an HTTP server the test starts itself):
 *
 *   api.github.com -> route-intercepted fixtures (a green in-fence PR that
 *                    merges during the cycle, then an empty queue)
 *   chat.z.ai      -> route-intercepted minimal chat page running the REAL
 *                    packaged content script
 *   muse-spark     -> a REAL local HTTP agent on 127.0.0.1 answering the
 *                    {kind, brief, context} contract
 *
 * Scenarios:
 *   1. full loop (chatzai-web driver): monitor -> merge -> dispatch brief ->
 *      chat intelligence verdict -> honest WAIT; then the no-continue-button
 *      surface: the page surfaces a real Continue button and the watchdog
 *      CLICKS it by itself.
 *   2. chain fallback (the owner's recovery requirement): the chat session is
 *      dead and cannot resurrect -> the chain rotates to the local muse spark
 *      agent -> its DISPATCH directive creates the next work order issue.
 *   3. all sources fail -> the loop parks in an honest WAIT naming every
 *      source (fail-closed, never a guess).
 *
 * Headless: set CONTROLLER_E2E_HEADLESS=1 to run Chromium's new headless mode
 * (extensions supported) — useful for CI; headed remains the default.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MUSE_SPARK_PORT = Number(process.env.CONTROLLER_MUSE_SPARK_PORT ?? 18788);
const HEADLESS = process.env.CONTROLLER_E2E_HEADLESS === "1";

// ── the fake chat.z.ai page ────────────────────────────────────────────────

const CHAT_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Chat (mock)</title></head>
<body style="font-family: sans-serif; background: #0d1220; color: #eee">
  <div id="messages"><div class="assistant-message">Session ready. Ask anything.</div></div>
  <form id="composer-form">
    <textarea id="composer" placeholder="Message…"></textarea>
    <button id="send" type="submit" aria-label="Send">Send</button>
  </form>
  <button id="continue-btn" aria-label="Continue" style="display:none">Continue</button>
  <script>
    window.__received = [];
    window.__continueClicks = 0;
    const messages = document.getElementById("messages");
    const composer = document.getElementById("composer");
    const continueBtn = document.getElementById("continue-btn");
    window.__showContinue = () => { continueBtn.style.display = "block"; };
    continueBtn.addEventListener("click", () => {
      window.__continueClicks += 1;
      continueBtn.style.display = "none";
      const reply = document.createElement("div");
      reply.className = "assistant-message";
      reply.textContent = "resumed after continue click";
      messages.appendChild(reply);
    });
    document.getElementById("composer-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const text = composer.value.trim();
      if (!text) return;
      composer.value = "";
      window.__received.push(text);
      const userBubble = document.createElement("div");
      userBubble.className = "user-message";
      userBubble.textContent = text;
      messages.appendChild(userBubble);
      setTimeout(() => {
        const reply = document.createElement("div");
        reply.className = "assistant-message";
        const isProbe = /connectivity probe/i.test(text);
        const isDispatch = /CONTROLLER STATUS BRIEF/i.test(text);
        reply.textContent = isProbe
          ? "WAIT: probe acknowledged"
          : isDispatch
            ? "WAIT: e2e acknowledged — queue policy: no new work in the fixture"
            : "WAIT: acknowledged";
        messages.appendChild(reply);
      }, 400);
    });
  </script>
</body></html>`;

// ── the fake GitHub API state machine ─────────────────────────────────────

function createGithubMock() {
  const state = {
    merged: [],
    createdIssues: [],
    comments: [],
    pr: {
      number: 10,
      title: "WO-1 — e2e lane",
      head: { ref: "work/e2e-lane", sha: "e2eprsha0000000000000000000000001" },
      draft: false,
      mergeable: true,
      user: { login: "worker" },
      created_at: "2026-10-16T00:00:00Z",
    },
  };
  return { state, route };
  function route(route) {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/user") return json({ login: "payswapdotorg" });
    if (path === "/repos/e2e-org/e2e-repo") return json({ default_branch: "main" });
    if (path === "/repos/e2e-org/e2e-repo/branches/main") {
      return json({ commit: { sha: "e2emainsha00000000000000000000001" } });
    }
    if (path === "/repos/e2e-org/e2e-repo/pulls") {
      return json(state.merged.length > 0 ? [] : [state.pr]);
    }
    if (path === "/repos/e2e-org/e2e-repo/issues") {
      if (method === "POST") {
        const body = route.request().postDataJSON();
        state.createdIssues.push(body);
        return json({ number: 42 + state.createdIssues.length, ...body });
      }
      return json([]);
    }
    if (/^\/repos\/e2e-org\/e2e-repo\/commits\/[^/]+\/check-runs$/.test(path)) {
      return json({ total_count: 1, check_runs: [{ conclusion: "success" }] });
    }
    if (/^\/repos\/e2e-org\/e2e-repo\/pulls\/\d+\/merge$/.test(path) && method === "PUT") {
      state.merged.push(route.request().postDataJSON());
      return json({ sha: "e2emerged0000000000000000000000001" });
    }
    if (/^\/repos\/e2e-org\/e2e-repo\/issues\/\d+\/comments$/.test(path) && method === "POST") {
      state.comments.push(route.request().postDataJSON());
      return json({ id: 1 });
    }
    return json({ message: `unexpected ${method} ${path}` }, 500);
  }
}

// ── the REAL local muse spark agent ───────────────────────────────────────

function createMuseSparkAgent(replyText) {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad json" }));
        return;
      }
      received.push({ at: new Date().toISOString(), payload });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: replyText }));
    });
  });
  const listen = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(MUSE_SPARK_PORT, "127.0.0.1", () => resolve());
    });
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  return { received, listen, close };
}

// ── the run ────────────────────────────────────────────────────────────────

async function main() {
  const { chromium } = await import("playwright");
  const profileDir = await mkdtemp(join(tmpdir(), "controller-e2e-"));
  const github = createGithubMock();
  const museSpark = createMuseSparkAgent(
    "DISPATCH: WO-2 — muse spark recovery lane\n```\nRecovery dispatch issued by the local muse spark agent fixture.\n```",
  );
  await museSpark.listen();
  console.log(`[e2e] local muse spark agent listening on 127.0.0.1:${MUSE_SPARK_PORT}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    ...(HEADLESS ? { channel: "chromium" } : {}),
    args: [
      "--disable-extensions-except=" + join(root, "dist/chromium"),
      "--load-extension=" + join(root, "dist/chromium"),
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    // Mocks first — the extension's fetches go through the same network stack.
    await context.route("https://api.github.com/**", github.route);
    await context.route("https://chat.z.ai/**", (route) =>
      route.fulfill({ contentType: "text/html", body: CHAT_PAGE_HTML }),
    );

    // The background service worker.
    let serviceWorker = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
    if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    console.log(`[e2e] extension up: ${extensionId} (${HEADLESS ? "headless" : "headed"})`);

    // Drive the message boundary through a REAL extension page (the popup):
    // chrome.runtime.sendMessage from the service worker's own context does not
    // deliver to its own onMessage listener — the popup page does.
    const driverPage = await context.newPage();
    await driverPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const sendToService = (message) =>
      driverPage.evaluate(async (payload) => {
        return await new Promise((resolve) => {
          chrome.runtime.sendMessage(payload, (response) => {
            void chrome.runtime.lastError;
            resolve(response ?? { ok: false, error: "no response" });
          });
        });
      }, message);
    const waitForLog = async (pattern, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = await sendToService({ type: "controller:status" });
        const hit = (status?.log ?? []).find((l) => pattern.test(`${l.kind}: ${l.message ?? ""}`));
        if (hit) return { hit, status };
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { hit: null, status: await sendToService({ type: "controller:status" }) };
    };

    // ═══ Scenario 1 — the full loop over the chat.z.ai driver ═══════════
    const configured = await sendToService({
      type: "controller:config:set",
      config: {
        github: { token: "e2e-token", owner: "e2e-org", repo: "e2e-repo", autoMerge: true, mergeMethod: "squash" },
        intelligence: { driver: "chatzai-web", localEndpoint: "http://127.0.0.1:8765" },
        chat: {
          resurrect: true,
          continuePrompt: "continue",
          directive: "You are the resident supervisor.",
          watchdogIntervalSeconds: 1,
          idleContinueAfterSeconds: 3,
        },
        loop: { intervalMinutes: 30 },
        safety: { requireGreenChecks: true, requireIntelligenceReview: false, onlyMergeBranchPrefixes: ["work/"] },
      },
    });
    if (!configured.ok) throw new Error(`config:set failed: ${configured.error}`);
    console.log("[e2e] scenario 1: config accepted (message boundary responsive after the v1.1 fix)");

    // Open + attach the (mocked) chat.z.ai session tab.
    const chatPage = await context.newPage();
    await chatPage.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded" });
    await chatPage.waitForSelector("#composer", { timeout: 15_000 });
    const attached = await sendToService({ type: "controller:chat:attach" });
    if (!attached.ok) throw new Error(`chat attach failed: ${JSON.stringify(attached)}`);
    console.log(`[e2e] scenario 1: chat tab attached (#${attached.tabId}, reused=${attached.reused})`);

    // Run ONE full supervisor cycle.
    await sendToService({ type: "controller:start" });
    {
      const deadline = Date.now() + 60_000;
      let chatReceived = 0;
      while (Date.now() < deadline) {
        chatReceived = await chatPage.evaluate(() => window.__received.length);
        if (github.state.merged.length === 1 && chatReceived >= 1) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    if (github.state.merged.length !== 1) {
      throw new Error(`expected exactly 1 merge, got ${github.state.merged.length}`);
    }
    const received = await chatPage.evaluate(() => window.__received);
    const dispatchBrief = received.find((t) => /CONTROLLER STATUS BRIEF/i.test(t));
    if (!dispatchBrief) {
      const dump = await sendToService({ type: "controller:status" });
      console.error("[e2e] supervisor log tail:\n" + (dump?.log ?? []).map((l) => `  ${l.kind}/${l.level}: ${l.message}`).join("\n"));
      throw new Error(`dispatch brief never reached the chat session; received=${JSON.stringify(received).slice(0, 300)}`);
    }
    console.log("[e2e] scenario 1: merge executed + dispatch brief delivered to the chat session");

    const { hit: waitLog } = await waitForLog(/dispatch: WAIT/);
    if (!waitLog) throw new Error("honest WAIT log entry missing");
    console.log("[e2e] scenario 1: honest WAIT recorded");

    // The no-continue-button surface: the page surfaces a REAL Continue button.
    await chatPage.evaluate(() => window.__showContinue());
    {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const clicks = await chatPage.evaluate(() => window.__continueClicks);
        if (clicks >= 1) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const continueClicks = await chatPage.evaluate(() => window.__continueClicks);
    if (continueClicks < 1) {
      throw new Error("the watchdog never clicked the surfaced Continue button");
    }
    const continueReplies = await chatPage.evaluate(() =>
      [...document.querySelectorAll(".assistant-message")].filter((n) => /resumed after continue click/.test(n.textContent ?? "")).length,
    );
    if (continueReplies < 1) throw new Error("the continue click did not resume the session on the page");
    console.log("[e2e] scenario 1: watchdog clicked the real Continue button by itself (no human)");

    await sendToService({ type: "controller:stop" });

    // ═══ Scenario 2 — chain fallback to the local muse spark agent ══════
    await chatPage.close();
    const chained = await sendToService({
      type: "controller:config:set",
      config: {
        github: { token: "e2e-token", owner: "e2e-org", repo: "e2e-repo", autoMerge: true, mergeMethod: "squash" },
        intelligence: {
          driver: "chain",
          timeoutSeconds: 8,
          failureThreshold: 2,
          cooldownMinutes: 1,
          chain: [
            { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
            { id: "muse-spark", kind: "local-http", url: `http://127.0.0.1:${MUSE_SPARK_PORT}/ask`, enabled: true },
          ],
        },
        chat: { resurrect: false, continuePrompt: "continue", directive: "You are the resident supervisor." },
        loop: { intervalMinutes: 30 },
        safety: { requireGreenChecks: true, requireIntelligenceReview: false, onlyMergeBranchPrefixes: ["work/"] },
      },
    });
    if (!chained.ok) throw new Error(`chain config failed: ${JSON.stringify(chained)}`);

    await sendToService({ type: "controller:start" });
    const { hit: museSparkHit } = await waitForLog(/chain: source "muse-spark" answered/, 60_000);
    if (!museSparkHit) {
      const dump = await sendToService({ type: "controller:status" });
      console.error("[e2e] log tail:\n" + (dump?.log ?? []).map((l) => `  ${l.kind}/${l.level}: ${l.message}`).join("\n"));
      throw new Error("the chain never rotated to the muse spark agent");
    }
    const { hit: rotationHit } = await waitForLog(/chain: source "chatzai-web" failed/);
    if (!rotationHit) throw new Error("the chatzai-web failure was not logged before rotation");
    if (museSpark.received.length < 1) throw new Error("the muse spark agent never received the brief");
    const briefPayload = museSpark.received[0].payload;
    if (!/CONTROLLER STATUS BRIEF/i.test(String(briefPayload?.brief ?? ""))) {
      throw new Error(`muse spark received an unexpected payload: ${JSON.stringify(briefPayload).slice(0, 200)}`);
    }
    {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (github.state.createdIssues.length >= 1) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (github.state.createdIssues.length < 1) {
      throw new Error("the muse-spark DISPATCH directive never created the next work order issue");
    }
    console.log(`[e2e] scenario 2: chain rotated chatzai-web -> muse spark; directive created issue "${github.state.createdIssues[0].title}"`);
    await sendToService({ type: "controller:stop" });

    // ═══ Scenario 3 — every source fails: honest, typed WAIT ════════════
    const doomed = await sendToService({
      type: "controller:config:set",
      config: {
        github: { token: "e2e-token", owner: "e2e-org", repo: "e2e-repo", autoMerge: true, mergeMethod: "squash" },
        intelligence: {
          driver: "chain",
          timeoutSeconds: 5,
          failureThreshold: 2,
          cooldownMinutes: 1,
          chain: [
            { id: "chatzai-web", kind: "chatzai-web", url: "", enabled: true },
            { id: "dead-agent", kind: "local-http", url: "http://127.0.0.1:1/ask", enabled: true },
          ],
        },
        chat: { resurrect: false, continuePrompt: "continue", directive: "You are the resident supervisor." },
        loop: { intervalMinutes: 30 },
        safety: { requireGreenChecks: true, requireIntelligenceReview: false, onlyMergeBranchPrefixes: ["work/"] },
      },
    });
    if (!doomed.ok) throw new Error(`doomed config failed: ${JSON.stringify(doomed)}`);
    await sendToService({ type: "controller:start" });
    const { hit: allFailedHit } = await waitForLog(/WAIT \(intelligence unavailable\): all intelligence sources failed/, 60_000);
    if (!allFailedHit) {
      const dump = await sendToService({ type: "controller:status" });
      console.error("[e2e] log tail:\n" + (dump?.log ?? []).map((l) => `  ${l.kind}/${l.level}: ${l.message}`).join("\n"));
      throw new Error("the all-sources-failed WAIT was never recorded");
    }
    console.log("[e2e] scenario 3: every source failed -> honest fail-closed WAIT naming both sources");
    await sendToService({ type: "controller:stop" });

    console.log("[e2e] PASS — full loop + continue-button watchdog + chain recovery + fail-closed posture verified");
  } finally {
    await context.close().catch(() => {});
    await museSpark.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[e2e] FAIL: ${error?.message ?? error}`);
  process.exit(1);
});
