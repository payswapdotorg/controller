# ROADMAP_STATUS — Operator Dashboard (NON-AUTHORITATIVE)

> **This file is explicitly NON-AUTHORITATIVE.** It is an observability
> surface only. It is not a substitute for the roadmap, work orders,
> machine state, GitHub, or the frozen architecture. If this file ever
> disagrees with repository authority, repository authority wins and this
> file is wrong. It never claims an action that has not actually occurred.

- **current state:** `CHANGES_REQUESTED`
- **active Work Order:** CTRL-003 — GitHub adapter (`spec/work-items/CTRL-003.md`, `READY`)
- **PR:** #7 — https://github.com/pectoraux/controller/pull/7 (implementation)
- **head SHA under review:** `3321dc8ed0dd5df6b5901b865cd9242466cacc23`
  (CTRL-003 implementation + FZ-CTRL003-001/002/003 fixes; the branch tip may
  additionally advance with status-dashboard-only commits, which do not alter
  the implementation)
- **last completed worker action:** review iteration 2 received — Architect
  REQUEST_CHANGES with one remaining HIGH finding `FZ-CTRL003-004`
  (`MergeAuthorization` is forgeable; `merge_pull_request()` must be
  executable only with an authorization issued by `authorize_merge`).
  Worker is resolving it now; the branch will advance with the fix.
- **ARCHITECT ACTION: REVIEW REQUIRED** (after the fix lands)
- **last update (UTC):** 2026-09-04T13:02:20Z
- **next step:** worker implements the FZ-CTRL003-004 non-forgeable
  authorization capability, reruns the full validation suite, updates the
  durable PR transcript, and returns this PR to `WAITING_FOR_ARCHITECT`

## Maintenance protocol

- On entering `WAITING_FOR_ARCHITECT`: update this file in the same governed
  change (or immediately before the PR is presented) with the fields above.
- On leaving `WAITING_FOR_ARCHITECT`: update immediately to the new state
  (`IMPLEMENTING`, `CHANGES_REQUESTED`, `APPROVED`, `RECONCILING`, or
  equivalent repository-defined state).
- Updating this file does not require a separate Architect approval.
- This file records only actions that have actually occurred; it is not a
  prediction.
