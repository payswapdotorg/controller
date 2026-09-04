"""Unit tests: the CTRL-005 deterministic orchestration boundary.

All behavior is exercised offline: synthetic repository fixtures
(``tests.util.make_repo``) + the deterministic GitHub and Z.ai fakes.
Covers (AC8): ready dispatch, exact PR/worker correlation, repeated
observation, restart reconstruction, stale/foreign correlation, authority
contradiction, adapter failures, and refusal of unsupported downstream
actions.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from controller.errors import (
    ContradictionError,
    GithubAmbiguityError,
    GithubStaleBaseError,
    IneligibleDispatchError,
    OrchestrationContradictionError,
    OrchestrationMissingReferenceError,
    ZaiContextMismatchError,
)
from controller.github import GithubAdapter
from controller.orchestrator import (
    ChangesRequested as ChangesRequestedOutcome,
)
from controller.orchestrator import (
    DownstreamHandoff,
    Orchestrator,
    WorkerDispatched,
)
from controller.orchestrator import (
    ImplementationStarted as ImplementationStartedOutcome,
)
from controller.orchestrator import (
    OrchestrationReferences as Refs,
)
from controller.orchestrator import (
    WorkerResumed as WorkerResumedOutcome,
)
from controller.states import LifecycleState
from controller.zai import ZaiAdapter, ZaiWorkerSession
from tests.github_fakes import (
    BASE_SHA,
    HEAD_SHA,
    OWNER,
    REPO,
    FakeTransport,
    adapter_responses,
    commit_status,
    pull_request,
    ref,
    review,
)
from tests.util import make_repo
from tests.zai_fakes import SESSION_ID, FakeZaiTransport, resume_path, worker_session

ARCHITECT = "pectoraux"
BRANCH = "ctrl-005-orchestrator"
WORK_ITEM = "CTRL-005"


def _session(**overrides: object) -> ZaiWorkerSession:
    """Typed worker-session evidence as the accepted adapter would issue
    it at dispatch (binding fields match the governed fixture context)."""
    defaults: dict[str, object] = {
        "session_id": SESSION_ID,
        "repository": REPO,
        "work_item": WORK_ITEM,
        "base_sha": BASE_SHA,
        "pr_number": None,
        "head_sha": None,
        "status": "active",
        "updated_at": "2026-09-04T15:00:00Z",
    }
    defaults.update(overrides)
    return ZaiWorkerSession(**defaults)  # type: ignore[arg-type]


def _refs(**overrides: object) -> Refs:
    defaults: dict[str, object] = {
        "branch": BRANCH,
        "base_sha": BASE_SHA,
        "worker_session": _session(),
        "architect_reviewer": ARCHITECT,
    }
    defaults.update(overrides)
    return Refs(**defaults)  # type: ignore[arg-type]


def _github(**overrides: object) -> FakeTransport:
    """A fake GitHub with the governed PR/CI/review evidence wired up."""
    defaults: dict[str, object] = {
        "prs": [pull_request(head_branch=BRANCH)],
        "pr": pull_request(head_branch=BRANCH),
        "reviews": [review(11, state="APPROVED")],
        "status": commit_status("success", []),
        "base_ref": ref("main", BASE_SHA),
    }
    defaults.update(overrides)
    return FakeTransport(adapter_responses(**defaults))  # type: ignore[arg-type]


def _no_pr_github() -> FakeTransport:
    """A fake GitHub where no governed pull request exists yet: the PR
    list endpoint serves an empty list (a valid pre-PR observation)."""
    return FakeTransport(
        {
            f"/repos/{REPO}/pulls?state=open&head={OWNER}:{BRANCH}": [],
            f"/repos/{REPO}/branches/main": ref("main", BASE_SHA),
        }
    )


def _zai() -> FakeZaiTransport:
    return FakeZaiTransport(
        {
            "/worker/sessions": worker_session(work_item=WORK_ITEM),
            resume_path(): worker_session(
                work_item=WORK_ITEM, pr_number=7, head_sha=HEAD_SHA, status="resumed"
            ),
        }
    )


class OrchestrationFixture(unittest.TestCase):
    """Shared fixture helpers."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _repo(self, status: str = "READY") -> Path:
        return make_repo(
            self.base,
            status=status,
            work_item=WORK_ITEM,
            # The synthetic authority must declare the same repository the
            # GitHub/Z.ai adapters are bound to (the Z.ai adapter cross-checks
            # the context repository against its binding, CTRL-004 contract).
            state_overrides={"repository": REPO},
        )

    def _orchestrator(
        self, github: FakeTransport | None = None, zai: FakeZaiTransport | None = None
    ) -> tuple[Orchestrator, FakeTransport, FakeZaiTransport]:
        github = github if github is not None else _github()
        zai = zai if zai is not None else _zai()
        return (
            Orchestrator(github=GithubAdapter(github, REPO), zai=ZaiAdapter(zai, REPO)),
            github,
            zai,
        )


