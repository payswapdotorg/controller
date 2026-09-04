# ROADMAP_STATUS — Operator Dashboard (NON-AUTHORITATIVE)

> **This file is explicitly NON-AUTHORITATIVE.** It is an observability
> surface only. It is not a substitute for the roadmap, work orders,
> machine state, GitHub, or the frozen architecture. If this file ever
> disagrees with repository authority, repository authority wins and this
> file is wrong. It never claims an action that has not actually occurred.

- **current state:** `CHANGES_REQUESTED`
- **active Work Order:** CTRL-003 — GitHub adapter (`spec/work-items/CTRL-003.md`, `READY`)
- **PR:** #7 — https://github.com/pectoraux/controller/pull/7 (implementation)
- **head SHA of record:** `1939140f51a877eacecdd3c5e70d67a0ffda2323` (implementation under review; branch tip advances with the requested fixes)
- **last completed worker action:** Architect review received — REQUEST_CHANGES with
  findings FZ-CTRL003-001 (bind merge authorization to the authoritative
  active work-item identity), FZ-CTRL003-002 (bind APPROVE to the exact
  reviewed head SHA), FZ-CTRL003-003 (bind authorization to the intended
  base ref + SHA); worker is resolving all three now
- **ARCHITECT ACTION:** (none — worker resolving requested changes)
- **last update (UTC):** 2026-09-04T12:08:21Z
- **next step:** worker fixes all three findings, adds the required
  contradiction/retarget/head-change tests, reruns the full validation suite,
  pushes to the same PR, and returns this file to `WAITING_FOR_ARCHITECT`

## Maintenance protocol

- On entering `WAITING_FOR_ARCHITECT`: update this file in the same governed
  change (or immediately before the PR is presented) with the fields above.
- On leaving `WAITING_FOR_ARCHITECT`: update immediately to the new state
  (`IMPLEMENTING`, `CHANGES_REQUESTED`, `APPROVED`, `RECONCILING`, or
  equivalent repository-defined state).
- Updating this file does not require a separate Architect approval.
- This file records only actions that have actually occurred; it is not a
  prediction.
