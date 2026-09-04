# ROADMAP_STATUS — Operator Dashboard (NON-AUTHORITATIVE)

> **This file is explicitly NON-AUTHORITATIVE.** It is an observability
> surface only. It is not a substitute for the roadmap, work orders,
> machine state, GitHub, or the frozen architecture. If this file ever
> disagrees with repository authority, repository authority wins and this
> file is wrong. It never claims an action that has not actually occurred.

- **current state:** `WAITING_FOR_ARCHITECT`
- **active Work Order:** CTRL-003 — GitHub adapter (`spec/work-items/CTRL-003.md`, `READY`)
- **PR:** #7 — https://github.com/pectoraux/controller/pull/7 (implementation)
- **head SHA awaiting review:** `7ed812b1f3e6d0f5630692eabfbaa700d2b20d18`
  (CTRL-003 implementation + FZ-CTRL003-001/002/003/004 fixes; the branch tip
  may additionally advance with status-dashboard-only commits, which do not
  alter the implementation)
- **last completed worker action:** FZ-CTRL003-004 resolved —
  `MergeAuthorization` is now an opaque non-forgeable capability issued only
  by `authorize_merge` (module-private `_IssuanceProof` bound to the issued
  field values; construction and `merge_pull_request` both fail closed with
  `GithubAuthorizationForgedError` before any remote mutation; structural
  AST tests prove the single merge path is gated); full validation green
  (209/209 tests, strict mypy, ruff, CLI, guard, forbidden-surface audit
  PASS)
- **ARCHITECT ACTION: REVIEW REQUIRED**
- **last update (UTC):** 2026-09-04T13:02:50Z
- **next step:** the human operator should say `go` to invoke the Architect
  review cycle for PR #7 (review iteration 3)

## Maintenance protocol

- On entering `WAITING_FOR_ARCHITECT`: update this file in the same governed
  change (or immediately before the PR is presented) with the fields above.
- On leaving `WAITING_FOR_ARCHITECT`: update immediately to the new state
  (`IMPLEMENTING`, `CHANGES_REQUESTED`, `APPROVED`, `RECONCILING`, or
  equivalent repository-defined state).
- Updating this file does not require a separate Architect approval.
- This file records only actions that have actually occurred; it is not a
  prediction.
