"""Unit tests: the CTRL-007 Architect review loop (packet grammar and
value forms, position discipline, decision observation and correlation,
REQUEST_CHANGES packet construction, iteration control, the
CHANGES_REQUESTED re-observation, the same-worker/same-PR handoff with
adapter-issued session evidence, and restart determinism). Fully
offline: the fake GitHub transport serves canned JSON, the synthetic
authority tree is local, and the loop is exercised with zero
worker-provider surface of any kind."""

from __future__ import annotations

import dataclasses
import tempfile
import unittest
from pathlib import Path
from typing import Any

from controller.errors import (
    ReviewContradictionError,
    ReviewLoopPositionError,
    ReviewMissingReferenceError,
    ReviewPacketError,
)
from controller.github import GithubAdapter
from controller.orchestrator import OrchestrationReferences
from controller.review import (
    ArchitectReviewLoop,
    FindingSeverity,
    ReviewDecision,
    ReviewFinding,
    ReviewLoopOutcome,
    ReviewPacket,
)
from controller.states import LifecycleState
from controller.zai import (
    ZaiAdapter,
    ZaiIssuedWorkerSession,
    ZaiWorkerContext,
    ZaiWorkerSession,
)
from tests.github_fakes import (
    BASE_SHA,
    HEAD_SHA,
    OWNER,
    REPO,
    FakeTransport,
    adapter_responses,
    comment,
    pull_request,
    review,
)
from tests.util import REPO_ROOT, make_repo
from tests.zai_fakes import START_PATH, FakeZaiTransport, worker_session

BRANCH = "ctrl-007-review-loop"
WORK_ITEM = "CTRL-007"
ARCHITECT = "pectoraux"
SESSION_ID = "zai-session-ctrl-007-001"
FINDING = (
    "CTRL007-F01",
    "HIGH",
    "controller/review.py",
    "AC4",
    "normalize the packet grammar strictly",
)


def _session(**overrides: object) -> ZaiWorkerSession:
    """A hand-constructed ordinary session value: structurally exact for
    the governed fixture context, but NOT adapter-issued evidence (the
    public value form any caller can build by hand)."""
    defaults: dict[str, object] = {
        "session_id": SESSION_ID,
        "repository": REPO,
        "work_item": WORK_ITEM,
        "base_sha": BASE_SHA,
        "pr_number": None,
        "head_sha": None,
        "status": "active",
        "updated_at": "2026-09-04T16:50:00Z",
    }
    defaults.update(overrides)
    return ZaiWorkerSession(**defaults)  # type: ignore[arg-type]


def _issued_session(session_id: str = SESSION_ID) -> ZaiIssuedWorkerSession:
    """Adapter-issued session evidence, produced by the actual issuance
    boundary: the ZaiAdapter normalizing a (fake) provider response for
    the exact governed fixture context (FZ-CTRL007-001)."""
    report = worker_session(
        session_id=session_id,
        repository=REPO,
        work_item=WORK_ITEM,
        base_sha=BASE_SHA,
        pr_number=None,
        head_sha=None,
    )
    adapter = ZaiAdapter(FakeZaiTransport({START_PATH: report}), REPO)
    context = ZaiWorkerContext(
        repository=REPO,
        work_item=WORK_ITEM,
        work_order_path="spec/work-items/CTRL-007.md",
        base_sha=BASE_SHA,
    )
    return adapter.start_worker(context)


def _refs(**overrides: object) -> OrchestrationReferences:
    defaults: dict[str, object] = {
        "branch": BRANCH,
        "base_sha": BASE_SHA,
        "worker_session": _issued_session(),
        "architect_reviewer": ARCHITECT,
    }
    defaults.update(overrides)
    return OrchestrationReferences(**defaults)  # type: ignore[arg-type]


