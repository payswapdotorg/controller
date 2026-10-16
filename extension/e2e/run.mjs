#!/usr/bin/env node
/**
 * Controller extension E2E (Chromium-class target — Opera/Chrome/Edge engine).
 *
 * One REAL browser run of the full resident loop against fully mocked surfaces:
 *   - api.github.com  -> route-intercepted fixtures (a green in-fence PR that
 *     merges during the cycle, then an empty queue)
 *   - chat.z.ai       -> route-intercepted minimal chat page with the REAL
 *     packaged content script (the driver sends the dispatch brief, the page
 *     "thinks" 400ms and answers a scripted WAIT directive)
 *
 * Asserts the north-star mechanics end to end:
 *   1. the background service boots and accepts typed config;
 *   2. the attached chat tab answers the driver round-trip;
 *   3. one supervisor cycle MERGES the green PR through the mocked GitHub API;
 *   4. the empty queue sends the dispatch brief to the chat session (the page
 *      records every received message — no human continue button involved);
 *   5. the WAIT directive parks the loop honestly.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── the fake chat.z.ai page ────────────────────────────────────────────────

const CHAT_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Chat (mock)</title></head>
<body style="font-family: sans-serif; background: #0d1220; color: #eee">
  <div id="messages"><div class="assistant-message">Session ready. Ask anything.</div></div>
  <form id="composer-form">
    <textarea id="composer" placeholder="Message…"></textarea>
    <button id="send" type="submit" aria-label="Send">Send</button>
  </form>
  <script>
    window.__received = [];
    const messages = document.getElementById("messages");
    const composer = document.getElementById("composer");
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
        return json({ number: 42, ...body });
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

// ── the run ────────────────────────────────────────────────────────────────

async function main() {
  const { chromium } = await import("playwright");
  const profileDir = await mkdtemp(join(tmpdir(), "controller-e2e-"));
  const github = createGithubMock();

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
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
    console.log(`[e2e] extension up: ${extensionId}`);

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

    // 1. Configure.
    const configured = await sendToService({
      type: "controller:config:set",
      config: {
        github: { token: "e2e-token", owner: "e2e-org", repo: "e2e-repo", autoMerge: true, mergeMethod: "squash" },
        intelligence: { driver: "chatzai-web", localEndpoint: "http://127.0.0.1:8765" },
        chat: { resurrect: true, continuePrompt: "continue", directive: "You are the resident supervisor." },
        loop: { intervalMinutes: 30 },
        safety: { requireGreenChecks: true, requireIntelligenceReview: false, onlyMergeBranchPrefixes: ["work/"] },
      },
    });
    if (!configured.ok) throw new Error(`config:set failed: ${configured.error}`);
    console.log("[e2e] config accepted");

    // 2. Open + attach the (mocked) chat.z.ai session tab.
    const chatPage = await context.newPage();
    await chatPage.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded" });
    await chatPage.waitForSelector("#composer", { timeout: 15_000 });
    const attached = await sendToService({ type: "controller:chat:attach" });
    if (!attached.ok) throw new Error(`chat attach failed: ${JSON.stringify(attached)}`);
    console.log(`[e2e] chat tab attached (#${attached.tabId}, reused=${attached.reused})`);

    // Diagnostics: one direct driver round-trip before the loop.
    const probe = await sendToService({ type: "controller:chat:test" });
    console.log(`[e2e] chat driver probe: ${JSON.stringify(probe).slice(0, 300)}`);

    // 3. Run ONE full supervisor cycle.
    await sendToService({ type: "controller:start" });
    const deadline = Date.now() + 60_000;
    let status = null;
    while (Date.now() < deadline) {
      status = await sendToService({ type: "controller:status" });
      const merged = github.state.merged.length;
      const chatReceived = await chatPage.evaluate(() => window.__received.length);
      if (merged === 1 && chatReceived >= 1) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 4. Assertions.
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
    console.log(`[e2e] merge executed on the GitHub mock: ${JSON.stringify(github.state.merged[0])}`);
    console.log(`[e2e] dispatch brief delivered to the chat session (${received.length} messages total)`);

    // The chat reply settles ~4.5s after delivery (stability window) — await the
    // honest WAIT log entry with its own bounded poll.
    const logDeadline = Date.now() + 45_000;
    let waitLog = null;
    let finalStatus = status;
    while (Date.now() < logDeadline) {
      finalStatus = await sendToService({ type: "controller:status" });
      waitLog = (finalStatus?.log ?? []).find((l) => l.kind === "dispatch" && /WAIT/.test(l.message ?? ""));
      if (waitLog) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`[e2e] last action: ${finalStatus?.status?.lastAction ?? "?"} | cycles: ${finalStatus?.status?.cycles ?? "?"}`);

    const logs = finalStatus?.log ?? [];
    const harvestLog = logs.find((l) => l.kind === "harvest" && /#10 merged/.test(l.message ?? ""));
    if (!harvestLog) throw new Error("harvest log entry missing");
    if (!waitLog) {
      console.error("[e2e] supervisor log tail:\n" + logs.map((l) => `  ${l.kind}/${l.level}: ${l.message}`).join("\n"));
      throw new Error("honest WAIT log entry missing");
    }

    console.log("[e2e] PASS — full loop verified: monitor -> harvest (merge) -> dispatch brief -> chat intelligence -> honest WAIT");
  } finally {
    await context.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[e2e] FAIL: ${error?.message ?? error}`);
  process.exit(1);
});
