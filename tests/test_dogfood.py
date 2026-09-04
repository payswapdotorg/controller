"""Integration tests: the CTRL-010 end-to-end dogfood composition.

Exercises the frozen acceptance criteria of
``spec/work-items/CTRL-010.md`` against the real composed boundaries —
repository authority (CTRL-001/002), orchestrator (CTRL-005), evidence
gate (CTRL-006), review loop (CTRL-007), merge/reconciliation loop
(CTRL-008), and recovery boundary (CTRL-009) — over the deterministic
scripted scenario world. Every test is offline and deterministic: no
network, no credentials, no wall-clock, no randomness (AC6). The
committed ``tests/dogfood_execution_record.json`` is replayed and
compared byte-for-semantic-equality on every run.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from controller.authority import reconstruct
from controller.dogfood import (
    DogfoodStepRecord,
    SCENARIO_AUTOMATION_STAGE,
    SCENARIO_COMPLETED_BEFORE,
    SCENARIO_DISPATCH_BASE,
    SCENARIO_HEAD_V1,
    SCENARIO_HEAD_V2,
    SCENARIO_MERGE_COMMIT,
    SCENARIO_PR_NUMBER,
    SCENARIO_SESSION_ID,
    SCENARIO_WORK_ITEM,
    SCENARIO_WORK_ORDER_PATH,
    run_fail_closed_probes,
    run_governed_dogfood,
)
from controller.states import LifecycleState
from tests.util import REPO_ROOT

#: The committed durable execution record (AC6 replay fixture).
RECORD_PATH = REPO_ROOT / "tests" / "dogfood_execution_record.json"

#: The complete frozen happy-path sequence the run must traverse (AC1),
#: including the change loop's second IMPLEMENTING -> ... -> REVIEW_PENDING
#: traversal after CHANGES_REQUESTED.
EXPECTED_SEQUENCE = (
    "READY",
    "DISPATCHED",
    "IMPLEMENTING",
    "PR_OPEN",
    "CI_PENDING",
    "REVIEW_PENDING",
    "CHANGES_REQUESTED",
    "IMPLEMENTING",
    "PR_OPEN",
    "CI_PENDING",
    "REVIEW_PENDING",
    "APPROVED",
    "MERGING",
    "MERGED",
    "RECONCILING",
    "COMPLETE",
)

#: The boundaries the composition must use (AC7: it composes, never
#: re-implements — each accepted boundary appears in the step log).
EXPECTED_BOUNDARIES = {
    "ORCHESTRATOR",
    "EVIDENCE_GATE",
    "REVIEW_LOOP",
    "MERGE_BOUNDARY",
    "RECOVERY_BOUNDARY",
}


class DogfoodFixture(unittest.TestCase):
    """Shared fixture: one full governed dogfood run."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.repo_root = self.base / "scenario-repo"
        self.record = run_governed_dogfood(self.base)

    def _steps_with(self, phase_prefix: str) -> list[DogfoodStepRecord]:
        return [s for s in self.record.steps if s.phase.startswith(phase_prefix)]


