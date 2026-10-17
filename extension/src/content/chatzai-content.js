/**
 * chat.z.ai content driver — the DOM automation surface.
 *
 * The north-star requirement: the connected chat.z.ai session is a source of
 * intelligence WITHOUT a human pressing continue. This script:
 *
 *   1. answers ping (composer readiness);
 *   2. sends a brief and waits for the assistant turn to COMPLETE
 *      (multi-strategy completion detection — never a guess: on ambiguous
 *      DOM it times out honestly and reports the failure kind);
 *   3. returns the last assistant message text;
 *   4. runs a local auto-continue watchdog that, when the session sits idle:
 *      FIRST clicks the real continue affordance when the page surfaces one
 *      (the exact button the owner never wants to press), and only otherwise
 *      types the configured continue prompt into the composer.
 *
 * Watchdog timings and the continue prompt come from the live config
 * (chrome.storage.local "controller.config") and refresh on config changes.
 *
 * Selector strategies are intentionally layered (generic ARIA/textbox/submit
 * semantics first, product-specific attributes second) so the driver degrades
 * honestly rather than silently misfiring when the host app changes.
 */

import { isContinueControl } from "./continue-match.js";

(() => {
  if (window.__CONTROLLER_CHAT_DRIVER__) return;
  window.__CONTROLLER_CHAT_DRIVER__ = true;

  const SEND_TIMEOUT_MS = 10 * 60 * 1000;
  const CONFIG_KEY = "controller.config";

  // Watchdog tuning — replaced by the live config as soon as it loads.
  let watchdog = {
    continuePrompt: "continue",
    idleContinueAfterMs: 45 * 1000,
    watchdogIntervalMs: 30 * 1000,
    configured: false,
  };
  let watchdogTimer = null;

  async function loadWatchdogConfig() {
    try {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      const chat = stored?.[CONFIG_KEY]?.chat;
      if (!chat) return;
      watchdog = {
        continuePrompt: typeof chat.continuePrompt === "string" && chat.continuePrompt.trim() !== "" ? chat.continuePrompt : "continue",
        idleContinueAfterMs: Math.max(2, Number(chat.idleContinueAfterSeconds) || 45) * 1000,
        watchdogIntervalMs: Math.max(1, Number(chat.watchdogIntervalSeconds) || 30) * 1000,
        configured: true,
      };
      scheduleWatchdog();
    } catch {
      // No config yet — the defaults above keep the watchdog honest.
    }
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CONFIG_KEY]) void loadWatchdogConfig();
    });
  }
  void loadWatchdogConfig();

  // ── element discovery (layered strategies) ───────────────────────────────

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function findComposer() {
    const candidates = [
      ...document.querySelectorAll('textarea:not([readonly]):not([disabled])'),
      ...document.querySelectorAll('div[contenteditable="true"][role="textbox"]'),
      ...document.querySelectorAll('div[contenteditable="true"]'),
      ...document.querySelectorAll('[role="textbox"][contenteditable="true"]'),
    ];
    const visibleOnes = candidates.filter(visible);
    // Prefer the last (bottom-most) visible composer — chat UIs put it last.
    return visibleOnes.length > 0 ? visibleOnes[visibleOnes.length - 1] : null;
  }

  function findContinueControl() {
    const controls = [...document.querySelectorAll('button, [role="button"], a[role="button"]')];
    const candidates = controls.filter((el) => visible(el) && isContinueControl(el));
    // Prefer the last visible one (bottom of the transcript is where chat UIs
    // anchor the continue affordance).
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }

  function findSendButton(composer) {
    const scope = composer?.closest("form") ?? document;
    const buttons = [...scope.querySelectorAll("button")].filter(visible);
    // Strategy 1: explicit submit inside the composer form.
    const submit = buttons.find((b) => b.type === "submit" && !b.disabled);
    if (submit) return submit;
    // Strategy 2: aria/label semantics.
    const labelled = buttons.find((b) => {
      const label = (
        b.getAttribute("aria-label") ||
        b.getAttribute("title") ||
        b.textContent ||
        ""
      ).toLowerCase();
      return /send|submit|arrow-up|arrow_up/.test(label) && !b.disabled;
    });
    if (labelled) return labelled;
    // Strategy 3: last enabled button near the composer.
    const near = buttons.filter((b) => !b.disabled && composer && Math.abs(b.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom) < 220);
    return near.length > 0 ? near[near.length - 1] : null;
  }

  function messageNodes() {
    const nodes = [
      ...document.querySelectorAll('[data-message-author-role="assistant"]'),
      ...document.querySelectorAll('[data-testid*="assistant"i]'),
      ...document.querySelectorAll('[class*="assistant"i]'),
      ...document.querySelectorAll('[class*="markdown"i]'),
    ];
    const unique = new Set(nodes);
    return [...unique].filter((n) => visible(n) && (n.textContent ?? "").trim().length > 0);
  }

  function lastAssistantText() {
    const nodes = messageNodes();
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const text = (nodes[i].innerText ?? nodes[i].textContent ?? "").trim();
      if (text.length > 0) return text;
    }
    return null;
  }

  function generationInFlight() {
    // Streaming indicators: enabled stop buttons, spinners, "thinking" chips.
    const stopLike = [...document.querySelectorAll("button")].some(
      (b) =>
        visible(b) &&
        !b.disabled &&
        /^(stop|halt|pause)$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()),
    );
    const spinner = [...document.querySelectorAll('[class*="loading"i], [class*="typing"i], [class*="generating"i]')].some(visible);
    return stopLike || spinner;
  }

  // ── actions ──────────────────────────────────────────────────────────────

  async function typeIntoComposer(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(composer, text);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable: insertText keeps the host editor's own state consistent.
      composer.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
    await sleep(150);
    const value = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.textContent;
    if ((value ?? "").trim() === "") {
      return { ok: false, error: "composer did not accept the text" };
    }
    return { ok: true };
  }

  function pressSend(composer) {
    const button = findSendButton(composer);
    if (button) {
      button.click();
      return { ok: true, via: "button" };
    }
    // Keyboard fallback: Enter.
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
    );
    return { ok: true, via: "enter" };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForCompletion(beforeCount, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let stableSince = null;
    let lastCount = beforeCount;
    while (Date.now() < deadline) {
      await sleep(1000);
      const count = messageNodes().length;
      if (count !== lastCount || generationInFlight()) {
        lastCount = count;
        stableSince = null;
        continue;
      }
      if (count > beforeCount) {
        if (stableSince === null) stableSince = Date.now();
        if (Date.now() - stableSince >= 4000) {
          return { ok: true, count };
        }
      }
    }
    return { ok: false, error: "completion timeout — assistant turn did not settle", count: lastCount };
  }

  async function sendBrief(text) {
    // One exchange at a time: the driver's ask() and the watchdog share this
    // entry point. While a send + completion-wait is in flight the watchdog
    // must stay quiet — otherwise its auto-continue keeps the transcript
    // moving and the driver's completion detector never settles.
    if (sendBrief.inFlight) return { ok: false, error: "another send is already in flight" };
    sendBrief.inFlight = true;
    try {
      const composer = findComposer();
      if (!composer) return { ok: false, error: "composer not found on the page" };
      const typed = await typeIntoComposer(composer, text);
      if (!typed.ok) return typed;
      const before = messageNodes().length;
      const sent = pressSend(composer);
      if (!sent.ok) return sent;
      const completion = await waitForCompletion(before, SEND_TIMEOUT_MS);
      if (!completion.ok) return completion;
      const reply = lastAssistantText();
      if (reply === null) return { ok: false, error: "assistant turn completed but no text extracted" };
      return { ok: true, text: reply };
    } finally {
      sendBrief.inFlight = false;
    }
  }

  // ── message boundary with the background service ────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "chatzai:ping") {
      const composer = findComposer();
      sendResponse({ ok: true, ready: Boolean(composer), messages: messageNodes().length });
      return false;
    }
    if (message?.type === "chatzai:send") {
      sendBrief(String(message.text ?? ""))
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
      return true; // async response
    }
    return false;
  });

  // ── the auto-continue watchdog (no continue button, ever) ───────────────

  let lastActivityAt = Date.now();
  const observer = new MutationObserver(() => {
    lastActivityAt = Date.now();
  });
  const startObserving = () => observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  if (document.body) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving);

  async function watchdogTick() {
    try {
      if (sendBrief.inFlight) return; // never fight an in-flight driver exchange
      if (generationInFlight()) return;
      const idleFor = Date.now() - lastActivityAt;
      if (idleFor < watchdog.idleContinueAfterMs) return;

      // 1. The REAL continue affordance: the page surfaces a continue button —
      //    click it ourselves (the exact thing the owner refuses to do by hand).
      const continueControl = findContinueControl();
      if (continueControl) {
        lastActivityAt = Date.now();
        continueControl.click();
        window.__controllerContinueClicks = (window.__controllerContinueClicks ?? 0) + 1;
        return;
      }

      // 2. Fallback: idle composer — type the configured continue prompt.
      const composer = findComposer();
      if (!composer) return;
      const empty = ((composer.value ?? composer.textContent ?? "")).trim() === "";
      if (!empty) return;
      lastActivityAt = Date.now();
      await sendBrief(watchdog.continuePrompt);
    } catch {
      // The watchdog never throws upward; failures surface via sendBrief logs.
    }
  }

  function scheduleWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => void watchdogTick(), watchdog.watchdogIntervalMs);
  }
  scheduleWatchdog();
})();
