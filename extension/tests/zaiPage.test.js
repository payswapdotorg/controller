/**
 * Z.ai page surface tests (CTRL-014) — the content script's closed
 * DOM primitive vocabulary, executed offline through a minimal fake
 * DOM in a node:vm context (no Chrome, no network).
 *
 * Covers: the probe modes (visible/count/texts/text/value/enabled),
 * null-fact degradation for absent surfaces, action refusals on
 * ambiguity/disabled/invisible targets, the verbatim type semantics
 * with input/change events, the Enter key sequence, and the
 * fail-closed command validation (unknown op, missing marker,
 * invalid selector, oversized probe batches).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT = readFileSync(join(here, "..", "page", "zaiPage.js"), "utf-8");

/**
 * Copy a value out of the VM realm into plain main-realm values so
 * strict deep-equality works across realms (prototype identity
 * differs between vm contexts).
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles ?? false;
    this.cancelable = options.cancelable ?? false;
    this.key = options.key ?? "";
  }
}
class FakeInputEvent extends FakeEvent {}
class FakeKeyboardEvent extends FakeEvent {}
class FakeMouseEvent extends FakeEvent {}

class FakeElement {
  constructor({ tag = "div", id = "", text = "", value = null, attrs = {}, disabled = false, visible = true } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.textContent = text;
    if (value !== null) {
      this.value = value;
    }
    this.attrs = attrs;
    this.disabled = disabled;
    this.visible = visible;
    this.isConnected = true;
    this.events = [];
    this.clicked = 0;
    this.focused = false;
    this.rect = visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
  }
  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  focus() {
    this.focused = true;
  }
  click() {
    this.clicked += 1;
  }
  dispatchEvent(event) {
    this.events.push(event.type);
    return true;
  }
}

/**
 * The selector grammar the fake DOM accepts: tag, #id, [attr],
 * [attr="value"], tag[attr="value"], and comma groups. Anything else
 * throws a SyntaxError exactly like a real document would.
 */
const SIMPLE_SELECTORS = [
  /^#[A-Za-z][A-Za-z0-9_-]*$/,
  /^\[[A-Za-z-]+\]$/,
  /^\[[A-Za-z-]+="[^"]*"\]$/,
  /^[a-zA-Z]+$/,
  /^[a-zA-Z]+\[[A-Za-z-]+="[^"]*"\]$/,
];

/** Validate that a selector parses in the grammar (no element access). */
function validateSelector(selector) {
  for (const part of selector.split(",").map((s) => s.trim())) {
    if (!SIMPLE_SELECTORS.some((pattern) => pattern.test(part))) {
      throw new SyntaxError(`'${part}' is not a valid selector`);
    }
  }
}

/** Match one simple selector against an element. */
function matchesSimple(element, selector) {
  if (selector.startsWith("#")) {
    return element.id === selector.slice(1);
  }
  const attrMatch = selector.match(/^\[([A-Za-z-]+)(?:="([^"]+)")?\]$/);
  if (attrMatch) {
    const value = element.getAttribute(attrMatch[1]);
    return attrMatch[2] === undefined ? value !== null : value === attrMatch[2];
  }
  const tagAttr = selector.match(/^([a-zA-Z]+)\[([A-Za-z-]+)="([^"]+)"\]$/);
  if (tagAttr) {
    return element.tagName === tagAttr[1].toUpperCase() && element.getAttribute(tagAttr[2]) === tagAttr[3];
  }
  return element.tagName === selector.toUpperCase();
}

function matches(element, selector) {
  return selector.split(",").map((s) => s.trim()).some((simple) => matchesSimple(element, simple));
}

/**
 * Build the page-script environment and return its listener driver.
 * The fake document supports exactly the selector grammar the
 * product uses (tag, #id, [attr], [attr="value"], tag[attr="value"],
 * and comma groups).
 */
function buildPage(elements, { activeElement = null } = {}) {
  const listeners = [];
  const document = {
    body: new FakeElement({ tag: "body" }),
    querySelectorAll(selector) {
      // Parse-validate the selector FIRST — exactly like a real
      // document (parsing precedes matching, even with zero
      // candidate elements).
      validateSelector(selector);
      return elements.filter((element) => element.visible && matches(element, selector));
    },
    activeElement,
  };
  const context = vm.createContext({
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listeners.push(fn);
          },
        },
      },
    },
    document,
    window: {
      getComputedStyle(element) {
        return { visibility: element.visible ? "visible" : "hidden", display: element.visible ? "block" : "none" };
      },
    },
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    InputEvent: FakeInputEvent,
    KeyboardEvent: FakeKeyboardEvent,
    MouseEvent: FakeMouseEvent,
    Event: FakeEvent,
  });
  context.Object = Object;
  context.Array = Array;
  context.Number = Number;
  context.String = String;
  vm.runInContext(PAGE_SCRIPT, context, { filename: "page/zaiPage.js" });
  assert.equal(listeners.length, 1);
  return {
    send(message) {
      return new Promise((resolve) => {
        const keepOpen = listeners[0](message, {}, resolve);
        assert.equal(keepOpen, true);
      });
    },
    document,
  };
}