class DispatchCycleTests(OrchestrationFixture):
    """AC1/AC2: READY + eligible starts the worker with the exact context."""

    def test_ready_dispatches_worker_with_exact_context(self) -> None:
        repo = self._repo("READY")
        orchestrator, github, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo)
        assert isinstance(outcome, WorkerDispatched)
        self.assertEqual(outcome.work_item, WORK_ITEM)
        self.assertIs(outcome.lifecycle, LifecycleState.READY)
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.READY, LifecycleState.DISPATCHED),
        )
        self.assertEqual(outcome.session.work_item, WORK_ITEM)
        # exactly one worker start, and the context binds repository authority:
        self.assertEqual(len(zai.calls_matching("/worker/sessions")), 1)
        payload = zai.calls[0][1]
        self.assertEqual(payload["work_item"], WORK_ITEM)
        self.assertEqual(payload["repository"], REPO)
        self.assertEqual(payload["base_sha"], BASE_SHA)
        work_order = payload["work_order"]
        assert isinstance(work_order, dict)
        self.assertIn("Status: `READY`", str(work_order["content"]))
        # no GitHub mutation happened:
        self.assertEqual(github.calls_matching("POST", "/"), [])
        self.assertEqual(github.calls_matching("PUT", "/"), [])

    def test_ineligible_authority_refuses_before_any_worker_start(self) -> None:
        repo = make_repo(
            self.base,
            status="READY",
            work_item=WORK_ITEM,
            state_overrides={"completed": [WORK_ITEM], "repository": REPO},
        )
        orchestrator, _, zai = self._orchestrator()
        with self.assertRaises(IneligibleDispatchError):
            orchestrator.run_cycle(repo)
        self.assertEqual(zai.calls, [])

    def test_contradictory_authority_fails_closed_before_remote_io(self) -> None:
        repo = make_repo(
            self.base,
            status="READY",
            work_item=WORK_ITEM,
            work_item_status="DISPATCHED",
            state_overrides={"repository": REPO},
        )
        orchestrator, _, zai = self._orchestrator()
        with self.assertRaises(ContradictionError):
            orchestrator.run_cycle(repo)
        self.assertEqual(zai.calls, [])