class GovernedLoopCompositionTests(DogfoodFixture):
    """AC1 — the full governed loop composes, step by owning step."""

    def test_full_lifecycle_traversal_from_ready_to_complete(self) -> None:
        positions = [s.lifecycle_before for s in self.record.steps]
        # Every expected position appears, in order, before its successor.
        index = 0
        for expected in EXPECTED_SEQUENCE:
            while index < len(positions) and positions[index] != expected:
                index += 1
            self.assertLess(
                index,
                len(positions),
                msg=f"lifecycle position {expected} never observed in the run",
            )
        self.assertEqual(self.record.steps[-1].lifecycle_after, "COMPLETE")

    def test_every_step_is_performed_by_the_owning_boundary(self) -> None:
        boundaries = {s.boundary for s in self.record.steps}
        self.assertEqual(boundaries, EXPECTED_BOUNDARIES)

    def test_every_transition_comes_from_the_frozen_table(self) -> None:
        valid = {state.value for state in LifecycleState}
        for step in self.record.steps:
            self.assertIn(step.lifecycle_before, valid)
            self.assertIn(step.lifecycle_after, valid)
            if step.event_command is not None:
                self.assertIn(
                    step.event_command,
                    {
                        "DISPATCH",
                        "BEGIN_IMPLEMENTATION",
                        "OPEN_PR",
                        "AWAIT_CI",
                        "RECORD_CI_SUCCESS",
                        "REQUEST_CHANGES",
                        "RESUME_IMPLEMENTATION",
                        "APPROVE",
                        "MERGE",
                        "RECORD_MERGE",
                        "RECONCILE",
                        "RECORD_RECONCILIATION",
                    },
                )

    def test_the_second_iteration_repeats_the_evidence_and_review_cycle(self) -> None:
        ci_records = self._steps_with("record-ci-success")
        self.assertEqual(len(ci_records), 2)
        review_decisions = [s for s in self.record.steps if s.phase.startswith("architect-")]
        self.assertEqual(
            [s.identity["decision"] for s in review_decisions],
            ["REQUEST_CHANGES", "APPROVE"],
        )

    def test_repository_authority_remains_valid_at_the_final_position(self) -> None:
        state = reconstruct(self.repo_root)
        self.assertEqual(state.work_item, SCENARIO_WORK_ITEM)
        self.assertIs(state.lifecycle, LifecycleState.COMPLETE)


class IdentityCorrelationTests(DogfoodFixture):
    """AC2 — exact identity preservation across the composed run."""

    def test_scenario_identities_correlate_in_every_step(self) -> None:
        self.assertEqual(self.record.work_item, SCENARIO_WORK_ITEM)
        self.assertEqual(self.record.pr_number, SCENARIO_PR_NUMBER)
        self.assertEqual(self.record.dispatch_base, SCENARIO_DISPATCH_BASE)
        self.assertEqual(self.record.head_initial, SCENARIO_HEAD_V1)
        self.assertEqual(self.record.head_final, SCENARIO_HEAD_V2)
        self.assertEqual(self.record.merge_commit_sha, SCENARIO_MERGE_COMMIT)
        self.assertEqual(self.record.session_id, SCENARIO_SESSION_ID)
        for step in self.record.steps:
            if "pr" in step.identity:
                self.assertEqual(step.identity["pr"], SCENARIO_PR_NUMBER)
            if "work_item" in step.identity:
                self.assertEqual(step.identity["work_item"], SCENARIO_WORK_ITEM)

    def test_pr_heads_correlate_exactly_per_iteration(self) -> None:
        first = self._steps_with("open-pull-request")[0]
        second = self._steps_with("open-pull-request-iteration-2")[0]
        self.assertEqual(first.identity["head_sha"], SCENARIO_HEAD_V1)
        self.assertEqual(second.identity["head_sha"], SCENARIO_HEAD_V2)
        self.assertEqual(first.identity["base_sha"], SCENARIO_DISPATCH_BASE)
        self.assertEqual(second.identity["base_sha"], SCENARIO_DISPATCH_BASE)

    def test_the_review_packet_identity_is_exact(self) -> None:
        request = self._steps_with("architect-request-changes")[0]
        self.assertEqual(request.identity["head_sha"], SCENARIO_HEAD_V1)
        self.assertEqual(request.identity["base_sha"], SCENARIO_DISPATCH_BASE)
        self.assertEqual(request.identity["iteration"], 1)
        self.assertEqual(request.identity["session_id"], SCENARIO_SESSION_ID)

    def test_the_reapproval_is_bound_to_the_new_head(self) -> None:
        approve = self._steps_with("architect-approve")[0]
        self.assertEqual(approve.identity["head_sha"], SCENARIO_HEAD_V2)
        self.assertEqual(approve.identity["decision"], "APPROVE")

    def test_the_worker_session_identity_is_bound_for_the_whole_run(self) -> None:
        session_steps = [s for s in self.record.steps if s.identity.get("session_id") is not None]
        self.assertEqual(
            {s.identity["session_id"] for s in session_steps},
            {SCENARIO_SESSION_ID},
        )


