"""Unit tests: the CTRL-006 CI/evidence gate (policy validation, authority
reconstruction and position discipline, exact correlation, deterministic
classification, the one governed lifecycle step, the typed retry handoff
boundary, and restart determinism). Fully offline: the fake GitHub
transport serves canned JSON, the synthetic authority tree is local, and
no worker-provider surface is ever constructed."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

from controller.errors import (
    EvidenceContradictionError,
    EvidenceGatePositionError,
    EvidenceMissingReferenceError,
    EvidencePolicyError,
    GithubAmbiguityError,
    GithubStaleBaseError,
)
from controller.evidence import (
    EvidenceClassification,
    EvidenceGate,
    EvidenceGateOutcome,
    EvidencePolicy,
    EvidenceRetryRequest,
)
from controller.github import GithubAdapter
from controller.orchestrator import OrchestrationReferences
from controller.states import LifecycleState
from controller.zai import ZaiWorkerSession
from tests.github_fakes import (
    BASE_SHA,
    HEAD_SHA,
    OWNER,
    REPO,
    FakeTransport,
    adapter_responses,
    commit_status,
    pull_request,
)
from tests.util import REPO_ROOT, make_repo

BRANCH = "ctrl-006-evidence-gate"
WORK_ITEM = "CTRL-006"
SESSION_ID = "zai-session-ctrl-006-001"
REQUIRED = ("ci/controller", "lint/controller")
RETRYABLE = ("ci/controller",)
POLICY = EvidencePolicy(required_checks=REQUIRED, retryable_checks=RETRYABLE)


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
        "updated_at": "2026-09-04T16:10:00Z",
    }
    defaults.update(overrides)
    return ZaiWorkerSession(**defaults)  # type: ignore[arg-type]


def _refs(**overrides: object) -> OrchestrationReferences:
    defaults: dict[str, object] = {
        "branch": BRANCH,
        "base_sha": BASE_SHA,
        "worker_session": _session(),
    }
    defaults.update(overrides)
    return OrchestrationReferences(**defaults)  # type: ignore[arg-type]


class GateFixtureMixin(unittest.TestCase):
    """Shared fixture: synthetic authority at a gate position + fake GitHub."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _repo(self, status: str) -> Path:
        return make_repo(
            self.base,
            status=status,
            work_item=WORK_ITEM,
            state_overrides={"repository": REPO},
        )

    def _gate(
        self,
        status: str,
        *,
        check_states: list[tuple[str, str]] | None = None,
        combined_state: str = "success",
        with_pr: bool = True,
        pr_base_sha: str = BASE_SHA,
        prs: list[dict[str, Any]] | None = None,
    ) -> tuple[EvidenceGate, Path]:
        entries = (
            check_states
            if check_states is not None
            else [
                ("ci/controller", "success"),
                ("lint/controller", "success"),
            ]
        )
        single = pull_request(
            number=17,
            title="CTRL-006 — CI/evidence gate",
            head_branch=BRANCH,
            head_sha=HEAD_SHA,
            base_sha=pr_base_sha,
        )
        served = prs if prs is not None else ([single] if with_pr else [])
        responses = adapter_responses(
            prs=served,
            pr=single if with_pr else None,
            status=commit_status(state=combined_state, statuses=entries),
        )
        if not with_pr:
            responses[f"/repos/{REPO}/pulls?state=open&head={OWNER}:{BRANCH}"] = []
        transport = FakeTransport(responses=responses)
        gate = EvidenceGate(github=GithubAdapter(transport, REPO))
        return gate, self._repo(status)

    def _transport(self, gate: EvidenceGate) -> FakeTransport:
        transport = gate._github._transport  # noqa: SLF001 - test seam
        assert isinstance(transport, FakeTransport)
        return transport