def _packet_block(**overrides: Any) -> str:
    """Render one machine-readable review-packet block (the frozen grammar)."""
    findings: list[tuple[str, str, str, str, str]] = overrides.pop("findings", [FINDING])
    values: dict[str, Any] = {
        "work_item": WORK_ITEM,
        "pr": 17,
        "head_sha": HEAD_SHA,
        "base_sha": BASE_SHA,
        "iteration": 1,
        "decision": "REQUEST_CHANGES",
    }
    values.update(overrides)
    lines = [
        "```review-packet",
        f"work_item: {values['work_item']}",
        f"pr: {values['pr']}",
        f"head_sha: {values['head_sha']}",
        f"base_sha: {values['base_sha']}",
        f"iteration: {values['iteration']}",
        f"decision: {values['decision']}",
    ]
    if not findings:
        lines.append("findings: []")
    else:
        lines.append("findings:")
        for finding_id, severity, path, criterion, required in findings:
            lines.append(f"  - id: {finding_id}")
            lines.append(f"    severity: {severity}")
            lines.append(f"    path: {path}")
            lines.append(f"    criterion: {criterion}")
            lines.append(f"    required_change: {required}")
    lines.append("```")
    return "\n".join(lines)


class LoopFixtureMixin(unittest.TestCase):
    """Shared fixture: synthetic authority at a loop position + fake GitHub."""

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

    def _loop(
        self,
        status: str,
        *,
        reviews: list[dict[str, Any]] | None = None,
        comments: list[dict[str, Any]] | None = None,
        with_pr: bool = True,
        pr_head_sha: str = HEAD_SHA,
    ) -> tuple[ArchitectReviewLoop, Path]:
        single = pull_request(
            number=17,
            title="CTRL-007 — Architect review loop",
            head_branch=BRANCH,
            head_sha=pr_head_sha,
            base_sha=BASE_SHA,
        )
        served = [single] if with_pr else []
        responses = adapter_responses(
            prs=served,
            pr=single if with_pr else None,
            reviews=reviews if reviews is not None else [],
        )
        if not with_pr:
            responses[f"/repos/{REPO}/pulls?state=open&head={OWNER}:{BRANCH}"] = []
        if comments is not None:
            responses[f"/repos/{REPO}/issues/17/comments"] = comments
        else:
            responses[f"/repos/{REPO}/issues/17/comments"] = []
        transport = FakeTransport(responses=responses)
        loop = ArchitectReviewLoop(github=GithubAdapter(transport, REPO))
        return loop, self._repo(status)

    def _transport(self, loop: ArchitectReviewLoop) -> FakeTransport:
        transport = loop._github._transport  # noqa: SLF001 - test seam
        assert isinstance(transport, FakeTransport)
        return transport


class PacketValueTests(unittest.TestCase):
    """AC4: the packet value form validates and round-trips exactly."""

    def test_serialize_deserialize_round_trip(self) -> None:
        packet = ReviewPacket(
            work_item=WORK_ITEM,
            pr_number=17,
            head_sha=HEAD_SHA,
            base_sha=BASE_SHA,
            iteration=2,
            decision=ReviewDecision.REQUEST_CHANGES,
            findings=(
                ReviewFinding(
                    finding_id=FINDING[0],
                    severity=FindingSeverity.HIGH,
                    path=FINDING[2],
                    criterion=FINDING[3],
                    required_change=FINDING[4],
                ),
            ),
        )
        rebuilt = ReviewPacket.deserialize(packet.serialize())
        self.assertEqual(rebuilt, packet)

    def test_unknown_top_level_key_is_refused(self) -> None:
        with self.assertRaises(ReviewPacketError):
            ReviewPacket.deserialize(
                {
                    "work_item": WORK_ITEM,
                    "pr": 17,
                    "head_sha": HEAD_SHA,
                    "base_sha": BASE_SHA,
                    "iteration": 1,
                    "decision": "REQUEST_CHANGES",
                    "findings": [],
                    "extra": "field",
                }
            )

    def test_request_changes_without_findings_is_refused(self) -> None:
        with self.assertRaises(ReviewPacketError):
            ReviewPacket(
                work_item=WORK_ITEM,
                pr_number=17,
                head_sha=HEAD_SHA,
                base_sha=BASE_SHA,
                iteration=1,
                decision=ReviewDecision.REQUEST_CHANGES,
                findings=(),
            )

    def test_approve_with_findings_is_refused(self) -> None:
        with self.assertRaises(ReviewPacketError):
            ReviewPacket(
                work_item=WORK_ITEM,
                pr_number=17,
                head_sha=HEAD_SHA,
                base_sha=BASE_SHA,
                iteration=1,
                decision=ReviewDecision.APPROVE,
                findings=(
                    ReviewFinding(
                        finding_id=FINDING[0],
                        severity=FindingSeverity.HIGH,
                        path=FINDING[2],
                        criterion=FINDING[3],
                        required_change=FINDING[4],
                    ),
                ),
            )

    def test_bad_sha_is_refused(self) -> None:
        with self.assertRaises(ReviewPacketError):
            ReviewPacket(
                work_item=WORK_ITEM,
                pr_number=17,
                head_sha="XYZ",
                base_sha=BASE_SHA,
                iteration=1,
                decision=ReviewDecision.APPROVE,
                findings=(),
            )


