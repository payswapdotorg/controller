"""CTRL-010 — End-to-end dogfood: the composed governed loop, proven once.

This module is the deterministic integration/dogfood proof required by
``spec/work-items/CTRL-010.md``. It defines exactly one governed
scenario and executes it through the **accepted CTRL-001 through
CTRL-009 boundaries only**: repository authority (CTRL-001/002) is
reconstructed by every step, the CTRL-005 orchestrator performs the
dispatch/implementation/PR/CI-wait/resume steps, the CTRL-006 evidence
gate classifies the CI evidence, the CTRL-007 review loop observes the
Architect decisions and constructs the machine-readable change packet,
the CTRL-008 merge/reconciliation loop evaluates the frozen merge
predicate, executes the single authorized merge attempt, and derives
the deterministic reconciliation record, and the CTRL-009 recovery
boundary classifies the deliberately injected restart and directs the
resumption through the owning boundary's frozen predicate.

Doctrine (frozen by the Work Order):

* **Composition, never re-implementation (AC7).** Every governed
  decision in the run is made by the boundary that owns it. This module
  supplies the deterministic scenario fixtures (a synthetic repository
  under a caller-supplied directory plus scripted in-memory provider
  surfaces), invokes the boundaries in the frozen order, projects the
  returned domain events into the synthetic repository machine state
  (the governed-commit simulation the human operator performs in Stage
  1), and records the evidence. It contains no transition table, no
  merge predicate, no review-selection rule, no classification logic of
  its own: the dogfood layer composes.
* **Exact identity preservation (AC2).** The scenario pins one work
  item, one governed branch, one PR, one dispatch base, two successive
  heads (before and after the change iteration), one worker session,
  one Architect reviewer identity, the required CI checks, and the
  observed merge commit — and every step's record carries the identity
  facts the boundary actually observed, cross-checked against the
  scenario's expectations. Foreign, stale, ambiguous, or contradictory
  identity fails closed through the boundaries' own typed errors.
* **Deliberate restart (AC3).** The interruption point is the hardest
  partial-operation case: the authorized merge mutation lands on the
  provider surface while the governed state write is simulated as lost
  (machine state still records ``APPROVED`` with the PR observed
  merged). The restarted process — carrying only durable identity
  references, no hidden controller state — asks the CTRL-009 recovery
  boundary, which classifies ``EXTERNAL_COMPLETION_OBSERVED`` and
  directs the CTRL-008 merge boundary, whose external-merge
  continuation records the observed merge **without re-attempting the
  mutation** (the provider-call log proves the zero second ``PUT``).
* **Change loop (AC4).** Exactly one Architect ``REQUEST_CHANGES``
  iteration is exercised: the same PR, the same worker session, the
  verbatim durable findings, the new head, and the re-approval bound to
  that new head.
* **Determinism (AC6).** No wall-clock, no randomness, no
  process-local controller state: two runs from equivalently built
  fixtures produce equal execution records, and the committed
  ``tests/dogfood_execution_record.json`` is regenerated and compared
  by the test suite.
* **Stage evidence (AC8).** The execution record states explicitly
  that the roadmap Stage 6 prerequisites (the CTRL-008 merge/
  reconciliation boundary and the CTRL-009 recovery boundary, per the
  roadmap's Stage 6 mapping "CTRL-009 + CTRL-010") are exercised
  end-to-end by this run, while ``automationStage`` is preserved
  verbatim — this module never advances the stage and any transition
  remains an explicit Architect-governed authority update.
* **Fail-closed coverage (AC9).** Two typed failure probes are part of
  the record: a contradictory carried session (refused before any
  provider call) and the unsafe partial-operation case (``MERGING``
  with an unmerged PR: recovery classifies
  ``PARTIAL_MUTATION_UNRESOLVED`` and stops; the merge boundary itself
  refuses with a typed error and never re-attempts).

The scenario repository is materialized under a caller-supplied
directory (a temporary directory in every caller: tests and the
execution-record generator). The projection writes **only** files
inside that synthetic repository; the real repository — and every
other path — is never touched by this module. The scripted transports
are in-memory (no network, no tokens, no real provider), matching
the accepted fake-transport seams the CTRL-003/CTRL-004 adapters were
built with.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path

from controller.authority import verify_authority
from controller.domain import DomainEvent
from controller.errors import (
    ControllerError,
    MergeContradictionError,
    OrchestrationContradictionError,
)
from controller.evidence import EvidenceClassification, EvidenceGate, EvidencePolicy
from controller.github import GithubAdapter
from controller.merge import MergePolicy, MergeReconciliationLoop
from controller.orchestrator import (
    AwaitingCI,
    ImplementationStarted,
    OrchestrationReferences,
    Orchestrator,
    PullRequestOpened,
    WorkerDispatched,
    WorkerResumed,
)
from controller.recovery import (
    GovernedBoundary,
    RecoveryBoundary,
    RecoveryCondition,
    RecoveryPlan,
    SessionBinding,
)
from controller.review import (
    ArchitectReviewLoop,
    FindingSeverity,
    ReviewDecision,
    ReviewFinding,
)
from controller.states import LifecycleState
from controller.zai import ZaiAdapter, ZaiWorkerSession

# ---------------------------------------------------------------------------
# The frozen scenario identities (AC2: one exact identity per fact)
# ---------------------------------------------------------------------------

#: The repository the synthetic authority declares (and both adapters bind).
SCENARIO_REPOSITORY = "pectoraux/controller"
#: The dogfood work item itself — the scenario's single active item.
SCENARIO_WORK_ITEM = "CTRL-010"
#: Its frozen work-order path inside the synthetic repository.
SCENARIO_WORK_ORDER_PATH = "spec/work-items/CTRL-010.md"
#: The governed implementation branch (one-PR-per-work-item correlation key).
SCENARIO_BRANCH = "ctrl-010-dogfood"
#: The Architect reviewer identity (the authority-recorded decision author).
SCENARIO_ARCHITECT = "pectoraux"
#: The governed PR number for the scenario's single work item.
SCENARIO_PR_NUMBER = 30
#: The exact dispatch base (the main head the work order was dispatched from).
SCENARIO_DISPATCH_BASE = "a" * 40
#: The first implementation head (before the change iteration).
SCENARIO_HEAD_V1 = "b" * 40
#: The second implementation head (after the worker resolved the findings).
SCENARIO_HEAD_V2 = "d" * 40
#: The observed merge commit (the exact CTRL-008 evidence form).
SCENARIO_MERGE_COMMIT = "c" * 40
#: The provider-issued worker session identity (one session for the run).
SCENARIO_SESSION_ID = "zai-session-ctrl-010-001"
#: The required CI check contexts (the same vocabulary CTRL-006/CTRL-003 bind).
SCENARIO_REQUIRED_CHECKS = ("ci/tests", "ci/validate")
#: The completed ledger the synthetic authority starts from (x9: CTRL-001
#: through CTRL-009 reconciled; the dogfood item is the tenth).
SCENARIO_COMPLETED_BEFORE = tuple(f"CTRL-{index:03d}" for index in range(1, 10))
#: The automation stage, preserved verbatim for the whole run (AC8).
SCENARIO_AUTOMATION_STAGE = "STAGE-1-STATE-MACHINE-AUTOMATION"

#: Fixed review/comment timestamps — deterministic ordering evidence.
_REVIEW_CHANGES_AT = "2026-09-05T10:11:00Z"
_REVIEW_APPROVE_AT = "2026-09-05T10:22:00Z"
_SESSION_UPDATED_AT = "2026-09-05T10:00:00Z"
_COMMENT_AT = "2026-09-05T10:12:00Z"

#: The single durable finding the Architect's REQUEST_CHANGES packet carries.
SCENARIO_FINDING = ReviewFinding(
    finding_id="CTRL010-F01",
    severity=FindingSeverity.HIGH,
    path="controller/dogfood.py",
    criterion="AC4",
    required_change="exercise the same-worker/same-PR change loop with the verbatim findings",
)

# ---------------------------------------------------------------------------
# Typed execution records (the durable evidence surface; deterministic)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DogfoodStepRecord:
    """One composed step of the governed loop, with its proof surface.

    ``boundary`` names the accepted boundary that made the decision;
    ``phase`` is the scenario-local name; ``lifecycle_before``/
    ``lifecycle_after`` are the authority positions around the step;
    ``event_command`` is the frozen transition the boundary applied
    (``None`` for pure observations); ``outcome`` is the outcome class
    name; ``identity`` carries the exact identity facts the boundary
    observed (PR number, head/base SHAs, merge SHA, session id — only
    the fields that exist at that step); ``provider_calls`` is the
    complete provider-call log for exactly this step (method + path),
    proving which boundaries performed which remote effects — and, at
    the restart-resumption step, proving that none were performed.
    """

    step: int
    phase: str
    boundary: str
    lifecycle_before: str
    lifecycle_after: str
    event_command: str | None
    outcome: str
    identity: dict[str, object]
    provider_calls: tuple[str, ...]
    #: Whether the governed state write landed for this step. False
    #: exactly once, at the deliberate interruption: the merge mutation
    #: landed on the provider surface while the state write was lost
    #: (the partial-operation condition CTRL-009 must classify).
    projected: bool = True

    def serialize(self) -> dict[str, object]:
        """Deterministic value form for the durable execution record."""
        return {
            "step": self.step,
            "phase": self.phase,
            "boundary": self.boundary,
            "lifecycle_before": self.lifecycle_before,
            "lifecycle_after": self.lifecycle_after,
            "event_command": self.event_command,
            "outcome": self.outcome,
            "identity": dict(sorted(self.identity.items())),
            "provider_calls": list(self.provider_calls),
            "projected": self.projected,
        }


@dataclass(frozen=True)
class DogfoodRestartRecord:
    """The deliberate restart: the CTRL-009 plan that directed the resume.

    Everything the recovery boundary derived from repository authority
    and observed evidence at the interruption point — transported
    verbatim, with the provider-call proof that the classification
    itself performed zero mutations and zero provider calls.
    """

    lifecycle: str
    condition: str
    boundary: str
    next_step: str | None
    session_id: str | None
    session_binding: str | None
    session_required: bool
    pull_request: int | None
    base_sha: str | None
    merge_commit_sha: str | None
    provider_calls: tuple[str, ...]
    basis: tuple[str, ...]

    @classmethod
    def from_plan(cls, plan: RecoveryPlan, provider_calls: tuple[str, ...]) -> DogfoodRestartRecord:
        """Transport one evaluated recovery plan verbatim."""
        return cls(
            lifecycle=plan.lifecycle.value,
            condition=plan.condition.value,
            boundary=plan.boundary.value,
            next_step=plan.next_step,
            session_id=plan.session_id,
            session_binding=(
                plan.session_binding.value if plan.session_binding is not None else None
            ),
            session_required=plan.session_required,
            pull_request=plan.pull_request.number if plan.pull_request is not None else None,
            base_sha=plan.base_sha,
            merge_commit_sha=plan.merge_commit_sha,
            provider_calls=provider_calls,
            basis=plan.basis,
        )

    def serialize(self) -> dict[str, object]:
        """Deterministic value form for the durable execution record."""
        return {
            "lifecycle": self.lifecycle,
            "condition": self.condition,
            "boundary": self.boundary,
            "next_step": self.next_step,
            "session_id": self.session_id,
            "session_binding": self.session_binding,
            "session_required": self.session_required,
            "pull_request": self.pull_request,
            "base_sha": self.base_sha,
            "merge_commit_sha": self.merge_commit_sha,
            "provider_calls": list(self.provider_calls),
            "basis": list(self.basis),
        }


@dataclass(frozen=True)
class DogfoodFailureRecord:
    """One fail-closed probe: the composed Controller refused, typed.

    ``probe`` names the injected condition; ``error`` is the typed
    refusal (class name + message, verbatim); ``lifecycle_before`` is
    the authority position at the refusal; ``provider_calls`` is the
    complete provider-call log for the probe — empty for the
    contradiction probe (the refusal precedes any provider I/O) and
    read-only for the partial-mutation probe (observations only, zero
    mutations, zero retries).
    """

    probe: str
    lifecycle_before: str
    error: str
    message: str
    provider_calls: tuple[str, ...]
    remote_mutations: tuple[str, ...]
    #: The CTRL-009 classification of the same condition, when the probe
    #: also asked the recovery boundary (the partial-mutation probe:
    #: PARTIAL_MUTATION_UNRESOLVED — stop, never retry).
    recovery_condition: str | None = None

    def serialize(self) -> dict[str, object]:
        """Deterministic value form for the durable execution record."""
        return {
            "probe": self.probe,
            "lifecycle_before": self.lifecycle_before,
            "error": self.error,
            "message": self.message,
            "provider_calls": list(self.provider_calls),
            "remote_mutations": list(self.remote_mutations),
            "recovery_condition": self.recovery_condition,
        }


@dataclass(frozen=True)
class DogfoodExecutionRecord:
    """The complete governed dogfood run: the durable evidence transcript.

    Every field is derived from repository authority, the scripted
    provider surfaces, and the boundaries' own outcomes — nothing from
    wall-clock, randomness, or process-local state — so two runs from
    equivalently built fixtures produce equal records (AC6, replayed by
    the test suite against the committed
    ``tests/dogfood_execution_record.json``).
    """

    work_item: str
    repository: str
    branch: str
    dispatch_base: str
    pr_number: int
    head_initial: str
    head_final: str
    merge_commit_sha: str
    session_id: str
    architect_reviewer: str
    automation_stage: str
    completed_before: tuple[str, ...]
    completed_after: tuple[str, ...]
    next_work_item: str | None
    final_lifecycle: str
    change_iterations: int
    merge_attempts: int
    steps: tuple[DogfoodStepRecord, ...]
    restart: DogfoodRestartRecord | None
    terminal_governance: DogfoodRestartRecord | None
    failures: tuple[DogfoodFailureRecord, ...]
    stage6_statement: str

    def serialize(self) -> dict[str, object]:
        """Deterministic value form for the durable execution record."""
        return {
            "work_item": self.work_item,
            "repository": self.repository,
            "branch": self.branch,
            "dispatch_base": self.dispatch_base,
            "pr_number": self.pr_number,
            "head_initial": self.head_initial,
            "head_final": self.head_final,
            "merge_commit_sha": self.merge_commit_sha,
            "session_id": self.session_id,
            "architect_reviewer": self.architect_reviewer,
            "automation_stage": self.automation_stage,
            "completed_before": list(self.completed_before),
            "completed_after": list(self.completed_after),
            "next_work_item": self.next_work_item,
            "final_lifecycle": self.final_lifecycle,
            "change_iterations": self.change_iterations,
            "merge_attempts": self.merge_attempts,
            "steps": [step.serialize() for step in self.steps],
            "restart": self.restart.serialize() if self.restart is not None else None,
            "terminal_governance": (
                self.terminal_governance.serialize()
                if self.terminal_governance is not None
                else None
            ),
            "failures": [failure.serialize() for failure in self.failures],
            "stage6_statement": self.stage6_statement,
        }


#: The explicit Stage-6 prerequisite statement (AC8) — recorded verbatim
#: on every run; the automation stage itself is preserved, never advanced.
_STAGE6_STATEMENT = (
    "Stage 6 (merge/reconciliation automation) prerequisites per the roadmap "
    "mapping (CTRL-009 + CTRL-010) are exercised end-to-end by this run: the "
    "CTRL-008 merge predicate authorized exactly one merge attempt, the "
    "external-merge continuation recorded the observed merge without a second "
    "attempt after the deliberate restart, the deterministic reconciliation "
    "record derived the completed ledger and selected no next item, and the "
    "CTRL-009 recovery boundary classified and directed the resumption. "
    "automationStage is preserved verbatim (STAGE-1-STATE-MACHINE-AUTOMATION); "
    "CTRL-010 does not advance the stage, and any stage transition remains an "
    "explicit Architect-governed authority update supported by accepted "
    "evidence."
)

# ---------------------------------------------------------------------------
# The scripted scenario world (deterministic, in-memory, no network)
# ---------------------------------------------------------------------------


def _pull_request_payload(
    *,
    state: str,
    head_sha: str,
    merged: bool,
    merge_commit_sha: str | None,
) -> dict[str, object]:
    """The scenario's single governed PR, in the GitHub JSON shape."""
    return {
        "number": SCENARIO_PR_NUMBER,
        "state": state,
        "title": f"{SCENARIO_WORK_ITEM} — End-to-End Dogfood",
        "head": {"ref": SCENARIO_BRANCH, "sha": head_sha},
        "base": {"ref": "main", "sha": SCENARIO_DISPATCH_BASE},
        "draft": False,
        "merged": merged,
        "mergeable_state": "clean",
        "merge_commit_sha": merge_commit_sha,
    }