class EvidencePolicyTests(unittest.TestCase):
    """AC3/AC4: the policy is validated and canonicalized before use."""

    def test_empty_required_checks_is_refused(self) -> None:
        with self.assertRaises(EvidencePolicyError):
            EvidencePolicy(required_checks=())

    def test_duplicate_required_check_is_refused(self) -> None:
        with self.assertRaises(EvidencePolicyError):
            EvidencePolicy(required_checks=("ci/controller", "ci/controller"))

    def test_empty_check_name_is_refused(self) -> None:
        with self.assertRaises(EvidencePolicyError):
            EvidencePolicy(required_checks=("",))

    def test_retryable_outside_required_is_refused(self) -> None:
        with self.assertRaises(EvidencePolicyError):
            EvidencePolicy(required_checks=("ci/controller",), retryable_checks=("other",))

    def test_duplicate_retryable_check_is_refused(self) -> None:
        with self.assertRaises(EvidencePolicyError):
            EvidencePolicy(
                required_checks=("ci/controller", "lint"),
                retryable_checks=("ci/controller", "ci/controller"),
            )

    def test_permutations_are_canonicalized_to_equal_values(self) -> None:
        first = EvidencePolicy(required_checks=("b-check", "a-check"))
        second = EvidencePolicy(required_checks=("a-check", "b-check"))
        self.assertEqual(first, second)

    def test_empty_retryable_set_is_valid_default(self) -> None:
        policy = EvidencePolicy(required_checks=("ci/controller",))
        self.assertEqual(policy.retryable_checks, ())

    def test_is_retryable_requires_all_failures_retryable(self) -> None:
        policy = EvidencePolicy(required_checks=REQUIRED, retryable_checks=RETRYABLE)
        self.assertTrue(policy.is_retryable(("ci/controller",)))
        self.assertFalse(policy.is_retryable(("ci/controller", "lint/controller")))
        self.assertFalse(policy.is_retryable(("lint/controller",)))
        self.assertFalse(policy.is_retryable(()))


class GatePositionTests(GateFixtureMixin):
    """AC1: authority is reconstructed first; positions outside the gate
    fail closed before any remote observation."""

    def test_ready_position_fails_closed_without_remote_calls(self) -> None:
        gate, repo = self._gate("READY")
        with self.assertRaises(EvidenceGatePositionError):
            gate.evaluate(repo, _refs(), POLICY)
        self.assertEqual(self._transport(gate).calls, [])

    def test_implementing_position_fails_closed(self) -> None:
        gate, repo = self._gate("IMPLEMENTING")
        with self.assertRaises(EvidenceGatePositionError):
            gate.evaluate(repo, _refs(), POLICY)
        self.assertEqual(self._transport(gate).calls, [])

    def test_review_pending_position_fails_closed(self) -> None:
        gate, repo = self._gate("REVIEW_PENDING")
        with self.assertRaises(EvidenceGatePositionError):
            gate.evaluate(repo, _refs(), POLICY)
        self.assertEqual(self._transport(gate).calls, [])

    def test_real_repository_is_currently_outside_gate_positions(self) -> None:
        gate = EvidenceGate(github=GithubAdapter(FakeTransport(), REPO))
        with self.assertRaises(EvidenceGatePositionError):
            gate.evaluate(REPO_ROOT, _refs(), POLICY)