class RestartProofTests(DogfoodFixture):
    """AC3 — the deliberate interruption is recovered, never replayed."""

    def test_the_interruption_is_the_lost_state_write_after_the_merge(self) -> None:
        step = self._steps_with("authorized-merge-attempt")[0]
        self.assertEqual(step.boundary, "MERGE_BOUNDARY")
        self.assertFalse(step.projected)
        self.assertEqual(step.event_command, "MERGE")
        self.assertTrue(step.identity["merge_attempted"])
        self.assertEqual(step.lifecycle_before, "APPROVED")
        self.assertEqual(step.lifecycle_after, "APPROVED")
        unprojected = [s for s in self.record.steps if not s.projected]
        self.assertEqual(len(unprojected), 1)

    def test_recovery_classifies_the_external_completion(self) -> None:
        restart = self.record.restart
        assert restart is not None
        self.assertEqual(restart.lifecycle, "APPROVED")
        self.assertEqual(restart.condition, "EXTERNAL_COMPLETION_OBSERVED")
        self.assertEqual(restart.boundary, "MERGE_BOUNDARY")
        self.assertEqual(restart.next_step, "MERGE")
        self.assertEqual(restart.merge_commit_sha, SCENARIO_MERGE_COMMIT)
        self.assertEqual(restart.pull_request, SCENARIO_PR_NUMBER)
        self.assertEqual(restart.session_id, SCENARIO_SESSION_ID)
        self.assertEqual(restart.session_binding, "VERIFIED_ISSUED")
        self.assertFalse(restart.session_required)

    def test_the_resumption_performs_no_second_merge_mutation(self) -> None:
        step = self._steps_with("record-observed-merge")[0]
        self.assertEqual(step.boundary, "MERGE_BOUNDARY")
        self.assertFalse(step.identity["merge_attempted"])
        self.assertEqual(step.event_command, "MERGE")
        self.assertEqual(step.lifecycle_after, "MERGING")
        self.assertEqual(
            step.provider_calls,
            ("GET /repos/pectoraux/controller/pulls?state=all&head=pectoraux:ctrl-010-dogfood",),
        )

    def test_the_recovery_classification_is_read_only(self) -> None:
        restart = self.record.restart
        assert restart is not None
        self.assertTrue(all(c.startswith("GET ") for c in restart.provider_calls))

    def test_no_worker_start_or_resume_is_replayed_after_the_restart(self) -> None:
        post_restart = self.record.steps[13:]
        for step in post_restart:
            self.assertFalse(
                any("/worker/" in call for call in step.provider_calls),
                msg=f"step {step.step} replayed a worker provider call",
            )

    def test_exactly_one_merge_mutation_exists_in_the_whole_run(self) -> None:
        puts = [
            call
            for step in self.record.steps
            for call in step.provider_calls
            if call.startswith("PUT ")
        ]
        self.assertEqual(
            puts,
            [f"PUT /repos/pectoraux/controller/pulls/{SCENARIO_PR_NUMBER}/merge"],
        )

    def test_exactly_two_worker_starts_and_one_resume(self) -> None:
        starts = [
            call
            for step in self.record.steps
            for call in step.provider_calls
            if call == "POST /worker/sessions"
        ]
        resumes = [
            call
            for step in self.record.steps
            for call in step.provider_calls
            if call.endswith("/resume")
        ]
        self.assertEqual(len(starts), 2)
        self.assertEqual(
            resumes,
            [f"POST /worker/sessions/{SCENARIO_SESSION_ID}/resume"],
        )