class LoopPositionTests(LoopFixtureMixin):
    """AC1: authority first; positions outside the loop fail closed."""

    def test_ready_position_fails_closed_without_remote_calls(self) -> None:
        loop, repo = self._loop("READY")
        with self.assertRaises(ReviewLoopPositionError):
            loop.evaluate(repo, _refs())
        self.assertEqual(self._transport(loop).calls, [])

    def test_ci_pending_position_fails_closed(self) -> None:
        loop, repo = self._loop("CI_PENDING")
        with self.assertRaises(ReviewLoopPositionError):
            loop.evaluate(repo, _refs())
        self.assertEqual(self._transport(loop).calls, [])

    def test_real_repository_is_currently_outside_loop_positions(self) -> None:
        loop = ArchitectReviewLoop(github=GithubAdapter(FakeTransport(), REPO))
        with self.assertRaises(ReviewLoopPositionError):
            loop.evaluate(REPO_ROOT, _refs())

    def test_missing_reviewer_reference_fails_closed(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING")
        with self.assertRaises(ReviewMissingReferenceError):
            loop.evaluate(repo, _refs(architect_reviewer=None))

    def test_missing_correlation_references_fail_closed(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING")
        with self.assertRaises(ReviewMissingReferenceError):
            loop.evaluate(repo, _refs(branch=None))
        with self.assertRaises(ReviewMissingReferenceError):
            loop.evaluate(repo, _refs(base_sha=None))


class DecisionObservationTests(LoopFixtureMixin):
    """AC2/AC3: decision observation, correlation, and refusal to infer."""

    def _reviews(self, state: str, commit_id: str | None = HEAD_SHA) -> list[dict[str, Any]]:
        return [review(101, author=ARCHITECT, state=state, commit_id=commit_id)]

    def test_no_reviews_observes_without_decision_or_event(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING", reviews=[])
        outcome = loop.evaluate(repo, _refs())
        self.assertIsNone(outcome.decision)
        self.assertIsNone(outcome.event)
        self.assertIsNone(outcome.packet)

    def test_foreign_author_reviews_are_not_authoritative(self) -> None:
        loop, repo = self._loop(
            "REVIEW_PENDING", reviews=[review(101, author="someone-else", state="APPROVED")]
        )
        outcome = loop.evaluate(repo, _refs())
        self.assertIsNone(outcome.decision)
        self.assertIsNone(outcome.event)

    def test_commented_latest_review_is_not_a_decision(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING", reviews=self._reviews("COMMENTED"))
        outcome = loop.evaluate(repo, _refs())
        self.assertIsNone(outcome.decision)
        self.assertIsNone(outcome.event)

    def test_stale_head_review_is_not_the_current_decision(self) -> None:
        loop, repo = self._loop(
            "REVIEW_PENDING", reviews=self._reviews("APPROVED", commit_id="e" * 40)
        )
        outcome = loop.evaluate(repo, _refs())
        self.assertIsNone(outcome.decision)
        self.assertIsNone(outcome.event)

    def test_unreported_commit_id_is_not_the_current_decision(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING", reviews=self._reviews("APPROVED", commit_id=None))
        outcome = loop.evaluate(repo, _refs())
        self.assertIsNone(outcome.decision)

    def test_latest_decision_wins_by_deterministic_order(self) -> None:
        older = review(99, author=ARCHITECT, state="APPROVED", submitted_at="2026-09-04T10:00:00Z")
        newer = review(
            101,
            author=ARCHITECT,
            state="CHANGES_REQUESTED",
            submitted_at="2026-09-04T11:00:00Z",
        )
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[older, newer],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        outcome = loop.evaluate(repo, _refs())
        self.assertIs(outcome.decision, ReviewDecision.REQUEST_CHANGES)

    def test_approve_at_exact_head_emits_approve_without_merge(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING", reviews=self._reviews("APPROVED"))
        outcome = loop.evaluate(repo, _refs())
        assert outcome.event is not None
        self.assertEqual(outcome.event.command.value, "APPROVE")
        self.assertIs(outcome.event.from_state, LifecycleState.REVIEW_PENDING)
        self.assertIs(outcome.event.to_state, LifecycleState.APPROVED)
        transport = self._transport(loop)
        self.assertTrue(all(call[0] == "GET" for call in transport.calls))
        self.assertFalse(transport.calls_matching("POST", "/"))
        self.assertFalse(transport.calls_matching("PUT", "/"))

    def test_absent_pr_at_review_pending_is_a_contradiction(self) -> None:
        loop, repo = self._loop("REVIEW_PENDING", with_pr=False)
        with self.assertRaises(ReviewContradictionError):
            loop.evaluate(repo, _refs())


class RequestChangesTests(LoopFixtureMixin):
    """AC4/AC6: the durable packet for REQUEST_CHANGES."""

    def _changes_loop(
        self,
        *,
        comments: list[dict[str, Any]],
        reviews: list[dict[str, Any]] | None = None,
        status: str = "REVIEW_PENDING",
    ) -> tuple[ArchitectReviewLoop, Path]:
        changes = (
            reviews
            if reviews is not None
            else [review(101, author=ARCHITECT, state="CHANGES_REQUESTED")]
        )
        return self._loop(status, reviews=changes, comments=comments)

    def test_valid_packet_is_transported_verbatim_with_event(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author=ARCHITECT, body=_packet_block())]
        )
        outcome = loop.evaluate(repo, _refs())
        assert outcome.packet is not None
        self.assertEqual(outcome.packet.work_item, WORK_ITEM)
        self.assertEqual(outcome.packet.pr_number, 17)
        self.assertEqual(outcome.packet.head_sha, HEAD_SHA)
        self.assertEqual(outcome.packet.base_sha, BASE_SHA)
        self.assertEqual(outcome.packet.iteration, 1)
        self.assertIs(outcome.packet.decision, ReviewDecision.REQUEST_CHANGES)
        self.assertEqual(len(outcome.packet.findings), 1)
        self.assertEqual(outcome.packet.findings[0].finding_id, FINDING[0])
        self.assertIs(outcome.packet.findings[0].severity, FindingSeverity.HIGH)
        self.assertEqual(outcome.packet.findings[0].path, FINDING[2])
        self.assertEqual(outcome.packet.findings[0].criterion, FINDING[3])
        self.assertEqual(outcome.packet.findings[0].required_change, FINDING[4])
        assert outcome.event is not None
        self.assertEqual(outcome.event.command.value, "REQUEST_CHANGES")
        self.assertIs(outcome.event.from_state, LifecycleState.REVIEW_PENDING)
        self.assertIs(outcome.event.to_state, LifecycleState.CHANGES_REQUESTED)

    def test_missing_packet_fails_closed(self) -> None:
        loop, repo = self._changes_loop(comments=[])
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_prose_only_comment_does_not_satisfy_the_packet(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author=ARCHITECT, body="### REQUEST CHANGES prose only")]
        )
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_stale_iteration_packet_is_not_the_current_packet(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author=ARCHITECT, body=_packet_block(iteration=0))]
        )
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_head_drifted_packet_is_not_the_current_packet(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author=ARCHITECT, body=_packet_block(head_sha="e" * 40))]
        )
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_foreign_work_item_packet_is_a_contradiction(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author=ARCHITECT, body=_packet_block(work_item="CTRL-009"))]
        )
        with self.assertRaises(ReviewContradictionError):
            loop.evaluate(repo, _refs())

    def test_foreign_pr_packet_is_a_contradiction(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author=ARCHITECT, body=_packet_block(pr=99))]
        )
        with self.assertRaises(ReviewContradictionError):
            loop.evaluate(repo, _refs())

    def test_two_current_packets_are_ambiguous(self) -> None:
        block = _packet_block()
        loop, repo = self._changes_loop(
            comments=[
                comment(500, author=ARCHITECT, body=block),
                comment(501, author=ARCHITECT, body=block),
            ]
        )
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_second_iteration_counts_prior_change_requests(self) -> None:
        first = review(
            101,
            author=ARCHITECT,
            state="CHANGES_REQUESTED",
            submitted_at="2026-09-04T10:00:00Z",
            commit_id="e" * 40,
        )
        second = review(
            102,
            author=ARCHITECT,
            state="CHANGES_REQUESTED",
            submitted_at="2026-09-04T11:00:00Z",
            commit_id=HEAD_SHA,
        )
        loop, repo = self._changes_loop(
            reviews=[first, second],
            comments=[
                comment(
                    500,
                    author=ARCHITECT,
                    body=_packet_block(iteration=1, head_sha="e" * 40),
                ),
                comment(501, author=ARCHITECT, body=_packet_block(iteration=2)),
            ],
        )
        outcome = loop.evaluate(repo, _refs())
        assert outcome.packet is not None
        self.assertEqual(outcome.packet.iteration, 2)
        self.assertEqual(outcome.iteration, 2)

    def test_malformed_grammar_fails_closed(self) -> None:
        broken = "\n".join(
            [
                "```review-packet",
                f"work_item: {WORK_ITEM}",
                "pr: seventeen",
                f"head_sha: {HEAD_SHA}",
                f"base_sha: {BASE_SHA}",
                "iteration: 1",
                "decision: REQUEST_CHANGES",
                "findings:",
                f"  - id: {FINDING[0]}",
                f"    severity: {FINDING[1]}",
                f"    path: {FINDING[2]}",
                f"    criterion: {FINDING[3]}",
                f"    required_change: {FINDING[4]}",
                "```",
            ]
        )
        loop, repo = self._changes_loop(comments=[comment(500, author=ARCHITECT, body=broken)])
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_unknown_severity_fails_closed(self) -> None:
        loop, repo = self._changes_loop(
            comments=[
                comment(
                    500,
                    author=ARCHITECT,
                    body=_packet_block(findings=[(FINDING[0], "CRITICAL", *FINDING[2:])]),
                )
            ]
        )
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())

    def test_packet_from_non_architect_comment_is_ignored(self) -> None:
        loop, repo = self._changes_loop(
            comments=[comment(500, author="someone-else", body=_packet_block())]
        )
        with self.assertRaises(ReviewPacketError):
            loop.evaluate(repo, _refs())