def _review_payload(
    *,
    review_id: int,
    state: str,
    submitted_at: str,
    commit_id: str,
) -> dict[str, object]:
    """One Architect review, in the GitHub JSON shape."""
    return {
        "id": review_id,
        "user": {"login": SCENARIO_ARCHITECT},
        "state": state,
        "submitted_at": submitted_at,
        "commit_id": commit_id,
    }


def _checks_in(state: str) -> tuple[tuple[str, str], ...]:
    """Every required check context reporting one status state."""
    return tuple((check, state) for check in sorted(SCENARIO_REQUIRED_CHECKS))


def _combined_status_payload(
    *, state: str, checks: tuple[tuple[str, str], ...]
) -> dict[str, object]:
    """The combined commit status at one head, in the GitHub JSON shape."""
    return {
        "state": state,
        "total_count": len(checks),
        "statuses": [
            {"context": context, "state": status_state} for context, status_state in checks
        ],
    }


def _packet_comment_payload() -> dict[str, object]:
    """The Architect's machine-readable REQUEST_CHANGES packet comment.

    The fenced block follows the frozen CTRL-007 grammar exactly (keys
    in order, finding keys in order, iteration 1, the exact observed
    head/base/PR/work item, one finding).
    """
    finding = SCENARIO_FINDING
    body = "\n".join(
        (
            "```review-packet",
            f"work_item: {SCENARIO_WORK_ITEM}",
            f"pr: {SCENARIO_PR_NUMBER}",
            f"head_sha: {SCENARIO_HEAD_V1}",
            f"base_sha: {SCENARIO_DISPATCH_BASE}",
            "iteration: 1",
            "decision: REQUEST_CHANGES",
            "findings:",
            f"  - id: {finding.finding_id}",
            f"    severity: {finding.severity.value}",
            f"    path: {finding.path}",
            f"    criterion: {finding.criterion}",
            f"    required_change: {finding.required_change}",
            "```",
        )
    )
    return {
        "id": 1,
        "user": {"login": SCENARIO_ARCHITECT},
        "created_at": _COMMENT_AT,
        "body": f"ARCHITECT DECISION — REQUEST_CHANGES\n\n{body}",
    }


