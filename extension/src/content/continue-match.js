/**
 * Pure helpers that decide whether a DOM control is a "continue" control.
 *
 * The owner's requirement: no human ever presses the continue button. The
 * watchdog therefore has to FIND the real continue button on the host page
 * (chat.z.ai surfaces one in several postures) and click it — before falling
 * back to typing the configured continue prompt into the composer.
 *
 * Kept pure (no DOM access beyond the passed element) so it is unit-tested
 * directly; the content script supplies the elements.
 */

/**
 * Labels that mean "continue this session". Deliberately tight: a button
 * whose entire accessible label is one of these words (plus the CJK shapes
 * chat.z.ai uses). Big cards or menu items that merely CONTAIN the word are
 * rejected by the length cap.
 */
export const CONTINUE_LABEL_RE =
  /^\s*(continue|continue\s+(generation|chat|session)|keep\s+going|resume|继续|继续生成|继续对话|恢复)\s*$/i;

const MAX_LABEL_LENGTH = 40;

/** The accessible-ish label of a control: aria-label, title, then text. */
export function controlLabel(el) {
  if (!el || typeof el.getAttribute !== "function") return "";
  return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();
}

/**
 * A continue control: a visible-enabled button-ish element whose label (or
 * test-id/id) identifies it as the continue affordance.
 */
export function isContinueControl(el) {
  if (!el || typeof el.getAttribute !== "function") return false;
  if (el.disabled === true) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  const tag = el.tagName;
  const role = el.getAttribute("role");
  if (tag !== "BUTTON" && tag !== "A" && role !== "button") return false;
  // Icon-only continue buttons carry no label — match them by test id / id.
  // (^|[^a-z])continue — matches "continue-button", "conversation-continue",
  // "continueBtn"; rejects "discontinue" (letter before the word).
  const testId = el.getAttribute("data-testid") ?? "";
  const id = el.getAttribute("id") ?? "";
  if (/(^|[^a-z])continue/i.test(testId) || /(^|[^a-z])continue/i.test(id)) return true;
  const label = controlLabel(el);
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return false;
  return CONTINUE_LABEL_RE.test(label);
}