class ChangesRequestedReobservationTests(LoopFixtureMixin):
    """AC6: idempotent re-observation at CHANGES_REQUESTED."""

    def _changes_requested_loop(
        self,
        *,
        reviews: list[dict[str, Any]] | None = None,
        comments: list[dict[str, Any]] | None = None,
    ) -> tuple[ArchitectReviewLoop, Path]:
        changes = (
            reviews
            if reviews is not None
            else [review(101, author=ARCHITECT, state="CHANGES_REQUESTED")]
        )
        served = (
            comments
            if comments is not None
            else [comment(500, author=ARCHITECT, body=_packet_block())]
        )
        return self._loop("CHANGES_REQUESTED", reviews=changes, comments=served)

    def test_reobservation_rebuilds_the_packet_without_event(self) -> None:
        loop, repo = self._changes_requested_loop()
        outcome = loop.evaluate(repo, _refs())
        assert outcome.packet is not None
        self.assertIs(outcome.lifecycle, LifecycleState.CHANGES_REQUESTED)
        self.assertIsNone(outcome.event)
        self.assertEqual(outcome.packet.iteration, 1)
        assert outcome.handoff is not None

    def test_vanished_decision_is_a_contradiction(self) -> None:
        loop, repo = self._changes_requested_loop(reviews=[])
        with self.assertRaises(ReviewContradictionError):
            loop.evaluate(repo, _refs())

    def test_flipped_decision_is_a_contradiction(self) -> None:
        loop, repo = self._changes_requested_loop(
            reviews=[review(101, author=ARCHITECT, state="APPROVED")]
        )
        with self.assertRaises(ReviewContradictionError):
            loop.evaluate(repo, _refs())

    def test_repeated_reobservation_is_idempotent(self) -> None:
        loop, repo = self._changes_requested_loop()
        first: ReviewLoopOutcome = loop.evaluate(repo, _refs())
        second: ReviewLoopOutcome = loop.evaluate(repo, _refs())
        self.assertEqual(first, second)