// --------------------------------------------------------------------
// Probes.
// --------------------------------------------------------------------

test("probe visible/count report structural facts about the surface", async () => {
  const composer = new FakeElement({ tag: "textarea", id: "chat-input", value: "hello" });
  const page = buildPage([composer]);
  const result = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [
      { name: "composer", selector: "#chat-input", mode: "visible" },
      { name: "dialogs", selector: '[role="dialog"], dialog', mode: "count" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.facts.composer), { visible: true, count: 1 });
  assert.deepEqual(plain(result.facts.dialogs), { count: 0, matching: 0 });
});

test("probe text/value/enabled read the single visible element", async () => {
  const composer = new FakeElement({ tag: "textarea", id: "chat-input", value: "hello" });
  const dialog = new FakeElement({ tag: "div", attrs: { role: "dialog" }, text: "Confirm submission" });
  const page = buildPage([composer, dialog]);
  const result = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [
      { name: "composer", selector: "#chat-input", mode: "value" },
      { name: "dialog", selector: '[role="dialog"], dialog', mode: "text" },
      { name: "enabled", selector: "#chat-input", mode: "enabled" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.facts.composer), { value: "hello" });
  assert.deepEqual(plain(result.facts.dialog), { text: "Confirm submission" });
  assert.deepEqual(plain(result.facts.enabled), { enabled: true });
});

test("absent or ambiguous fact probes degrade to explicit null facts", async () => {
  const one = new FakeElement({ tag: "div", attrs: { role: "alert" }, text: "a" });
  const two = new FakeElement({ tag: "div", attrs: { role: "alert" }, text: "b" });
  const page = buildPage([one, two]);
  const result = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [
      { name: "missing", selector: '[role="dialog"]', mode: "text" },
      { name: "ambiguous", selector: '[role="alert"]', mode: "text" },
      { name: "missingEnabled", selector: '[role="dialog"]', mode: "enabled" },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.facts.missing), { text: null, ambiguous: false });
  assert.deepEqual(plain(result.facts.ambiguous), { text: null, ambiguous: true });
  assert.deepEqual(plain(result.facts.missingEnabled), { enabled: null, ambiguous: false });
});

test("probe texts returns every visible match's trimmed text in order", async () => {
  const b1 = new FakeElement({ tag: "button", text: "Sign in" });
  const b2 = new FakeElement({ tag: "button", text: "  ZCode  " });
  const b3 = new FakeElement({ tag: "button", text: "Agent" });
  const page = buildPage([b1, b2, b3]);
  const result = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [{ name: "buttons", selector: "button", mode: "texts" }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.facts.buttons), { texts: ["Sign in", "ZCode", "Agent"] });
});