class ChangeLoopProofTests(DogfoodFixture):
    """AC4 — one same-worker/same-PR REQUEST_CHANGES iteration."""

    def test_exactly_one_change_iteration_on_the_same_pr(self) -> None:
        self.assertEqual(self.record.change_iterations, 1)
        resume = self._steps_with("resume-same-worker")[0]
        self.assertEqual(resume.identity["session_id"], SCENARIO_SESSION_ID)
        self.assertEqual(resume.identity["pr"], SCENARIO_PR_NUMBER)
        self.assertEqual(resume.identity["head_sha"], SCENARIO_HEAD_V1)
        self.assertEqual(resume.identity["findings"], 1)

    def test_the_worker_cannot_author_the_semantic_decision(self) -> None:
        # The REQUEST_CHANGES and APPROVE decisions enter the run only as
        # observed scripted Architect review evidence; the worker-side
        # boundaries only record what the REVIEW_LOOP observed.
        decisions = [
            s.identity["decision"] for s in self.record.steps if s.phase.startswith("architect-")
        ]
        self.assertEqual(decisions, ["REQUEST_CHANGES", "APPROVE"])
        for step in self.record.steps:
            if step.boundary == "REVIEW_LOOP":
                self.assertIn(
                    step.identity["decision"],
                    {"REQUEST_CHANGES", "APPROVE"},
                )