class ImplementationCycleTests(OrchestrationFixture):
    """AC4: DISPATCHED/IMPLEMENTING steps and PR correlation."""

    def test_dispatched_without_session_reference_only_observes(self) -> None:
        repo = self._repo("DISPATCHED")
        orchestrator, _, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs(worker_session=None))
        self.assertIsNone(outcome.event)
        self.assertEqual(zai.calls, [])

    def test_dispatched_with_session_reference_begins_implementation(self) -> None:
        repo = self._repo("DISPATCHED")
        orchestrator, _, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs())
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.DISPATCHED, LifecycleState.IMPLEMENTING),
        )
        self.assertEqual(zai.calls, [])

    def test_implementing_without_pr_observes(self) -> None:
        repo = self._repo("IMPLEMENTING")
        github = _no_pr_github()
        orchestrator, _, zai = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)
        self.assertEqual(zai.calls, [])

    def test_implementing_with_exact_pr_opens_it(self) -> None:
        repo = self._repo("IMPLEMENTING")
        orchestrator, _, _ = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs())
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.IMPLEMENTING, LifecycleState.PR_OPEN),
        )

    def test_implementing_without_correlation_references_fails_closed(self) -> None:
        repo = self._repo("IMPLEMENTING")
        orchestrator, _, zai = self._orchestrator()
        with self.assertRaises(OrchestrationMissingReferenceError):
            orchestrator.run_cycle(repo, _refs(branch=None))
        with self.assertRaises(OrchestrationMissingReferenceError):
            orchestrator.run_cycle(repo, _refs(base_sha=None))
        self.assertEqual(zai.calls, [])

    def test_stale_base_correlation_refuses(self) -> None:
        repo = self._repo("IMPLEMENTING")
        drifted = pull_request(head_branch=BRANCH, base_sha="c" * 40)
        github = _github(pr=drifted, prs=[drifted])
        orchestrator, _, zai = self._orchestrator(github=github)
        with self.assertRaises(GithubStaleBaseError):
            orchestrator.run_cycle(repo, _refs())
        self.assertEqual(zai.calls, [])

    def test_ambiguous_correlation_refuses(self) -> None:
        repo = self._repo("IMPLEMENTING")
        first = pull_request(head_branch=BRANCH)
        second = pull_request(8, head_branch=BRANCH)
        github = _github(prs=[first, second], pr=first)
        orchestrator, _, zai = self._orchestrator(github=github)
        with self.assertRaises(GithubAmbiguityError):
            orchestrator.run_cycle(repo, _refs())
        self.assertEqual(zai.calls, [])


class EvidenceCycleTests(OrchestrationFixture):
    """AC4/AC7: CI observation and the downstream policy boundary."""

    def test_pr_open_begins_ci_wait_with_status_evidence(self) -> None:
        repo = self._repo("PR_OPEN")
        orchestrator, _, _ = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs())
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.PR_OPEN, LifecycleState.CI_PENDING),
        )

    def test_pr_open_without_observed_pr_is_a_contradiction(self) -> None:
        repo = self._repo("PR_OPEN")
        github = _no_pr_github()
        orchestrator, _, zai = self._orchestrator(github=github)
        with self.assertRaises(OrchestrationContradictionError):
            orchestrator.run_cycle(repo, _refs())
        self.assertEqual(zai.calls, [])

    def test_ci_pending_with_success_records_evidence(self) -> None:
        repo = self._repo("CI_PENDING")
        orchestrator, _, _ = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs())
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.CI_PENDING, LifecycleState.REVIEW_PENDING),
        )

    def test_ci_pending_with_pending_status_only_observes(self) -> None:
        repo = self._repo("CI_PENDING")
        github = _github(status=commit_status("pending", []))
        orchestrator, _, _ = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)

    def test_ci_pending_with_failure_exposes_evidence_without_policy(self) -> None:
        """AC7: CI failure evidence is exposed for the CTRL-006 gate; the
        orchestrator implements no retry or failure policy."""
        repo = self._repo("CI_PENDING")
        github = _github(status=commit_status("failure", [("ci/tests", "failure")]))
        orchestrator, _, _ = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)


