# ROADMAP_STATUS — Operator Dashboard (NON-AUTHORITATIVE)

> **This file is explicitly NON-AUTHORITATIVE.** It is an observability
> surface only. It is not a substitute for the roadmap, work orders,
> machine state, GitHub, or the frozen architecture. If this file ever
> disagrees with repository authority, repository authority wins and this
> file is wrong. It never claims an action that has not actually occurred.

- **current state:** `CHANGES_REQUESTED`
- **active Work Order:** CTRL-008 — Merge + Reconciliation (`spec/work-items/CTRL-008.md`, `READY`)
- **PR:** #23 (branch `ctrl-008-merge-reconciliation`, head `d3816778063894f0df6c64e98be3fafcdaa877a6`, opened from the exact dispatch base `f55f5190a82a0fb774285a03347e6df71163cbd5` plus the absorbed post-dispatch governance drift `c67bc666e08a4ac3162bd18a296ba05c499069b7`), returned to `WAITING_FOR_ARCHITECT` with a green validation transcript
- **last completed architect action:** CTRL-007 reconciled; CTRL-008 defined/frozen/activated as the sole READY item; durable worker dispatch issued against exact base `f55f5190a82a0fb774285a03347e6df71163cbd5`
- **last completed worker action:** CTRL-008 implementation delivered — `controller/merge.py` (the governed merge + post-merge reconciliation boundary), the `GithubPullRequest.merge_commit_sha` observed-evidence extension, the `MergeLoopError` family, and `tests/test_merge.py` (43 new tests; suite 433 → 476); mechanical real-repository test-pin update to the CTRL-008 authority (the worker-PR precedent); no spec/ authority touched
- **current implementation action:** Architect REQUEST_CHANGES received on PR #23 (FZ-CTRL008-001, HIGH — comment `5546019426`, 2026-09-04T20:21:53Z): the merge-boundary correlation must operate on the correlated PR's observed current `main` base SHA, with the dispatch-base SHA carried as provenance only (the real PR #23 shape: dispatch base `f55f5190a82a0fb774285a03347e6df71163cbd5`, current base `c67bc666e08a4ac3162bd18a296ba05c499069b7`); correction in progress on the same PR
- **last update (UTC):** 2026-09-04T21:03:08Z
- **next planned item:** CTRL-009 — Recovery / idempotency (per the roadmap; not defined, not eligible)
- **next step:** the worker delivers the FZ-CTRL008-001 correction on the same PR #23 (same Work Item, no new PR) and returns to `WAITING_FOR_ARCHITECT`; on APPROVE + merge predicates the merge proceeds and post-merge reconciliation records CTRL-008/COMPLETE

## Maintenance protocol

- On entering `WAITING_FOR_ARCHITECT`: update this file in the same governed
  change (or immediately before the PR is presented) with the fields above.
- On leaving `WAITING_FOR_ARCHITECT`: update immediately to the new state
  (`IMPLEMENTING`, `CHANGES_REQUESTED`, `APPROVED`, `RECONCILING`, or
  equivalent repository-defined state).
- Updating this file does not require a separate Architect approval.
- This file records only actions that have actually occurred; it is not a
  prediction.
