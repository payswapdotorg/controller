/**
 * The supervisor finite-state machine — the resident loop.
 *
 *   monitor -> harvest -> review -> dispatch -> wait -> monitor ...
 *
 * Pure module: every side effect is an injected interface (github client,
 * intelligence driver, log sink, clock). The service layer (service.js) wires
 * it to chrome.* APIs; the tests wire it to fakes.
 *
 * Policies (all honest, all recorded):
 *   HARVEST   merge iff: not draft AND mergeable AND checks green (when
 *             requireGreenChecks) AND head branch under an allowed prefix AND
 *             (review policy) the intelligence verdict is APPROVE when
 *             requireIntelligenceReview, else the deterministic policy.
 *   REVIEW    each open PR gets an intelligence verdict when a driver is
 *             configured; REQUIRE-CHANGES posts the reason as a PR comment.
 *   DISPATCH  when the queue is empty: ask the intelligence source for the
 *             next directive; DISPATCH creates the issue (the work order
 *             registration surface) + a dispatch-record comment.
 *   WAIT      honest rest: queue empty and no dispatchable work.
 *   RESURRECT if the attached chat tab died and resurrect is on, the service
 *             layer opens a new session tab and replays the standing
 *             directive (the no-continue-button requirement).
 */

import { buildDispatchBrief, buildReviewBrief, parseDirective } from "./intelligence.js";