class ReviewCycleTests(OrchestrationFixture):
    """AC4/AC7: Architect review evidence and the resume path."""

    def test_review_pending_without_reviews_observes(self) -> None:
        repo = self._repo("REVIEW_PENDING")
        github = _github(reviews=[])
        orchestrator, _, zai = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)
        self.assertEqual(zai.calls, [])

    def test_review_pending_requires_architect_reference(self) -> None:
        repo = self._repo("REVIEW_PENDING")
        orchestrator, _, zai = self._orchestrator()
        with self.assertRaises(OrchestrationMissingReferenceError):
            orchestrator.run_cycle(repo, _refs(architect_reviewer=None))
        self.assertEqual(zai.calls, [])

    def test_changes_requested_review_maps_to_request_changes(self) -> None:
        repo = self._repo("REVIEW_PENDING")
        github = _github(reviews=[review(11, state="CHANGES_REQUESTED", commit_id=HEAD_SHA)])
        orchestrator, _, zai = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        assert isinstance(outcome, ChangesRequestedOutcome)
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.REVIEW_PENDING, LifecycleState.CHANGES_REQUESTED),
        )
        self.assertTrue(outcome.findings)
        self.assertEqual(zai.calls, [])

    def test_approval_bound_to_exact_head_maps_to_approve(self) -> None:
        repo = self._repo("REVIEW_PENDING")
        orchestrator, _, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs())
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.REVIEW_PENDING, LifecycleState.APPROVED),
        )
        self.assertEqual(zai.calls, [])

    def test_stale_approval_only_observes(self) -> None:
        repo = self._repo("REVIEW_PENDING")
        github = _github(reviews=[review(11, state="APPROVED", commit_id="old" * 10)])
        orchestrator, _, zai = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)
        self.assertEqual(zai.calls, [])

    def test_non_architect_reviews_do_not_decide(self) -> None:
        repo = self._repo("REVIEW_PENDING")
        github = _github(reviews=[review(11, author="someone-else", state="APPROVED")])
        orchestrator, _, zai = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)
        self.assertEqual(zai.calls, [])

    def test_changes_requested_resumes_same_worker_with_packet(self) -> None:
        """AC3: the resume targets the same governed worker/PR context and
        carries the observed review packet verbatim."""
        repo = self._repo("CHANGES_REQUESTED")
        github = _github(reviews=[review(11, state="CHANGES_REQUESTED", commit_id=HEAD_SHA)])
        orchestrator, _, zai = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        assert isinstance(outcome, WorkerResumedOutcome)
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.CHANGES_REQUESTED, LifecycleState.IMPLEMENTING),
        )
        self.assertEqual(len(zai.calls_matching(resume_path())), 1)
        path, payload = zai.calls[0]
        self.assertEqual(path, resume_path())
        self.assertEqual(payload["session_id"], SESSION_ID)
        self.assertEqual(payload["work_item"], WORK_ITEM)
        self.assertEqual(payload["base_sha"], BASE_SHA)
        self.assertEqual(payload["pr"], {"number": 7, "head_sha": HEAD_SHA})
        findings = payload["review_findings"]
        assert isinstance(findings, list)
        self.assertEqual(len(findings), 1)
        self.assertIn("CHANGES_REQUESTED", str(findings[0]))

    def test_changes_requested_without_session_reference_fails_closed(self) -> None:
        repo = self._repo("CHANGES_REQUESTED")
        github = _github(reviews=[review(11, state="CHANGES_REQUESTED", commit_id=HEAD_SHA)])
        orchestrator, _, zai = self._orchestrator(github=github)
        with self.assertRaises(OrchestrationMissingReferenceError):
            orchestrator.run_cycle(repo, _refs(worker_session=None))
        self.assertEqual(zai.calls, [])

    def test_changes_requested_with_cleared_evidence_is_a_contradiction(self) -> None:
        """AC5: authority records CHANGES_REQUESTED but the latest architect
        review is now an APPROVE — repository authority outranks the remote
        projection and the run stops."""
        repo = self._repo("CHANGES_REQUESTED")
        github = _github(reviews=[review(11, state="APPROVED", commit_id=HEAD_SHA)])
        orchestrator, _, zai = self._orchestrator(github=github)
        with self.assertRaises(OrchestrationContradictionError):
            orchestrator.run_cycle(repo, _refs())
        self.assertEqual(zai.calls, [])

    def test_worker_fork_refusal_propagates(self) -> None:
        """AC2: the Z.ai adapter refuses a session for a foreign work
        context; the orchestrator does not swallow the typed failure."""
        repo = self._repo("CHANGES_REQUESTED")
        github = _github(reviews=[review(11, state="CHANGES_REQUESTED", commit_id=HEAD_SHA)])
        zai = FakeZaiTransport(
            {resume_path(): worker_session(work_item="CTRL-006", pr_number=7, head_sha=HEAD_SHA)}
        )
        orchestrator, _, _ = self._orchestrator(github=github, zai=zai)
        with self.assertRaises(ZaiContextMismatchError):
            orchestrator.run_cycle(repo, _refs())


