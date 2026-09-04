"""CTRL-009 recovery-boundary tests (governed restart/interruption
classification, exact identity binding, restart equivalence, and the
zero-mutation/zero-fabrication safety properties).

Fully offline: a fake GitHub transport serves canned JSON for the exact
observation paths the boundary consults (whole-history PR listing, the
combined commit status at CI positions, architect reviews at review
positions), the synthetic authority tree is local, and every evaluation
asserts zero non-GET transport calls — the boundary performs no
mutations of any kind and consults only the paths its position
classification needs (least-privilege observation).

The real PR #23 restart shape is pinned with the literal production
SHAs: the work item dispatched from f55f519, main advanced to c67bc66
and the advancement was absorbed, so the merged governed PR's frozen
merge-time base (c67bc66) legitimately differs from the dispatch
provenance (f55f519) at the merge boundary (FZ-CTRL008-001), while a
base that differs at a PRE-merge position is a contradiction the frozen
pre-merge correlation already refuses.

The FZ-CTRL009-001 regressions pin the no-start-replay contract: at
READY/DISPATCHED with an observed governed PR the plan directs NO
next step (the observed PR is durable evidence the dispatch/start
work already ran, and the orchestrator's own READY/DISPATCHED cycles
re-perform the provider start), so no Z.ai invocation can be caused
by the recovery continuation. The FZ-CTRL009-002 regression pins the
required-session fail-closed at the CHANGES_REQUESTED resume: an
absent required carried worker session is a typed missing-reference
error, never a resume directive without session identity.
"""

from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path
from typing import Any

from controller.errors import (
    ContradictionError,
    RecoveryContradictionError,
    RecoveryMissingReferenceError,
    RecoveryTerminalStateError,
    SpecError,
)
from controller.github import GithubAdapter
from controller.orchestrator import OrchestrationReferences
from controller.recovery import (
    GovernedBoundary,
    RecoveryBoundary,
    RecoveryCondition,
    RecoveryPlan,
    SessionBinding,
)
from controller.states import LifecycleState
from controller.zai import ZaiAdapter, ZaiIssuedWorkerSession, ZaiWorkerContext, ZaiWorkerSession
from tests.github_fakes import (
    BASE_SHA,
    HEAD_SHA,
    OWNER,
    REPO,
    FakeTransport,
    commit_status,
    pull_request,
    review,
)
from tests.util import make_repo
from tests.zai_fakes import START_PATH, FakeZaiTransport, worker_session

WORK_ITEM = "CTRL-009"
BRANCH = "ctrl-009-recovery"
ARCHITECT = "pectoraux"
PR_NUMBER = 26
MERGE_SHA = "c" * 40
DRIFTED_BASE = "e" * 40
COMPLETED = tuple(f"CTRL-00{i}" for i in range(1, 9))
AUTOMATION_STAGE = "STAGE-1-STATE-MACHINE-AUTOMATION"

# The literal production SHAs of the real FZ-CTRL008-001 case: the
# CTRL-008 work item dispatched from f55f519 and the governed PR #23
# merged on the absorbed current base c67bc66.
REAL_DISPATCH_BASE = "f55f5190a82a0fb774285a03347e6df71163cbd5"
REAL_CURRENT_BASE = "c67bc666e08a4ac3162bd18a296ba05c499069b7"

ALL_LIST_PATH = f"/repos/{REPO}/pulls?state=all&head={OWNER}:{BRANCH}"
STATUS_PATH = f"/repos/{REPO}/commits/{HEAD_SHA}/status"
REVIEWS_PATH = f"/repos/{REPO}/pulls/{PR_NUMBER}/reviews"
SESSION_ID = "zai-sess-009"

#: The recovery boundary's own source, for the FZ-CTRL009-001
#: structural guard: the boundary surface can never invoke the worker
#: provider (no provider-start call site, no adapter construction,
#: exactly one sealed static verifier invocation).
RECOVERY_SOURCE = (Path(__file__).resolve().parent.parent / "controller" / "recovery.py").read_text(
    encoding="utf-8"
)


def open_pr(**overrides: Any) -> dict[str, object]:
    """A governed open PR on the exact dispatch base."""
    defaults: dict[str, Any] = {
        "number": PR_NUMBER,
        "title": "CTRL-009 — Recovery / Idempotency",
        "head_branch": BRANCH,
        "head_sha": HEAD_SHA,
        "base_branch": "main",
        "base_sha": BASE_SHA,
    }
    defaults.update(overrides)
    return pull_request(**defaults)