class HandoffTests(LoopFixtureMixin):
    """AC5: the typed same-worker/same-PR handoff over adapter-issued
    session evidence, with zero worker-provider I/O (FZ-CTRL007-001)."""

    def _request_changes_outcome(self, **session_overrides: object) -> ReviewLoopOutcome:
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        return loop.evaluate(repo, _refs(worker_session=_session(**session_overrides)))

    def test_handoff_carries_exact_governed_facts(self) -> None:
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        outcome = loop.evaluate(repo, _refs())
        assert outcome.handoff is not None
        self.assertEqual(outcome.handoff.session_id, SESSION_ID)
        self.assertEqual(outcome.handoff.repository, REPO)
        self.assertEqual(outcome.handoff.work_item, WORK_ITEM)
        self.assertEqual(outcome.handoff.work_order_path, "spec/work-items/CTRL-007.md")
        self.assertEqual(outcome.handoff.branch, BRANCH)
        self.assertEqual(outcome.handoff.base_sha, BASE_SHA)
        self.assertEqual(outcome.handoff.pr_number, 17)
        self.assertEqual(outcome.handoff.head_sha, HEAD_SHA)
        self.assertIs(outcome.handoff.packet, outcome.packet)

    def test_structurally_exact_non_adapter_session_cannot_produce_handoff(self) -> None:
        """FZ-CTRL007-001 regression: a hand-constructed session value
        with a structurally exact binding for the governed context is
        refused — the ordinary public value form is not execution
        evidence; only adapter-issued evidence produces a handoff."""
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        with self.assertRaises(ReviewContradictionError) as raised:
            loop.evaluate(repo, _refs(worker_session=_session()))
        self.assertIn("adapter-issued evidence", str(raised.exception))
        self.assertIn("FZ-CTRL007-001", str(raised.exception))
        self.assertTrue(all(call[0] == "GET" for call in self._transport(loop).calls))

    def test_forged_issuance_proof_cannot_produce_handoff(self) -> None:
        """FZ-CTRL007-001 regression at the provenance boundary itself:
        a value of the issued type whose ordinary fields are all exact
        for the governed context but whose proof was not computed by the
        adapter fails verification — provenance, not a field mismatch."""
        forged = ZaiIssuedWorkerSession(
            session_id=SESSION_ID,
            repository=REPO,
            work_item=WORK_ITEM,
            base_sha=BASE_SHA,
            pr_number=None,
            head_sha=None,
            status="active",
            updated_at="2026-09-04T16:50:00Z",
            _proof="00" * 32,
        )
        self.assertFalse(forged.verify_issuance())
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        with self.assertRaises(ReviewContradictionError) as raised:
            loop.evaluate(repo, _refs(worker_session=forged))
        self.assertIn("does not verify", str(raised.exception))
        self.assertTrue(all(call[0] == "GET" for call in self._transport(loop).calls))

    def test_tampered_issued_evidence_cannot_produce_handoff(self) -> None:
        """Issued evidence whose fields were altered after issuance
        (here: the session identity) fails its own proof — the MAC binds
        every ordinary field, so tampering is detected locally."""
        tampered = dataclasses.replace(_issued_session(), session_id="zai-sess-tampered-999")
        self.assertFalse(tampered.verify_issuance())
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        with self.assertRaises(ReviewContradictionError) as raised:
            loop.evaluate(repo, _refs(worker_session=tampered))
        self.assertIn("does not verify", str(raised.exception))

    def test_issued_evidence_verifies_and_produces_the_handoff(self) -> None:
        """The positive boundary: evidence actually issued by the adapter
        (normalizing a provider response) verifies locally and produces
        the handoff without any provider call from the loop."""
        issued = _issued_session()
        self.assertIsInstance(issued, ZaiIssuedWorkerSession)
        self.assertTrue(issued.verify_issuance())
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        outcome = loop.evaluate(repo, _refs(worker_session=issued))
        assert outcome.handoff is not None
        self.assertEqual(outcome.handoff.session_id, SESSION_ID)

    def test_absent_session_leaves_packet_exposed_without_handoff(self) -> None:
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        outcome = loop.evaluate(repo, _refs(worker_session=None))
        assert outcome.packet is not None
        self.assertIsNone(outcome.handoff)
        self.assertTrue(all(call[0] == "GET" for call in self._transport(loop).calls))

    def test_foreign_repository_session_fails_closed(self) -> None:
        with self.assertRaises(ReviewContradictionError):
            self._request_changes_outcome(repository="other/repo")

    def test_foreign_work_item_session_fails_closed(self) -> None:
        with self.assertRaises(ReviewContradictionError):
            self._request_changes_outcome(work_item="CTRL-008")

    def test_wrong_base_session_fails_closed(self) -> None:
        with self.assertRaises(ReviewContradictionError):
            self._request_changes_outcome(base_sha="e" * 40)

    def test_session_claiming_foreign_pr_fails_closed(self) -> None:
        with self.assertRaises(ReviewContradictionError):
            self._request_changes_outcome(pr_number=99)

    def test_session_claiming_drifted_head_fails_closed(self) -> None:
        with self.assertRaises(ReviewContradictionError):
            self._request_changes_outcome(head_sha="f" * 40)

    def test_local_binding_proof_precedes_evidence_verification(self) -> None:
        """The ordinary binding proof (FZ-CTRL005-001 doctrine) fires on
        locally carried fields with zero remote calls — a foreign-repo
        session is refused before any GitHub mutation could occur."""
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        with self.assertRaises(ReviewContradictionError):
            loop.evaluate(repo, _refs(worker_session=_session(repository="other/repo")))
        self.assertTrue(all(call[0] == "GET" for call in self._transport(loop).calls))

    def test_handoff_performs_no_worker_provider_io_at_all(self) -> None:
        """AC5 observation-only contract: the happy-path handoff issues
        GitHub reads only, and the loop instance carries no Z.ai surface
        of any kind — zero worker-provider calls, structurally."""
        loop, repo = self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )
        loop.evaluate(repo, _refs())
        transport = self._transport(loop)
        self.assertTrue(all(call[0] == "GET" for call in transport.calls))
        self.assertFalse(hasattr(loop, "_zai"))
        self.assertFalse(hasattr(loop, "zai"))


class RestartDeterminismTests(LoopFixtureMixin):
    """AC7: identical inputs reproduce identical decisions."""

    def _fixture(self) -> tuple[ArchitectReviewLoop, Path]:
        return self._loop(
            "REVIEW_PENDING",
            reviews=[review(101, author=ARCHITECT, state="CHANGES_REQUESTED")],
            comments=[comment(500, author=ARCHITECT, body=_packet_block())],
        )

    def test_repeated_evaluation_is_deterministic(self) -> None:
        loop, repo = self._fixture()
        self.assertEqual(loop.evaluate(repo, _refs()), loop.evaluate(repo, _refs()))

    def test_fresh_loop_instance_reproduces_the_decision(self) -> None:
        loop, repo = self._fixture()
        other, _ = self._fixture()
        self.assertEqual(loop.evaluate(repo, _refs()), other.evaluate(repo, _refs()))

    def test_loop_instance_holds_only_the_github_adapter(self) -> None:
        loop, _ = self._fixture()
        self.assertEqual(sorted(loop.__dict__.keys()), ["_github"])  # noqa: SLF001 - structural runtime-non-authority pin


if __name__ == "__main__":
    unittest.main()