class SessionEvidenceProofTests(OrchestrationFixture):
    """FZ-CTRL005-001: the DISPATCHED->IMPLEMENTING transition (and the
    resume path) prove the carried typed worker-session binding — session
    id, repository, active Work Item, dispatch base SHA — against
    reconstructed authority BEFORE any lifecycle event or remote mutation.
    A bare session-id string is not an accepted carried form."""

    def _assert_no_lifecycle_effect(self, github: FakeTransport, zai: FakeZaiTransport) -> None:
        """No lifecycle event can have been emitted (the run failed closed)
        and no remote mutation occurred."""
        self.assertEqual(zai.calls, [])
        self.assertEqual(github.calls_matching("POST", "/"), [])
        self.assertEqual(github.calls_matching("PUT", "/"), [])

    def test_references_have_no_bare_session_id_field(self) -> None:
        """The raw-string carried reference is gone from the API: only the
        typed adapter-issued session evidence exists."""
        fields = set(Refs.__dataclass_fields__)
        self.assertIn("worker_session", fields)
        self.assertNotIn("worker_session_id", fields)

    def test_dispatched_foreign_work_item_session_refuses(self) -> None:
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        forged = _session(work_item="CTRL-006")
        with self.assertRaises(OrchestrationContradictionError) as ctx:
            orchestrator.run_cycle(repo, _refs(worker_session=forged))
        self.assertIn("CTRL-006", str(ctx.exception))
        self._assert_no_lifecycle_effect(github, zai)

    def test_dispatched_foreign_repository_session_refuses(self) -> None:
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        swapped = _session(repository="someone-else/other-repo")
        with self.assertRaises(OrchestrationContradictionError) as ctx:
            orchestrator.run_cycle(repo, _refs(worker_session=swapped))
        self.assertIn("someone-else/other-repo", str(ctx.exception))
        self._assert_no_lifecycle_effect(github, zai)

    def test_dispatched_wrong_base_sha_session_refuses(self) -> None:
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        drifted = _session(base_sha="c" * 40)
        with self.assertRaises(OrchestrationContradictionError) as ctx:
            orchestrator.run_cycle(repo, _refs(worker_session=drifted))
        self.assertIn("dispatch base", str(ctx.exception))
        self._assert_no_lifecycle_effect(github, zai)

    def test_dispatched_session_only_reference_never_advances(self) -> None:
        """The structurally weakest carried form — no typed session
        evidence at all — can only observe; the lifecycle never advances
        on a session id alone."""
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs(worker_session=None))
        self.assertIsNone(outcome.event)
        self._assert_no_lifecycle_effect(github, zai)

    def test_dispatched_forged_session_with_pr_identity_refuses(self) -> None:
        """A structurally valid forged session that already claims PR
        identity contradicts the DISPATCHED position (authority records no
        governed pull request; none is invented)."""
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        forged = _session(pr_number=7, head_sha=HEAD_SHA)
        with self.assertRaises(OrchestrationContradictionError) as ctx:
            orchestrator.run_cycle(repo, _refs(worker_session=forged))
        self.assertIn("still DISPATCHED", str(ctx.exception))
        self._assert_no_lifecycle_effect(github, zai)

    def test_dispatched_missing_base_reference_fails_closed(self) -> None:
        """Session evidence cannot be proven without the dispatch-base
        reference; nothing is guessed."""
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        with self.assertRaises(OrchestrationMissingReferenceError):
            orchestrator.run_cycle(repo, _refs(base_sha=None))
        self._assert_no_lifecycle_effect(github, zai)

    def test_resume_foreign_session_binding_fails_before_event_or_mutation(self) -> None:
        """The same proof gates the CHANGES_REQUESTED resume path: a
        foreign bound session refuses before the RESUME_IMPLEMENTATION
        event and before any provider call."""
        repo = self._repo("CHANGES_REQUESTED")
        github = _github(reviews=[review(11, state="CHANGES_REQUESTED", commit_id=HEAD_SHA)])
        orchestrator, github, zai = self._orchestrator(github=github)
        forged = _session(work_item="CTRL-006")
        with self.assertRaises(OrchestrationContradictionError):
            orchestrator.run_cycle(repo, _refs(worker_session=forged))
        self._assert_no_lifecycle_effect(github, zai)

    def test_dispatched_valid_session_evidence_advances_exactly_once(self) -> None:
        """The honest path still works: proven evidence emits exactly one
        BEGIN_IMPLEMENTATION event bound to the proven session id."""
        repo = self._repo("DISPATCHED")
        orchestrator, github, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo, _refs())
        assert isinstance(outcome, ImplementationStartedOutcome)
        assert outcome.event is not None
        self.assertEqual(
            (outcome.event.from_state, outcome.event.to_state),
            (LifecycleState.DISPATCHED, LifecycleState.IMPLEMENTING),
        )
        self.assertEqual(outcome.session_id, SESSION_ID)
        self._assert_no_lifecycle_effect(github, zai)