test("invisible elements are excluded from every probe mode", async () => {
  const hidden = new FakeElement({ tag: "button", text: "Hidden", visible: false });
  const page = buildPage([hidden]);
  const result = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [{ name: "buttons", selector: "button", mode: "texts" }],
  });
  assert.deepEqual(plain(result.facts.buttons), { texts: [] });
});

test("a malformed probe (bad mode / bad shape) refuses the whole batch", async () => {
  const page = buildPage([]);
  const badMode = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [{ name: "x", selector: "button", mode: "hover" }],
  });
  assert.equal(badMode.ok, false);
  assert.equal(badMode.error.code, "PAGE_MALFORMED");

  const badShape = await page.send({ zaiPage: true, op: "probe", probes: "not-a-list" });
  assert.equal(badShape.ok, false);
  assert.equal(badShape.error.code, "PAGE_MALFORMED");

  const tooMany = await page.send({
    zaiPage: true,
    op: "probe",
    probes: Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, selector: "button", mode: "visible" })),
  });
  assert.equal(tooMany.ok, false);
  assert.ok(/at most 64/.test(tooMany.error.message));
});

test("an invalid selector is a malformed command, never a silent empty result", async () => {
  const page = buildPage([]);
  const result = await page.send({
    zaiPage: true,
    op: "probe",
    probes: [{ name: "x", selector: "button[unclosed", mode: "visible" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
});

// --------------------------------------------------------------------
// Actions.
// --------------------------------------------------------------------

test("click clicks the single visible enabled match", async () => {
  const send = new FakeElement({ tag: "button", id: "send-message-button" });
  const page = buildPage([send]);
  const result = await page.send({ zaiPage: true, op: "click", selector: "#send-message-button" });
  assert.equal(result.ok, true);
  assert.equal(result.clicked, true);
  assert.equal(send.clicked, 1);
  assert.deepEqual(send.events, ["mousedown", "mouseup"]);
});

test("click refuses ambiguity, invisibility, and disabled targets", async () => {
  const a = new FakeElement({ tag: "button", attrs: { "aria-label": "Agent" } });
  const b = new FakeElement({ tag: "button", attrs: { "aria-label": "Agent" } });
  const disabled = new FakeElement({ tag: "button", id: "send-message-button", disabled: true });
  const invisible = new FakeElement({ tag: "button", id: "new-chat-button", visible: false });
  const page = buildPage([a, b, disabled, invisible]);

  const ambiguous = await page.send({ zaiPage: true, op: "click", selector: 'button[aria-label="Agent"]' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "PAGE_AMBIGUOUS");
  assert.ok(/2 visible elements/.test(ambiguous.error.message));

  const refused = await page.send({ zaiPage: true, op: "click", selector: "#send-message-button" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "PAGE_REFUSED");

  const missing = await page.send({ zaiPage: true, op: "click", selector: "#new-chat-button" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "PAGE_AMBIGUOUS");
});

test("clickIndex clicks the index-th visible match in the probe's ordering", async () => {
  const b1 = new FakeElement({ tag: "button", text: "GLM-5.3-Flash" });
  const b2 = new FakeElement({ tag: "button", text: "GLM-5.3" });
  const b3 = new FakeElement({ tag: "button", text: "GLM-5.2" });
  const page = buildPage([b1, b2, b3]);
  const result = await page.send({ zaiPage: true, op: "clickIndex", selector: "button", index: 1 });
  assert.equal(result.ok, true);
  assert.equal(b2.clicked, 1);
  assert.equal(b1.clicked, 0);
  const outOfRange = await page.send({ zaiPage: true, op: "clickIndex", selector: "button", index: 5 });
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error.code, "PAGE_AMBIGUOUS");
});

test("type sets the value verbatim and fires input+change events", async () => {
  const composer = new FakeElement({ tag: "textarea", id: "chat-input", value: "" });
  const page = buildPage([composer]);
  const prompt = "line one\nline two & special 'chars' — verbatim";
  const result = await page.send({ zaiPage: true, op: "type", selector: "#chat-input", text: prompt });
  assert.equal(result.ok, true);
  assert.equal(result.typed, true);
  assert.equal(composer.value, prompt); // byte-identical, never rewritten
  assert.equal(composer.focused, true);
  assert.deepEqual(composer.events, ["input", "change"]);
});

test("type refuses when the element rejects the exact text", async () => {
  const composer = new FakeElement({ tag: "textarea", id: "chat-input", value: "" });
  // A React-controlled composer that ignores the programmatic value:
  Object.defineProperty(composer, "value", {
    get() {
      return "something else";
    },
    set() {
      /* swallowed */
    },
    configurable: true,
  });
  const page = buildPage([composer]);
  const result = await page.send({ zaiPage: true, op: "type", selector: "#chat-input", text: "prompt" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_REFUSED");
  assert.ok(/verbatim/.test(result.error.message));
});

test("pressEnter dispatches the Enter key sequence on the focused element", async () => {
  const composer = new FakeElement({ tag: "textarea", id: "chat-input", value: "x" });
  const page = buildPage([composer], { activeElement: composer });
  const result = await page.send({ zaiPage: true, op: "pressEnter" });
  assert.equal(result.ok, true);
  assert.equal(result.pressed, "Enter");
  assert.deepEqual(composer.events, ["keydown", "keypress", "keyup"]);
});

test("pressEnter falls back to the body when nothing is focused", async () => {
  const page = buildPage([], { activeElement: null });
  const result = await page.send({ zaiPage: true, op: "pressEnter" });
  assert.equal(result.ok, true);
  assert.equal(result.target, "BODY");
  assert.deepEqual(page.document.body.events, ["keydown", "keypress", "keyup"]);
});

// --------------------------------------------------------------------
// Command-boundary fail-closed rules.
// --------------------------------------------------------------------

test("an unknown op is refused with the closed vocabulary named", async () => {
  const page = buildPage([]);
  const result = await page.send({ zaiPage: true, op: "scrollIntoView", selector: "#x" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGE_MALFORMED");
  assert.ok(/probe, click, type, pressEnter/.test(result.error.message));
});

test("a message without the zaiPage marker is ignored, never consumed", async () => {
  const page = buildPage([]);
  // The listener returns false for foreign messages and never answers.
  const ignored = await new Promise((resolve) => {
    const pageModule = page;
    void pageModule;
    // Re-dispatch through a raw listener invocation:
    const result = rawListener(page)({ kind: "GetConfiguration" }, {}, resolve);
    assert.equal(result, false);
    setTimeout(() => resolve("no-response"), 10);
  });
  assert.equal(ignored, "no-response");
});

test("a missing-marker page command is ignored without response (not ours)", async () => {
  // A command missing the zaiPage marker is a foreign message: the
  // listener must return false (never consume it) and never answer.
  const listener = rawListener();
  const answered = await new Promise((resolve) => {
    const keepOpen = listener({ op: "probe", probes: [] }, {}, () => resolve("answered"));
    assert.equal(keepOpen, false);
    setTimeout(() => resolve("no-response"), 20);
  });
  assert.equal(answered, "no-response");
});

/** Access the raw registered listener for foreign-message tests. */
function rawListener(page) {
  // The page object only exposes send(); rebuild a context to grab the
  // listener directly (the same script, a second isolated context).
  const listeners = [];
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } },
    document: { body: {}, querySelectorAll: () => [] },
    window: { getComputedStyle: () => ({ visibility: "visible", display: "block" }) },
    HTMLElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    InputEvent: FakeInputEvent,
    KeyboardEvent: FakeKeyboardEvent,
    MouseEvent: FakeMouseEvent,
    Event: FakeEvent,
    Object,
    Array,
    Number,
    String,
  });
  vm.runInContext(PAGE_SCRIPT, context, { filename: "page/zaiPage.js" });
  return listeners[0];
}
