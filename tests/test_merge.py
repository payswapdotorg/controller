"""Unit tests: the CTRL-008 merge + post-merge reconciliation boundary
(frozen merge-predicate evaluation through the CTRL-003 adapter, the
single authorized merge attempt with execution-time drift protection,
observed external merge evidence, the MERGING/MERGED/RECONCILING steps,
the deterministic idempotent reconciliation record and next-eligible
selection, restart determinism, and the worker-merge prohibition).
Fully offline: a stateful fake GitHub transport serves canned JSON and
swaps the governed PR to its merged form exactly when the merge PUT
lands, the synthetic authority tree is local, and the loop is exercised
with zero worker-provider surface of any kind.

FZ-CTRL008-001 regression coverage: the merge-boundary base identity is
the correlated PR's observed current base SHA — the exact current
``main`` base the PR represents — never the carried dispatch-base
provenance. The real PR #23 shape is pinned with the literal production
SHAs (dispatch base ``f55f519…``, absorbed current base ``c67bc66…``,
head ``35ecd42…``): an explicitly absorbed post-dispatch ``main``
advancement is legitimate and merges on the current base, while a base
that drifts between authorization and execution still refuses the
mutation at the CTRL-003 execution-time re-proof (true drift, zero PUT).
"""

from __future__ import annotations

import ast
import sys
import tempfile
import unittest
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from controller.commands import CommandName
from controller.domain import DomainEvent
from controller.errors import (
    ContradictionError,
    GithubContradictionError,
    GithubMalformedResponseError,
    GithubMergeBlockedError,
    GithubStaleBaseError,
    MergeContradictionError,
    MergeLoopPositionError,
    MergeMissingReferenceError,
    MergePolicyError,
    SpecError,
)
from controller.github import GithubAdapter, GithubPullRequest
from controller.merge import (
    MergeLoopOutcome,
    MergePolicy,
    MergeReconciliationLoop,
    ReconciliationRecord,
)
from controller.orchestrator import OrchestrationReferences
from controller.states import LifecycleState
from tests.github_fakes import (
    BASE_SHA,
    HEAD_SHA,
    OWNER,
    REPO,
    FakeTransport,
    commit_status,
    merge_success,
    pull_request,
    review,
)
from tests.util import REPO_ROOT, canonical_state, make_repo, write_state

WORK_ITEM = "CTRL-008"
BRANCH = "ctrl-008-merge-reconciliation"
ARCHITECT = "pectoraux"
WORKER = "zai-worker"
PR_NUMBER = 23
MERGE_SHA = "c" * 40
DRIFTED_SHA = "d" * 40
DRIFTED_BASE = "e" * 40
COMPLETED = ("CTRL-001", "CTRL-002", "CTRL-003", "CTRL-004", "CTRL-005", "CTRL-006", "CTRL-007")
REQUIRED_CHECKS = ("ci/validate", "ci/tests")
AUTOMATION_STAGE = "STAGE-1-STATE-MACHINE-AUTOMATION"

# The literal production SHAs of the real FZ-CTRL008-001 case (PR #23):
# the work order was dispatched from f55f519 (the PR #22 governance
# merge), then main advanced to c67bc66 (badee75 + the Architect
# control-loop document) and the advancement was explicitly absorbed
# into the governed branch — so the correlated PR's current base is
# c67bc66, legitimately distinct from the dispatch provenance.
REAL_DISPATCH_BASE = "f55f5190a82a0fb774285a03347e6df71163cbd5"
REAL_CURRENT_BASE = "c67bc666e08a4ac3162bd18a296ba05c499069b7"
REAL_PR_HEAD = "35ecd42d4cb68c3a330ae60ff24250ccfedc5280"

PR_PATH = f"/repos/{REPO}/pulls/{PR_NUMBER}"
OPEN_LIST_PATH = f"/repos/{REPO}/pulls?state=open&head={OWNER}:{BRANCH}"
ALL_LIST_PATH = f"/repos/{REPO}/pulls?state=all&head={OWNER}:{BRANCH}"
REVIEWS_PATH = f"/repos/{REPO}/pulls/{PR_NUMBER}/reviews"
STATUS_PATH = f"/repos/{REPO}/commits/{HEAD_SHA}/status"
REAL_STATUS_PATH = f"/repos/{REPO}/commits/{REAL_PR_HEAD}/status"
MERGE_PATH = f"/repos/{REPO}/pulls/{PR_NUMBER}/merge"

GREEN_STATUS = commit_status(
    state="success",
    statuses=[("ci/tests", "success"), ("ci/validate", "success")],
)

