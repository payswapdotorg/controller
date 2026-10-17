/**
 * The continue-control matcher — the pure half of the no-continue-button
 * watchdog. The content script supplies DOM elements; these tests pin the
 * decision table (labels, shapes, disabled states, icon-only buttons).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONTINUE_LABEL_RE, controlLabel, isContinueControl } from "../src/content/continue-match.js";

function fakeEl({ tag = "BUTTON", role = null, aria = null, title = null, text = "", disabled = false, ariaDisabled = null, testid = null, id = null } = {}) {
  const attrs = { "aria-label": aria, "aria-disabled": ariaDisabled, "data-testid": testid, id, role, title };
  return {
    tagName: tag,
    disabled,
    textContent: text,
    getAttribute(name) {
      return name in attrs ? attrs[name] : null;
    },
  };
}

test("plain continue labels match", () => {
  assert.equal(isContinueControl(fakeEl({ text: "Continue" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "continue" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "  Continue  " })), true);
  assert.equal(isContinueControl(fakeEl({ aria: "Continue generation" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "Keep going" })), true);
  assert.equal(isContinueControl(fakeEl({ aria: "Resume" })), true);
});

test("CJK continue labels match", () => {
  assert.equal(isContinueControl(fakeEl({ aria: "继续" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "继续生成" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "继续对话" })), true);
  assert.equal(isContinueControl(fakeEl({ aria: "恢复" })), true);
});

test("icon-only continue buttons match via data-testid / id", () => {
  assert.equal(isContinueControl(fakeEl({ text: "", testid: "continue-button" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "⏎", testid: "conversation-continue" })), true);
  assert.equal(isContinueControl(fakeEl({ text: "", id: "continueBtn" })), true);
});

test("disabled and aria-disabled controls never match", () => {
  assert.equal(isContinueControl(fakeEl({ text: "Continue", disabled: true })), false);
  assert.equal(isContinueControl(fakeEl({ text: "Continue", ariaDisabled: "true" })), false);
});

test("non-button shapes are rejected", () => {
  assert.equal(isContinueControl(fakeEl({ tag: "DIV", text: "Continue" })), false);
  assert.equal(isContinueControl(fakeEl({ tag: "SPAN", text: "Continue" })), false);
  assert.equal(isContinueControl(fakeEl({ tag: "DIV", role: "button", text: "Continue" })), true);
  assert.equal(isContinueControl(fakeEl({ tag: "A", text: "Continue" })), true);
});

test("big surfaces that merely contain the word are rejected", () => {
  assert.equal(
    isContinueControl(
      fakeEl({
        text: "Continue reading the documentation to understand how the adapter composes with the supervisor loop",
      }),
    ),
    false,
  );
});

test("unrelated labels are rejected", () => {
  assert.equal(isContinueControl(fakeEl({ text: "Send" })), false);
  assert.equal(isContinueControl(fakeEl({ text: "Stop" })), false);
  assert.equal(isContinueControl(fakeEl({ text: "Regenerate response" })), false);
  assert.equal(isContinueControl(fakeEl({ aria: "Share conversation" })), false);
  assert.equal(isContinueControl(fakeEl({ text: "" })), false);
  assert.equal(isContinueControl(null), false);
});

test("controlLabel prefers aria-label, then title, then text", () => {
  assert.equal(controlLabel(fakeEl({ aria: "A", title: "B", text: "C" })), "A");
  assert.equal(controlLabel(fakeEl({ title: "B", text: "C" })), "B");
  assert.equal(controlLabel(fakeEl({ text: "C" })), "C");
  assert.equal(controlLabel(fakeEl({})), "");
});

test("the continue label regex is anchored and case-insensitive", () => {
  assert.ok(CONTINUE_LABEL_RE.test("CONTINUE"));
  assert.ok(CONTINUE_LABEL_RE.test("Continue chat"));
  assert.ok(!CONTINUE_LABEL_RE.test("Continue reading the documentation chapter"));
  assert.ok(!CONTINUE_LABEL_RE.test("Discontinue"));
  assert.ok(!CONTINUE_LABEL_RE.test(""));
});