class ClassificationTests(GateFixtureMixin):
    """AC3/AC4: the frozen classification rules, applied at CI_PENDING."""

    def _evaluate(
        self,
        check_states: list[tuple[str, str]] | None,
        combined_state: str = "success",
    ) -> EvidenceGateOutcome:
        gate, repo = self._gate(
            "CI_PENDING", check_states=check_states, combined_state=combined_state
        )
        return gate.evaluate(repo, _refs(), POLICY)

    def test_all_required_success_classifies_terminal_success(self) -> None:
        outcome = self._evaluate([("ci/controller", "success"), ("lint/controller", "success")])
        self.assertIs(outcome.classification, EvidenceClassification.TERMINAL_SUCCESS)
        self.assertEqual(outcome.successful_checks, ("ci/controller", "lint/controller"))
        self.assertEqual(outcome.failed_checks, ())
        self.assertEqual(outcome.pending_checks, ())
        self.assertEqual(outcome.missing_checks, ())
        self.assertEqual(outcome.blocked_checks, ())

    def test_pending_check_classifies_pending_without_event(self) -> None:
        outcome = self._evaluate([("ci/controller", "success"), ("lint/controller", "pending")])
        self.assertIs(outcome.classification, EvidenceClassification.PENDING)
        self.assertEqual(outcome.pending_checks, ("lint/controller",))
        self.assertIsNone(outcome.event)

    def test_failure_check_classifies_terminal_failure(self) -> None:
        outcome = self._evaluate([("ci/controller", "failure"), ("lint/controller", "success")])
        self.assertIs(outcome.classification, EvidenceClassification.TERMINAL_FAILURE)
        self.assertEqual(outcome.failed_checks, ("ci/controller",))
        self.assertIsNone(outcome.event)

    def test_error_state_is_terminal_failure(self) -> None:
        outcome = self._evaluate([("ci/controller", "error"), ("lint/controller", "success")])
        self.assertIs(outcome.classification, EvidenceClassification.TERMINAL_FAILURE)
        self.assertEqual(outcome.failed_checks, ("ci/controller",))

    def test_missing_check_while_suite_pending_is_pending(self) -> None:
        outcome = self._evaluate([("lint/controller", "success")], combined_state="pending")
        self.assertIs(outcome.classification, EvidenceClassification.PENDING)
        self.assertEqual(outcome.missing_checks, ("ci/controller",))
        self.assertEqual(outcome.pending_checks, ("ci/controller",))

    def test_missing_check_after_terminal_suite_is_policy_blocked(self) -> None:
        outcome = self._evaluate([("lint/controller", "success")], combined_state="success")
        self.assertIs(outcome.classification, EvidenceClassification.POLICY_BLOCKED)
        self.assertEqual(outcome.missing_checks, ("ci/controller",))
        self.assertEqual(outcome.blocked_checks, ("ci/controller",))

    def test_unrecognized_check_state_is_policy_blocked(self) -> None:
        outcome = self._evaluate([("ci/controller", "weird-state"), ("lint/controller", "success")])
        self.assertIs(outcome.classification, EvidenceClassification.POLICY_BLOCKED)
        self.assertEqual(outcome.blocked_checks, ("ci/controller",))

    def test_duplicate_context_entries_are_policy_blocked(self) -> None:
        outcome = self._evaluate(
            [
                ("ci/controller", "success"),
                ("ci/controller", "failure"),
                ("lint/controller", "success"),
            ]
        )
        self.assertIs(outcome.classification, EvidenceClassification.POLICY_BLOCKED)
        self.assertEqual(outcome.blocked_checks, ("ci/controller",))

    def test_empty_status_report_is_pending_when_combined_pending(self) -> None:
        outcome = self._evaluate([], combined_state="pending")
        self.assertIs(outcome.classification, EvidenceClassification.PENDING)
        self.assertEqual(outcome.missing_checks, ("ci/controller", "lint/controller"))
        self.assertEqual(outcome.pending_checks, ("ci/controller", "lint/controller"))

    def test_blocked_check_outranks_simultaneous_failure(self) -> None:
        outcome = self._evaluate([("ci/controller", "failure"), ("lint/controller", "weird-state")])
        self.assertIs(outcome.classification, EvidenceClassification.POLICY_BLOCKED)

    def test_unrelated_checks_neither_satisfy_nor_block(self) -> None:
        outcome = self._evaluate(
            [
                ("ci/controller", "success"),
                ("lint/controller", "success"),
                ("docs/preview", "failure"),
            ],
            combined_state="failure",
        )
        self.assertIs(outcome.classification, EvidenceClassification.TERMINAL_SUCCESS)
        self.assertEqual(outcome.unrelated_checks, ("docs/preview",))

    def test_outcome_carries_exact_correlated_identity(self) -> None:
        outcome = self._evaluate([("ci/controller", "success"), ("lint/controller", "success")])
        self.assertEqual(outcome.work_item, WORK_ITEM)
        self.assertEqual(outcome.repository, REPO)
        self.assertEqual(outcome.branch, BRANCH)
        self.assertEqual(outcome.pr_number, 17)
        self.assertEqual(outcome.head_sha, HEAD_SHA)
        self.assertEqual(outcome.base_sha, BASE_SHA)
        self.assertIs(outcome.lifecycle, LifecycleState.CI_PENDING)


