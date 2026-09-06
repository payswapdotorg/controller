/**
 * The Z.ai provider page surface (CTRL-014) — the extension's ONLY
 * content script.
 *
 * This is the generic, closed-vocabulary DOM primitive executor that
 * runs inside `https://chat.z.ai/*` pages. It contains NO
 * provider-specific knowledge: no Z.ai selectors, no observation
 * interpretation, no sequencing. Every locator and every interpretation
 * of page facts lives in the Z.ai adapter (src/zaiAdapter.js), which
 * drives this surface through the page bridge (src/zaiPageBridge.js).
 *
 * The closed command vocabulary (nothing else is executable):
 *
 *   { zaiPage: true, op: "probe", probes: [{ name, selector, mode }] }
 *       mode: "visible" | "enabled" | "text" | "value" | "count" | "texts"
 *              | "location"
 *       -> { ok: true, facts: { [name]: ... } }   structural facts only
 *
 *       CONTINUATION 16 (PR #6 review 5125198728): the "location" mode
 *       reports the document's own URL (href) — a GENERIC page fact
 *       with no element, so its probe needs no selector. The page's
 *       URL is the provider's own routing state (which chat session
 *       the page holds); this script only REPORTS it, never
 *       navigates, never parses it, never compares it — every
 *       interpretation of the URL lives in the adapter. Like every
 *       fact probe it is read-only: no action can ever be issued
 *       through it.
 *
 *   { zaiPage: true, op: "click", selector }
 *       -> clicks the single visible+enabled match (ambiguity refuses)
 *
 *   { zaiPage: true, op: "clickIndex", selector, index }
 *       -> clicks the index-th visible+enabled match (the adapter
 *          resolves WHICH index from a prior "texts" probe; the two
 *          share the same visible-match ordering)
 *
 *   { zaiPage: true, op: "type", selector, text }
 *       -> focuses the single match, sets its value verbatim, fires
 *          input/change events (React-controlled surfaces accept it)
 *
 *   { zaiPage: true, op: "pressEnter" }
 *       -> dispatches an Enter key sequence on the focused element (or
 *          the body when nothing is focused) — the ONLY key the page
 *          surface can ever press, and only on explicit command
 *
 * Fail-closed rules (mirroring the extension's typed boundary):
 *   - an unknown op or a malformed command is refused, never guessed;
 *   - a selector matching zero, or MORE THAN ONE, visible element for
 *     an ACTION refuses (no best-effort clicking); a FACT probe over
 *     zero or many visible elements degrades to an explicit null
 *     fact (absence is information — the adapter classifies it);
 *   - results are structural facts (booleans/strings/numbers), never
 *     an element reference, never page scripting, never evaluation;
 *   - messages without the `zaiPage: true` marker are ignored (the
 *     channel serves only the Z.ai adapter bridge);
 *   - no network, no storage, no credential access, no remote code —
 *     the script only reads/dispatches DOM events in its own page.
 *
 * Human authentication remains out of band: this script never
 * interacts with login forms or credentials.
 */
/* global chrome, document, window, HTMLElement, HTMLTextAreaElement,
          InputEvent, KeyboardEvent, MouseEvent, Event */