def merged_pr(**overrides: Any) -> dict[str, object]:
    """A governed merged PR with canonical merge evidence."""
    defaults: dict[str, Any] = {
        "number": PR_NUMBER,
        "title": "CTRL-009 — Recovery / Idempotency",
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


def architect_review(
    review_id: int,
    state: str = "APPROVED",
    commit_id: str | None = HEAD_SHA,
    submitted_at: str = "2026-09-04T10:00:00Z",
    author: str = ARCHITECT,
) -> dict[str, object]:
    return review(
        review_id,
        author=author,
        state=state,
        submitted_at=submitted_at,
        commit_id=commit_id,
    )


def _issued_session(
    *,
    session_id: str = SESSION_ID,
    pr_number: int | None = None,
    head_sha: str | None = None,
) -> ZaiIssuedWorkerSession:
    """Adapter-issued session evidence, produced by the actual issuance
    boundary: the ZaiAdapter normalizing a (fake) provider response for
    the exact governed fixture context (FZ-CTRL007-001). The context and
    report agree on the repository, Work Item, dispatch base, and PR
    identity, so the provider-context fork guard passes and the adapter
    mints genuinely bound evidence."""
    report = worker_session(
        session_id=session_id,
        repository=REPO,
        work_item=WORK_ITEM,
        base_sha=BASE_SHA,
        pr_number=pr_number,
        head_sha=head_sha,
    )
    adapter = ZaiAdapter(FakeZaiTransport({START_PATH: report}), REPO)
    context = ZaiWorkerContext(
        repository=REPO,
        work_item=WORK_ITEM,
        work_order_path="spec/work-items/CTRL-009.md",
        base_sha=BASE_SHA,
        pr_number=pr_number,
        head_sha=head_sha,
    )
    return adapter.start_worker(context)


def _foreign_session(**overrides: Any) -> ZaiIssuedWorkerSession:
    """A genuine issued session with one ordinary field transplanted to
    a foreign value: recovery's ordinary-binding check fires BEFORE the
    provenance verifier, so the foreign binding is refused (the sealed
    proof, which binds the original fields, would also fail)."""
    return dataclasses.replace(_issued_session(), **overrides)


def _plain_session(**overrides: Any) -> ZaiWorkerSession:
    """The ordinary request form (hand-constructed, as a caller would)."""
    fields: dict[str, Any] = {
        "session_id": SESSION_ID,
        "repository": REPO,
        "work_item": WORK_ITEM,
        "base_sha": BASE_SHA,
        "pr_number": None,
        "head_sha": None,
        "status": "active",
        "updated_at": "2026-09-04T15:00:00Z",
    }
    fields.update(overrides)
    return ZaiWorkerSession(**fields)


def _refs(**overrides: object) -> OrchestrationReferences:
    defaults: dict[str, object] = {
        "branch": BRANCH,
        "base_sha": BASE_SHA,
        "worker_session": None,
        "architect_reviewer": ARCHITECT,
    }
    defaults.update(overrides)
    return OrchestrationReferences(**defaults)  # type: ignore[arg-type]


class RecoveryFixtureMixin(unittest.TestCase):
    """Shared fixture: synthetic authority at any lifecycle position."""

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

    def _evaluate(
        self, transport: FakeTransport, root: Path, **ref_overrides: object
    ) -> RecoveryPlan:
        boundary = RecoveryBoundary(github=GithubAdapter(transport, REPO))
        plan = boundary.evaluate(root, _refs(**ref_overrides))
        # Zero-mutation property (AC5/AC8): recovery is a classifier —
        # it never performs a remote mutation of any kind.
        self.assertEqual(transport.calls_matching("PUT", "/repos/"), [])
        self.assertEqual(transport.calls_matching("POST", "/repos/"), [])
        return plan

    def _assert_fail_closed(
        self,
        transport: FakeTransport,
        root: Path,
        error: type[Exception],
        **ref_overrides: object,
    ) -> None:
        boundary = RecoveryBoundary(github=GithubAdapter(transport, REPO))
        with self.assertRaises(error):
            boundary.evaluate(root, _refs(**ref_overrides))
        self.assertEqual(transport.calls_matching("PUT", "/repos/"), [])
        self.assertEqual(transport.calls_matching("POST", "/repos/"), [])


class AuthorityFirstTests(RecoveryFixtureMixin):
    """AC1: authority is reconstructed before any external evidence."""

    def test_malformed_authority_fails_closed_before_any_call(self) -> None:
        root = self._repo("NOT_A_STATE")
        transport = FakeTransport({})
        self._assert_fail_closed(transport, root, SpecError)
        self.assertEqual(transport.calls, [])

    def test_authority_disagreement_fails_closed(self) -> None:
        root = self._repo("READY", work_item_status="IMPLEMENTING")
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(transport, root, ContradictionError)

    def test_terminal_exception_state_has_no_recovery(self) -> None:
        root = self._repo("BLOCKED")
        transport = FakeTransport({})
        self._assert_fail_closed(transport, root, RecoveryTerminalStateError)
        self.assertEqual(transport.calls, [])

    def test_escalated_and_cancelled_are_equally_terminal(self) -> None:
        for status in ("ESCALATED", "CANCELLED"):
            with self.subTest(status=status):
                root = self._repo(status)
                transport = FakeTransport({})
                self._assert_fail_closed(transport, root, RecoveryTerminalStateError)
                self.assertEqual(transport.calls, [])

    def test_missing_branch_reference_fails_closed(self) -> None:
        root = self._repo("READY")
        transport = FakeTransport({})
        self._assert_fail_closed(transport, root, RecoveryMissingReferenceError, branch=None)
        self.assertEqual(transport.calls, [])

    def test_missing_base_reference_fails_closed(self) -> None:
        root = self._repo("READY")
        transport = FakeTransport({})
        self._assert_fail_closed(transport, root, RecoveryMissingReferenceError, base_sha=None)
        self.assertEqual(transport.calls, [])


class FreshStartTests(RecoveryFixtureMixin):
    """READY-position classification."""

    def test_ready_with_no_pr_is_a_fresh_start(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        plan = self._evaluate(transport, self._repo("READY"))
        self.assertEqual(plan.condition, RecoveryCondition.FRESH_START)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertEqual(plan.next_step, "DISPATCH")
        self.assertIsNone(plan.pull_request)
        self.assertIsNone(plan.merge_commit_sha)
        self.assertFalse(plan.session_required)

    def test_ready_with_open_pr_is_evidence_ahead(self) -> None:
        served = open_pr()
        transport = FakeTransport({ALL_LIST_PATH: [served]})
        plan = self._evaluate(transport, self._repo("READY"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertIsNone(plan.next_step)
        assert plan.pull_request is not None
        self.assertEqual(plan.pull_request.number, PR_NUMBER)
        self.assertEqual(plan.base_sha, BASE_SHA)
        self.assertEqual(plan.dispatch_base, BASE_SHA)

    def test_ready_with_closed_pr_is_unsupported(self) -> None:
        served = open_pr(state="closed")
        transport = FakeTransport({ALL_LIST_PATH: [served]})
        self._assert_fail_closed(transport, self._repo("READY"), RecoveryContradictionError)

    def test_ready_with_base_drift_fails_closed(self) -> None:
        served = open_pr(base_sha=DRIFTED_BASE)
        transport = FakeTransport({ALL_LIST_PATH: [served]})
        self._assert_fail_closed(transport, self._repo("READY"), RecoveryContradictionError)

    def test_multiple_prs_across_history_is_a_contradiction(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr(), open_pr(number=27, state="closed")]})
        self._assert_fail_closed(transport, self._repo("READY"), RecoveryContradictionError)

    def test_foreign_base_ref_is_a_contradiction(self) -> None:
        served = open_pr(base_branch="develop")
        transport = FakeTransport({ALL_LIST_PATH: [served]})
        self._assert_fail_closed(transport, self._repo("READY"), RecoveryContradictionError)


class PreMergeBandTests(RecoveryFixtureMixin):
    """DISPATCHED through CHANGES_REQUESTED classification."""

    def test_dispatched_in_progress(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        plan = self._evaluate(transport, self._repo("DISPATCHED"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertEqual(plan.next_step, "BEGIN_IMPLEMENTATION")

    def test_dispatched_with_open_pr_is_evidence_ahead(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        plan = self._evaluate(transport, self._repo("DISPATCHED"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertIsNone(plan.next_step)

    def test_implementing_in_progress(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        plan = self._evaluate(transport, self._repo("IMPLEMENTING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.next_step, "OPEN_PR")

    def test_implementing_with_open_pr_is_evidence_ahead(self) -> None:
        """The canonical restart case: the PR opening already performed,
        the machine-state write did not survive — record, never repeat.
        OPEN_PR is a pure GitHub observation through the orchestrator's
        IMPLEMENTING cycle (no provider invocation), so the direction
        stands (contrast the READY/DISPATCHED no-step contract,
        NoStartReplayTests)."""
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        plan = self._evaluate(transport, self._repo("IMPLEMENTING"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertEqual(plan.next_step, "OPEN_PR")

    def test_implementing_with_merged_pr_is_unsupported(self) -> None:
        """Deep evidence-ahead at a pre-merge position: the frozen
        pre-merge correlation observes open PRs only, so a closed PR is
        an unsupported recovery condition — governance attention."""
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        self._assert_fail_closed(transport, self._repo("IMPLEMENTING"), RecoveryContradictionError)

    def test_pr_open_pending_ci_is_in_progress(self) -> None:
        transport = FakeTransport(
            {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="pending")}
        )
        plan = self._evaluate(transport, self._repo("PR_OPEN"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertEqual(plan.next_step, "AWAIT_CI")
        self.assertEqual(plan.ci_state, "pending")

    def test_pr_open_terminal_success_is_evidence_ahead(self) -> None:
        transport = FakeTransport(
            {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="success")}
        )
        plan = self._evaluate(transport, self._repo("PR_OPEN"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.next_step, "AWAIT_CI")

    def test_pr_open_with_no_pr_is_authority_ahead(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(transport, self._repo("PR_OPEN"), RecoveryContradictionError)

    def test_ci_pending_pending_is_in_progress_at_the_gate(self) -> None:
        transport = FakeTransport(
            {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="pending")}
        )
        plan = self._evaluate(transport, self._repo("CI_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.EVIDENCE_GATE)
        self.assertEqual(plan.next_step, "RECORD_CI_SUCCESS")

    def test_ci_pending_success_is_evidence_ahead(self) -> None:
        transport = FakeTransport(
            {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="success")}
        )
        plan = self._evaluate(transport, self._repo("CI_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.boundary, GovernedBoundary.EVIDENCE_GATE)
        self.assertEqual(plan.next_step, "RECORD_CI_SUCCESS")

    def test_ci_pending_failure_is_reported_not_classified(self) -> None:
        """Recovery carries the raw observed state verbatim; the CTRL-006
        gate remains the classification authority (no parallel policy)."""
        transport = FakeTransport(
            {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="failure")}
        )
        plan = self._evaluate(transport, self._repo("CI_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.ci_state, "failure")


class ReviewBandTests(RecoveryFixtureMixin):
    """REVIEW_PENDING / CHANGES_REQUESTED classification (AC4: decisions
    are observed and transported, never fabricated)."""

    def test_review_pending_no_decision_is_in_progress(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()], REVIEWS_PATH: []})
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.REVIEW_LOOP)
        self.assertIsNone(plan.next_step)
        self.assertIsNone(plan.architect_decision)

    def test_review_pending_bound_approval_is_evidence_ahead(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(501, state="APPROVED")],
            }
        )
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.boundary, GovernedBoundary.REVIEW_LOOP)
        self.assertEqual(plan.next_step, "APPROVE")
        decision = plan.architect_decision
        assert decision is not None
        self.assertEqual(decision.state, "APPROVED")
        self.assertEqual(decision.author, ARCHITECT)
        self.assertEqual(decision.review_id, 501)
        self.assertEqual(decision.head_sha, HEAD_SHA)

    def test_review_pending_bound_changes_requested_is_evidence_ahead(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(502, state="CHANGES_REQUESTED")],
            }
        )
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.next_step, "REQUEST_CHANGES")

    def test_stale_decision_is_history_not_permission(self) -> None:
        """A decision bound to an older head is stale — never current."""
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(501, state="APPROVED", commit_id="9" * 40)],
            }
        )
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertIsNone(plan.architect_decision)

    def test_unbound_decision_is_not_current(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(501, state="APPROVED", commit_id=None)],
            }
        )
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertIsNone(plan.architect_decision)

    def test_non_decision_states_are_never_inferred_from(self) -> None:
        for state in ("COMMENTED", "PENDING", "DISMISSED"):
            with self.subTest(state=state):
                transport = FakeTransport(
                    {
                        ALL_LIST_PATH: [open_pr()],
                        REVIEWS_PATH: [architect_review(501, state=state)],
                    }
                )
                plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
                self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
                self.assertIsNone(plan.architect_decision)

    def test_foreign_author_reviews_are_ignored(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(501, state="APPROVED", author="someone-else")],
            }
        )
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertIsNone(plan.architect_decision)

    def test_latest_decision_wins_by_deterministic_order(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [
                    architect_review(501, state="APPROVED", submitted_at="2026-09-04T10:00:00Z"),
                    architect_review(
                        502, state="CHANGES_REQUESTED", submitted_at="2026-09-04T11:00:00Z"
                    ),
                ],
            }
        )
        plan = self._evaluate(transport, self._repo("REVIEW_PENDING"))
        decision = plan.architect_decision
        assert decision is not None
        self.assertEqual(decision.state, "CHANGES_REQUESTED")
        self.assertEqual(decision.review_id, 502)

    def test_missing_reviewer_reference_fails_closed(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()], REVIEWS_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("REVIEW_PENDING"),
            RecoveryMissingReferenceError,
            architect_reviewer=None,
        )

    def test_changes_requested_intact_is_in_progress_resume(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(502, state="CHANGES_REQUESTED")],
            }
        )
        plan = self._evaluate(
            transport, self._repo("CHANGES_REQUESTED"), worker_session=_plain_session()
        )
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertEqual(plan.next_step, "RESUME_IMPLEMENTATION")
        self.assertTrue(plan.session_required)
        self.assertEqual(plan.session_id, SESSION_ID)
        self.assertEqual(plan.session_binding, SessionBinding.REQUEST_FORM)

    def test_changes_requested_without_session_fails_closed(self) -> None:
        """FZ-CTRL009-002: the CHANGES_REQUESTED resume requires the
        carried worker-session reference (AC3 — exact identity
        correlation for required session evidence); an absent required
        session is a typed fail-closed missing reference, never a
        resume directive without session identity. The
        decision-stability contradiction still fires first (the
        flipped/vanished tests below carry no session either)."""
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(502, state="CHANGES_REQUESTED")],
            }
        )
        self._assert_fail_closed(
            transport, self._repo("CHANGES_REQUESTED"), RecoveryMissingReferenceError
        )

    def test_changes_requested_flipped_decision_is_a_contradiction(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(503, state="APPROVED")],
            }
        )
        self._assert_fail_closed(
            transport, self._repo("CHANGES_REQUESTED"), RecoveryContradictionError
        )

    def test_changes_requested_vanished_decision_is_a_contradiction(self) -> None:
        transport = FakeTransport(
            {ALL_LIST_PATH: [open_pr()], REVIEWS_PATH: [architect_review(503, state="COMMENTED")]}
        )
        self._assert_fail_closed(
            transport, self._repo("CHANGES_REQUESTED"), RecoveryContradictionError
        )