class MergeReconciliationProofTests(DogfoodFixture):
    """AC5 — the approved merge path and the reconciliation record."""

    def test_the_authorized_merge_uses_the_ctrl_008_predicate_exactly(self) -> None:
        step = self._steps_with("authorized-merge-attempt")[0]
        self.assertTrue(step.identity["merge_attempted"])
        self.assertEqual(step.identity["merge_commit_sha"], SCENARIO_MERGE_COMMIT)
        self.assertEqual(step.identity["head_sha"], SCENARIO_HEAD_V2)
        self.assertEqual(step.identity["base_sha"], SCENARIO_DISPATCH_BASE)
        self.assertEqual(step.identity["dispatch_base"], SCENARIO_DISPATCH_BASE)

    def test_dispatch_base_provenance_is_carried_distinct_from_base_identity(self) -> None:
        step = self._steps_with("authorized-merge-attempt")[0]
        self.assertIn("dispatch_base", step.identity)
        self.assertIn("base_sha", step.identity)

    def test_the_reconciliation_record_derives_the_ledger_and_no_successor(self) -> None:
        self.assertEqual(
            self.record.completed_after,
            (*SCENARIO_COMPLETED_BEFORE, SCENARIO_WORK_ITEM),
        )
        self.assertEqual(self.record.completed_before, SCENARIO_COMPLETED_BEFORE)
        self.assertIsNone(self.record.next_work_item)

    def test_the_final_machine_state_records_completion(self) -> None:
        state = json.loads(
            (self.repo_root / "spec/state/controller-program-state.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["status"], "COMPLETE")
        self.assertEqual(state["completed"], [*SCENARIO_COMPLETED_BEFORE, SCENARIO_WORK_ITEM])
        work_order = (self.repo_root / SCENARIO_WORK_ORDER_PATH).read_text(encoding="utf-8")
        self.assertIn("Status: `COMPLETE`", work_order)

    def test_the_terminal_condition_is_awaiting_governance(self) -> None:
        terminal = self.record.terminal_governance
        assert terminal is not None
        self.assertEqual(terminal.condition, "AWAITING_GOVERNANCE")
        self.assertEqual(terminal.boundary, "ARCHITECT_GOVERNANCE")
        self.assertEqual(terminal.merge_commit_sha, SCENARIO_MERGE_COMMIT)
        self.assertEqual(terminal.next_step, "ADVANCE")


class DeterminismTests(unittest.TestCase):
    """AC6 — deterministic evidence and repeatability."""

    def test_two_runs_from_equal_fixtures_produce_equal_records(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            record_one = run_governed_dogfood(Path(first))
            record_two = run_governed_dogfood(Path(second))
        self.assertEqual(record_one, record_two)

    def test_serialized_records_are_stable_json(self) -> None:
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            one = json.dumps(run_governed_dogfood(Path(first)).serialize(), sort_keys=True)
            two = json.dumps(run_governed_dogfood(Path(second)).serialize(), sort_keys=True)
        self.assertEqual(one, two)

    def test_committed_execution_record_replays_from_fresh_fixtures(self) -> None:
        committed = json.loads(RECORD_PATH.read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as tmp:
            fresh = run_governed_dogfood(Path(tmp)).serialize()
        self.assertEqual(fresh, committed)


class FrozenBoundaryIntegrityTests(DogfoodFixture):
    """AC7 — the dogfood composes; it introduces no parallel lifecycle."""

    def test_the_composition_uses_every_accepted_boundary(self) -> None:
        boundaries = {s.boundary for s in self.record.steps}
        self.assertEqual(
            boundaries,
            {
                "ORCHESTRATOR",
                "EVIDENCE_GATE",
                "REVIEW_LOOP",
                "MERGE_BOUNDARY",
                "RECOVERY_BOUNDARY",
            },
        )

    def test_no_step_introduces_a_state_outside_the_frozen_lifecycle(self) -> None:
        valid = {state.value for state in LifecycleState}
        for step in self.record.steps:
            self.assertIn(step.lifecycle_before, valid)
            self.assertIn(step.lifecycle_after, valid)


class StageTransitionEvidenceTests(DogfoodFixture):
    """AC8 — explicit stage evidence; the stage is never advanced."""

    def test_the_automation_stage_is_preserved_verbatim(self) -> None:
        self.assertEqual(self.record.automation_stage, SCENARIO_AUTOMATION_STAGE)
        state = json.loads(
            (self.repo_root / "spec/state/controller-program-state.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(state["automationStage"], SCENARIO_AUTOMATION_STAGE)

    def test_the_stage6_statement_is_explicit_and_records_no_transition(self) -> None:
        statement = self.record.stage6_statement
        self.assertIn("Stage 6", statement)
        self.assertIn("preserved verbatim", statement)
        self.assertIn("does not advance the stage", statement)
        self.assertIn("Architect-governed", statement)
        self.assertNotIn("transitioned", statement)


class FailClosedTests(unittest.TestCase):
    """AC9 — contradiction and unsafe partial operation fail closed."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def test_foreign_session_refuses_before_any_provider_call(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            failures = run_fail_closed_probes(Path(tmp))
        foreign = failures[0]
        self.assertEqual(foreign.probe, "foreign-session-contradiction")
        self.assertEqual(foreign.error, "OrchestrationContradictionError")
        self.assertIn("CTRL-009", foreign.message)
        self.assertEqual(foreign.provider_calls, ())
        self.assertEqual(foreign.remote_mutations, ())

    def test_partial_mutation_stops_without_retry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            failures = run_fail_closed_probes(Path(tmp))
        partial = failures[1]
        self.assertEqual(partial.probe, "partial-mutation-unresolved")
        self.assertEqual(partial.error, "MergeContradictionError")
        self.assertEqual(partial.recovery_condition, "PARTIAL_MUTATION_UNRESOLVED")
        self.assertIn("never re-attempts", partial.message)
        self.assertEqual(partial.remote_mutations, ())
        self.assertTrue(all(c.startswith("GET ") for c in partial.provider_calls))

    def test_probes_are_deterministic(self) -> None:
        with (
            tempfile.TemporaryDirectory() as first,
            tempfile.TemporaryDirectory() as second,
        ):
            one = run_fail_closed_probes(Path(first))
            two = run_fail_closed_probes(Path(second))
        self.assertEqual(one, two)


class RecordValueTests(DogfoodFixture):
    """The execution record's value forms (durable evidence surface)."""

    def test_serialize_is_json_round_trippable(self) -> None:
        payload = self.record.serialize()
        text = json.dumps(payload, sort_keys=True, indent=1)
        self.assertEqual(json.loads(text), payload)

    def test_every_step_serializes_with_the_full_proof_surface(self) -> None:
        for step in self.record.steps:
            payload = step.serialize()
            self.assertEqual(
                set(payload),
                {
                    "step",
                    "phase",
                    "boundary",
                    "lifecycle_before",
                    "lifecycle_after",
                    "event_command",
                    "outcome",
                    "identity",
                    "provider_calls",
                    "projected",
                },
            )


if __name__ == "__main__":
    unittest.main()
