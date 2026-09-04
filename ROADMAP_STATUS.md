# ROADMAP_STATUS — Operator Dashboard (NON-AUTHORITATIVE)

> **This file is explicitly NON-AUTHORITATIVE.** It is an observability
> surface only. It is not a substitute for the roadmap, work orders,
> machine state, GitHub, or the frozen architecture. If this file ever
> disagrees with repository authority, repository authority wins and this
> file is wrong. It never claims an action that has not actually occurred.

- **current state:** `CHANGES_REQUESTED`
- **active Work Order:** CTRL-003 — GitHub adapter (`spec/work-items/CTRL-003.md`, `READY`)
- **PR:** #7 — https://github.com/pectoraux/controller/pull/7 (implementation)
- **head SHA under review:** `0963abf0dc3153f92ef0d489b6c42b3335ec3e1b`
  (CTRL-003 implementation + FZ-CTRL003-001/002/003/004 fixes; the branch tip
  may additionally advance with status-dashboard-only commits, which do not
  alter the implementation)
- **outstanding Architect finding:** FZ-CTRL003-004A (HIGH, review iteration 3) —
  the module-private `_IssuanceProof` remains importable, so a caller can
  construct a valid-looking proof and pass it into the public
  `MergeAuthorization` constructor; required resolution (Architect-accepted
  path 2): `merge_pull_request` must independently re-establish the complete
  merge-policy proof before the remote mutation
- **last completed worker action:** review iteration 3 detected by the resident
  monitor loop; entering the fix cycle for FZ-CTRL003-004A
- **last update (UTC):** 2026-09-04T13:33:00Z
- **next step:** implement FZ-CTRL003-004A on this same PR, rerun the full
  validation suite, push, update the PR transcript, return to
  `WAITING_FOR_ARCHITECT`

## Maintenance protocol

- On entering `WAITING_FOR_ARCHITECT`: update this file in the same governed
  change (or immediately before the PR is presented) with the fields above.
- On leaving `WAITING_FOR_ARCHITECT`: update immediately to the new state
  (`IMPLEMENTING`, `CHANGES_REQUESTED`, `APPROVED`, `RECONCILING`, or
  equivalent repository-defined state).
- Updating this file does not require a separate Architect approval.
- This file records only actions that have actually occurred; it is not a
  prediction.