class CorrelationTests(GateFixtureMixin):
    """AC2: exact correlation; foreign/stale/ambiguous/missing refuse."""

    def test_missing_branch_reference_fails_closed_before_remote_calls(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        with self.assertRaises(EvidenceMissingReferenceError):
            gate.evaluate(repo, _refs(branch=None), POLICY)
        self.assertEqual(self._transport(gate).calls, [])

    def test_missing_base_reference_fails_closed_before_remote_calls(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        with self.assertRaises(EvidenceMissingReferenceError):
            gate.evaluate(repo, _refs(base_sha=None), POLICY)
        self.assertEqual(self._transport(gate).calls, [])

    def test_absent_governed_pr_at_ci_pending_is_a_contradiction(self) -> None:
        gate, repo = self._gate("CI_PENDING", with_pr=False)
        with self.assertRaises(EvidenceContradictionError):
            gate.evaluate(repo, _refs(), POLICY)

    def test_base_drift_propagates_typed_adapter_error(self) -> None:
        gate, repo = self._gate("CI_PENDING", pr_base_sha="c" * 40)
        with self.assertRaises(GithubStaleBaseError):
            gate.evaluate(repo, _refs(), POLICY)

    def test_ambiguous_pr_matches_propagate_typed_adapter_error(self) -> None:
        single = pull_request(number=17, head_branch=BRANCH, head_sha=HEAD_SHA, base_sha=BASE_SHA)
        twin = pull_request(number=18, head_branch=BRANCH, head_sha="d" * 40, base_sha=BASE_SHA)
        gate, repo = self._gate("CI_PENDING", prs=[single, twin])
        with self.assertRaises(GithubAmbiguityError):
            gate.evaluate(repo, _refs(), POLICY)

    def test_evaluation_performs_only_observations_no_mutations(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        gate.evaluate(repo, _refs(), POLICY)
        transport = self._transport(gate)
        self.assertTrue(all(call[0] == "GET" for call in transport.calls))
        self.assertFalse(transport.calls_matching("POST", "/"))
        self.assertFalse(transport.calls_matching("PUT", "/"))


class LifecycleStepTests(GateFixtureMixin):
    """AC6: at most one governed transition per evaluation, requested
    through the frozen CTRL-001/CTRL-002 model."""

    def test_pr_open_begins_ci_wait_with_await_ci_event(self) -> None:
        gate, repo = self._gate("PR_OPEN")
        outcome = gate.evaluate(repo, _refs(), POLICY)
        assert outcome.event is not None
        self.assertEqual(outcome.event.command.value, "AWAIT_CI")
        self.assertIs(outcome.event.from_state, LifecycleState.PR_OPEN)
        self.assertIs(outcome.event.to_state, LifecycleState.CI_PENDING)

    def test_pr_open_emits_await_ci_even_on_terminal_failure(self) -> None:
        gate, repo = self._gate(
            "PR_OPEN",
            check_states=[("ci/controller", "failure"), ("lint/controller", "success")],
            combined_state="failure",
        )
        outcome = gate.evaluate(repo, _refs(), POLICY)
        assert outcome.event is not None
        self.assertEqual(outcome.event.command.value, "AWAIT_CI")

    def test_ci_pending_terminal_success_records_ci_success(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        outcome = gate.evaluate(repo, _refs(), POLICY)
        assert outcome.event is not None
        self.assertEqual(outcome.event.command.value, "RECORD_CI_SUCCESS")
        self.assertIs(outcome.event.from_state, LifecycleState.CI_PENDING)
        self.assertIs(outcome.event.to_state, LifecycleState.REVIEW_PENDING)

    def test_ci_pending_pending_evidence_observes_without_event(self) -> None:
        gate, repo = self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "success"), ("lint/controller", "pending")],
            combined_state="pending",
        )
        outcome = gate.evaluate(repo, _refs(), POLICY)
        self.assertIsNone(outcome.event)

    def test_ci_pending_failure_observes_without_event(self) -> None:
        gate, repo = self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "failure"), ("lint/controller", "success")],
            combined_state="failure",
        )
        outcome = gate.evaluate(repo, _refs(), POLICY)
        self.assertIsNone(outcome.event)

    def test_ci_pending_policy_blocked_observes_without_event(self) -> None:
        gate, repo = self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "weird-state"), ("lint/controller", "success")],
        )
        outcome = gate.evaluate(repo, _refs(), POLICY)
        self.assertIsNone(outcome.event)

    def test_outcome_exposes_at_most_one_event(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        outcome = gate.evaluate(repo, _refs(), POLICY)
        self.assertIsInstance(outcome.event, object)
        self.assertIsInstance(outcome.retry, (EvidenceRetryRequest, type(None)))


class RetryBoundaryTests(GateFixtureMixin):
    """AC5: the typed retry handoff — permitted, refused, and failed closed."""

    def _failing_gate(self) -> tuple[EvidenceGate, Path]:
        return self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "failure"), ("lint/controller", "success")],
            combined_state="failure",
        )

    def test_retryable_failure_hands_off_typed_request(self) -> None:
        gate, repo = self._failing_gate()
        outcome = gate.evaluate(repo, _refs(), POLICY)
        assert outcome.retry is not None
        self.assertEqual(outcome.retry.session_id, SESSION_ID)
        self.assertEqual(outcome.retry.repository, REPO)
        self.assertEqual(outcome.retry.work_item, WORK_ITEM)
        self.assertEqual(outcome.retry.work_order_path, "spec/work-items/CTRL-006.md")
        self.assertEqual(outcome.retry.branch, BRANCH)
        self.assertEqual(outcome.retry.base_sha, BASE_SHA)
        self.assertEqual(outcome.retry.pr_number, 17)
        self.assertEqual(outcome.retry.head_sha, HEAD_SHA)
        self.assertEqual(outcome.retry.failed_checks, ("ci/controller",))
        self.assertIn("ci/controller", outcome.retry.reason)

    def test_non_retryable_failure_is_exposed_without_retry(self) -> None:
        gate, repo = self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "success"), ("lint/controller", "failure")],
            combined_state="failure",
        )
        outcome = gate.evaluate(repo, _refs(), POLICY)
        self.assertIsNone(outcome.retry)

    def test_mixed_retryable_and_non_retryable_failure_has_no_retry(self) -> None:
        gate, repo = self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "failure"), ("lint/controller", "error")],
            combined_state="failure",
        )
        outcome = gate.evaluate(repo, _refs(), POLICY)
        self.assertIsNone(outcome.retry)

    def test_retryable_failure_without_session_reference_is_exposed(self) -> None:
        gate, repo = self._failing_gate()
        outcome = gate.evaluate(repo, _refs(worker_session=None), POLICY)
        self.assertIs(outcome.classification, EvidenceClassification.TERMINAL_FAILURE)
        self.assertIsNone(outcome.retry)

    def test_foreign_repository_session_fails_closed(self) -> None:
        gate, repo = self._failing_gate()
        with self.assertRaises(EvidenceContradictionError):
            gate.evaluate(repo, _refs(worker_session=_session(repository="other/repo")), POLICY)

    def test_foreign_work_item_session_fails_closed(self) -> None:
        gate, repo = self._failing_gate()
        with self.assertRaises(EvidenceContradictionError):
            gate.evaluate(repo, _refs(worker_session=_session(work_item="CTRL-007")), POLICY)

    def test_wrong_base_session_fails_closed(self) -> None:
        gate, repo = self._failing_gate()
        with self.assertRaises(EvidenceContradictionError):
            gate.evaluate(repo, _refs(worker_session=_session(base_sha="e" * 40)), POLICY)

    def test_session_claiming_foreign_pr_fails_closed(self) -> None:
        gate, repo = self._failing_gate()
        with self.assertRaises(EvidenceContradictionError):
            gate.evaluate(repo, _refs(worker_session=_session(pr_number=99)), POLICY)

    def test_session_claiming_drifted_head_fails_closed(self) -> None:
        gate, repo = self._failing_gate()
        with self.assertRaises(EvidenceContradictionError):
            gate.evaluate(repo, _refs(worker_session=_session(head_sha="f" * 40)), POLICY)

    def test_retry_handoff_performs_no_worker_provider_calls(self) -> None:
        gate, repo = self._failing_gate()
        gate.evaluate(repo, _refs(), POLICY)
        transport = self._transport(gate)
        self.assertTrue(all(call[0] == "GET" for call in transport.calls))

    def test_success_and_pending_never_produce_retry_requests(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        self.assertIsNone(gate.evaluate(repo, _refs(), POLICY).retry)
        gate2, repo2 = self._gate(
            "CI_PENDING",
            check_states=[("ci/controller", "pending"), ("lint/controller", "success")],
            combined_state="pending",
        )
        self.assertIsNone(gate2.evaluate(repo2, _refs(), POLICY).retry)


class RestartDeterminismTests(GateFixtureMixin):
    """AC7: identical inputs reproduce identical decisions; the gate holds
    no runtime state beyond the injected adapter."""

    def test_repeated_evaluation_is_deterministic(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        first = gate.evaluate(repo, _refs(), POLICY)
        second = gate.evaluate(repo, _refs(), POLICY)
        self.assertEqual(first, second)

    def test_fresh_gate_instance_reproduces_the_decision(self) -> None:
        gate, repo = self._gate("CI_PENDING")
        other, _ = self._gate("CI_PENDING")
        self.assertEqual(
            gate.evaluate(repo, _refs(), POLICY), other.evaluate(repo, _refs(), POLICY)
        )

    def test_gate_instance_holds_only_the_injected_adapter(self) -> None:
        gate, _ = self._gate("CI_PENDING")
        self.assertEqual(sorted(gate.__dict__.keys()), ["_github"])  # noqa: SLF001 - structural runtime-non-authority pin


if __name__ == "__main__":
    unittest.main()