class DogfoodEvidence:
    """The durable external world the scenario's boundaries observe.

    This is the scripted GitHub/provider surface: one mutable, fully
    deterministic model of the governed PR, its reviews and comments,
    the combined CI status per head, the main branch head, and the
    provider's worker-session report. The scenario runner advances it
    exactly where the governed world would advance (the worker opens
    the PR, CI completes, the Architect reviews, the worker pushes the
    fix, the provider merge lands). The scripted transports serve every
    request from this model, so the same evidence snapshot always
    produces the same boundary decisions (AC6).
    """

    def __init__(self) -> None:
        self._pr: dict[str, object] | None = None
        self._reviews: list[dict[str, object]] = []
        self._comments: list[dict[str, object]] = []
        self._status_by_head: dict[str, dict[str, object]] = {}

    # -- the world advances exactly where the governed loop advances --------

    def worker_opens_pull_request(self) -> None:
        """The dispatched worker pushes the branch and opens the governed PR
        at the first implementation head; CI begins pending."""
        self._pr = _pull_request_payload(
            state="open", head_sha=SCENARIO_HEAD_V1, merged=False, merge_commit_sha=None
        )
        self._status_by_head[SCENARIO_HEAD_V1] = _combined_status_payload(
            state="pending", checks=_checks_in("pending")
        )

    def ci_completes(self, head_sha: str) -> None:
        """The required CI checks reach terminal success at one head."""
        self._status_by_head[head_sha] = _combined_status_payload(
            state="success", checks=_checks_in("success")
        )

    def architect_requests_changes(self) -> None:
        """The Architect submits the REQUEST_CHANGES decision bound to the
        first head and posts the machine-readable review packet."""
        self._reviews.append(
            _review_payload(
                review_id=1,
                state="CHANGES_REQUESTED",
                submitted_at=_REVIEW_CHANGES_AT,
                commit_id=SCENARIO_HEAD_V1,
            )
        )
        self._comments.append(_packet_comment_payload())

    def worker_pushes_fix(self) -> None:
        """The resumed worker resolves the finding and pushes the new head;
        CI at the new head begins pending (the old review is now stale)."""
        assert self._pr is not None
        self._pr["head"] = {"ref": SCENARIO_BRANCH, "sha": SCENARIO_HEAD_V2}
        self._status_by_head[SCENARIO_HEAD_V2] = _combined_status_payload(
            state="pending", checks=_checks_in("pending")
        )

    def architect_approves(self) -> None:
        """The Architect re-reviews and approves, bound to the new head."""
        self._reviews.append(
            _review_payload(
                review_id=2,
                state="APPROVED",
                submitted_at=_REVIEW_APPROVE_AT,
                commit_id=SCENARIO_HEAD_V2,
            )
        )

    def merge_lands(self) -> None:
        """The provider-side merge lands: the PR is closed and merged with
        the exact merge commit (the external evidence the restarted
        process will observe)."""
        assert self._pr is not None
        self._pr["state"] = "closed"
        self._pr["merged"] = True
        self._pr["merge_commit_sha"] = SCENARIO_MERGE_COMMIT

    # -- read access for the scripted transports -----------------------------

    @property
    def pull_request(self) -> dict[str, object] | None:
        return self._pr

    @property
    def reviews(self) -> list[dict[str, object]]:
        return list(self._reviews)

    @property
    def comments(self) -> list[dict[str, object]]:
        return list(self._comments)

    def status_at(self, head_sha: str) -> dict[str, object] | None:
        return self._status_by_head.get(head_sha)

    @property
    def head_sha(self) -> str | None:
        if self._pr is None:
            return None
        head = self._pr["head"]
        assert isinstance(head, dict)
        sha = head["sha"]
        assert isinstance(sha, str)
        return sha