_MERGE_EVENT = DomainEvent(
    WORK_ITEM, CommandName.MERGE, LifecycleState.APPROVED, LifecycleState.MERGING
)
_RECORD_MERGE_EVENT = DomainEvent(
    WORK_ITEM, CommandName.RECORD_MERGE, LifecycleState.MERGING, LifecycleState.MERGED
)
_RECONCILE_EVENT = DomainEvent(
    WORK_ITEM, CommandName.RECONCILE, LifecycleState.MERGED, LifecycleState.RECONCILING
)
_RECORD_RECONCILIATION_EVENT = DomainEvent(
    WORK_ITEM,
    CommandName.RECORD_RECONCILIATION,
    LifecycleState.RECONCILING,
    LifecycleState.COMPLETE,
)


def open_pr(**overrides: Any) -> dict[str, object]:
    defaults: dict[str, Any] = {
        "number": PR_NUMBER,
        "title": "CTRL-008 — Merge + reconciliation",
        "head_branch": BRANCH,
        "head_sha": HEAD_SHA,
        "base_branch": "main",
        "base_sha": BASE_SHA,
    }
    defaults.update(overrides)
    return pull_request(**defaults)


def merged_pr(**overrides: Any) -> dict[str, object]:
    defaults: dict[str, Any] = {
        "number": PR_NUMBER,
        "title": "CTRL-008 — Merge + reconciliation",
        "head_branch": BRANCH,
        "head_sha": HEAD_SHA,
        "base_branch": "main",
        "base_sha": BASE_SHA,
        "state": "closed",
        "merged": True,
        "mergeable_state": None,
        "merge_commit_sha": MERGE_SHA,
    }
    defaults.update(overrides)
    return pull_request(**defaults)


def architect_approval(review_id: int = 501, commit_id: str | None = HEAD_SHA) -> dict[str, object]:
    return review(review_id, author=ARCHITECT, state="APPROVED", commit_id=commit_id)


def _refs(**overrides: object) -> OrchestrationReferences:
    defaults: dict[str, object] = {
        "branch": BRANCH,
        "base_sha": BASE_SHA,
        "worker_session": None,
        "architect_reviewer": ARCHITECT,
    }
    defaults.update(overrides)
    return OrchestrationReferences(**defaults)  # type: ignore[arg-type]


class MergeExecutionTransport(FakeTransport):
    """Serves the open governed PR and swaps it to the merged form exactly
    when the merge PUT lands (the same atomic transition GitHub performs)."""

    def __init__(
        self,
        responses: Mapping[str, object],
        *,
        swap_on_merge_put: Mapping[str, object] | None = None,
    ) -> None:
        super().__init__(responses)
        self._swap_on_merge_put: dict[str, object] = dict(swap_on_merge_put or {})

    def put_json(self, path: str, payload: Mapping[str, object]) -> object:
        result = super().put_json(path, payload)
        if path == MERGE_PATH and self._swap_on_merge_put:
            self._responses.update(self._swap_on_merge_put)
        return result


class DriftingHeadTransport(FakeTransport):
    """Serves the governed PR with one head for the first GET (the
    authorization-time observation) and a drifted head for every later
    GET (the execution-time re-proof): authorization/execution drift."""

    def __init__(self, responses: Mapping[str, object]) -> None:
        self._pr_gets = 0
        super().__init__(responses)

    def get_json(self, path: str) -> object:
        if path == PR_PATH:
            self._pr_gets += 1
            if self._pr_gets > 1:
                drifted = open_pr(head_sha=DRIFTED_SHA)
                self._responses[PR_PATH] = drifted
                self._responses[OPEN_LIST_PATH] = [drifted]
                self._responses[ALL_LIST_PATH] = [drifted]
        return super().get_json(path)


class DriftingBaseTransport(FakeTransport):
    """True base drift — not the absorbed post-dispatch advancement.

    Serves the governed PR at its current base for the first GET (the
    authorization-time observation) and a base that advanced *after*
    authorization for every later GET (the execution-time re-proof):
    the authorized base no longer matches the live PR, so the CTRL-003
    re-proof must refuse the mutation with zero PUT calls."""

    def __init__(self, responses: Mapping[str, object]) -> None:
        self._pr_gets = 0
        super().__init__(responses)

    def get_json(self, path: str) -> object:
        if path == PR_PATH:
            self._pr_gets += 1
            if self._pr_gets > 1:
                drifted = open_pr(base_sha=DRIFTED_BASE)
                self._responses[PR_PATH] = drifted
                self._responses[OPEN_LIST_PATH] = [drifted]
                self._responses[ALL_LIST_PATH] = [drifted]
        return super().get_json(path)