class DownstreamBoundaryTests(OrchestrationFixture):
    """AC7/AC8: downstream stages are exposed, never executed."""

    def test_approved_hands_off_without_merge(self) -> None:
        repo = self._repo("APPROVED")
        orchestrator, github, zai = self._orchestrator()
        outcome = orchestrator.run_cycle(repo)
        assert isinstance(outcome, DownstreamHandoff)
        self.assertIsNone(outcome.event)
        self.assertIn("CTRL-008", outcome.reason)
        self.assertEqual(zai.calls, [])
        self.assertEqual(github.calls_matching("PUT", "/"), [])

    def test_merged_reconciling_and_complete_hand_off(self) -> None:
        for status in ("MERGING", "MERGED", "RECONCILING", "COMPLETE", "NEXT_READY"):
            with self.subTest(status=status):
                repo = self._repo(status)
                orchestrator, github, zai = self._orchestrator()
                outcome = orchestrator.run_cycle(repo)
                self.assertIsNone(outcome.event)
                self.assertEqual(zai.calls, [])
                self.assertEqual(github.calls_matching("PUT", "/"), [])


class DeterminismTests(OrchestrationFixture):
    """AC6: restart reconstruction and idempotent observation."""

    def test_repeated_observation_is_idempotent(self) -> None:
        repo = self._repo("CI_PENDING")
        github = _github(status=commit_status("pending", []))
        first, _, _ = self._orchestrator(github=github)
        second, _, _ = self._orchestrator(github=github)
        self.assertEqual(
            first.run_cycle(repo, _refs()),
            second.run_cycle(repo, _refs()),
        )

    def test_restart_reconstruction_yields_the_same_decision(self) -> None:
        """A fresh orchestrator (new process equivalent) with the same
        repository, evidence, and references decides identically."""
        repo = self._repo("READY")
        github, zai = _github(), _zai()
        first = Orchestrator(github=GithubAdapter(github, REPO), zai=ZaiAdapter(zai, REPO))
        outcome_one = first.run_cycle(repo)
        github_two, zai_two = _github(), _zai()
        second = Orchestrator(github=GithubAdapter(github_two, REPO), zai=ZaiAdapter(zai_two, REPO))
        outcome_two = second.run_cycle(repo)
        self.assertEqual(outcome_one, outcome_two)

    def test_outcomes_carry_the_governed_event_only_when_authorized(self) -> None:
        repo = self._repo("IMPLEMENTING")
        github = _no_pr_github()
        orchestrator, _, _ = self._orchestrator(github=github)
        outcome = orchestrator.run_cycle(repo, _refs())
        self.assertIsNone(outcome.event)


if __name__ == "__main__":
    unittest.main()
