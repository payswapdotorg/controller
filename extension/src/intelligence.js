/**
 * The intelligence layer — pluggable sources of judgment, in a chain.
 *
 * The supervisor loop is deterministic mechanics (GitHub is the source of
 * truth). Judgment — review verdicts, next-dispatch briefs, recovery cases —
 * comes from an ordered CHAIN of sources (the owner's recovery requirement):
 *
 *   1. another chat.z.ai session  (the attached tab; resurrected when dead)
 *   2. a local muse spark agent   (any HTTP endpoint on the machine)
 *   3. a local GitHub Copilot bridge (same contract)
 *   4. any other available source (same contract)
 *
 * The chain rotates on failure: the first source that answers wins the turn;
 * a source that fails `failureThreshold` times in a row is benched for
 * `cooldownMinutes` and automatically returns to rotation afterwards. Every
 * rotation event is logged — the operator always sees which source answered.
 *
 * Legacy single-driver modes remain first-class (chatzai-web | local-http |
 * none) for configs that predate the chain or deliberately want no rotation.
 *
 * Contract: ask({ kind, brief, context }) -> { ok: true, text, driver } |
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
 * Bounded by an AbortController timeout — a hung local agent must never hang
 * the supervisor cycle with it.
 */
export function createLocalHttpDriver(endpoint, fetchImpl = fetch, timeoutMs = INTELLIGENCE_TIMEOUT_MS_DEFAULT) {
  return {
    kind: "local-http",
    async ask(input) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timer = null;
      // The timeout bounds the ask even when the endpoint (or a fake in tests)
      // ignores the abort signal: race the clock, not just the signal.
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      });
      let response;
      try {
        response = await Promise.race([
          fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: input.kind,
              brief: input.brief,
              context: input.context ?? {},
            }),
            signal: controller?.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        return { ok: false, error: `local endpoint unreachable: ${error?.message ?? error}`, driver: "local-http" };
      } finally {
        if (timer) clearTimeout(timer);
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
 * The rotating intelligence chain. Sources are tried in configured order;
 * failures rotate to the next source, consecutive failures bench a source
 * for the cooldown, and the first success resets that source's counter.
 *
 * deps:
 *   chatDriverFactory  () => driver for chatzai-web sources (service layer)
 *   fetchImpl          fetch for local-http sources (injectable for tests)
 *   timeoutMs          per-source timeout for local-http asks
 *   failureThreshold   consecutive failures before benching
 *   cooldownMs         bench duration
 *   log                the service log sink
 *   now                injectable clock (tests)
 */
export function createChainDriver(sources, deps) {
  const {
    chatDriverFactory,
    fetchImpl = fetch,
    timeoutMs = INTELLIGENCE_TIMEOUT_MS_DEFAULT,
    failureThreshold = 2,
    cooldownMs = 5 * 60 * 1000,
    log = () => {},
    now = () => Date.now(),
  } = deps ?? {};

  const chatDrivers = new Map(); // id -> driver instance (reused across asks)
  const healthState = new Map(); // id -> { consecutiveFailures, benchedUntil, answered, lastError, lastOkAt }

  function stateFor(source) {
    if (!healthState.has(source.id)) {
      healthState.set(source.id, { consecutiveFailures: 0, benchedUntil: 0, answered: 0, lastError: null, lastOkAt: null });
    }
    return healthState.get(source.id);
  }

  function driverFor(source) {
    if (source.kind !== "chatzai-web") return createLocalHttpDriver(source.url, fetchImpl, timeoutMs);
    if (!chatDrivers.has(source.id)) chatDrivers.set(source.id, chatDriverFactory ? chatDriverFactory() : createNoneDriver());
    return chatDrivers.get(source.id);
  }

  function usable(source) {
    if (!source.enabled) return false;
    if (source.kind === "local-http" && source.url === "") return false;
    return true;
  }

  return {
    kind: "chain",
    async ask(input) {
      const failures = [];
      for (const source of sources) {
        if (!usable(source)) continue;
        const state = stateFor(source);
        const at = now();
        if (state.benchedUntil > at) {
          failures.push(`${source.id}: benched until ${new Date(state.benchedUntil).toISOString()}`);
          continue;
        }
        if (state.benchedUntil !== 0 && state.benchedUntil <= at) {
          // Cooldown elapsed — the source returns to rotation with a clean slate.
          state.benchedUntil = 0;
          state.consecutiveFailures = 0;
          log({ kind: "chain", level: "info", message: `source "${source.id}" cooldown elapsed — back in rotation` });
        }
        const driver = driverFor(source);
        const reply = await driver.ask(input);
        if (reply.ok) {
          state.consecutiveFailures = 0;
          state.answered += 1;
          state.lastOkAt = new Date(now()).toISOString();
          state.lastError = null;
          log({ kind: "chain", level: "info", message: `source "${source.id}" answered the ${input.kind} ask` });
          return { ...reply, driver: source.id };
        }
        state.consecutiveFailures += 1;
        state.lastError = reply.error ?? "unknown failure";
        failures.push(`${source.id}: ${state.lastError}`);
        log({ kind: "chain", level: "warn", message: `source "${source.id}" failed (${state.lastError}) — rotating` });
        if (state.consecutiveFailures >= failureThreshold) {
          state.benchedUntil = now() + cooldownMs;
          log({
            kind: "chain",
            level: "warn",
            message: `source "${source.id}" benched for ${Math.round(cooldownMs / 60000)} min after ${state.consecutiveFailures} consecutive failures`,
          });
        }
      }
      return {
        ok: false,
        error: `all intelligence sources failed — ${failures.join(" | ") || "no usable source enabled"}`,
        driver: "chain",
      };
    },
    /** Per-source health for the popup (which source answered, which is benched). */
    health() {
      return sources.map((source) => {
        const state = stateFor(source);
        return {
          id: source.id,
          kind: source.kind,
          url: source.url,
          enabled: source.enabled,
          usable: usable(source),
          consecutiveFailures: state.consecutiveFailures,
          benchedUntil: state.benchedUntil > now() ? new Date(state.benchedUntil).toISOString() : null,
          answered: state.answered,
          lastError: state.lastError,
          lastOkAt: state.lastOkAt,
        };
      });
    },
  };
}

/**
 * Compose the driver stack from config. The chatzai-web driver is supplied by
 * the service layer (it needs tabs APIs); this factory covers the rest.
 * "chain" (the v1.1 default) rotates over the configured sources; the legacy
 * single-driver selections keep their exact v1 behavior. The service log sink
 * is threaded through so rotation events are visible to the operator.
 */
export function createDriverFromConfig(config, chatDriver, fetchImpl = fetch, log = () => {}) {
  const intelligence = config.intelligence ?? {};
  switch (intelligence.driver) {
    case "chain":
      return createChainDriver(intelligence.chain ?? [], {
        chatDriverFactory: () => chatDriver ?? createNoneDriver(),
        fetchImpl,
        timeoutMs: (intelligence.timeoutSeconds ?? 120) * 1000,
        failureThreshold: intelligence.failureThreshold ?? 2,
        cooldownMs: (intelligence.cooldownMinutes ?? 5) * 60 * 1000,
        log,
      });
    case "local-http":
      return createLocalHttpDriver(intelligence.localEndpoint, fetchImpl, (intelligence.timeoutSeconds ?? 120) * 1000);
    case "chatzai-web":
      return chatDriver ?? createNoneDriver();
    default:
      return createNoneDriver();
  }
}
