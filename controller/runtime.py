"""Production Controller runtime (CTRL-011).

The runnable, continuously usable Controller process over the accepted
Stage-7 orchestration boundaries. Doctrine (the work order, verbatim
in intent):

* **Authority first, every cycle.** Before any governed action the
  runtime re-loads and re-validates repository authority
  (:func:`controller.authority.verify_authority` +
  :func:`controller.domain.reconstruct_domain`). Malformed, missing,
  stale, or contradictory authority fails closed with the frozen
  CTRL-001/002 typed errors *before* any remote call (AC2).
* **Reconstruction, not memory.** The active Work Item and lifecycle
  position are reconstructed from repository and GitHub evidence by
  the accepted CTRL-009 recovery boundary; the non-authoritative
  execution references (branch, dispatch base, worker session,
  architect reviewer) are carried **in memory only** and rebuilt after
  restart from externally supplied process configuration plus observed
  evidence (AC5, scope: "carries non-authoritative execution references
  in memory only and reconstructs them after restart").
* **Routing, never policy.** Exactly one governed step per cycle is
  invoked on the boundary the recovery plan names; each boundary
  re-derives its own position and applies its own frozen predicate.
  The runtime duplicates no predicate, re-implements no gate, and adds
  no merge, approval, completion, or advancement authority (AC3/AC8).
  A misrouted cycle fails closed through the boundary's own typed
  position error — the safety property the composition inherits.
* **The governed recording.** Boundary-validated domain events are
  projected into the controlled repository's machine-state ``status``
  and work-order ``Status:`` line — exactly the two surfaces CTRL-001
  authority cross-checks, exactly the recording the CTRL-010 dogfood
  proved — guarded by ``verify_authority`` after every write. The
  reconciliation record projects the completed ledger (and nothing
  else: no next-item activation, no stage change). The runtime never
  commits, pushes, merges its own work, or touches the roadmap, the
  architecture, or the automation stage: durable remote authority
  remains with the human/Architect exception handler (AC8, non-goal:
  no authoritative controller persistence).
* **Fail closed, observably.** Contradictions, malformed authority,
  stale correlation, provider failures, and ambiguous state propagate
  the frozen typed errors; the CLI converts them to non-zero exits
  with a ``FAIL-CLOSED`` line on stderr (AC7).
* **Token isolation (AC6).** GitHub/Z.ai provider tokens come only from
  externally supplied process configuration (environment variables
  named by the operator). The runtime never reads them from
  repository files, never writes them anywhere, and every structured
  output path is routed through a redaction guard so a token can never
  reach a log line.
* **Bounded polling, no busy loop.** The long-running mode sleeps
  between unchanged-evidence cycles with multiplicative backoff capped
  at a configured maximum, and runs at most a configured number of
  cycles per invocation (AC4). Service supervision (restart policy,
  watchdogs) belongs to the operator's supervisor, not the runtime.

Structured operator output: every cycle emits a
:class:`RuntimeCycleReport` — a deterministic, serializable record of
the authority fingerprint, the recovery classification, the boundary
invoked, the outcome, the applied event, the provider mutations
observed (method and path only — never payloads, never tokens),
and the operator guidance. Reports are operator telemetry, never
authority (the repository stays the sole durable truth).
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path
from typing import Protocol

from controller.authority import WORK_ITEMS_DIR, verify_authority
from controller.domain import DomainEvent, GovernedWorkItem, reconstruct_domain
from controller.errors import ControllerError
from controller.evidence import EvidenceGate, EvidenceGateOutcome, EvidencePolicy
from controller.github import GithubAdapter, GithubTransport
from controller.merge import MergeLoopOutcome, MergePolicy, MergeReconciliationLoop
from controller.orchestrator import (
    OrchestrationOutcome,
    OrchestrationReferences,
    Orchestrator,
    WorkerDispatched,
    WorkerResumed,
)
from controller.recovery import (
    GovernedBoundary,
    RecoveryBoundary,
    RecoveryCondition,
    RecoveryPlan,
)
from controller.review import ArchitectReviewLoop, ReviewLoopOutcome
from controller.zai import ZaiAdapter, ZaiTransport, ZaiWorkerSession

#: Environment variables the runtime reads provider tokens from (AC6). The
#: operator (or service supervisor) supplies them; the repository never
#: does. Nothing else in the runtime reads process configuration.
GITHUB_TOKEN_ENV = "CONTROLLER_GITHUB_TOKEN"
ZAI_TOKEN_ENV = "CONTROLLER_ZAI_TOKEN"

#: Sentinel values for a reconstructed request-form worker session. They
#: are deliberately *not* provider facts: the request form exists so the
#: consuming worker boundary can re-prove provenance from live provider
#: state (the FZ-CTRL005-002 fork guard); these sentinels never reach a
#: predicate that consults provider status.
_REQUEST_FORM_STATUS = "REQUEST-FORM"
_REQUEST_FORM_UPDATED_AT = "REQUEST-FORM"


# ---------------------------------------------------------------------------
# Provider tokens (AC6 — external only, never read from files, never emitted)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RuntimeTokens:
    """Externally supplied provider tokens, isolated from the repo.

    Constructed only from a process environment mapping (the service
    supervisor's job). The class performs no file I/O whatsoever, so a
    provider token can never originate from repository authority or any
    committed file; :meth:`masked` is the only sanctioned display form
    and every structured-output path uses it.
    """

    github_token: str
    zai_token: str

    @classmethod
    def from_environment(cls, env: Mapping[str, str] | None = None) -> RuntimeTokens:
        """Read provider tokens from the process environment (or an
        injected mapping, for tests). A missing token raises the typed
        configuration error — an unavailable mandatory dependency fails
        closed (AC7), never a silent anonymous connection."""
        source: Mapping[str, str] = os.environ if env is None else env
        github_token = source.get(GITHUB_TOKEN_ENV, "")
        zai_token = source.get(ZAI_TOKEN_ENV, "")
        missing = [
            name
            for name, value in (
                (GITHUB_TOKEN_ENV, github_token),
                (ZAI_TOKEN_ENV, zai_token),
            )
            if not value
        ]
        if missing:
            raise RuntimeConfigurationError(
                "external provider tokens are incomplete: "
                + ", ".join(missing)
                + " must be supplied by the process environment (never repository files)"
            )
        return cls(github_token=github_token, zai_token=zai_token)

    def masked(self) -> dict[str, str]:
        """The redacted display form — the only sanctioned emission."""
        return {
            GITHUB_TOKEN_ENV: _mask(self.github_token),
            ZAI_TOKEN_ENV: _mask(self.zai_token),
        }


def _mask(token: str) -> str:
    """Redact a token to a non-reversible length hint."""
    return f"<redacted:{len(token)} chars>"


class RuntimeConfigurationError(ControllerError):
    """The runtime process configuration is unusable (fail closed)."""


# ---------------------------------------------------------------------------
# Process configuration and time injection
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RuntimeConfiguration:
    """The externally supplied process configuration for one runtime.

    Everything here is operator input (CLI flags, environment, or a
    supervisor's unit file) — never repository authority. The governed
    facts (repository name, active Work Item, lifecycle) are always
    re-derived from the repository at ``repo_root``; the carried
    references (branch, dispatch base, session id, reviewer) are the
    non-authoritative identity references the operator reconstructed
    after a restart (scope: "reconstructs them after restart").
    """

    repo_root: Path
    #: The controlled repository's GitHub ``owner/name`` (transport
    #: addressing only; authority always comes from ``repo_root``).
    repository: str
    #: Required CI checks for the evidence gate and merge predicate
    #: (fresh caller-supplied policy inputs, CTRL-006/008 discipline).
    required_checks: tuple[str, ...]
    retryable_checks: tuple[str, ...] = ()
    #: The GitHub identity whose reviews are the Architect's decisions.
    architect_reviewer: str = ""
    #: Carried governed branch reference (implementation branch name).
    branch: str | None = None
    #: Carried dispatch-base provenance reference (exact base SHA).
    base_sha: str | None = None
    #: Carried worker-session identity reference (request form is
    #: reconstructed; the provider re-proves provenance, FZ-CTRL005-002).
    session_id: str | None = None
    #: Long-run poll bounds: base interval, backoff multiplier, cap.
    poll_interval_seconds: float = 60.0
    poll_backoff_multiplier: float = 2.0
    poll_max_seconds: float = 600.0
    #: Hard bound on governed cycles per ``run`` invocation (AC4).
    max_cycles: int = 1000
    #: Optional API roots (defaults: production GitHub / provider root).
    github_api_root: str | None = None
    zai_api_root: str | None = None

    def __post_init__(self) -> None:
        if not self.required_checks:
            raise RuntimeConfigurationError(
                "required_checks must name at least one required check context"
            )
        for name in self.required_checks:
            if not isinstance(name, str) or not name:
                raise RuntimeConfigurationError(
                    f"required check context {name!r} must be a non-empty string"
                )
        if not self.architect_reviewer:
            raise RuntimeConfigurationError(
                "architect_reviewer must be supplied (the Architect's GitHub identity)"
            )
        if self.poll_interval_seconds <= 0:
            raise RuntimeConfigurationError("poll_interval_seconds must be positive")
        if self.poll_backoff_multiplier < 1.0:
            raise RuntimeConfigurationError("poll_backoff_multiplier must be >= 1.0")
        if self.poll_max_seconds < self.poll_interval_seconds:
            raise RuntimeConfigurationError("poll_max_seconds must be >= poll base interval")
        if self.max_cycles < 1:
            raise RuntimeConfigurationError("max_cycles must be at least 1")


class RuntimeClock(Protocol):
    """Injectable time source (operator telemetry only, never domain)."""

    def now(self) -> str:
        """The current UTC timestamp as an ISO-8601 string."""
        ...


class RuntimeSleeper(Protocol):
    """Injectable sleep primitive for bounded polling (AC4)."""

    def sleep(self, seconds: float) -> None:
        """Block for ``seconds`` (test doubles record instead)."""
        ...


class SystemClock:
    """The real-time clock (production default)."""

    def now(self) -> str:
        from datetime import datetime, timezone

        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class SystemSleeper:
    """The real ``time.sleep`` (production default)."""

    def sleep(self, seconds: float) -> None:
        import time

        time.sleep(seconds)


# ---------------------------------------------------------------------------
# Recording transports (the mutation proof surface)
# ---------------------------------------------------------------------------


@dataclass
class CallRecord:
    """One provider call as proof surface: method and path only.

    Payloads are deliberately not recorded: they carry review content
    and (in transport headers, not here) provider tokens. The runtime's
    operator output can therefore never leak either.
    """

    method: str
    path: str

    @property
    def is_mutation(self) -> bool:
        return self.method in ("POST", "PUT", "PATCH", "DELETE")


class RecordingGithubTransport:
    """A pass-through GitHub transport that records (method, path) calls.

    Wraps any :class:`controller.github.GithubTransport` — production
    urllib or a test double — so every runtime cycle can report the
    exact provider calls it caused without capturing payloads.
    """

    def __init__(self, inner: GithubTransport) -> None:
        self._inner = inner
        self.calls: list[CallRecord] = []

    def get_json(self, path: str) -> object:
        self.calls.append(CallRecord(method="GET", path=path))
        return self._inner.get_json(path)

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append(CallRecord(method="POST", path=path))
        return self._inner.post_json(path, payload)

    def put_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append(CallRecord(method="PUT", path=path))
        return self._inner.put_json(path, payload)


class RecordingZaiTransport:
    """A pass-through Z.ai transport that records (method, path) calls."""

    def __init__(self, inner: ZaiTransport) -> None:
        self._inner = inner
        self.calls: list[CallRecord] = []

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append(CallRecord(method="POST", path=path))
        return self._inner.post_json(path, payload)


# ---------------------------------------------------------------------------
# The governed recording (the dogfood-proven authority projection)
# ---------------------------------------------------------------------------

_STATE_FILE = Path("spec/state/controller-program-state.json")
_STATUS_LINE = re.compile(r"^Status:\s*`[A-Z_]+`\s*$", re.MULTILINE)


class RuntimeRecorderError(ControllerError):
    """The governed recording failed; the write is refused (fail closed)."""


@dataclass
class RuntimeRecorder:
    """Projects boundary-validated events into the controlled repository.

    This is the Stage-7 mechanical recording duty the CTRL-010 dogfood
    proved on its synthetic repository, performed on the controlled
    repository's working tree: one domain event updates the machine-state
    ``status`` and the work order's ``Status:`` line — exactly the two
    surfaces CTRL-001 authority cross-checks — and authority is
    re-verified after every write. The reconciliation record projects
    the completed ledger the CTRL-008 boundary derived, and nothing
    else (no next-item activation, no stage change — those are
    explicit Architect-governed acts).

    The recorder performs **no git operations**: committing and pushing
    the recorded authority to the durable remote remains with the
    operator/Architect (the exception handler), exactly as during
    bootstrap. It is therefore not a persistence layer — it writes the
    repository's own authoritative surfaces through the accepted
    validation, or refuses.
    """

    def project_event(self, repo_root: Path, event: DomainEvent) -> None:
        """Record one boundary-validated transition, then re-verify authority.

        Fail closed (refusing the write is impossible after the fact, so
        the error surfaces and the runtime stops) if the projection
        would leave authority invalid or unverifiable.
        """
        state_path = repo_root / _STATE_FILE
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuntimeRecorderError(
                f"the controlled machine state at {state_path} is unreadable: {exc}"
            ) from exc
        if not isinstance(data, dict):
            raise RuntimeRecorderError(
                f"the controlled machine state at {state_path} is not an object"
            )
        if data.get("activeWorkItem") != event.work_item:
            raise RuntimeRecorderError(
                f"the boundary event names work item '{event.work_item}', but "
                f"machine state identifies '{data.get('activeWorkItem')}' as active: "
                "a cross-item recording is refused"
            )
        if data.get("status") != event.from_state.value:
            raise RuntimeRecorderError(
                f"the boundary event transitions from {event.from_state.value}, but "
                f"machine state records {data.get('status')!r}: the state moved "
                "between reconstruction and recording — fail closed, never overwrite"
            )
        data["status"] = event.to_state.value
        state_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        self._record_work_order_status(repo_root, event)
        verify_authority(repo_root)

    def project_reconciliation(self, repo_root: Path, record: Mapping[str, object]) -> None:
        """Record the CTRL-008-derived completed ledger (nothing else)."""
        completed_after = record.get("completed_after")
        if not isinstance(completed_after, list) or not all(
            isinstance(item, str) for item in completed_after
        ):
            raise RuntimeRecorderError("the reconciliation record's completed ledger is malformed")
        state_path = repo_root / _STATE_FILE
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise RuntimeRecorderError(
                f"the controlled machine state at {state_path} is not an object"
            )
        data["completed"] = list(completed_after)
        state_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        verify_authority(repo_root)

    def _record_work_order_status(self, repo_root: Path, event: DomainEvent) -> None:
        """Update the active work order's ``Status:`` line (the second
        authority-checked surface). A work order that lost its status
        line is a contradiction, not something to repair. Called only
        from :meth:`project_event` **after** the machine state write and
        **before** the whole-tree re-verification, with the event's work
        item already proven identical to the active one."""
        order_path = repo_root / WORK_ITEMS_DIR / f"{event.work_item}.md"
        try:
            text = order_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise RuntimeRecorderError(
                f"the active work order at {order_path} is unreadable: {exc}"
            ) from exc
        updated = _STATUS_LINE.sub(f"Status: `{event.to_state.value}`", text, count=1)
        if updated == text and f"Status: `{event.to_state.value}`" not in text:
            raise RuntimeRecorderError(
                f"the active work order at {order_path} lost its Status line"
            )
        order_path.write_text(updated, encoding="utf-8")


# ---------------------------------------------------------------------------
# Structured operator output
# ---------------------------------------------------------------------------


class CycleStatus(str, Enum):
    """The operator-facing disposition of one governed cycle."""

    #: A boundary step executed and a governed event was recorded.
    ADVANCED = "ADVANCED"
    #: A boundary step executed as a pure observation (no event, no
    #: mutation): evidence is unchanged; the long-run loop polls.
    OBSERVED = "OBSERVED"
    #: No worker-side step is directed at this position: the runtime
    #: holds for governance attention (fail-closed pause, not a guess).
    PAUSED = "PAUSED"
    #: The lifecycle reached a governance-complete position; the loop
    #: ends and advancement stays with the Architect.
    COMPLETED = "COMPLETED"


@dataclass(frozen=True)
class RuntimeCycleReport:
    """One governed cycle's complete operator record (serializable).

    Deterministic given the same authority, evidence, references, and
    injected clock: reports are operator telemetry, never authority.
    Provider calls appear as method + path only — never payloads, never
    tokens (the AC6 emission guard).
    """

    cycle: int
    timestamp: str
    work_item: str
    repository: str
    lifecycle_before: str
    recovery_condition: str
    recovery_boundary: str
    recovery_next_step: str | None
    recovery_basis: tuple[str, ...]
    boundary_invoked: str | None
    outcome: str | None
    event_command: str | None
    event_from_state: str | None
    event_to_state: str | None
    lifecycle_after: str
    mutations: tuple[str, ...]
    status: CycleStatus
    guidance: str

    def serialize(self) -> dict[str, object]:
        """The deterministic machine-readable value form."""
        return {
            "cycle": self.cycle,
            "timestamp": self.timestamp,
            "work_item": self.work_item,
            "repository": self.repository,
            "lifecycle_before": self.lifecycle_before,
            "recovery": {
                "condition": self.recovery_condition,
                "boundary": self.recovery_boundary,
                "next_step": self.recovery_next_step,
                "basis": list(self.recovery_basis),
            },
            "boundary_invoked": self.boundary_invoked,
            "outcome": self.outcome,
            "event": {
                "command": self.event_command,
                "from_state": self.event_from_state,
                "to_state": self.event_to_state,
            },
            "lifecycle_after": self.lifecycle_after,
            "mutations": list(self.mutations),
            "status": self.status.value,
            "guidance": self.guidance,
        }

    def human_summary(self) -> str:
        """One operator-scannable line (log-friendly)."""
        step = self.event_command if self.event_command is not None else "observe"
        return (
            f"[{self.timestamp}] cycle {self.cycle} {self.work_item} "
            f"{self.lifecycle_before} -> {self.lifecycle_after} "
            f"({step}, {self.recovery_boundary}, {self.status.value})"
        )


# ---------------------------------------------------------------------------
# The runtime
# ---------------------------------------------------------------------------


class ControllerRuntime:
    """The production Controller process over the accepted boundaries.

    One :meth:`run_one_cycle` is one deterministic governed step:
    verify authority, reconstruct position through CTRL-009, route to
    the boundary the plan names, project the boundary-validated event
    through the guarded recorder, and report. :meth:`run` is the
    long-running mode: bounded polling/backoff between unchanged-evidence
    cycles, hard cycle cap, clean end on governance-complete.

    The instance holds only the injected adapters (wrapped in the
    recording transports), the policies, the recorder, the clock and
    sleeper, and the **in-memory** carried references — restarting the
    process rebuilds everything from repository/GitHub evidence plus
    the operator's externally supplied configuration (AC5/AC6).
    """

    def __init__(
        self,
        *,
        configuration: RuntimeConfiguration,
        github_transport: GithubTransport,
        zai_transport: ZaiTransport,
        recorder: RuntimeRecorder | None = None,
        clock: RuntimeClock | None = None,
        sleeper: RuntimeSleeper | None = None,
    ) -> None:
        self._configuration = configuration
        self._github_transport = RecordingGithubTransport(github_transport)
        self._zai_transport = RecordingZaiTransport(zai_transport)
        github = GithubAdapter(self._github_transport, configuration.repository)
        zai = ZaiAdapter(self._zai_transport, configuration.repository)
        self._orchestrator = Orchestrator(github=github, zai=zai)
        self._gate = EvidenceGate(github=github)
        self._review_loop = ArchitectReviewLoop(github=github)
        self._merge_loop = MergeReconciliationLoop(github=github)
        self._recovery = RecoveryBoundary(github=github)
        self._recorder = recorder if recorder is not None else RuntimeRecorder()
        self._clock = clock if clock is not None else SystemClock()
        self._sleeper = sleeper if sleeper is not None else SystemSleeper()
        self._references = self._initial_references(configuration)
        self._cycle_count = 0

    # -- carried references (memory only, rebuilt on restart) ----------------

    def _initial_references(self, configuration: RuntimeConfiguration) -> OrchestrationReferences:
        """Build the initial carried references from the external process
        configuration. Nothing is guessed: absent configuration leaves
        the reference absent, and the boundaries fail closed (typed
        missing-reference errors) rather than inferring values.

        A configured ``session_id`` is bound lazily on the first cycle
        (see :meth:`_bind_request_form_session`), because the request
        form's repository/work-item binding comes from reconstructed
        authority — which is read per cycle, never cached.
        """
        return OrchestrationReferences(
            branch=configuration.branch,
            base_sha=configuration.base_sha,
            worker_session=None,
            architect_reviewer=configuration.architect_reviewer,
        )

    def _bind_request_form_session(self, item: GovernedWorkItem) -> None:
        """Bind the operator-supplied session identity to a request-form
        session, once, from reconstructed authority + external config.

        The request form deliberately asserts no provider facts (status
        sentinels, no PR identity): the consuming worker boundary
        re-proves provenance from live provider state (FZ-CTRL005-002)
        and the recovery boundary carries it as REQUEST_FORM. Requires
        the dispatch-base configuration; without it the reference stays
        absent and the owning boundary fails closed with its own typed
        missing-reference error.
        """
        session_id = self._configuration.session_id
        if session_id is None:
            return
        carried = self._references.worker_session
        if carried is not None:
            return  # an in-memory outcome session outranks the config form
        base_sha = self._configuration.base_sha
        if base_sha is None:
            return  # unbindable: the boundary's typed error is the guidance
        self._references = replace(
            self._references,
            worker_session=ZaiWorkerSession(
                session_id=session_id,
                repository=item.identity.repository,
                work_item=item.identity.work_item,
                base_sha=base_sha,
                pr_number=None,
                head_sha=None,
                status=_REQUEST_FORM_STATUS,
                updated_at=_REQUEST_FORM_UPDATED_AT,
            ),
        )

    # -- one governed cycle (AC2/AC3/AC7) --------------------------------------

    def run_one_cycle(self) -> RuntimeCycleReport:
        """Advance the controlled repository by exactly one governed step.

        Order is fixed and auditable: authority verification, domain
        reconstruction, request-form binding, CTRL-009 recovery
        classification, boundary routing (exactly the plan's direction),
        guarded event projection, structured report. Every failure is a
        frozen typed :class:`controller.errors.ControllerError` — the
        CLI converts those to non-zero fail-closed exits (AC7).
        """
        self._cycle_count += 1
        repo_root = self._configuration.repo_root
        mutations_mark = self._mutation_mark()

        # (1) Authority first — before any remote action (AC2). The
        # boundaries re-derive it internally too; the runtime's own
        # verification is the pre-action guard (fail closed here).
        verify_authority(repo_root)
        item: GovernedWorkItem = reconstruct_domain(repo_root)
        self._bind_request_form_session(item)

        # (2) Reconstruction from repository + GitHub evidence (AC5):
        # the plan names the owning boundary and the directed step.
        plan: RecoveryPlan = self._recovery.evaluate(repo_root, self._references)

        # (3) Governance positions end the loop cleanly (no boundary call).
        if plan.condition is RecoveryCondition.AWAITING_GOVERNANCE:
            return self._report(
                item,
                plan,
                None,
                None,
                mutations_mark,
                CycleStatus.COMPLETED,
                "the Work Item lifecycle is complete; advancement and successor "
                "activation are Architect-side governance",
            )
        if plan.condition is RecoveryCondition.PARTIAL_MUTATION_UNRESOLVED:
            return self._report(
                item,
                plan,
                None,
                None,
                mutations_mark,
                CycleStatus.PAUSED,
                "a post-mutation position has no observed external outcome: "
                "governance attention is required and no automatic retry is "
                "ever attempted across the merge boundary",
            )
        if plan.next_step is None:
            if plan.condition is RecoveryCondition.IN_PROGRESS:
                # An in-progress position awaiting an external actor with no
                # frozen-table transition to request — REVIEW_PENDING while
                # no Architect decision is bound to the exact head. The
                # owning boundary's step is a pure observation: route it
                # below so the boundary observes verbatim (zero mutations,
                # zero events) and the long-run mode keeps polling (AC4).
                pass
            else:
                # No worker-side step directed (e.g. evidence ahead at the
                # start positions — the dispatch/start work is durably
                # performed and is never replayed, FZ-CTRL009-001).
                return self._report(
                    item,
                    plan,
                    None,
                    None,
                    mutations_mark,
                    CycleStatus.PAUSED,
                    "no worker-side step is directed at this position: observed "
                    "evidence is ahead of recorded authority — advance the "
                    "machine state through the governed recording (governance), "
                    "then restart the runtime",
                )

        # (4) Exactly one boundary step, routed by the plan (AC3).
        event: DomainEvent | None
        guidance: str
        if plan.boundary is GovernedBoundary.ORCHESTRATOR:
            outcome = self._orchestrator.run_cycle(repo_root, self._references)
            event, guidance = self._absorb_orchestration(outcome)
            boundary_name, outcome_name = "ORCHESTRATOR", type(outcome).__name__
        elif plan.boundary is GovernedBoundary.EVIDENCE_GATE:
            gate_outcome = self._gate.evaluate(repo_root, self._references, self._evidence_policy())
            event, guidance = self._absorb_evidence(gate_outcome)
            boundary_name, outcome_name = "EVIDENCE_GATE", "EvidenceGateOutcome"
        elif plan.boundary is GovernedBoundary.REVIEW_LOOP:
            review_outcome = self._review_loop.evaluate(repo_root, self._references)
            event, guidance = self._absorb_review(review_outcome)
            boundary_name, outcome_name = "REVIEW_LOOP", "ReviewLoopOutcome"
        elif plan.boundary is GovernedBoundary.MERGE_BOUNDARY:
            merge_outcome = self._merge_loop.evaluate(
                repo_root, self._references, self._merge_policy()
            )
            event, guidance = self._absorb_merge(merge_outcome)
            boundary_name, outcome_name = "MERGE_BOUNDARY", "MergeLoopOutcome"
        else:  # pragma: no cover - the enum is closed and covered above
            raise RuntimeConfigurationError(
                f"the recovery plan names boundary '{plan.boundary.value}', "
                "which the runtime does not route"
            )

        # (5) The governed recording — guarded, never duplicated policy.
        if event is not None:
            self._recorder.project_event(repo_root, event)
        status = CycleStatus.ADVANCED if event is not None else CycleStatus.OBSERVED
        return self._report(
            item,
            plan,
            (boundary_name, outcome_name),
            event,
            mutations_mark,
            status,
            guidance,
        )

    # -- long-running mode (AC4) -----------------------------------------------

    def run(self) -> tuple[RuntimeCycleReport, ...]:
        """Run governed cycles until a terminal position, a governance
        hold, or the configured cycle cap.

        Unchanged-evidence cycles (pure observations) sleep the bounded
        polling interval with multiplicative backoff capped at the
        configured maximum — never a busy loop. Advancing cycles
        continue immediately and reset the backoff. The sleep is real
        (or injected for tests); supervision policy belongs to the
        operator's service manager, not the runtime.
        """
        reports: list[RuntimeCycleReport] = []
        interval = self._configuration.poll_interval_seconds
        cycles = 0
        while cycles < self._configuration.max_cycles:
            report = self.run_one_cycle()
            reports.append(report)
            cycles += 1
            if report.status in (CycleStatus.COMPLETED, CycleStatus.PAUSED):
                break
            if report.status is CycleStatus.OBSERVED:
                # Sleep only between observation cycles — never a trailing
                # sleep before the invocation ends at the cap.
                if cycles < self._configuration.max_cycles:
                    self._sleeper.sleep(interval)
                    interval = min(
                        interval * self._configuration.poll_backoff_multiplier,
                        self._configuration.poll_max_seconds,
                    )
            else:
                interval = self._configuration.poll_interval_seconds
        return tuple(reports)

    # -- policy construction (fresh inputs per evaluation) ----------------------

    def _evidence_policy(self) -> EvidencePolicy:
        return EvidencePolicy(
            required_checks=self._configuration.required_checks,
            retryable_checks=self._configuration.retryable_checks,
        )

    def _merge_policy(self) -> MergePolicy:
        return MergePolicy(required_checks=self._configuration.required_checks)

    # -- outcome absorption: event + guidance + in-memory carry ----------------

    def _absorb_orchestration(
        self, outcome: OrchestrationOutcome
    ) -> tuple[DomainEvent | None, str]:
        """Absorb one orchestrator outcome: carry the worker session (the
        typed adapter-issued evidence — in memory only) and translate
        the outcome into operator guidance. No policy is added here."""
        if isinstance(outcome, WorkerDispatched):
            # The dispatch-issued session is the carried reference for
            # every later worker-side step (memory only, AC5).
            self._references = replace(self._references, worker_session=outcome.session)
            return outcome.event, (
                "worker dispatched with the exact repository-derived context; "
                "the session reference is carried in memory only"
            )
        if isinstance(outcome, WorkerResumed):
            self._references = replace(self._references, worker_session=outcome.session)
            return outcome.event, (
                f"the same governed worker/PR context resumed with "
                f"{len(outcome.findings)} verbatim review finding(s)"
            )
        return outcome.event, _orchestration_guidance(outcome)

    def _absorb_evidence(self, outcome: EvidenceGateOutcome) -> tuple[DomainEvent | None, str]:
        """Absorb one evidence-gate outcome (classification is the gate's;
        the runtime only reports it)."""
        guidance = {
            "PENDING": "CI evidence is pending; polling continues (bounded)",
            "TERMINAL_SUCCESS": "terminal-success CI evidence recorded",
            "TERMINAL_FAILURE": "terminal CI failure observed: "
            + (
                "a typed retry request is exposed"
                if outcome.retry is not None
                else "no retry policy permits a retry — governance attention"
            ),
            "POLICY_BLOCKED": "required checks are blocked by policy — governance attention",
        }[outcome.classification.value]
        return outcome.event, guidance

    def _absorb_review(self, outcome: ReviewLoopOutcome) -> tuple[DomainEvent | None, str]:
        """Absorb one review-loop outcome (the decision is the Architect's,
        observed verbatim — never inferred)."""
        if outcome.decision is None:
            return outcome.event, "no Architect decision is bound to the exact head; polling"
        if outcome.decision.value == "APPROVE":
            return outcome.event, "Architect approval observed and recorded for the exact head"
        return outcome.event, (
            f"Architect REQUEST_CHANGES observed (iteration {outcome.iteration}); "
            "the same governed worker/PR context resumes on the next cycle"
        )

    def _absorb_merge(self, outcome: MergeLoopOutcome) -> tuple[DomainEvent, str]:
        """Absorb one merge/reconciliation outcome. The single authorized
        merge ``PUT`` (if any) already executed inside the boundary under
        its frozen predicate; the runtime records the returned event and,
        at ``RECONCILING``, the derived reconciliation ledger (nothing
        else — no next-item activation, no stage change)."""
        if outcome.record is not None:
            self._recorder.project_reconciliation(
                self._configuration.repo_root, outcome.record.serialize()
            )
        if outcome.merge_attempted:
            guidance = (
                "the single authorized merge attempt executed; the observed merge "
                "commit is recorded next cycle (at most one mutation attempt)"
            )
        elif outcome.event.command.value == "RECORD_MERGE":
            guidance = "observed merge evidence recorded (no second merge attempt)"
        elif outcome.event.command.value == "RECORD_RECONCILIATION":
            guidance = (
                "post-merge reconciliation recorded (completed ledger; no "
                "next-item activation, no stage change)"
            )
        else:
            guidance = "merge/reconciliation boundary step applied"
        return outcome.event, guidance

    # -- reporting --------------------------------------------------------------

    def _mutation_mark(self) -> int:
        return len(self._github_transport.calls) + len(self._zai_transport.calls)

    def _mutations_since(self, mark: int) -> tuple[str, ...]:
        """Provider mutations since the mark, as ``METHOD path`` proof lines
        (never payloads — the AC6 emission guard)."""
        github = self._github_transport.calls
        zai = self._zai_transport.calls
        records = [*github, *zai]
        return tuple(f"{call.method} {call.path}" for call in records[mark:] if call.is_mutation)

    def _report(
        self,
        item: GovernedWorkItem,
        plan: RecoveryPlan,
        invoked: tuple[str, str] | None,
        event: DomainEvent | None,
        mutations_mark: int,
        status: CycleStatus,
        guidance: str,
    ) -> RuntimeCycleReport:
        lifecycle_after = event.to_state.value if event is not None else item.lifecycle.value
        return RuntimeCycleReport(
            cycle=self._cycle_count,
            timestamp=self._clock.now(),
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle_before=item.lifecycle.value,
            recovery_condition=plan.condition.value,
            recovery_boundary=plan.boundary.value,
            recovery_next_step=plan.next_step,
            recovery_basis=plan.basis,
            boundary_invoked=invoked[0] if invoked else None,
            outcome=invoked[1] if invoked else None,
            event_command=event.command.value if event else None,
            event_from_state=event.from_state.value if event else None,
            event_to_state=event.to_state.value if event else None,
            lifecycle_after=lifecycle_after,
            mutations=self._mutations_since(mutations_mark),
            status=status,
            guidance=guidance,
        )


def _orchestration_guidance(outcome: OrchestrationOutcome) -> str:
    """Deterministic operator guidance per orchestration outcome class."""
    name = type(outcome).__name__
    guidance = {
        "ImplementationStarted": "implementation began on the proven worker session",
        "PullRequestOpened": "the governed pull request is observed and recorded",
        "AwaitingWorker": (
            "the dispatch-issued worker session reference is not carried; "
            "supply it via external configuration to continue (never guessed)"
        ),
        "AwaitingPullRequest": "the governed pull request is not yet open; polling",
        "AwaitingCI": "the CI wait began; the evidence gate classifies next cycle",
        "DownstreamHandoff": "the position belongs to a downstream boundary; "
        "recovery routes it on the next cycle",
    }
    return guidance.get(name, "orchestration boundary step applied")