class ScriptedGithubTransport:
    """In-memory GithubTransport serving the :class:`DogfoodEvidence`.

    No network, no tokens: every request is answered from the
    current evidence model and recorded in the call log (method +
    path). The only mutation is the provider-side merge ``PUT`` —
    served exactly like the accepted fake transport serves it, and
    landing the merge in the evidence model — which the CTRL-003
    adapter reaches only through its governed ``merge_pull_request``
    path after the frozen predicate held twice (authorization and
    execution-time re-proof). Any request outside the scenario's
    surface raises the adapter's typed base error (fail closed, never
    guessed).
    """

    def __init__(self, evidence: DogfoodEvidence) -> None:
        self._evidence = evidence
        self.calls: list[tuple[str, str]] = []

    def get_json(self, path: str) -> object:
        self.calls.append(("GET", path))
        return self._serve_get(path)

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append(("POST", path))
        raise _github_refusal(
            f"the scenario GitHub surface has no '{path}' mutation; the "
            "governed loop performs no GitHub-side POST"
        )

    def put_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append(("PUT", path))
        pr = self._evidence.pull_request
        expected = f"/repos/{SCENARIO_REPOSITORY}/pulls/{SCENARIO_PR_NUMBER}/merge"
        if path != expected or pr is None:
            raise _github_refusal(f"unexpected merge request for '{path}'")
        head = pr["head"]
        assert isinstance(head, dict)
        if payload.get("sha") != head.get("sha"):
            raise _github_refusal(
                "merge payload head does not match the governed PR head; the "
                "execution-time re-proof would have refused this first"
            )
        self._evidence.merge_lands()
        return {
            "merged": True,
            "sha": SCENARIO_MERGE_COMMIT,
            "message": f"Pull Request #{SCENARIO_PR_NUMBER} successfully merged",
        }

    # -- read routing ---------------------------------------------------------

    def _serve_get(self, path: str) -> object:
        repo = SCENARIO_REPOSITORY
        pr = self._evidence.pull_request
        if path == f"/repos/{repo}/branches/main":
            return {"name": "main", "commit": {"sha": SCENARIO_DISPATCH_BASE}}
        if path in (
            f"/repos/{repo}/pulls?state=open&head={SCENARIO_REPOSITORY.split('/')[0]}:{SCENARIO_BRANCH}",
            f"/repos/{repo}/pulls?state=all&head={SCENARIO_REPOSITORY.split('/')[0]}:{SCENARIO_BRANCH}",
        ):
            if pr is None:
                return []
            if "state=open" in path and pr.get("state") != "open":
                return []
            return [pr]
        if path == f"/repos/{repo}/pulls/{SCENARIO_PR_NUMBER}":
            if pr is None:
                raise _github_refusal(f"no pull request #{SCENARIO_PR_NUMBER} exists")
            return pr
        if path == f"/repos/{repo}/pulls/{SCENARIO_PR_NUMBER}/reviews":
            return self._evidence.reviews
        if path == f"/repos/{repo}/issues/{SCENARIO_PR_NUMBER}/comments":
            return self._evidence.comments
        for head_sha in (SCENARIO_HEAD_V1, SCENARIO_HEAD_V2):
            if path == f"/repos/{repo}/commits/{head_sha}/status":
                status = self._evidence.status_at(head_sha)
                if status is None:
                    raise _github_refusal(f"no commit status observed for head {head_sha}")
                return status
        raise _github_refusal(f"no scripted evidence serves '{path}'")


