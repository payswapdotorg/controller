/**
 * The intelligence layer — pluggable sources of judgment.
 *
 * The supervisor loop is deterministic mechanics (GitHub is the source of
 * truth). Judgment — review verdicts, next-dispatch briefs, recovery cases —
 * comes from a configurable driver:
 *
 *   chatzai-web : the attached chat.z.ai tab (the browser session IS the
 *                 intelligence; the content script drives the real DOM)
 *   local-http  : a local agent endpoint (muse spark, a GitHub Copilot CLI
 *                 bridge, or anything that answers POST {brief} -> {reply})
 *   none        : deterministic-only mode (the loop still harvests green,
 *                 in-fence PRs; judgment-dependent steps WAIT honestly)
 *
 * Contract: ask({ kind, brief, context }) -> { ok: true, text } |
 * { ok: false, error, kind } — failures are TYPED and honest, never a guess.
 */

export const INTELLIGENCE_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000;

/**
 * Parse a supervisor directive out of an intelligence reply.
 * Recognized markers (anywhere in the text, case-insensitive):
 *   DISPATCH: <issue title>  + a fenced ```body``` block  -> create the issue
 *   WAIT: <reason>
 *   APPROVE
 *   REQUIRE-CHANGES: <reason>
 *   DEFER
 * Unparseable replies return { action: "unparsed", text } — the caller
 * records them verbatim and treats them as WAIT (honest posture).
 */
export function parseDirective(text) {
  const raw = typeof text === "string" ? text : "";
  const fenced = raw.match(/```(?:\w*\n)?([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : null;

  const dispatch = raw.match(/^\s*DISPATCH:\s*(.+)$/im);
  if (dispatch) {
    return { action: "dispatch", title: dispatch[1].trim().slice(0, 140), body };
  }
  const wait = raw.match(/^\s*WAIT:\s*(.+)$/im);
  if (wait) return { action: "wait", reason: wait[1].trim().slice(0, 300) };
  if (/^\s*APPROVE\b/im.test(raw)) return { action: "approve" };
  const require = raw.match(/^\s*REQUIRE-CHANGES:\s*(.+)$/im);
  if (require) return { action: "require-changes", reason: require[1].trim().slice(0, 300) };
  if (/^\s*DEFER\b/im.test(raw)) return { action: "defer" };
  return { action: "unparsed", text: raw.slice(0, 400) };
}

/**
 * Build the status brief sent to the intelligence source when the queue is
 * empty (the dispatch decision point). The repository state is embedded —
 * the intelligence layer never needs to guess it.
 */
export function buildDispatchBrief(snapshot, config) {
  const prs = snapshot.openPullRequests
    .map((p) => `  - #${p.number} ${p.title} [${p.headRef}] checks=${p.checkState} mergeable=${p.mergeable}`)
    .join("\n");
  const issues = snapshot.openIssues.map((i) => `  - #${i.number} ${i.title}`).join("\n");
  return [
    "CONTROLLER STATUS BRIEF (the GitHub repository is the sole source of truth).",
    `Repository: ${config.github.owner}/${config.github.repo}`,
    `main HEAD: ${snapshot.mainHead ?? "unknown"}`,
    `Open pull requests (${snapshot.openPullRequests.length}):`,
    prs || "  (none)",
    `Open issues (${snapshot.openIssues.length}):`,
    issues || "  (none)",
    "",
    "The mechanical queue is empty. Decide the next action and reply with exactly one directive:",
    "- DISPATCH: <issue title> followed by a fenced code block containing the issue body (register the next work order), or",
    "- WAIT: <reason> (roadmap complete, owner decision pending, or another honest blocker).",
  ].join("\n");
}

/**
 * Build a review brief for one pull request (the judgment surface).
 */
export function buildReviewBrief(snapshot, pr, config) {
  return [
    "CONTROLLER REVIEW REQUEST (the GitHub repository is the sole source of truth).",
    `Repository: ${config.github.owner}/${config.github.repo}`,
    `main HEAD: ${snapshot.mainHead ?? "unknown"}`,
    `Pull request #${pr.number}: ${pr.title}`,
    `Branch: ${pr.headRef} @ ${pr.headSha}`,
    `CI checks: ${pr.checkState}; mergeable: ${pr.mergeable}; draft: ${pr.draft}`,
    "",
    "Review this delivery and reply with exactly one verdict:",
    "- APPROVE (merge it), or",
    "- REQUIRE-CHANGES: <reason> (leave it open with a review comment).",
  ].join("\n");
}

/** @typedef {{ kind: "review"|"dispatch"|"recovery"|"directive", brief: string, context?: object }} AskInput */

/**
 * The local-http driver: POST {kind, brief, context} -> {reply} or {text}.
 */
export function createLocalHttpDriver(endpoint, fetchImpl = fetch) {
  return {
    kind: "local-http",
    async ask(input) {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: input.kind,
            brief: input.brief,
            context: input.context ?? {},
          }),
        });
      } catch (error) {
        return { ok: false, error: `local endpoint unreachable: ${error?.message ?? error}`, driver: "local-http" };
      }
      if (!(response.status >= 200 && response.status < 300)) {
        return { ok: false, error: `local endpoint HTTP ${response.status}`, driver: "local-http" };
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, error: "local endpoint returned unparseable JSON", driver: "local-http" };
      }
      const text = typeof payload?.reply === "string" ? payload.reply : typeof payload?.text === "string" ? payload.text : null;
      if (text === null) {
        return { ok: false, error: "local endpoint reply missing .reply/.text field", driver: "local-http" };
      }
      return { ok: true, text, driver: "local-http" };
    },
  };
}

/**
 * The "none" driver — honest refusal (deterministic-only mode).
 */
export function createNoneDriver() {
  return {
    kind: "none",
    async ask() {
      return { ok: false, error: "no intelligence driver configured (deterministic-only mode)", driver: "none" };
    },
  };
}

/**
 * Compose the driver stack from config. The chatzai-web driver is supplied by
 * the service layer (it needs tabs APIs); this factory covers the rest.
 */
export function createDriverFromConfig(config, chatDriver, fetchImpl = fetch) {
  switch (config.intelligence.driver) {
    case "local-http":
      return createLocalHttpDriver(config.intelligence.localEndpoint, fetchImpl);
    case "chatzai-web":
      return chatDriver ?? createNoneDriver();
    default:
      return createNoneDriver();
  }
}