class MergeLoopFixtureMixin(unittest.TestCase):
    """Shared fixture: synthetic authority at a merge-boundary position."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _repo(
        self, status: str, *, work_item_status: str | None = None, **state_overrides: Any
    ) -> Path:
        overrides: dict[str, Any] = {
            "repository": REPO,
            "automationStage": AUTOMATION_STAGE,
            "completed": list(COMPLETED),
        }
        overrides.update(state_overrides)
        return make_repo(
            self.base,
            status=status,
            work_item=WORK_ITEM,
            state_overrides=overrides,
            work_item_status=work_item_status,
        )

    def _advance(self, root: Path, status: str) -> None:
        """Advance the synthetic machine state and work order together."""
        write_state(
            root,
            canonical_state(
                status=status,
                activeWorkItem=WORK_ITEM,
                repository=REPO,
                automationStage=AUTOMATION_STAGE,
                completed=list(COMPLETED),
            ),
        )
        self._work_order(root, WORK_ITEM, status)

    def _work_order(self, root: Path, work_item: str, status: str) -> None:
        (root / "spec/work-items" / f"{work_item}.md").write_text(
            f"# {work_item} — Synthetic Test Item\n\n"
            f"Status: `{status}`\n\nSynthetic work order body.\n",
            encoding="utf-8",
        )

    def _evaluate(
        self, transport: FakeTransport, root: Path, **ref_overrides: object
    ) -> MergeLoopOutcome:
        loop = MergeReconciliationLoop(github=GithubAdapter(transport, REPO))
        return loop.evaluate(root, _refs(**ref_overrides), MergePolicy(REQUIRED_CHECKS))

    def _merge_put_calls(self, transport: FakeTransport) -> int:
        return len(transport.calls_matching("PUT", MERGE_PATH))


def _open_pr_responses(
    *,
    reviews: list[dict[str, Any]] | None = None,
    status: dict[str, Any] | None = None,
    merge_result: dict[str, Any] | None = None,
    all_list: list[dict[str, Any]] | None = None,
    open_list: list[dict[str, Any]] | None = None,
    pr: dict[str, Any] | None = None,
) -> dict[str, object]:
    served = pr if pr is not None else open_pr()
    responses: dict[str, object] = {
        PR_PATH: served,
        OPEN_LIST_PATH: open_list if open_list is not None else [served],
        ALL_LIST_PATH: all_list if all_list is not None else [served],
        REVIEWS_PATH: reviews if reviews is not None else [architect_approval()],
    }
    if status is not None:
        responses[STATUS_PATH] = status
    if merge_result is not None:
        responses[MERGE_PATH] = merge_result
    return responses


def _merged_pr_responses(
    *,
    all_list: list[dict[str, Any]] | None = None,
    pr: dict[str, Any] | None = None,
) -> dict[str, object]:
    served = pr if pr is not None else merged_pr()
    return {
        PR_PATH: served,
        OPEN_LIST_PATH: [],
        ALL_LIST_PATH: all_list if all_list is not None else [served],
        REVIEWS_PATH: [architect_approval()],
    }


class MergePolicyTests(unittest.TestCase):
    """The frozen required-evidence policy: canonical, validated, typed."""

    def test_policy_canonicalizes_to_sorted_order(self) -> None:
        self.assertEqual(
            MergePolicy(("ci/tests", "ci/validate")),
            MergePolicy(("ci/validate", "ci/tests")),
        )

    def test_policy_requires_at_least_one_check(self) -> None:
        with self.assertRaises(MergePolicyError):
            MergePolicy(())

    def test_policy_rejects_empty_check_names(self) -> None:
        with self.assertRaises(MergePolicyError):
            MergePolicy(("ci/validate", ""))

    def test_policy_rejects_duplicate_check_names(self) -> None:
        with self.assertRaises(MergePolicyError):
            MergePolicy(("ci/validate", "ci/validate"))


class PositionDisciplineTests(MergeLoopFixtureMixin):
    """AC1: authority first; positions outside the merge boundary fail
    closed with zero remote calls."""

    _FOREIGN_POSITIONS = [
        "READY",
        "DISPATCHED",
        "IMPLEMENTING",
        "PR_OPEN",
        "CI_PENDING",
        "REVIEW_PENDING",
        "CHANGES_REQUESTED",
        "COMPLETE",
    ]

    def test_foreign_positions_fail_closed_before_any_remote_call(self) -> None:
        for status in self._FOREIGN_POSITIONS:
            with self.subTest(position=status):
                transport = FakeTransport({})
                root = self._repo(status)
                with self.assertRaises(MergeLoopPositionError):
                    self._evaluate(transport, root)
                self.assertEqual(transport.calls, [])

    def test_terminal_exception_positions_fail_closed(self) -> None:
        for status in ("BLOCKED", "ESCALATED", "CANCELLED"):
            with self.subTest(position=status):
                transport = FakeTransport({})
                root = self._repo(status)
                with self.assertRaises(MergeLoopPositionError):
                    self._evaluate(transport, root)
                self.assertEqual(transport.calls, [])

    def test_malformed_authority_fails_closed_before_any_remote_call(self) -> None:
        transport = FakeTransport({})
        root = self._repo("APPROVED")
        state_path = root / "spec/state/controller-program-state.json"
        state_path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(SpecError):
            self._evaluate(transport, root)
        self.assertEqual(transport.calls, [])

    def test_contradictory_authority_fails_closed_before_any_remote_call(self) -> None:
        transport = FakeTransport({})
        root = self._repo("APPROVED", work_item_status="MERGING")
        with self.assertRaises(ContradictionError):
            self._evaluate(transport, root)
        self.assertEqual(transport.calls, [])

    def test_missing_correlation_references_fail_closed(self) -> None:
        root = self._repo("APPROVED")
        for missing in ("branch", "base_sha"):
            with self.subTest(missing=missing):
                transport = FakeTransport({})
                with self.assertRaises(MergeMissingReferenceError):
                    self._evaluate(transport, root, **{missing: None})
                self.assertEqual(transport.calls, [])


class CorrelationTests(MergeLoopFixtureMixin):
    """AC2: exactly one governed PR across its whole history, on the
    intended base ref, with the observed current base as the identity
    the boundary operates on (FZ-CTRL008-001)."""

    def test_no_governed_pr_is_a_contradiction(self) -> None:
        transport = FakeTransport(_open_pr_responses(all_list=[], open_list=[]))
        root = self._repo("APPROVED")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)

    def test_multiple_prs_for_the_branch_violate_the_one_pr_rule(self) -> None:
        served = open_pr()
        second = open_pr(number=31)
        transport = FakeTransport(_open_pr_responses(all_list=[served, second]))
        root = self._repo("APPROVED")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)

    def test_absorbed_base_advancement_merges_on_the_current_pr_base(self) -> None:
        """FZ-CTRL008-001 regression — the real PR #23 shape with the
        literal production SHAs: the carried dispatch-base provenance
        (f55f519…) differs from the correlated PR's current base
        (c67bc66…) because main advanced after dispatch and the
        advancement was explicitly absorbed into the governed branch.
        The boundary correlates, authorizes, and merges on the exact
        current main base — never on the dispatch provenance — and
        records both SHAs distinctly in the outcome."""
        served = open_pr(base_sha=REAL_CURRENT_BASE, head_sha=REAL_PR_HEAD)
        responses = _open_pr_responses(
            pr=served,
            reviews=[architect_approval(commit_id=REAL_PR_HEAD)],
            merge_result=merge_success(PR_NUMBER),
        )
        responses[REAL_STATUS_PATH] = GREEN_STATUS
        transport = MergeExecutionTransport(
            responses,
            swap_on_merge_put={
                PR_PATH: merged_pr(base_sha=REAL_CURRENT_BASE, head_sha=REAL_PR_HEAD),
                OPEN_LIST_PATH: [],
                ALL_LIST_PATH: [merged_pr(base_sha=REAL_CURRENT_BASE, head_sha=REAL_PR_HEAD)],
            },
        )
        root = self._repo("APPROVED")
        outcome = self._evaluate(transport, root, base_sha=REAL_DISPATCH_BASE)

        self.assertEqual(outcome.event, _MERGE_EVENT)
        self.assertTrue(outcome.merge_attempted)
        authorization = outcome.authorization
        assert authorization is not None
        self.assertEqual(authorization.base_ref, "main")
        self.assertEqual(authorization.base_sha, REAL_CURRENT_BASE)
        self.assertEqual(authorization.head_sha, REAL_PR_HEAD)
        self.assertEqual(outcome.base_sha, REAL_CURRENT_BASE)
        self.assertEqual(outcome.dispatch_base, REAL_DISPATCH_BASE)
        self.assertTrue(outcome.pull_request.merged)
        self.assertEqual(outcome.merge_commit_sha, MERGE_SHA)
        self.assertEqual(self._merge_put_calls(transport), 1)

    def test_foreign_base_ref_at_correlation_fails_closed(self) -> None:
        transport = FakeTransport(_open_pr_responses(pr=open_pr(base_branch="develop")))
        root = self._repo("APPROVED")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_merged_pr_is_correlated_across_its_whole_history(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("MERGING")
        outcome = self._evaluate(transport, root)
        self.assertEqual(outcome.event.command, CommandName.RECORD_MERGE)

    def test_merged_pr_correlates_on_its_frozen_merge_time_base(self) -> None:
        """FZ-CTRL008-001 post-merge shape: the merged PR's frozen
        merge-time base (c67bc66…) differs from the carried dispatch
        provenance (f55f519…) — the absorbed advancement — and the
        boundary still correlates and records evidence on it."""
        transport = FakeTransport(_merged_pr_responses(pr=merged_pr(base_sha=REAL_CURRENT_BASE)))
        root = self._repo("MERGING")
        outcome = self._evaluate(transport, root, base_sha=REAL_DISPATCH_BASE)
        self.assertEqual(outcome.event, _RECORD_MERGE_EVENT)
        self.assertEqual(outcome.base_sha, REAL_CURRENT_BASE)
        self.assertEqual(outcome.dispatch_base, REAL_DISPATCH_BASE)
        self.assertEqual(outcome.merge_commit_sha, MERGE_SHA)


class ApprovedExecutionTests(MergeLoopFixtureMixin):
    """AC3/AC4/AC5: the complete frozen predicate, one authorized merge
    attempt with execution-time re-proof, observed merge evidence."""

    def test_happy_path_authorizes_and_executes_exactly_one_merge(self) -> None:
        transport = MergeExecutionTransport(
            _open_pr_responses(status=GREEN_STATUS, merge_result=merge_success(PR_NUMBER)),
            swap_on_merge_put={
                PR_PATH: merged_pr(),
                OPEN_LIST_PATH: [],
                ALL_LIST_PATH: [merged_pr()],
            },
        )
        root = self._repo("APPROVED")
        outcome = self._evaluate(transport, root)

        self.assertIsInstance(outcome, MergeLoopOutcome)
        self.assertEqual(outcome.event, _MERGE_EVENT)
        self.assertTrue(outcome.merge_attempted)
        self.assertIsNotNone(outcome.authorization)
        authorization = outcome.authorization
        assert authorization is not None
        self.assertEqual(authorization.pr_number, PR_NUMBER)
        self.assertEqual(authorization.work_item, WORK_ITEM)
        self.assertEqual(authorization.base_ref, "main")
        self.assertEqual(authorization.base_sha, BASE_SHA)
        self.assertEqual(authorization.head_sha, HEAD_SHA)
        self.assertEqual(authorization.merge_method, "merge")
        self.assertEqual(authorization, replace(authorization, merge_method="merge"))
        self.assertEqual(outcome.base_sha, BASE_SHA)
        self.assertEqual(outcome.dispatch_base, BASE_SHA)
        self.assertTrue(outcome.pull_request.merged)
        self.assertEqual(outcome.merge_commit_sha, MERGE_SHA)
        self.assertEqual(self._merge_put_calls(transport), 1)
        self.assertEqual(len(transport.calls_matching("PUT", "/")), 1)

    def test_approval_bound_to_older_commit_blocks_the_merge(self) -> None:
        transport = FakeTransport(
            _open_pr_responses(
                status=GREEN_STATUS,
                reviews=[architect_approval(commit_id="f" * 40)],
            )
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubMergeBlockedError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_changes_requested_after_approval_blocks_the_merge(self) -> None:
        transport = FakeTransport(
            _open_pr_responses(
                status=GREEN_STATUS,
                reviews=[
                    architect_approval(review_id=501),
                    review(
                        502,
                        author=ARCHITECT,
                        state="CHANGES_REQUESTED",
                        commit_id=HEAD_SHA,
                        submitted_at="2026-09-04T12:00:00Z",
                    ),
                ],
            )
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubMergeBlockedError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_failing_required_check_blocks_the_merge(self) -> None:
        transport = FakeTransport(
            _open_pr_responses(
                status=commit_status(
                    state="failure",
                    statuses=[("ci/tests", "failure"), ("ci/validate", "success")],
                ),
            )
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubMergeBlockedError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_dirty_mergeability_blocks_the_merge(self) -> None:
        transport = FakeTransport(
            _open_pr_responses(status=GREEN_STATUS, pr=open_pr(mergeable_state="dirty"))
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubMergeBlockedError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_worker_authored_approval_never_merges_the_pr(self) -> None:
        transport = FakeTransport(
            _open_pr_responses(
                status=GREEN_STATUS,
                reviews=[review(501, author=WORKER, state="APPROVED", commit_id=HEAD_SHA)],
            )
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubMergeBlockedError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_completed_item_cannot_seek_merge_authorization(self) -> None:
        transport = FakeTransport(_open_pr_responses(status=GREEN_STATUS))
        root = self._repo("APPROVED", completed=[*COMPLETED, WORK_ITEM])
        with self.assertRaises(GithubContradictionError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_execution_time_head_drift_refuses_the_mutation(self) -> None:
        transport = DriftingHeadTransport(
            _open_pr_responses(status=GREEN_STATUS, merge_result=merge_success(PR_NUMBER))
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubStaleBaseError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_execution_time_base_drift_refuses_the_mutation(self) -> None:
        """FZ-CTRL008-001 true-drift retention: a base that advanced
        *between authorization and execution* (not an absorbed
        post-dispatch advancement) fails closed at the CTRL-003
        execution-time re-proof with zero PUT mutations."""
        transport = DriftingBaseTransport(
            _open_pr_responses(status=GREEN_STATUS, merge_result=merge_success(PR_NUMBER))
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubStaleBaseError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_github_refused_merge_surfaces_typed_with_no_event(self) -> None:
        transport = FakeTransport(
            _open_pr_responses(
                status=GREEN_STATUS,
                merge_result={"merged": False, "message": "refused"},
            )
        )
        root = self._repo("APPROVED")
        with self.assertRaises(GithubMergeBlockedError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 1)

    def test_missing_reviewer_reference_fails_closed_before_the_predicate(self) -> None:
        transport = FakeTransport(_open_pr_responses(status=GREEN_STATUS))
        root = self._repo("APPROVED")
        with self.assertRaises(MergeMissingReferenceError):
            self._evaluate(transport, root, architect_reviewer=None)
        self.assertEqual(self._merge_put_calls(transport), 0)


class ExternalMergeObservationTests(MergeLoopFixtureMixin):
    """AC5/AC7: an already-landed merge is recorded, never re-attempted."""

    def test_external_merge_at_approved_is_recorded_without_mutation(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("APPROVED")
        outcome = self._evaluate(transport, root)
        self.assertEqual(outcome.event, _MERGE_EVENT)
        self.assertFalse(outcome.merge_attempted)
        self.assertIsNone(outcome.authorization)
        self.assertEqual(outcome.merge_commit_sha, MERGE_SHA)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_external_merge_with_missing_merge_sha_fails_closed(self) -> None:
        transport = FakeTransport(_merged_pr_responses(pr=merged_pr(merge_commit_sha=None)))
        root = self._repo("APPROVED")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_external_merge_into_a_foreign_base_ref_fails_closed(self) -> None:
        transport = FakeTransport(_merged_pr_responses(pr=merged_pr(base_branch="develop")))
        root = self._repo("APPROVED")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)


class PostMergeStepTests(MergeLoopFixtureMixin):
    """MERGING/MERGED: observation of the merge result drives the record."""

    def test_merging_records_the_observed_merge(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("MERGING")
        outcome = self._evaluate(transport, root)
        self.assertEqual(outcome.event, _RECORD_MERGE_EVENT)
        self.assertEqual(outcome.merge_commit_sha, MERGE_SHA)
        self.assertFalse(outcome.merge_attempted)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_merging_without_a_landed_merge_never_re_attempts(self) -> None:
        transport = FakeTransport(_open_pr_responses(status=GREEN_STATUS))
        root = self._repo("MERGING")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)
        self.assertEqual(self._merge_put_calls(transport), 0)

    def test_merging_with_contradictory_merge_state_fails_closed(self) -> None:
        transport = FakeTransport(_merged_pr_responses(pr=merged_pr(state="open")))
        root = self._repo("MERGING")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)

    def test_merging_without_reviewer_reference_still_records_evidence(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("MERGING")
        outcome = self._evaluate(transport, root, architect_reviewer=None)
        self.assertEqual(outcome.event.command, CommandName.RECORD_MERGE)

    def test_merged_begins_reconciliation(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("MERGED")
        outcome = self._evaluate(transport, root)
        self.assertEqual(outcome.event, _RECONCILE_EVENT)
        self.assertIsNone(outcome.record)

    def test_merged_with_vanished_merge_evidence_fails_closed(self) -> None:
        transport = FakeTransport(_open_pr_responses(status=GREEN_STATUS))
        root = self._repo("MERGED")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)


class ReconciliationTests(MergeLoopFixtureMixin):
    """AC6/AC7: the deterministic, idempotent reconciliation record."""

    def test_reconciling_records_completion_and_preserves_the_stage(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING")
        outcome = self._evaluate(transport, root)
        self.assertEqual(outcome.event, _RECORD_RECONCILIATION_EVENT)
        record = outcome.record
        assert record is not None
        self.assertEqual(record.work_item, WORK_ITEM)
        self.assertEqual(record.repository, REPO)
        self.assertEqual(record.branch, BRANCH)
        self.assertEqual(record.base_sha, BASE_SHA)
        self.assertEqual(record.pr_number, PR_NUMBER)
        self.assertEqual(record.head_sha, HEAD_SHA)
        self.assertEqual(record.merge_commit_sha, MERGE_SHA)
        self.assertEqual(record.completed_before, COMPLETED)
        self.assertEqual(record.completed_after, (*COMPLETED, WORK_ITEM))
        self.assertIsNone(record.next_work_item)
        self.assertEqual(record.automation_stage, AUTOMATION_STAGE)

    def test_reconciliation_records_the_merge_time_base_not_the_dispatch_base(self) -> None:
        """FZ-CTRL008-001 post-merge regression: the deterministic record
        carries the merged PR's frozen merge-time base (c67bc66…) — never
        the carried dispatch provenance (f55f519…) — so the absorbed
        post-dispatch advancement reconciles on the observed merge
        boundary."""
        transport = FakeTransport(_merged_pr_responses(pr=merged_pr(base_sha=REAL_CURRENT_BASE)))
        root = self._repo("RECONCILING")
        outcome = self._evaluate(transport, root, base_sha=REAL_DISPATCH_BASE)
        record = outcome.record
        assert record is not None
        self.assertEqual(record.base_sha, REAL_CURRENT_BASE)
        self.assertEqual(outcome.base_sha, REAL_CURRENT_BASE)
        self.assertEqual(outcome.dispatch_base, REAL_DISPATCH_BASE)
        self.assertEqual(record.merge_commit_sha, MERGE_SHA)
        self.assertEqual(record.completed_after, (*COMPLETED, WORK_ITEM))

    def test_reconciliation_selects_the_unique_ready_successor(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING")
        self._work_order(root, "CTRL-009", "READY")
        outcome = self._evaluate(transport, root)
        record = outcome.record
        assert record is not None
        self.assertEqual(record.next_work_item, "CTRL-009")
        self.assertIn("CTRL-009", " ".join(record.basis))

    def test_reconciliation_fails_closed_on_multiple_ready_work_orders(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING")
        self._work_order(root, "CTRL-009", "READY")
        self._work_order(root, "CTRL-010", "READY")
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)

    def test_completed_items_are_never_selected_as_next_eligible(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING")
        self._work_order(root, "CTRL-002", "READY")
        outcome = self._evaluate(transport, root)
        record = outcome.record
        assert record is not None
        self.assertIsNone(record.next_work_item)

    def test_duplicate_completion_is_a_contradiction(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING", completed=[*COMPLETED, WORK_ITEM])
        with self.assertRaises(MergeContradictionError):
            self._evaluate(transport, root)

    def test_reconciliation_is_idempotent_across_repeated_evaluation(self) -> None:
        first_transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING")
        first = self._evaluate(first_transport, root)
        restart_transport = FakeTransport(_merged_pr_responses())
        second = self._evaluate(restart_transport, root)
        self.assertEqual(first.record, second.record)
        self.assertEqual(first.event, second.event)

    def test_reconciliation_serializes_deterministically(self) -> None:
        transport = FakeTransport(_merged_pr_responses())
        root = self._repo("RECONCILING")
        outcome = self._evaluate(transport, root)
        record = outcome.record
        assert record is not None
        serialized = record.serialize()
        self.assertEqual(
            set(serialized),
            {
                "work_item",
                "repository",
                "branch",
                "base_sha",
                "pr",
                "head_sha",
                "merge_commit_sha",
                "completed_before",
                "completed_after",
                "next_work_item",
                "automation_stage",
                "basis",
            },
        )
        self.assertEqual(serialized["merge_commit_sha"], MERGE_SHA)
        self.assertIsNone(serialized["next_work_item"])
        self.assertEqual(serialized["completed_after"], [*COMPLETED, WORK_ITEM])
        twin = ReconciliationRecord(
            work_item=record.work_item,
            repository=record.repository,
            branch=record.branch,
            base_sha=record.base_sha,
            pr_number=record.pr_number,
            head_sha=record.head_sha,
            merge_commit_sha=record.merge_commit_sha,
            completed_before=record.completed_before,
            completed_after=record.completed_after,
            next_work_item=record.next_work_item,
            automation_stage=record.automation_stage,
            basis=record.basis,
        )
        self.assertEqual(serialized, twin.serialize())


class FullBoundaryWalkTests(MergeLoopFixtureMixin):
    """The four governed steps of the merge boundary, chained exactly as
    the frozen transition table authorizes them (each step re-reconstructs
    authority from disk — restart determinism at every boundary)."""

    def test_the_four_step_walk_matches_the_frozen_table(self) -> None:
        root = self._repo("APPROVED")

        step1 = MergeExecutionTransport(
            _open_pr_responses(status=GREEN_STATUS, merge_result=merge_success(PR_NUMBER)),
            swap_on_merge_put={
                PR_PATH: merged_pr(),
                OPEN_LIST_PATH: [],
                ALL_LIST_PATH: [merged_pr()],
            },
        )
        first = self._evaluate(step1, root)
        self.assertEqual(first.event, _MERGE_EVENT)
        self.assertTrue(first.merge_attempted)
        self.assertEqual(self._merge_put_calls(step1), 1)

        self._advance(root, "MERGING")
        second = self._evaluate(FakeTransport(_merged_pr_responses()), root)
        self.assertEqual(second.event, _RECORD_MERGE_EVENT)

        self._advance(root, "MERGED")
        third = self._evaluate(FakeTransport(_merged_pr_responses()), root)
        self.assertEqual(third.event, _RECONCILE_EVENT)

        self._advance(root, "RECONCILING")
        fourth = self._evaluate(FakeTransport(_merged_pr_responses()), root)
        self.assertEqual(fourth.event, _RECORD_RECONCILIATION_EVENT)
        assert fourth.record is not None
        self.assertEqual(fourth.record.completed_after, (*COMPLETED, WORK_ITEM))
        self.assertIsNone(fourth.record.next_work_item)
        self.assertEqual(fourth.record.automation_stage, AUTOMATION_STAGE)

        events = [first.event, second.event, third.event, fourth.event]
        self.assertIs(events[0].from_state, LifecycleState.APPROVED)
        for previous, event in zip(events, events[1:], strict=False):
            self.assertIs(event.from_state, previous.to_state)
        self.assertIs(events[-1].to_state, LifecycleState.COMPLETE)


class MergeModuleSurfaceTests(unittest.TestCase):
    """The merge boundary holds no worker-provider surface of any kind."""

    def test_merge_module_has_no_zai_surface(self) -> None:
        tree = ast.parse((REPO_ROOT / "controller" / "merge.py").read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                self.assertFalse(
                    node.module is not None and node.module.startswith("controller.zai"),
                    msg=f"merge.py must not import controller.zai (found {node.module})",
                )
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertFalse(
                        alias.name.startswith("controller.zai"),
                        msg=f"merge.py must not import controller.zai (found {alias.name})",
                    )

    def test_merge_module_imports_only_stdlib_and_controller(self) -> None:
        allowed = set(sys.stdlib_module_names) | {"controller"}
        tree = ast.parse((REPO_ROOT / "controller" / "merge.py").read_text(encoding="utf-8"))
        roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    roots.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module is not None:
                    roots.add(node.module.split(".")[0])
        self.assertEqual(roots - allowed, set())

    def test_github_pull_request_carries_observed_merge_evidence(self) -> None:
        """The extended PR observation: merge_commit_sha is evidence, never
        synthesized; a non-string value is malformed and fails closed."""

        def _pr(**overrides: Any) -> GithubPullRequest:
            fields: dict[str, Any] = {
                "number": 1,
                "state": "open",
                "title": "t",
                "head_ref": BRANCH,
                "head_sha": HEAD_SHA,
                "base_ref": "main",
                "base_sha": BASE_SHA,
                "draft": False,
                "merged": False,
                "mergeable_state": None,
            }
            fields.update(overrides)
            return GithubPullRequest(**fields)

        self.assertIsNone(_pr().merge_commit_sha)
        observed = _pr(merged=True, state="closed", merge_commit_sha=MERGE_SHA)
        self.assertEqual(observed.merge_commit_sha, MERGE_SHA)
        transport = FakeTransport({PR_PATH: {**merged_pr(), "merge_commit_sha": 123}})
        adapter = GithubAdapter(transport, REPO)
        with self.assertRaises(GithubMalformedResponseError):
            adapter.get_pull_request(PR_NUMBER)


if __name__ == "__main__":
    unittest.main()