class ScriptedZaiTransport:
    """In-memory ZaiTransport serving the scenario's worker execution.

    The provider identifies the one governed worker session for the
    exact context: a start reports the session bound to the requested
    repository/work item/base (and PR identity when the request carries
    one — the resume), and a resume reports the very session the caller
    named. Every call is recorded. No network, no tokens; any
    other path fails closed with the adapter's typed base error.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append(("POST", path))
        repository = payload.get("repository")
        work_item = payload.get("work_item")
        base_sha = payload.get("base_sha")
        pr = payload.get("pr")
        pr_number: int | None = None
        head_sha: str | None = None
        if isinstance(pr, dict) and pr.get("number") is not None:
            pr_number = int(pr["number"])
            head_sha = str(pr.get("head_sha"))
        session_id = SCENARIO_SESSION_ID
        if path != "/worker/sessions":
            prefix = "/worker/sessions/"
            suffix = "/resume"
            if not (path.startswith(prefix) and path.endswith(suffix)):
                raise _zai_refusal(f"no scripted provider surface serves '{path}'")
            requested = path[len(prefix) : -len(suffix)]
            if requested != SCENARIO_SESSION_ID:
                raise _zai_refusal(
                    f"the provider identifies session '{SCENARIO_SESSION_ID}'; "
                    f"'{requested}' is a foreign execution identity"
                )
        return {
            "session_id": session_id,
            "repository": repository,
            "work_item": work_item,
            "base_sha": base_sha,
            "pr_number": pr_number,
            "head_sha": head_sha,
            "status": "active",
            "updated_at": _SESSION_UPDATED_AT,
        }


def _github_refusal(message: str) -> ControllerError:
    """The typed adapter base error for scripted-surface refusals."""
    from controller.errors import GithubAdapterError

    return GithubAdapterError(f"scripted dogfood GitHub surface: {message}")


def _zai_refusal(message: str) -> ControllerError:
    """The typed adapter base error for scripted-surface refusals."""
    from controller.errors import ZaiAdapterError

    return ZaiAdapterError(f"scripted dogfood provider surface: {message}")


# ---------------------------------------------------------------------------
# The synthetic scenario repository and the governed-commit projection
# ---------------------------------------------------------------------------

_STATE_FILE = "spec/state/controller-program-state.json"

#: The seven non-negotiable architecture rules, all affirmed (the same
#: frozen vocabulary the real repository authority declares).
_SCENARIO_RULES = {
    "repositoryIsSourceOfTruth": True,
    "controllerRuntimeStateIsReconstructible": True,
    "onePrPerWorkItem": True,
    "workerCannotMerge": True,
    "failClosedOnContradiction": True,
    "humanOperatorIsTemporaryMechanicalController": True,
    "architectMustAnnounceAutomationStage": True,
}

_STATUS_LINE: re.Pattern[str] = re.compile(r"^Status:\s*`[A-Z_]+`\s*$", re.MULTILINE)


def materialize_scenario_repository(
    base_dir: Path,
    *,
    status: str = LifecycleState.READY.value,
    completed: tuple[str, ...] = SCENARIO_COMPLETED_BEFORE,
) -> Path:
    """Materialize the synthetic scenario repository under ``base_dir``.

    The tree has the exact shape repository authority requires
    (CTRL-001): the machine-state JSON declaring the repository, the
    referenced authority documents, the active work item and its
    status, the completed ledger, the affirmed rules, and the
    automation stage; plus the referenced authority stubs and the
    frozen work order whose ``Status:`` line agrees with machine state.
    Only files inside ``base_dir`` are written — the real repository is
    never touched by the dogfood.
    """
    root = base_dir / "scenario-repo"
    (root / "spec/state").mkdir(parents=True, exist_ok=True)
    (root / "spec/roadmap").mkdir(parents=True, exist_ok=True)
    (root / "spec/architecture").mkdir(parents=True, exist_ok=True)
    (root / "spec/operations").mkdir(parents=True, exist_ok=True)
    (root / "spec/work-items").mkdir(parents=True, exist_ok=True)
    state: dict[str, object] = {
        "schemaVersion": "0.1",
        "repository": SCENARIO_REPOSITORY,
        "roadmap": "spec/roadmap/roadmap.md",
        "architecture": "spec/architecture/controller-architecture.md",
        "buildProcess": "spec/operations/controller-build-process.md",
        "activeWorkItem": SCENARIO_WORK_ITEM,
        "status": status,
        "automationStage": SCENARIO_AUTOMATION_STAGE,
        "completed": list(completed),
        "rules": dict(_SCENARIO_RULES),
        "nextAction": "synthetic dogfood scenario authority",
    }
    (root / _STATE_FILE).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    for relative in (
        "spec/roadmap/roadmap.md",
        "spec/architecture/controller-architecture.md",
        "spec/operations/controller-build-process.md",
    ):
        (root / relative).write_text("# synthetic dogfood authority stub\n", encoding="utf-8")
    (root / SCENARIO_WORK_ORDER_PATH).write_text(
        f"# {SCENARIO_WORK_ITEM} — End-to-End Dogfood\n\n"
        f"Status: `{status}`\n\nSynthetic dogfood work order body.\n",
        encoding="utf-8",
    )
    return root


def _project_event(repo_root: Path, event: DomainEvent) -> None:
    """Project one applied domain event into the scenario machine state.

    This is the governed-commit simulation: in Stage 1 the human
    operator records each governed transition in repository authority
    (the machine-state ``status`` and the work order's ``Status:`` line
    — the two surfaces CTRL-001 authority cross-checks). The dogfood
    harness performs the same recording on the **synthetic** repository
    only; the boundaries themselves never mutate authority.
    """
    state = _read_state(repo_root)
    state["status"] = event.to_state.value
    _write_state(repo_root, state)
    work_order = repo_root / SCENARIO_WORK_ORDER_PATH
    text = work_order.read_text(encoding="utf-8")
    updated = _STATUS_LINE.sub(f"Status: `{event.to_state.value}`", text, count=1)
    if updated == text:
        raise _scenario_defect("the scenario work order lost its Status line")
    work_order.write_text(updated, encoding="utf-8")


def _project_reconciliation(repo_root: Path, record: dict[str, object]) -> None:
    """Project the derived reconciliation record into the scenario state.

    The runtime persists exactly what the CTRL-008 boundary derived:
    the completed ledger after (authority's own tuple plus this item)
    and the completed status — never a next-item identity and never a
    stage change (those remain explicit Architect-governed acts).
    """
    completed_after = record["completed_after"]
    assert isinstance(completed_after, list)
    state = _read_state(repo_root)
    state["completed"] = completed_after
    _write_state(repo_root, state)


def _read_state(repo_root: Path) -> dict[str, object]:
    data = json.loads((repo_root / _STATE_FILE).read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _write_state(repo_root: Path, state: dict[str, object]) -> None:
    (repo_root / _STATE_FILE).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _scenario_defect(message: str) -> ControllerError:
    """The typed error for an internal scenario inconsistency (never caught
    silently: a broken fixture must fail loudly, not pass the dogfood)."""
    from controller.errors import ContradictionError

    return ContradictionError(f"dogfood scenario defect: {message}")


# ---------------------------------------------------------------------------
# The composed governed dogfood run (AC1 through AC8)
# ---------------------------------------------------------------------------


class _ScenarioRun:
    """One execution of the scenario: the boundaries, the world, the log."""

    def __init__(self, base_dir: Path) -> None:
        self.evidence = DogfoodEvidence()
        self.github_transport = ScriptedGithubTransport(self.evidence)
        self.zai_transport = ScriptedZaiTransport()
        github = GithubAdapter(self.github_transport, SCENARIO_REPOSITORY)
        zai = ZaiAdapter(self.zai_transport, SCENARIO_REPOSITORY)
        self.orchestrator = Orchestrator(github=github, zai=zai)
        self.gate = EvidenceGate(github=github)
        self.review_loop = ArchitectReviewLoop(github=github)
        self.merge_loop = MergeReconciliationLoop(github=github)
        self.recovery = RecoveryBoundary(github=github)
        self.repo_root = materialize_scenario_repository(base_dir)
        self.steps: list[DogfoodStepRecord] = []
        self._github_mark = 0
        self._zai_mark = 0

    # -- provider-call accounting (the mutation proof surface) ----------------

    def call_delta(self) -> tuple[str, ...]:
        """The provider calls made since the last delta, as one log."""
        github_calls = [
            f"{method} {path}" for method, path in self.github_transport.calls[self._github_mark :]
        ]
        zai_calls = [
            f"{method} {path}" for method, path in self.zai_transport.calls[self._zai_mark :]
        ]
        return tuple(github_calls + zai_calls)

    def remote_mutations(self) -> tuple[str, ...]:
        """The remote mutations (POST/PUT) made since the last delta."""
        return tuple(call for call in self.call_delta() if not call.startswith("GET "))

    # -- step recording --------------------------------------------------------

    def record(
        self,
        *,
        phase: str,
        boundary: str,
        lifecycle_before: str,
        lifecycle_after: str,
        event_command: str | None,
        outcome: str,
        identity: dict[str, object],
        projected: bool = True,
    ) -> None:
        """Append one composed step with its provider-call proof."""
        calls = self.call_delta()
        self.steps.append(
            DogfoodStepRecord(
                step=len(self.steps) + 1,
                phase=phase,
                boundary=boundary,
                lifecycle_before=lifecycle_before,
                lifecycle_after=lifecycle_after,
                event_command=event_command,
                outcome=outcome,
                identity=identity,
                provider_calls=calls,
                projected=projected,
            )
        )
        self._github_mark = len(self.github_transport.calls)
        self._zai_mark = len(self.zai_transport.calls)


def _apply_event(repo_root: Path, event: DomainEvent | None) -> None:
    """Project one boundary-returned event into the scenario machine state
    (the governed-commit simulation; no-op for pure observations).

    The CTRL-001 authority checker guards every projection: repository
    authority must remain valid and reconstructible after each governed
    state write — the whole-run coherence invariant the dogfood proves
    on top of the per-boundary decisions.
    """
    if event is not None:
        _project_event(repo_root, event)
        verify_authority(repo_root)


def run_governed_dogfood(base_dir: Path) -> DogfoodExecutionRecord:
    """Execute the complete governed dogfood scenario once, deterministically.

    The run composes the accepted boundaries in the frozen order —
    dispatch, implementation start, PR observation, CI wait, evidence
    classification, Architect review with one REQUEST_CHANGES
    iteration, same-worker/same-PR resume, re-review approval, the one
    authorized merge, a deliberate interruption and CTRL-009-directed
    resumption, merge recording, reconciliation — and returns the
    durable execution record. It never mutates anything outside the
    synthetic scenario repository under ``base_dir``.
    """
    run = _ScenarioRun(base_dir)
    evidence = run.evidence
    refs = OrchestrationReferences(
        branch=SCENARIO_BRANCH,
        base_sha=SCENARIO_DISPATCH_BASE,
        architect_reviewer=SCENARIO_ARCHITECT,
    )
    policy = EvidencePolicy(required_checks=SCENARIO_REQUIRED_CHECKS)
    merge_policy = MergePolicy(required_checks=SCENARIO_REQUIRED_CHECKS)

    # -- Step 1: READY + eligible -> the orchestrator dispatches the worker --
    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, WorkerDispatched), "step 1 must dispatch the worker"
    session = outcome.session
    assert session.session_id == SCENARIO_SESSION_ID, "step 1 session identity"
    assert session.work_item == SCENARIO_WORK_ITEM, "step 1 session work item"
    assert session.base_sha == SCENARIO_DISPATCH_BASE, "step 1 session dispatch base"
    assert session.pr_number is None and session.head_sha is None, "step 1 session is pre-PR"
    refs = replace(refs, worker_session=session)
    run.record(
        phase="dispatch-worker",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.READY.value,
        lifecycle_after=LifecycleState.DISPATCHED.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={
            "work_item": outcome.work_item,
            "session_id": session.session_id,
            "base_sha": session.base_sha,
        },
    )
    _apply_event(run.repo_root, outcome.event)

    # -- Step 2: DISPATCHED + proven session -> implementation begins --------
    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, ImplementationStarted), "step 2 must begin implementation"
    assert outcome.session_id == SCENARIO_SESSION_ID, "step 2 provenance re-proof identity"
    run.record(
        phase="begin-implementation",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.DISPATCHED.value,
        lifecycle_after=LifecycleState.IMPLEMENTING.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={"work_item": outcome.work_item, "session_id": outcome.session_id},
    )
    _apply_event(run.repo_root, outcome.event)

    # -- Step 3: IMPLEMENTING + the worker opens the governed PR at head V1 --
    evidence.worker_opens_pull_request()
    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, PullRequestOpened), "step 3 must open the governed PR"
    assert outcome.pull_request.number == SCENARIO_PR_NUMBER, "step 3 PR identity"
    assert outcome.pull_request.head_sha == SCENARIO_HEAD_V1, "step 3 PR head V1"
    assert outcome.pull_request.base_sha == SCENARIO_DISPATCH_BASE, "step 3 PR base"
    run.record(
        phase="open-pull-request",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.IMPLEMENTING.value,
        lifecycle_after=LifecycleState.PR_OPEN.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={
            "work_item": outcome.work_item,
            "pr": outcome.pull_request.number,
            "head_sha": outcome.pull_request.head_sha,
            "base_sha": outcome.pull_request.base_sha,
        },
    )
    _apply_event(run.repo_root, outcome.event)

    # -- Step 4: PR_OPEN -> the CI wait begins --------------------------------
    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, AwaitingCI), "step 4 must begin the CI wait"
    run.record(
        phase="await-ci",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.PR_OPEN.value,
        lifecycle_after=LifecycleState.CI_PENDING.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={"pr": SCENARIO_PR_NUMBER, "head_sha": SCENARIO_HEAD_V1},
    )
    _apply_event(run.repo_root, outcome.event)

    # -- Step 5: CI_PENDING + terminal success -> the evidence gate records --
    evidence.ci_completes(SCENARIO_HEAD_V1)
    gate_outcome = run.gate.evaluate(run.repo_root, refs, policy)
    assert gate_outcome.classification is EvidenceClassification.TERMINAL_SUCCESS, (
        "step 5 must classify terminal success"
    )
    assert gate_outcome.head_sha == SCENARIO_HEAD_V1, "step 5 evidence head identity"
    assert gate_outcome.successful_checks == tuple(sorted(SCENARIO_REQUIRED_CHECKS)), (
        "step 5 required checks identity"
    )
    run.record(
        phase="record-ci-success",
        boundary="EVIDENCE_GATE",
        lifecycle_before=LifecycleState.CI_PENDING.value,
        lifecycle_after=LifecycleState.REVIEW_PENDING.value,
        event_command=gate_outcome.event.command.value if gate_outcome.event else None,
        outcome="EvidenceGateOutcome",
        identity={
            "pr": gate_outcome.pr_number,
            "head_sha": gate_outcome.head_sha,
            "base_sha": gate_outcome.base_sha,
            "classification": gate_outcome.classification.value,
        },
    )
    _apply_event(run.repo_root, gate_outcome.event)

    # -- Step 6: REVIEW_PENDING + Architect REQUEST_CHANGES (iteration 1) ----
    evidence.architect_requests_changes()
    review_outcome = run.review_loop.evaluate(run.repo_root, refs)
    assert review_outcome.decision is ReviewDecision.REQUEST_CHANGES, (
        "step 6 must observe REQUEST_CHANGES"
    )
    assert review_outcome.iteration == 1, "step 6 change iteration is 1"
    packet = review_outcome.packet
    assert packet is not None, "step 6 must validate the review packet"
    assert packet.head_sha == SCENARIO_HEAD_V1, "step 6 packet head identity"
    assert packet.findings == (SCENARIO_FINDING,), "step 6 packet carries the verbatim finding"
    handoff = review_outcome.handoff
    assert handoff is not None, "step 6 must hand off to the same worker/PR"
    assert handoff.session_id == SCENARIO_SESSION_ID, "step 6 handoff session identity"
    assert handoff.pr_number == SCENARIO_PR_NUMBER, "step 6 handoff PR identity"
    run.record(
        phase="architect-request-changes",
        boundary="REVIEW_LOOP",
        lifecycle_before=LifecycleState.REVIEW_PENDING.value,
        lifecycle_after=LifecycleState.CHANGES_REQUESTED.value,
        event_command=review_outcome.event.command.value if review_outcome.event else None,
        outcome="ReviewLoopOutcome",
        identity={
            "pr": SCENARIO_PR_NUMBER,
            "head_sha": SCENARIO_HEAD_V1,
            "base_sha": SCENARIO_DISPATCH_BASE,
            "iteration": review_outcome.iteration,
            "decision": review_outcome.decision.value,
            "session_id": SCENARIO_SESSION_ID,
        },
    )
    _apply_event(run.repo_root, review_outcome.event)

    # -- Step 7: CHANGES_REQUESTED -> the same worker/PR context resumes -----
    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, WorkerResumed), "step 7 must resume the same worker"
    assert outcome.session.session_id == SCENARIO_SESSION_ID, "step 7 resume session identity"
    assert outcome.session.pr_number == SCENARIO_PR_NUMBER, "step 7 resume PR identity"
    assert len(outcome.findings) == 1, "step 7 carries the verbatim findings"
    run.record(
        phase="resume-same-worker-same-pr",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.CHANGES_REQUESTED.value,
        lifecycle_after=LifecycleState.IMPLEMENTING.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={
            "work_item": outcome.work_item,
            "session_id": outcome.session.session_id,
            "pr": outcome.session.pr_number,
            "head_sha": outcome.session.head_sha,
            "findings": len(outcome.findings),
        },
    )
    _apply_event(run.repo_root, outcome.event)
    evidence.worker_pushes_fix()

    # -- Steps 8-9: the new head's PR observation and CI wait ----------------
    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, PullRequestOpened), "step 8 must re-open the governed PR"
    assert outcome.pull_request.head_sha == SCENARIO_HEAD_V2, "step 8 PR head V2"
    run.record(
        phase="open-pull-request-iteration-2",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.IMPLEMENTING.value,
        lifecycle_after=LifecycleState.PR_OPEN.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={
            "pr": outcome.pull_request.number,
            "head_sha": outcome.pull_request.head_sha,
            "base_sha": outcome.pull_request.base_sha,
        },
    )
    _apply_event(run.repo_root, outcome.event)

    outcome = run.orchestrator.run_cycle(run.repo_root, refs)
    assert isinstance(outcome, AwaitingCI), "step 9 must begin the CI wait again"
    run.record(
        phase="await-ci-iteration-2",
        boundary="ORCHESTRATOR",
        lifecycle_before=LifecycleState.PR_OPEN.value,
        lifecycle_after=LifecycleState.CI_PENDING.value,
        event_command=outcome.event.command.value if outcome.event else None,
        outcome=type(outcome).__name__,
        identity={"pr": SCENARIO_PR_NUMBER, "head_sha": SCENARIO_HEAD_V2},
    )
    _apply_event(run.repo_root, outcome.event)

    # -- Step 10: terminal success at the new head ----------------------------
    evidence.ci_completes(SCENARIO_HEAD_V2)
    gate_outcome = run.gate.evaluate(run.repo_root, refs, policy)
    assert gate_outcome.classification is EvidenceClassification.TERMINAL_SUCCESS, (
        "step 10 must classify terminal success at the new head"
    )
    assert gate_outcome.head_sha == SCENARIO_HEAD_V2, "step 10 evidence head identity"
    run.record(
        phase="record-ci-success-iteration-2",
        boundary="EVIDENCE_GATE",
        lifecycle_before=LifecycleState.CI_PENDING.value,
        lifecycle_after=LifecycleState.REVIEW_PENDING.value,
        event_command=gate_outcome.event.command.value if gate_outcome.event else None,
        outcome="EvidenceGateOutcome",
        identity={
            "pr": gate_outcome.pr_number,
            "head_sha": gate_outcome.head_sha,
            "base_sha": gate_outcome.base_sha,
            "classification": gate_outcome.classification.value,
        },
    )
    _apply_event(run.repo_root, gate_outcome.event)

    # -- Step 11: the Architect re-approves, bound to the new head ------------
    evidence.architect_approves()
    review_outcome = run.review_loop.evaluate(run.repo_root, refs)
    assert review_outcome.decision is ReviewDecision.APPROVE, "step 11 must observe APPROVE"
    run.record(
        phase="architect-approve",
        boundary="REVIEW_LOOP",
        lifecycle_before=LifecycleState.REVIEW_PENDING.value,
        lifecycle_after=LifecycleState.APPROVED.value,
        event_command=review_outcome.event.command.value if review_outcome.event else None,
        outcome="ReviewLoopOutcome",
        identity={
            "pr": SCENARIO_PR_NUMBER,
            "head_sha": SCENARIO_HEAD_V2,
            "base_sha": SCENARIO_DISPATCH_BASE,
            "decision": review_outcome.decision.value,
        },
    )
    _apply_event(run.repo_root, review_outcome.event)

    # -- Step 12: the one authorized merge attempt executes -------------------
    merge_outcome = run.merge_loop.evaluate(run.repo_root, refs, merge_policy)
    assert merge_outcome.merge_attempted, "step 12 must execute the one merge attempt"
    assert merge_outcome.merge_commit_sha == SCENARIO_MERGE_COMMIT, "step 12 merge identity"
    assert merge_outcome.pull_request.head_sha == SCENARIO_HEAD_V2, "step 12 merged head"
    assert merge_outcome.dispatch_base == SCENARIO_DISPATCH_BASE, "step 12 dispatch-base provenance"
    run.record(
        phase="authorized-merge-attempt-state-write-lost",
        boundary="MERGE_BOUNDARY",
        lifecycle_before=LifecycleState.APPROVED.value,
        lifecycle_after=LifecycleState.APPROVED.value,
        event_command=merge_outcome.event.command.value if merge_outcome.event else None,
        outcome="MergeLoopOutcome",
        identity={
            "pr": merge_outcome.pull_request.number,
            "head_sha": merge_outcome.pull_request.head_sha,
            "base_sha": merge_outcome.base_sha,
            "dispatch_base": merge_outcome.dispatch_base,
            "merge_commit_sha": merge_outcome.merge_commit_sha,
            "merge_attempted": merge_outcome.merge_attempted,
        },
        projected=False,
    )
    # THE DELIBERATE INTERRUPTION: the governed state write after the merge
    # mutation is simulated as lost. The machine state still records
    # APPROVED while the PR is observed merged — the restart below carries
    # only durable identity references and reconstructs everything else.

    # -- Step 13: the restarted process asks CTRL-009 to classify ------------
    restart_refs = OrchestrationReferences(
        branch=SCENARIO_BRANCH,
        base_sha=SCENARIO_DISPATCH_BASE,
        worker_session=session,
        architect_reviewer=SCENARIO_ARCHITECT,
    )
    plan = run.recovery.evaluate(run.repo_root, restart_refs)
    assert plan.condition is RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED, (
        "step 13 must classify the observed external completion"
    )
    assert plan.boundary is GovernedBoundary.MERGE_BOUNDARY, "step 13 directs the merge boundary"
    assert plan.next_step == "MERGE", "step 13 next step is MERGE"
    assert plan.merge_commit_sha == SCENARIO_MERGE_COMMIT, "step 13 observed merge identity"
    assert plan.session_binding is SessionBinding.VERIFIED_ISSUED, (
        "step 13 session provenance is verified"
    )
    restart_record = DogfoodRestartRecord.from_plan(plan, run.call_delta())
    run.record(
        phase="restart-classification",
        boundary="RECOVERY_BOUNDARY",
        lifecycle_before=LifecycleState.APPROVED.value,
        lifecycle_after=LifecycleState.APPROVED.value,
        event_command=None,
        outcome="RecoveryPlan",
        identity={
            "condition": plan.condition.value,
            "boundary": plan.boundary.value,
            "next_step": plan.next_step,
            "merge_commit_sha": plan.merge_commit_sha,
            "base_sha": plan.base_sha,
        },
    )

    # -- Step 14: the owning boundary records the observed merge -------------
    merge_outcome = run.merge_loop.evaluate(run.repo_root, refs, merge_policy)
    assert not merge_outcome.merge_attempted, "step 14 must NOT re-attempt the merge"
    assert merge_outcome.merge_commit_sha == SCENARIO_MERGE_COMMIT, "step 14 merge identity"
    assert merge_outcome.authorization is None, "step 14 issues no new authorization"
    step14_mutations = run.remote_mutations()
    assert not step14_mutations, f"step 14 performed remote mutations: {step14_mutations}"
    run.record(
        phase="record-observed-merge-no-second-attempt",
        boundary="MERGE_BOUNDARY",
        lifecycle_before=LifecycleState.APPROVED.value,
        lifecycle_after=LifecycleState.MERGING.value,
        event_command=merge_outcome.event.command.value if merge_outcome.event else None,
        outcome="MergeLoopOutcome",
        identity={
            "pr": merge_outcome.pull_request.number,
            "head_sha": merge_outcome.pull_request.head_sha,
            "merge_commit_sha": merge_outcome.merge_commit_sha,
            "merge_attempted": merge_outcome.merge_attempted,
        },
    )
    _apply_event(run.repo_root, merge_outcome.event)

    # -- Steps 15-16: merge recording and reconcile transition ----------------
    merge_outcome = run.merge_loop.evaluate(run.repo_root, refs, merge_policy)
    assert merge_outcome.event.command.value == "RECORD_MERGE", "step 15 must record the merge"
    run.record(
        phase="record-merge",
        boundary="MERGE_BOUNDARY",
        lifecycle_before=LifecycleState.MERGING.value,
        lifecycle_after=LifecycleState.MERGED.value,
        event_command=merge_outcome.event.command.value,
        outcome="MergeLoopOutcome",
        identity={
            "pr": merge_outcome.pull_request.number,
            "merge_commit_sha": merge_outcome.merge_commit_sha,
        },
    )
    _project_event(run.repo_root, merge_outcome.event)

    merge_outcome = run.merge_loop.evaluate(run.repo_root, refs, merge_policy)
    assert merge_outcome.event.command.value == "RECONCILE", "step 16 must begin reconciliation"
    run.record(
        phase="reconcile",
        boundary="MERGE_BOUNDARY",
        lifecycle_before=LifecycleState.MERGED.value,
        lifecycle_after=LifecycleState.RECONCILING.value,
        event_command=merge_outcome.event.command.value,
        outcome="MergeLoopOutcome",
        identity={
            "pr": merge_outcome.pull_request.number,
            "merge_commit_sha": merge_outcome.merge_commit_sha,
        },
    )
    _project_event(run.repo_root, merge_outcome.event)

    # -- Step 17: the deterministic reconciliation record ---------------------
    merge_outcome = run.merge_loop.evaluate(run.repo_root, refs, merge_policy)
    assert merge_outcome.record is not None, "step 17 must derive the reconciliation record"
    record = merge_outcome.record
    assert record is not None, "step 17 must derive the reconciliation record"
    assert record.completed_after == (*SCENARIO_COMPLETED_BEFORE, SCENARIO_WORK_ITEM), (
        "step 17 completed ledger derivation"
    )
    assert record.next_work_item is None, (
        "step 17 selects no next item (the successor is Architect governance)"
    )
    assert record.automation_stage == SCENARIO_AUTOMATION_STAGE, (
        "step 17 preserves the automation stage verbatim"
    )
    run.record(
        phase="record-reconciliation",
        boundary="MERGE_BOUNDARY",
        lifecycle_before=LifecycleState.RECONCILING.value,
        lifecycle_after=LifecycleState.COMPLETE.value,
        event_command=merge_outcome.event.command.value,
        outcome="MergeLoopOutcome",
        identity={
            "pr": merge_outcome.pull_request.number,
            "merge_commit_sha": merge_outcome.merge_commit_sha,
            "next_work_item": record.next_work_item if record is not None else None,
            "automation_stage": record.automation_stage if record is not None else None,
        },
    )
    _project_event(run.repo_root, merge_outcome.event)
    if record is not None:
        _project_reconciliation(run.repo_root, record.serialize())

    # -- Step 18: the terminal observation — governance owns advancement -----
    plan = run.recovery.evaluate(run.repo_root, restart_refs)
    assert plan.condition is RecoveryCondition.AWAITING_GOVERNANCE, (
        "step 18 must classify the completed lifecycle as awaiting governance"
    )
    assert plan.boundary is GovernedBoundary.ARCHITECT_GOVERNANCE, "step 18 governance boundary"
    terminal_record = DogfoodRestartRecord.from_plan(plan, run.call_delta())
    run.record(
        phase="terminal-awaiting-governance",
        boundary="RECOVERY_BOUNDARY",
        lifecycle_before=LifecycleState.COMPLETE.value,
        lifecycle_after=LifecycleState.COMPLETE.value,
        event_command=None,
        outcome="RecoveryPlan",
        identity={
            "condition": plan.condition.value,
            "boundary": plan.boundary.value,
            "next_step": plan.next_step,
            "merge_commit_sha": plan.merge_commit_sha,
        },
    )

    failures = run_fail_closed_probes(base_dir)
    stage_after = _read_state(run.repo_root)["automationStage"]
    assert stage_after == SCENARIO_AUTOMATION_STAGE, (
        "the automation stage must be preserved verbatim for the whole run"
    )
    return DogfoodExecutionRecord(
        work_item=SCENARIO_WORK_ITEM,
        repository=SCENARIO_REPOSITORY,
        branch=SCENARIO_BRANCH,
        dispatch_base=SCENARIO_DISPATCH_BASE,
        pr_number=SCENARIO_PR_NUMBER,
        head_initial=SCENARIO_HEAD_V1,
        head_final=SCENARIO_HEAD_V2,
        merge_commit_sha=SCENARIO_MERGE_COMMIT,
        session_id=SCENARIO_SESSION_ID,
        architect_reviewer=SCENARIO_ARCHITECT,
        automation_stage=SCENARIO_AUTOMATION_STAGE,
        completed_before=SCENARIO_COMPLETED_BEFORE,
        completed_after=(*SCENARIO_COMPLETED_BEFORE, SCENARIO_WORK_ITEM),
        next_work_item=None,
        final_lifecycle=LifecycleState.COMPLETE.value,
        change_iterations=1,
        merge_attempts=1,
        steps=tuple(run.steps),
        restart=restart_record,
        terminal_governance=terminal_record,
        failures=failures,
        stage6_statement=_STAGE6_STATEMENT,
    )


# ---------------------------------------------------------------------------
# Fail-closed probes (AC9: contradiction and unsafe partial operation)
# ---------------------------------------------------------------------------


def run_fail_closed_probes(base_dir: Path) -> tuple[DogfoodFailureRecord, ...]:
    """Probe the composed Controller's fail-closed behavior, deterministically.

    Probe 1 — **contradictory carried session** (identity corruption):
    at ``DISPATCHED`` a carried worker session bound to a foreign work
    item is refused by the orchestrator's identity proof with a typed
    contradiction **before any provider call** (both transport logs stay
    empty).

    Probe 2 — **unsafe partial operation** (the unobserved merge
    outcome): machine state records ``MERGING`` while the governed PR
    is still open and unmerged. The CTRL-009 recovery boundary
    classifies ``PARTIAL_MUTATION_UNRESOLVED`` and directs nothing (the
    stop, never-retry doctrine); the CTRL-008 merge boundary itself
    refuses with a typed contradiction. Every provider call in the
    probe is a read — zero mutations, zero retries.
    """
    return (_foreign_session_probe(base_dir), _partial_mutation_probe(base_dir))


def _foreign_session_probe(base_dir: Path) -> DogfoodFailureRecord:
    """Probe 1: a foreign carried session refuses before any provider I/O."""
    run = _ScenarioRun(base_dir / "probe-foreign-session")
    _project_scenario_status(run.repo_root, LifecycleState.DISPATCHED.value)
    foreign_session = ZaiWorkerSession(
        session_id=SCENARIO_SESSION_ID,
        repository=SCENARIO_REPOSITORY,
        work_item="CTRL-009",
        base_sha=SCENARIO_DISPATCH_BASE,
        pr_number=None,
        head_sha=None,
        status="active",
        updated_at=_SESSION_UPDATED_AT,
    )
    refs = OrchestrationReferences(
        branch=SCENARIO_BRANCH,
        base_sha=SCENARIO_DISPATCH_BASE,
        worker_session=foreign_session,
        architect_reviewer=SCENARIO_ARCHITECT,
    )
    try:
        run.orchestrator.run_cycle(run.repo_root, refs)
    except OrchestrationContradictionError as exc:
        calls = run.call_delta()
        if calls:
            raise _scenario_defect(
                f"the foreign-session refusal must precede every provider call; observed: {calls}"
            ) from exc
        return DogfoodFailureRecord(
            probe="foreign-session-contradiction",
            lifecycle_before=LifecycleState.DISPATCHED.value,
            error=type(exc).__name__,
            message=str(exc),
            provider_calls=calls,
            remote_mutations=(),
        )
    raise _scenario_defect("the foreign-session probe must fail closed")


def _partial_mutation_probe(base_dir: Path) -> DogfoodFailureRecord:
    """Probe 2: an unobserved merge outcome stops; nothing is retried."""
    run = _ScenarioRun(base_dir / "probe-partial-mutation")
    _project_scenario_status(run.repo_root, LifecycleState.MERGING.value)
    run.evidence.worker_opens_pull_request()
    run.evidence.ci_completes(SCENARIO_HEAD_V1)
    refs = OrchestrationReferences(
        branch=SCENARIO_BRANCH,
        base_sha=SCENARIO_DISPATCH_BASE,
        architect_reviewer=SCENARIO_ARCHITECT,
    )
    plan = run.recovery.evaluate(run.repo_root, refs)
    if plan.condition is not RecoveryCondition.PARTIAL_MUTATION_UNRESOLVED:
        raise _scenario_defect(
            "the partial-mutation probe must classify "
            f"PARTIAL_MUTATION_UNRESOLVED, observed {plan.condition.value}"
        )
    if plan.next_step is not None:
        raise _scenario_defect("the partial-mutation plan must direct no next step")
    calls_before = len(run.github_transport.calls) + len(run.zai_transport.calls)
    try:
        run.merge_loop.evaluate(
            run.repo_root,
            refs,
            MergePolicy(required_checks=SCENARIO_REQUIRED_CHECKS),
        )
    except MergeContradictionError as exc:
        calls = run.call_delta()
        mutations = tuple(call for call in calls if not call.startswith("GET "))
        if mutations:
            raise _scenario_defect(
                f"the partial-mutation refusal must perform zero mutations; observed: {mutations}"
            ) from exc
        if len(run.github_transport.calls) + len(run.zai_transport.calls) == calls_before:
            raise _scenario_defect(
                "the merge refusal must be observed after read-only I/O"
            ) from exc
        return DogfoodFailureRecord(
            probe="partial-mutation-unresolved",
            lifecycle_before=LifecycleState.MERGING.value,
            error=type(exc).__name__,
            message=str(exc),
            provider_calls=calls,
            remote_mutations=mutations,
            recovery_condition=plan.condition.value,
        )
    raise _scenario_defect("the partial-mutation probe must fail closed")


def _project_scenario_status(repo_root: Path, status: str) -> None:
    """Place the synthetic scenario repository at one lifecycle position
    (the probe fixtures start mid-loop, exactly like the boundary unit
    tests' synthetic authorities)."""
    state = _read_state(repo_root)
    state["status"] = status
    _write_state(repo_root, state)
    work_order = repo_root / SCENARIO_WORK_ORDER_PATH
    text = work_order.read_text(encoding="utf-8")
    work_order.write_text(_STATUS_LINE.sub(f"Status: `{status}`", text, count=1), encoding="utf-8")


__all__ = [
    "DogfoodEvidence",
    "DogfoodExecutionRecord",
    "DogfoodFailureRecord",
    "DogfoodRestartRecord",
    "DogfoodStepRecord",
    "ScriptedGithubTransport",
    "ScriptedZaiTransport",
    "SCENARIO_ARCHITECT",
    "SCENARIO_BRANCH",
    "SCENARIO_COMPLETED_BEFORE",
    "SCENARIO_DISPATCH_BASE",
    "SCENARIO_FINDING",
    "SCENARIO_HEAD_V1",
    "SCENARIO_HEAD_V2",
    "SCENARIO_MERGE_COMMIT",
    "SCENARIO_PR_NUMBER",
    "SCENARIO_REPOSITORY",
    "SCENARIO_REQUIRED_CHECKS",
    "SCENARIO_SESSION_ID",
    "SCENARIO_WORK_ITEM",
    "SCENARIO_WORK_ORDER_PATH",
    "materialize_scenario_repository",
    "run_fail_closed_probes",
    "run_governed_dogfood",
]