class NoStartReplayTests(RecoveryFixtureMixin):
    """FZ-CTRL009-001: already-observed dispatch/start work is never
    replayed. The orchestrator's READY and DISPATCHED cycles perform
    the worker provider start (its accepted dispatch and
    provenance-re-proof semantics), so a recovery plan that directed
    DISPATCH or BEGIN_IMPLEMENTATION while a governed PR is already
    observed would cause a second worker/provider execution for one
    Work Item — even though the PR is itself durable evidence of prior
    work. The corrected contract: those positions direct NO next step,
    so the recovery continuation (the runtime following the plan)
    invokes no boundary path, and the boundary's own surface holds no
    worker-execution site — no Z.ai invocation can be caused."""

    def test_ready_with_pr_directs_no_step_never_the_dispatch_replay(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        plan = self._evaluate(transport, self._repo("READY"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertIsNone(plan.next_step)
        self.assertTrue(any("second worker/provider execution" in entry for entry in plan.basis))

    def test_dispatched_with_pr_directs_no_step_never_the_start_replay(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        plan = self._evaluate(transport, self._repo("DISPATCHED"))
        self.assertEqual(plan.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(plan.boundary, GovernedBoundary.ORCHESTRATOR)
        self.assertIsNone(plan.next_step)
        self.assertTrue(any("second worker/provider execution" in entry for entry in plan.basis))

    def test_the_no_step_direction_is_evidence_conditional(self) -> None:
        """The fresh-start/no-PR cases still direct their frozen steps —
        the first dispatch and the accepted provenance re-proof are not
        replays when no PR evidence exists — and IMPLEMENTING with an
        observed PR still directs OPEN_PR (a pure GitHub observation
        that records the already-open PR, never a provider call)."""
        transport = FakeTransport({ALL_LIST_PATH: []})
        ready = self._evaluate(transport, self._repo("READY"))
        self.assertEqual(ready.condition, RecoveryCondition.FRESH_START)
        self.assertEqual(ready.next_step, "DISPATCH")
        dispatched = self._evaluate(transport, self._repo("DISPATCHED"))
        self.assertEqual(dispatched.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(dispatched.next_step, "BEGIN_IMPLEMENTATION")
        observed = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        implementing = self._evaluate(observed, self._repo("IMPLEMENTING"))
        self.assertEqual(implementing.condition, RecoveryCondition.EVIDENCE_AHEAD)
        self.assertEqual(implementing.next_step, "OPEN_PR")

    def test_recovery_surface_holds_no_worker_execution_site(self) -> None:
        """The structural half of the proof: the boundary itself can
        never invoke the worker provider — no provider-start call site,
        no adapter construction, exactly one sealed static verifier
        invocation (the session types are the only other Z.ai
        references). With no directed step and no execution site, no
        Z.ai invocation can be caused by the recovery continuation."""
        self.assertNotIn("start_worker", RECOVERY_SOURCE)
        self.assertNotIn("ZaiAdapter(", RECOVERY_SOURCE)
        self.assertEqual(RECOVERY_SOURCE.count("_verify_issuance"), 1)


class MergeBandTests(RecoveryFixtureMixin):
    """APPROVED through RECONCILING classification (AC5: partial-operation
    safety; the FZ-CTRL008-001 base doctrine at the merge boundary)."""

    def test_approved_unmerged_is_in_progress_at_the_merge_boundary(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        plan = self._evaluate(transport, self._repo("APPROVED"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.MERGE_BOUNDARY)
        self.assertEqual(plan.next_step, "MERGE")
        self.assertIsNone(plan.merge_commit_sha)

    def test_approved_merged_is_external_completion_observed(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("APPROVED"))
        self.assertEqual(plan.condition, RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED)
        self.assertEqual(plan.boundary, GovernedBoundary.MERGE_BOUNDARY)
        self.assertEqual(plan.next_step, "MERGE")
        self.assertEqual(plan.merge_commit_sha, MERGE_SHA)

    def test_approved_no_pr_is_a_contradiction(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(transport, self._repo("APPROVED"), RecoveryContradictionError)

    def test_merged_evidence_must_be_closed(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr(state="open")]})
        self._assert_fail_closed(transport, self._repo("APPROVED"), RecoveryContradictionError)

    def test_merged_evidence_requires_the_canonical_merge_sha(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr(merge_commit_sha=None)]})
        self._assert_fail_closed(transport, self._repo("APPROVED"), RecoveryContradictionError)

    def test_merging_merged_is_recorded_never_retried(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("MERGING"))
        self.assertEqual(plan.condition, RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED)
        self.assertEqual(plan.next_step, "RECORD_MERGE")
        self.assertEqual(plan.merge_commit_sha, MERGE_SHA)

    def test_merging_unmerged_stops_without_retry(self) -> None:
        """The AC5 stop: a post-mutation position with an unobserved
        outcome — governance attention, never an automatic retry."""
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        plan = self._evaluate(transport, self._repo("MERGING"))
        self.assertEqual(plan.condition, RecoveryCondition.PARTIAL_MUTATION_UNRESOLVED)
        self.assertEqual(plan.boundary, GovernedBoundary.ARCHITECT_GOVERNANCE)
        self.assertIsNone(plan.next_step)
        self.assertIsNone(plan.merge_commit_sha)
        self.assertTrue(
            any("never retried" in line for line in plan.basis),
            plan.basis,
        )

    def test_merged_merged_is_in_progress_reconcile(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("MERGED"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.boundary, GovernedBoundary.MERGE_BOUNDARY)
        self.assertEqual(plan.next_step, "RECONCILE")

    def test_merged_unmerged_is_authority_ahead(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        self._assert_fail_closed(transport, self._repo("MERGED"), RecoveryContradictionError)

    def test_reconciling_merged_is_in_progress_record(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("RECONCILING"))
        self.assertEqual(plan.condition, RecoveryCondition.IN_PROGRESS)
        self.assertEqual(plan.next_step, "RECORD_RECONCILIATION")

    def test_reconciling_unmerged_is_authority_ahead(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        self._assert_fail_closed(transport, self._repo("RECONCILING"), RecoveryContradictionError)

    def test_absorbed_base_advancement_at_the_merge_boundary_is_legitimate(self) -> None:
        """FZ-CTRL008-001 at the recovery boundary: the real PR #23 shape.
        The work item dispatched from f55f519; main advanced and the
        advancement was absorbed, so the merged governed PR's frozen
        merge-time base c67bc66 legitimately differs from the dispatch
        provenance — the observed current base is the identity, and the
        dispatch SHA is recorded as distinct provenance."""
        served = merged_pr(base_sha=REAL_CURRENT_BASE)
        transport = FakeTransport({ALL_LIST_PATH: [served]})
        plan = self._evaluate(transport, self._repo("APPROVED"), base_sha=REAL_DISPATCH_BASE)
        self.assertEqual(plan.condition, RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED)
        self.assertEqual(plan.base_sha, REAL_CURRENT_BASE)
        self.assertEqual(plan.dispatch_base, REAL_DISPATCH_BASE)
        assert plan.pull_request is not None
        self.assertEqual(plan.pull_request.base_sha, REAL_CURRENT_BASE)

    def test_base_drift_at_a_pre_merge_position_still_fails_closed(self) -> None:
        """The same SHAs at a PRE-merge position: the frozen pre-merge
        correlation is exact-base, so the drift is a contradiction the
        owning boundaries already refuse — recovery mirrors the refusal."""
        served = open_pr(base_sha=REAL_CURRENT_BASE)
        transport = FakeTransport({ALL_LIST_PATH: [served]})
        self._assert_fail_closed(
            transport,
            self._repo("REVIEW_PENDING"),
            RecoveryContradictionError,
            base_sha=REAL_DISPATCH_BASE,
        )


class CompletedBandTests(RecoveryFixtureMixin):
    """COMPLETE / NEXT_READY: Architect-side governance (the worker never
    advances or claims completion)."""

    def test_complete_awaits_governance(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("COMPLETE"))
        self.assertEqual(plan.condition, RecoveryCondition.AWAITING_GOVERNANCE)
        self.assertEqual(plan.boundary, GovernedBoundary.ARCHITECT_GOVERNANCE)
        self.assertEqual(plan.next_step, "ADVANCE")
        self.assertEqual(plan.merge_commit_sha, MERGE_SHA)

    def test_next_ready_awaits_governance_with_no_worker_step(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("NEXT_READY"))
        self.assertEqual(plan.condition, RecoveryCondition.AWAITING_GOVERNANCE)
        self.assertIsNone(plan.next_step)

    def test_complete_without_merge_evidence_is_authority_ahead(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(transport, self._repo("COMPLETE"), RecoveryContradictionError)

    def test_complete_unmerged_is_authority_ahead(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        self._assert_fail_closed(transport, self._repo("COMPLETE"), RecoveryContradictionError)


class SessionIdentityTests(RecoveryFixtureMixin):
    """AC3/AC5: exact worker-session identity across recovery — the
    FZ-CTRL005-001 ordinary-binding facts, proven locally with zero
    provider calls, plus adapter-issued provenance through the sealed
    CTRL-004 verifier with the exact dynamic type pinned
    (FZ-CTRL007-005)."""

    def _evaluate_with_session(
        self, session: object, root: Path, transport: FakeTransport
    ) -> RecoveryPlan:
        return self._evaluate(transport, root, worker_session=session)

    def test_issued_session_verifies(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        plan = self._evaluate_with_session(_issued_session(), self._repo("READY"), transport)
        self.assertEqual(plan.session_id, SESSION_ID)
        self.assertEqual(plan.session_binding, SessionBinding.VERIFIED_ISSUED)

    def test_plain_request_form_is_carried_as_request_form(self) -> None:
        """The ordinary request form's live provenance re-proof belongs
        to the consuming worker boundary (FZ-CTRL005-002), never here."""
        transport = FakeTransport({ALL_LIST_PATH: []})
        plan = self._evaluate_with_session(_plain_session(), self._repo("READY"), transport)
        self.assertEqual(plan.session_binding, SessionBinding.REQUEST_FORM)

    def test_foreign_repository_session_is_refused(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("READY"),
            RecoveryContradictionError,
            worker_session=_foreign_session(repository="other/repo"),
        )

    def test_foreign_work_item_session_is_refused(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("READY"),
            RecoveryContradictionError,
            worker_session=_foreign_session(work_item="CTRL-004"),
        )

    def test_base_mismatch_session_is_refused(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("READY"),
            RecoveryContradictionError,
            worker_session=_foreign_session(base_sha=DRIFTED_BASE),
        )

    def test_session_reporting_absent_pr_is_stale(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("READY"),
            RecoveryContradictionError,
            worker_session=_foreign_session(pr_number=PR_NUMBER),
        )

    def test_session_reporting_foreign_pr_is_stale(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        self._assert_fail_closed(
            transport,
            self._repo("REVIEW_PENDING"),
            RecoveryContradictionError,
            worker_session=_foreign_session(pr_number=99),
            # REVIEWS_PATH intentionally unserved: the contradiction fires first
        )

    def test_session_reporting_foreign_head_is_stale(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [open_pr()]})
        self._assert_fail_closed(
            transport,
            self._repo("REVIEW_PENDING"),
            RecoveryContradictionError,
            worker_session=_foreign_session(pr_number=PR_NUMBER, head_sha="9" * 40),
        )

    def test_issued_session_subclass_is_refused(self) -> None:
        """FZ-CTRL007-005: subclass dispatch never establishes provenance."""

        class Subclassed(ZaiIssuedWorkerSession):
            pass

        genuine = _issued_session()
        sub = Subclassed(
            session_id=genuine.session_id,
            repository=genuine.repository,
            work_item=genuine.work_item,
            base_sha=genuine.base_sha,
            pr_number=genuine.pr_number,
            head_sha=genuine.head_sha,
            status=genuine.status,
            updated_at=genuine.updated_at,
            _proof=genuine._proof,
        )
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("READY"),
            RecoveryContradictionError,
            worker_session=sub,
        )

    def test_transplanted_proof_is_refused(self) -> None:
        """A genuine proof transplanted onto different ordinary fields
        cannot verify: the proof binds the exact fields it sealed."""
        genuine = _issued_session()
        transplanted = dataclasses.replace(genuine, session_id="zai-sess-transplanted-999")
        transport = FakeTransport({ALL_LIST_PATH: []})
        self._assert_fail_closed(
            transport,
            self._repo("READY"),
            RecoveryContradictionError,
            worker_session=transplanted,
        )

    def test_session_reporting_pr_identity_matches_observation(self) -> None:
        served = open_pr()
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [served],
                REVIEWS_PATH: [architect_review(502, state="CHANGES_REQUESTED")],
            }
        )
        plan = self._evaluate_with_session(
            _issued_session(pr_number=PR_NUMBER, head_sha=HEAD_SHA),
            self._repo("CHANGES_REQUESTED"),
            transport,
        )
        self.assertEqual(plan.session_binding, SessionBinding.VERIFIED_ISSUED)
        self.assertTrue(plan.session_required)


class RestartEquivalenceTests(RecoveryFixtureMixin):
    """AC6: deterministic idempotency across restarts."""

    def test_repeated_evaluation_returns_equal_plans(self) -> None:
        transport = FakeTransport(
            {
                ALL_LIST_PATH: [open_pr()],
                REVIEWS_PATH: [architect_review(501, state="APPROVED")],
            }
        )
        root = self._repo("REVIEW_PENDING")
        boundary = RecoveryBoundary(github=GithubAdapter(transport, REPO))
        first = boundary.evaluate(root, _refs())
        second = boundary.evaluate(root, _refs())
        self.assertEqual(first, second)

    def test_a_fresh_boundary_instance_returns_the_same_plan(self) -> None:
        """Restart equivalence: a new process (fresh boundary, fresh
        transport serving the same evidence) derives the same plan."""
        responses = {
            ALL_LIST_PATH: [merged_pr()],
        }
        root = self._repo("MERGING")
        first = RecoveryBoundary(
            github=GithubAdapter(FakeTransport(dict(responses)), REPO)
        ).evaluate(root, _refs())
        second = RecoveryBoundary(
            github=GithubAdapter(FakeTransport(dict(responses)), REPO)
        ).evaluate(root, _refs())
        self.assertEqual(first, second)
        self.assertEqual(first.condition, RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED)

    def test_authority_files_are_untouched_by_evaluation(self) -> None:
        """Recovery mutates no authority file: the tree is byte-identical
        before and after (the domain object is a projection, never a
        write-back)."""
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        root = self._repo("APPROVED")
        before = {
            path: path.read_bytes() for path in sorted((root / "spec").rglob("*")) if path.is_file()
        }
        self._evaluate(transport, root)
        after = {
            path: path.read_bytes() for path in sorted((root / "spec").rglob("*")) if path.is_file()
        }
        self.assertEqual(before, after)

    def test_plan_is_a_frozen_derived_value(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        plan = self._evaluate(transport, self._repo("APPROVED"))
        with self.assertRaises(dataclasses.FrozenInstanceError):
            plan.condition = RecoveryCondition.IN_PROGRESS  # type: ignore[misc]


class PositionCoverageTests(RecoveryFixtureMixin):
    """AC2/AC8: every non-terminal lifecycle position classifies; the
    observation matrix is least-privilege (each position consults only
    the evidence its classification needs)."""

    def test_every_position_produces_a_typed_plan(self) -> None:
        cases: list[tuple[LifecycleState, dict[str, object]]] = [
            (LifecycleState.READY, {ALL_LIST_PATH: []}),
            (LifecycleState.DISPATCHED, {ALL_LIST_PATH: []}),
            (LifecycleState.IMPLEMENTING, {ALL_LIST_PATH: []}),
            (
                LifecycleState.PR_OPEN,
                {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="pending")},
            ),
            (
                LifecycleState.CI_PENDING,
                {ALL_LIST_PATH: [open_pr()], STATUS_PATH: commit_status(state="success")},
            ),
            (LifecycleState.REVIEW_PENDING, {ALL_LIST_PATH: [open_pr()], REVIEWS_PATH: []}),
            (
                LifecycleState.CHANGES_REQUESTED,
                {
                    ALL_LIST_PATH: [open_pr()],
                    REVIEWS_PATH: [architect_review(502, state="CHANGES_REQUESTED")],
                },
            ),
            (LifecycleState.APPROVED, {ALL_LIST_PATH: [open_pr()]}),
            (LifecycleState.MERGING, {ALL_LIST_PATH: [merged_pr()]}),
            (LifecycleState.MERGED, {ALL_LIST_PATH: [merged_pr()]}),
            (LifecycleState.RECONCILING, {ALL_LIST_PATH: [merged_pr()]}),
            (LifecycleState.COMPLETE, {ALL_LIST_PATH: [merged_pr()]}),
            (LifecycleState.NEXT_READY, {ALL_LIST_PATH: [merged_pr()]}),
        ]
        for state, responses in cases:
            with self.subTest(state=state):
                transport = FakeTransport(responses)
                ref_overrides = (
                    {"worker_session": _plain_session()}
                    if state is LifecycleState.CHANGES_REQUESTED
                    else {}
                )
                plan = self._evaluate(transport, self._repo(state.value), **ref_overrides)
                self.assertEqual(plan.lifecycle, state)
                self.assertEqual(plan.work_item, WORK_ITEM)
                self.assertEqual(plan.repository, REPO)
                self.assertIsInstance(plan.condition, RecoveryCondition)
                self.assertIsInstance(plan.boundary, GovernedBoundary)
                self.assertTrue(plan.basis)

    def test_pre_pr_positions_never_consult_status_or_reviews(self) -> None:
        """Least-privilege observation: READY/DISPATCHED/IMPLEMENTING
        consult the PR listing only (unserved paths would raise)."""
        for status in ("READY", "DISPATCHED", "IMPLEMENTING"):
            with self.subTest(status=status):
                transport = FakeTransport({ALL_LIST_PATH: []})
                self._evaluate(transport, self._repo(status))
                observed = {method for method, _, _ in transport.calls}
                self.assertEqual(observed, {"GET"})
                paths = {path for _, path, _ in transport.calls}
                self.assertEqual(paths, {ALL_LIST_PATH})

    def test_merge_band_never_consult_status_or_reviews(self) -> None:
        transport = FakeTransport({ALL_LIST_PATH: [merged_pr()]})
        self._evaluate(transport, self._repo("APPROVED"))
        paths = {path for _, path, _ in transport.calls}
        self.assertEqual(paths, {ALL_LIST_PATH})


if __name__ == "__main__":
    unittest.main()