(function () {
  "use strict";

  var PROBE_MODES = ["visible", "enabled", "text", "value", "count", "texts", "location"];
  var MAX_PROBES = 64;
  var MAX_TEXT = 4000;

  function fail(code, message) {
    return { ok: false, error: { code: code, message: message } };
  }

  /**
   * Structural visibility: attached to the document and occupying a
   * non-zero box (the provider's overlays use display/opacity rules the
   * box check captures without provider knowledge).
   */
  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    if (typeof element.getBoundingClientRect === "function") {
      var box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        return false;
      }
    }
    var style = window.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function matches(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector), 0, 50);
    } catch (err) {
      return null; // invalid selector — treated as a malformed command
    }
  }

  function textOf(element) {
    // Form controls report their VALUE; every other element reports
    // its text content. (A <button> also HAS a .value property — an
    // empty string by default — which must never shadow its label.)
    var tag = element.tagName;
    var text = "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      text = typeof element.value === "string" ? element.value : "";
    } else if (typeof element.textContent === "string") {
      text = element.textContent;
    }
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  }

  function runProbe(probe) {
    if (typeof probe !== "object" || probe === null || Array.isArray(probe)) {
      return fail("PAGE_MALFORMED", "probe must be an object");
    }
    if (typeof probe.name !== "string" || probe.name.length === 0) {
      return fail("PAGE_MALFORMED", "probe.name must be a non-empty string");
    }
    if (PROBE_MODES.indexOf(probe.mode) === -1) {
      return fail("PAGE_MALFORMED", "probe.mode must be one of " + PROBE_MODES.join(", "));
    }
    // CONTINUATION 16: the document's own URL — the one selectorless
    // fact (no element exists to resolve; the URL is the page's
    // routing state, reported verbatim, never interpreted here). A
    // page without a usable location answers an explicit null fact
    // (absence is information, exactly like every other fact probe).
    if (probe.mode === "location") {
      var href = document.location && typeof document.location.href === "string" ? document.location.href : null;
      return { ok: true, fact: { href: href } };
    }
    if (typeof probe.selector !== "string" || probe.selector.length === 0) {
      return fail("PAGE_MALFORMED", "probe.selector must be a non-empty string");
    }
    var found = matches(probe.selector);
    if (found === null) {
      return fail("PAGE_MALFORMED", "probe selector is not a valid selector");
    }
    var visible = found.filter(isVisible);
    if (probe.mode === "count") {
      return { ok: true, fact: { count: visible.length, matching: found.length } };
    }
    if (probe.mode === "texts") {
      // Every visible match's trimmed text, in DOM order — the adapter
      // interprets the list (exact-token matching lives there, never
      // here). Indices align with the clickIndex op's visible order.
      return { ok: true, fact: { texts: visible.map(textOf).map(function (t) { return t.trim(); }) } };
    }
    if (probe.mode === "visible") {
      return { ok: true, fact: { visible: visible.length > 0, count: visible.length } };
    }
    if (visible.length !== 1) {
      // A fact probe over zero or many visible elements yields an
      // explicit null fact — absence/ambiguity is information the
      // adapter interprets; only ACTIONS refuse on ambiguity.
      if (probe.mode === "enabled") {
        return { ok: true, fact: { enabled: null, ambiguous: visible.length > 1 } };
      }
      if (probe.mode === "text") {
        return { ok: true, fact: { text: null, ambiguous: visible.length > 1 } };
      }
      return { ok: true, fact: { value: null, ambiguous: visible.length > 1 } };
    }
    var element = visible[0];
    if (probe.mode === "enabled") {
      return { ok: true, fact: { enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true" } };
    }
    if (probe.mode === "text") {
      return { ok: true, fact: { text: textOf(element) } };
    }
    if (probe.mode === "value") {
      return { ok: true, fact: { value: typeof element.value === "string" ? element.value : null } };
    }
    return fail("PAGE_MALFORMED", "unhandled probe mode");
  }

  function requireSingleVisible(selector, action) {
    var found = matches(selector);
    if (found === null) {
      return fail("PAGE_MALFORMED", "invalid selector for " + action);
    }
    var visible = found.filter(isVisible);
    if (visible.length !== 1) {
      return fail(
        "PAGE_AMBIGUOUS",
        action + " matched " + visible.length + " visible elements (need exactly 1; refusing best-effort action)"
      );
    }
    return { ok: true, element: visible[0] };
  }

  function clickElement(element) {
    if (element.disabled || element.getAttribute("aria-disabled") === "true") {
      return fail("PAGE_REFUSED", "the matched element is disabled — action refused");
    }
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    element.click();
    return { ok: true, clicked: true };
  }

  function setValue(element, text) {
    // Focus, then set the value through the native value setter so
    // React-controlled composers observe a real programmatic change,
    // then fire the standard input/change events. The text is carried
    // verbatim — never trimmed, never rewritten.
    if (typeof element.focus === "function") {
      element.focus();
    }
    var proto = Object.getPrototypeOf(element);
    var descriptor = Object.getOwnPropertyDescriptor(proto, "value") ||
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, "value") ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(element, text);
    } else {
      element.value = text;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === text;
  }

  function pressEnter() {
    var target = document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : document.body;
    var options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", options));
    target.dispatchEvent(new KeyboardEvent("keypress", options));
    target.dispatchEvent(new KeyboardEvent("keyup", options));
    return { ok: true, pressed: "Enter", target: target.tagName };
  }

  function handle(message) {
    if (typeof message !== "object" || message === null || message.zaiPage !== true) {
      return fail("PAGE_MALFORMED", "not a Z.ai page command");
    }
    if (typeof message.op !== "string") {
      return fail("PAGE_MALFORMED", "op must be a string");
    }
    if (message.op === "probe") {
      if (!Array.isArray(message.probes) || message.probes.length === 0 || message.probes.length > MAX_PROBES) {
        return fail("PAGE_MALFORMED", "probes must be a non-empty array of at most " + MAX_PROBES + " probes");
      }
      var facts = {};
      for (var i = 0; i < message.probes.length; i++) {
        var result = runProbe(message.probes[i]);
        if (!result.ok) {
          return result;
        }
        facts[message.probes[i].name] = result.fact;
      }
      return { ok: true, facts: facts };
    }
    if (message.op === "click") {
      if (typeof message.selector !== "string" || message.selector.length === 0) {
        return fail("PAGE_MALFORMED", "click.selector must be a non-empty string");
      }
      var clickable = requireSingleVisible(message.selector, "click");
      if (!clickable.ok) {
        return clickable;
      }
      return clickElement(clickable.element);
    }
    if (message.op === "clickIndex") {
      if (typeof message.selector !== "string" || message.selector.length === 0) {
        return fail("PAGE_MALFORMED", "clickIndex.selector must be a non-empty string");
      }
      if (typeof message.index !== "number" || !Number.isInteger(message.index) || message.index < 0) {
        return fail("PAGE_MALFORMED", "clickIndex.index must be a non-negative integer (the visible-match ordering from a prior texts probe)");
      }
      var indexed = matches(message.selector);
      if (indexed === null) {
        return fail("PAGE_MALFORMED", "invalid selector for clickIndex");
      }
      var indexedVisible = indexed.filter(isVisible);
      if (message.index >= indexedVisible.length) {
        return fail("PAGE_AMBIGUOUS", "clickIndex " + message.index + " is outside the current visible matches (" + indexedVisible.length + ") — the page changed; re-probe");
      }
      return clickElement(indexedVisible[message.index]);
    }
    if (message.op === "type") {
      if (typeof message.selector !== "string" || message.selector.length === 0) {
        return fail("PAGE_MALFORMED", "type.selector must be a non-empty string");
      }
      if (typeof message.text !== "string") {
        return fail("PAGE_MALFORMED", "type.text must be a string (the exact prompt, verbatim)");
      }
      var target = requireSingleVisible(message.selector, "type");
      if (!target.ok) {
        return target;
      }
      var accepted = setValue(target.element, message.text);
      if (!accepted) {
        return fail("PAGE_REFUSED", "the composer did not accept the exact text verbatim");
      }
      return { ok: true, typed: true, value: target.element.value };
    }
    if (message.op === "pressEnter") {
      return pressEnter();
    }
    return fail("PAGE_MALFORMED", "unknown op '" + String(message.op) + "' (closed vocabulary: probe, click, type, pressEnter)");
  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
      if (typeof message !== "object" || message === null || message.zaiPage !== true) {
        return false; // not ours — never consume another listener's message
      }
      try {
        sendResponse(handle(message));
      } catch (err) {
        sendResponse(fail("PAGE_MALFORMED", "page command failed: " + err));
      }
      return true; // the response is sent
    });
  }
})();