export function createSupervisor(deps) {
  const { github, intelligence, config, log, now = () => new Date().toISOString() } = deps;

  const state = {
    cycles: 0,
    lastCycleAt: null,
    lastSnapshot: null,
    lastAction: "boot",
    running: false,
  };

  function isAllowedBranch(headRef) {
    return config.safety.onlyMergeBranchPrefixes.some((prefix) => headRef.startsWith(prefix));
  }

  /** One full cycle. Returns a typed cycle record (also appended to the log). */
  async function tick() {
    if (state.running) {
      log({ at: now(), kind: "cycle", level: "warn", message: "cycle already running — skipping tick (overlap guard)" });
      return { ok: false, reason: "overlap" };
    }
    state.running = true;
    const cycle = { startedAt: now(), merged: [], reviewed: [], dispatched: null, waited: null, errors: [] };
    try {
      // ── MONITOR ────────────────────────────────────────────────────────────
      let snapshot;
      try {
        snapshot = await github.getSnapshot();
        state.lastSnapshot = snapshot;
      } catch (error) {
        const message = `monitor failed: ${error?.message ?? error}`;
        cycle.errors.push(message);
        log({ at: now(), kind: "monitor", level: "error", message });
        state.lastAction = "monitor-failed";
        return { ok: false, cycle };
      }
      state.cycles += 1;
      state.lastCycleAt = now();
      log({
        at: now(),
        kind: "monitor",
        level: "info",
        message: `main=${snapshot.mainHead?.slice(0, 7) ?? "?"} openPRs=${snapshot.openPullRequests.length} openIssues=${snapshot.openIssues.length}`,
      });

      // ── HARVEST + REVIEW (per open PR) ─────────────────────────────────────
      for (const pr of snapshot.openPullRequests) {
        if (pr.draft) continue;
        const fenceOk = isAllowedBranch(pr.headRef);
        const checksOk = !config.safety.requireGreenChecks || pr.checkState === "green";
        if (!pr.mergeable || !fenceOk || !checksOk) {
          log({
            at: now(),
            kind: "harvest",
            level: "info",
            message: `#${pr.number} held: mergeable=${pr.mergeable} fence=${fenceOk} checks=${pr.checkState}`,
          });
          continue;
        }

        let verdict = "approve";
        if (config.safety.requireIntelligenceReview) {
          const reply = await intelligence.ask({
            kind: "review",
            brief: buildReviewBrief(snapshot, pr, config),
            context: { pr },
          });
          if (!reply.ok) {
            cycle.errors.push(`review driver failed on #${pr.number}: ${reply.error}`);
            log({
              at: now(),
              kind: "review",
              level: "warn",
              message: `#${pr.number} review driver failed (${reply.error}) — held open, no merge (fail-closed)`,
            });
            continue;
          }
          const directive = parseDirective(reply.text);
          verdict = directive.action;
          cycle.reviewed.push({ number: pr.number, verdict, reason: directive.reason ?? null });
          if (verdict === "require-changes") {
            await github.comment(
              pr.number,
              `Controller review — REQUIRE-CHANGES: ${directive.reason ?? "unspecified"}\n\n(verdict source: ${reply.driver})`,
            );
            log({
              at: now(),
              kind: "review",
              level: "info",
              message: `#${pr.number} REQUIRE-CHANGES: ${directive.reason ?? "unspecified"}`,
            });
            continue;
          }
          if (verdict !== "approve") {
            log({ at: now(), kind: "review", level: "info", message: `#${pr.number} verdict ${verdict} — held open` });
            continue;
          }
        }

        if (!config.github.autoMerge) {
          log({ at: now(), kind: "harvest", level: "info", message: `#${pr.number} merge candidate held (autoMerge off)` });
          continue;
        }
        try {
          const merge = await github.mergePullRequest(pr.number, {
            title: `Controller harvest — #${pr.number} (${pr.headRef})`,
            body: `Merged by the Controller supervisor loop (cycle ${state.cycles}); checks=${pr.checkState}; verdict=${verdict}.`,
          });
          cycle.merged.push(pr.number);
          state.lastAction = "harvest";
          log({
            at: now(),
            kind: "harvest",
            level: "info",
            message: `#${pr.number} merged as ${merge?.sha?.slice(0, 7) ?? "?"} (${config.github.mergeMethod})`,
          });
        } catch (error) {
          cycle.errors.push(`merge #${pr.number} failed: ${error?.message ?? error}`);
          log({ at: now(), kind: "harvest", level: "error", message: `#${pr.number} merge failed: ${error?.message ?? error}` });
        }
      }

      // ── DISPATCH (queue empty) ─────────────────────────────────────────────
      const queueEmptyAfterHarvest = cycle.merged.length > 0 || snapshot.openPullRequests.length === 0;
      if (queueEmptyAfterHarvest && snapshot.openIssues.length === 0) {
        const brief = buildDispatchBrief(snapshot, config);
        const reply = await intelligence.ask({ kind: "dispatch", brief, context: { snapshot } });
        if (reply.ok) {
          const directive = parseDirective(reply.text);
          if (directive.action === "dispatch") {
            try {
              const issue = await github.createIssue(directive.title, directive.body ?? brief, []);
              cycle.dispatched = { number: issue?.number ?? null, title: directive.title };
              state.lastAction = "dispatch";
              log({
                at: now(),
                kind: "dispatch",
                level: "info",
                message: `dispatched next work order as issue #${issue?.number ?? "?"}: ${directive.title}`,
              });
              if (issue?.number) {
                await github
                  .comment(issue.number, "Controller dispatch record: created by the supervisor loop from an intelligence directive (source: " + reply.driver + ").")
                  .catch(() => {});
              }
            } catch (error) {
              cycle.errors.push(`createIssue failed: ${error?.message ?? error}`);
              log({ at: now(), kind: "dispatch", level: "error", message: `createIssue failed: ${error?.message ?? error}` });
            }
          } else if (directive.action === "wait") {
            cycle.waited = directive.reason ?? "no directive";
            state.lastAction = "wait";
            log({ at: now(), kind: "dispatch", level: "info", message: `WAIT: ${directive.reason ?? "no directive"}` });
          } else {
            cycle.waited = "unparsed directive (recorded verbatim in the log)";
            log({
              at: now(),
              kind: "dispatch",
              level: "warn",
              message: `unparsed intelligence reply: ${directive.text?.slice(0, 200) ?? ""}`,
            });
          }
        } else {
          cycle.waited = `intelligence unavailable: ${reply.error}`;
          state.lastAction = "wait";
          log({
            at: now(),
            kind: "dispatch",
            level: "info",
            message: `WAIT (intelligence unavailable): ${reply.error}`,
          });
        }
      } else if (!queueEmptyAfterHarvest) {
        log({ at: now(), kind: "dispatch", level: "info", message: "queue non-empty — next cycle re-monitors first" });
      }

      return { ok: cycle.errors.length === 0, cycle };
    } finally {
      state.running = false;
    }
  }

  return {
    tick,
    state,
    /** Snapshot of loop state for the popup. */
    status() {
      return {
        cycles: state.cycles,
        lastCycleAt: state.lastCycleAt,
        lastAction: state.lastAction,
        mainHead: state.lastSnapshot?.mainHead ?? null,
        openPullRequests: state.lastSnapshot?.openPullRequests.length ?? null,
        openIssues: state.lastSnapshot?.openIssues.length ?? null,
      };
    },
  };
}
