"""CI/evidence gate (CTRL-006).

Deterministic, fail-closed classification of the CI evidence for the
active governed Work Item, plus the typed retry handoff boundary.

Module doctrine (each clause maps to a frozen work-order acceptance
criterion):

* **Authority first (AC1).** Every evaluation reconstructs the governed
  work item from repository machine state through the CTRL-002 domain
  layer (:func:`controller.domain.reconstruct_domain`). Structural
  authority defects and authority contradictions fail closed before any
  remote observation or retry routing.
* **Exact correlation (AC2).** Evidence is observed only for the governed
  pull request correlated by branch and exact dispatch base through the
  accepted CTRL-003 adapter. Foreign, stale, ambiguous, or contradictory
  correlation propagates the adapter's typed errors; a missing governed
  PR at a CI evidence position is an authority/remote contradiction, not
  an observation.
* **Deterministic classification (AC3/AC4).** The frozen classification
  rules below map the observed combined commit status at the exact PR
  head plus the required-evidence policy to exactly one of PENDING,
  TERMINAL_SUCCESS, TERMINAL_FAILURE, or POLICY_BLOCKED. Identical
  authority, evidence, and policy yield identical outcomes — the gate
  holds no state, so restart replays the same decision.
* **Retry boundary (AC5).** A terminal failure is retryable only when
  the frozen policy classifies every failing required check as
  retryable and the exact governed worker/PR context is reconstructible
  from the carried references. The gate then produces a typed
  :class:`EvidenceRetryRequest` — a *request*, never an execution: the
  gate performs no worker-provider I/O and implements no worker logic;
  the consuming boundary (the CTRL-005 orchestrator/operator loop)
  re-establishes session provenance from live provider state and calls
  the accepted CTRL-004 adapter itself.
* **Lifecycle boundary (AC6).** At most one governed transition per
  evaluation, requested through the CTRL-002 domain model so the frozen
  CTRL-001 transition table remains the single validity authority:
  AWAIT_CI from PR_OPEN, and RECORD_CI_SUCCESS from CI_PENDING only on
  terminal-success evidence. Every other classification is a pure
  observation (no event).
* **Runtime non-authority (AC7).** The gate holds only the injected
  GitHub adapter — no database, cache, registry, scheduler, or queue.
  Unrelated observed check contexts are reported, never reinterpreted.

The frozen classification rules (AC3/AC4), applied to the combined
commit status observed at the exact governed PR head:

1. Every required check context is resolved independently:
   ``success`` is terminal-success; ``failure`` and ``error`` are
   terminal failure; ``pending`` is pending; any other state value is
   unrecognized (fail closed); a context reported more than once is
   ambiguous (fail closed); a required context absent from the report
   is missing — pending while the combined status is still ``pending``,
   policy-blocked once the combined status is terminal (the required
   evidence can no longer appear) or unrecognized.
2. Aggregate precedence: any blocked check → POLICY_BLOCKED; else any
   failed check → TERMINAL_FAILURE; else any pending check → PENDING;
   else (all required checks terminal-success) → TERMINAL_SUCCESS.
3. Check contexts outside the required set are reported as unrelated;
   they can neither satisfy the required evidence nor block it (the
   required set defines the gate; the separate frozen merge predicate
   remains authoritative at merge time).

The required-evidence policy is a fresh caller-supplied input, exactly
like ``required_checks`` in the CTRL-003 merge predicate: the gate
executes policy, it never defines repository facts. The policy is
structurally validated (non-empty, duplicate-free, retryable subset of
required) and canonicalized (sorted tuples), so equal inputs produce
equal values.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Final

from controller.commands import CommandName
from controller.domain import DomainCommand, DomainEvent, GovernedWorkItem, reconstruct_domain
from controller.errors import (
    EvidenceContradictionError,
    EvidenceGatePositionError,
    EvidenceMissingReferenceError,
    EvidencePolicyError,
    GithubNotFoundError,
)
from controller.github import GithubAdapter, GithubCommitStatus, GithubPullRequest
from controller.orchestrator import OrchestrationReferences
from controller.states import LifecycleState
from controller.zai import ZaiWorkerSession

#: Combined-status state that proves one check run finished successfully.
_SUCCESS_STATE: Final = "success"
#: Combined-status state that proves one check run has not finished yet.
_PENDING_STATE: Final = "pending"
#: Combined-status states that prove one check run terminally failed.
_FAILURE_STATES: Final[frozenset[str]] = frozenset({"failure", "error"})

#: The lifecycle positions the evidence gate owns: the PR exists by
#: authority and CI evidence is the governing fact.
_GATE_POSITIONS: Final[frozenset[LifecycleState]] = frozenset(
    {LifecycleState.PR_OPEN, LifecycleState.CI_PENDING}
)


class EvidenceClassification(str, Enum):
    """The deterministic classification of the observed CI evidence."""

    PENDING = "PENDING"
    TERMINAL_SUCCESS = "TERMINAL_SUCCESS"
    TERMINAL_FAILURE = "TERMINAL_FAILURE"
    POLICY_BLOCKED = "POLICY_BLOCKED"


@dataclass(frozen=True)
class EvidencePolicy:
    """The frozen required-evidence policy for one gate evaluation.

    ``required_checks`` names the exact check contexts the governed Work
    Item requires; ``retryable_checks`` names the subset whose terminal
    failure an explicit policy permits to hand off as a typed retry
    request. Both are caller-supplied fresh policy inputs (mirroring
    ``required_checks`` in the CTRL-003 merge predicate): the gate
    executes policy, it never invents repository facts.

    Tuples are canonicalized to sorted order at construction, so any
    permutation of the same names yields an equal (and therefore
    deterministic) value.
    """

    required_checks: tuple[str, ...]
    retryable_checks: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "required_checks", tuple(sorted(self.required_checks)))
        object.__setattr__(self, "retryable_checks", tuple(sorted(self.retryable_checks)))
        if not self.required_checks:
            raise EvidencePolicyError(
                "required_checks must name at least one required check context"
            )
        declared: set[str] = set()
        for name in self.required_checks:
            if not isinstance(name, str) or not name:
                raise EvidencePolicyError(
                    f"required check context {name!r} must be a non-empty string"
                )
            if name in declared:
                raise EvidencePolicyError(f"required check context {name!r} is declared twice")
            declared.add(name)
        retryable: set[str] = set()
        for name in self.retryable_checks:
            if not isinstance(name, str) or not name:
                raise EvidencePolicyError(
                    f"retryable check context {name!r} must be a non-empty string"
                )
            if name in retryable:
                raise EvidencePolicyError(f"retryable check context {name!r} is declared twice")
            retryable.add(name)
        unknown = retryable - declared
        if unknown:
            raise EvidencePolicyError(
                "retryable checks must be a subset of required checks; unknown: "
                + ", ".join(sorted(unknown))
            )

    def is_retryable(self, failed_checks: tuple[str, ...]) -> bool:
        """Whether an explicit policy permits retrying exactly these failures.

        Deterministic rule (AC5): every failing required check must be
        declared retryable and at least one failure must exist. A single
        non-retryable failure, or a mixed failure set, is exposed for
        governance attention without a guessed recovery.
        """
        return bool(failed_checks) and all(
            check in self.retryable_checks for check in failed_checks
        )


@dataclass(frozen=True)
class EvidenceRetryRequest:
    """A typed implementation-retry request handed to the boundary (AC5).

    The gate never executes this request: the consuming boundary (the
    CTRL-005 orchestrator/operator loop) re-establishes the session
    provenance from live provider state through the accepted CTRL-004
    adapter before any resume, mirroring the merge-authorization
    request/re-proof doctrine. The request carries only facts the gate
    itself proved: the locally proven worker-session binding, the exact
    correlated PR identity, and the retryable failure set.

    ``failed_checks`` are the exact required contexts that terminally
    failed; ``reason`` is the deterministic one-line justification. The
    boundary maps this value onto a
    :class:`controller.zai.ZaiWorkerContext` (repository, work item,
    work-order path, dispatch base, PR identity) and resumes the exact
    carried session id through the CTRL-004 adapter.
    """

    session_id: str
    repository: str
    work_item: str
    work_order_path: str
    branch: str
    base_sha: str
    pr_number: int
    head_sha: str
    failed_checks: tuple[str, ...]
    reason: str


@dataclass(frozen=True)
class EvidenceGateOutcome:
    """One deterministic evidence-gate decision (the full typed evidence).

    ``lifecycle`` is the authority-reconstructed state at the start of
    the evaluation; ``event`` is the single governed transition applied
    by this evaluation (``None`` for pure observations); ``retry`` is
    the typed resume request (present only for a retryable terminal
    failure with a reconstructible governed context). Every per-check
    tuple is sorted, so equal evidence yields equal outcomes, and the
    raw observed status rides along for downstream review/merge
    decisions (in-scope 4).
    """

    work_item: str
    repository: str
    lifecycle: LifecycleState
    classification: EvidenceClassification
    policy: EvidencePolicy
    branch: str
    pr_number: int
    base_sha: str
    head_sha: str
    status: GithubCommitStatus
    successful_checks: tuple[str, ...] = ()
    pending_checks: tuple[str, ...] = ()
    failed_checks: tuple[str, ...] = ()
    missing_checks: tuple[str, ...] = ()
    blocked_checks: tuple[str, ...] = ()
    unrelated_checks: tuple[str, ...] = ()
    event: DomainEvent | None = None
    retry: EvidenceRetryRequest | None = None


class EvidenceGate:
    """The deterministic CI/evidence gate over the accepted adapters.

    One :meth:`evaluate` reconstructs authority, correlates the exact
    governed PR, observes the combined commit status at its exact head,
    classifies the evidence against the supplied frozen policy, and
    performs at most one governed lifecycle step. The instance holds
    only the injected GitHub adapter (AC7); restart with the same
    repository, evidence, references, and policy reproduces the same
    decision. The gate never talks to the worker provider: retries are
    typed requests handed to the boundary (AC5).
    """

    def __init__(self, *, github: GithubAdapter) -> None:
        self._github = github

    def evaluate(
        self,
        repo_root: Path,
        references: OrchestrationReferences,
        policy: EvidencePolicy,
    ) -> EvidenceGateOutcome:
        """Classify the CI evidence for the active Work Order (one step).

        Fails closed with typed errors on authority defects (spec/
        contradiction), gate-position misuse, missing carried
        references, and correlation failures. The gate performs no
        remote mutations at all; failures surface before any retry
        routing.
        """
        item = reconstruct_domain(repo_root)
        state = item.lifecycle
        if state not in _GATE_POSITIONS:
            raise EvidenceGatePositionError(
                "the evidence gate applies at CI evidence positions "
                f"(PR_OPEN, CI_PENDING); '{item.identity.work_item}' is {state.value}, "
                "which belongs to another governed stage"
            )
        branch, base_sha = self._require_correlation_refs(references)
        pr = self._correlate_pull_request(item, state, branch, base_sha)
        status = self._github.get_commit_status(pr.head_sha)
        classification, detail = _classify(policy, status)
        event = self._governed_step(item, state, classification)
        retry = self._retry_request(item, references, pr, policy, detail.failed, branch, base_sha)
        return EvidenceGateOutcome(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            classification=classification,
            policy=policy,
            branch=branch,
            pr_number=pr.number,
            base_sha=base_sha,
            head_sha=pr.head_sha,
            status=status,
            successful_checks=detail.successful,
            pending_checks=detail.pending,
            failed_checks=detail.failed,
            missing_checks=detail.missing,
            blocked_checks=detail.blocked,
            unrelated_checks=detail.unrelated,
            event=event,
            retry=retry,
        )

    # -- internal: correlation (AC2) ------------------------------------------

    def _require_correlation_refs(self, references: OrchestrationReferences) -> tuple[str, str]:
        if references.branch is None or references.base_sha is None:
            raise EvidenceMissingReferenceError(
                "correlating the governed pull request requires the carried "
                "branch and dispatch-base references; they are never guessed"
            )
        return references.branch, references.base_sha

    def _correlate_pull_request(
        self, item: GovernedWorkItem, state: LifecycleState, branch: str, base_sha: str
    ) -> GithubPullRequest:
        """Correlate the exact governed PR; adapter typed errors propagate.

        At both gate positions authority already records the governed
        PR, so absence is an authority/remote contradiction rather than
        an observation (mirroring the CTRL-005 orchestrator discipline).
        """
        try:
            return self._github.correlate_work_pull_request(branch=branch, base_sha=base_sha)
        except GithubNotFoundError as exc:
            raise EvidenceContradictionError(
                f"machine state records {state.value} for "
                f"'{item.identity.work_item}' but no governed pull request "
                f"is observed for branch '{branch}'"
            ) from exc

    # -- internal: the one governed lifecycle step (AC6) ----------------------

    def _governed_step(
        self, item: GovernedWorkItem, state: LifecycleState, classification: EvidenceClassification
    ) -> DomainEvent | None:
        """Request at most one frozen transition for this evaluation.

        PR_OPEN begins the CI wait (AWAIT_CI, mirroring the CTRL-005
        orchestrator step); CI_PENDING records success only on
        terminal-success evidence (RECORD_CI_SUCCESS). Every other
        classification observes without an event. The CTRL-002 domain
        model remains the single validity authority — the gate never
        invents a transition the frozen table refuses.
        """
        if state is LifecycleState.PR_OPEN:
            return item.handle(DomainCommand(item.identity.work_item, CommandName.AWAIT_CI))
        if classification is EvidenceClassification.TERMINAL_SUCCESS:
            return item.handle(
                DomainCommand(item.identity.work_item, CommandName.RECORD_CI_SUCCESS)
            )
        return None

    # -- internal: the typed retry handoff (AC5) ------------------------------

    def _retry_request(
        self,
        item: GovernedWorkItem,
        references: OrchestrationReferences,
        pr: GithubPullRequest,
        policy: EvidencePolicy,
        failed: tuple[str, ...],
        branch: str,
        base_sha: str,
    ) -> EvidenceRetryRequest | None:
        """Build the typed retry request, or expose the failure without one.

        The request exists only when the frozen policy classifies every
        failing required check as retryable AND the exact governed
        worker context is reconstructible from the carried references.
        A contradictory carried session (foreign repository, work item,
        base, or drifted PR identity) fails closed; an absent session
        reference leaves the failure exposed for governance attention
        without guessed recovery. No provider I/O happens here — the
        boundary re-establishes provenance before any resume.
        """
        if not policy.is_retryable(failed):
            return None
        session = references.worker_session
        if session is None:
            return None
        self._prove_retry_session(item, session, pr, base_sha)
        return EvidenceRetryRequest(
            session_id=session.session_id,
            repository=item.identity.repository,
            work_item=item.identity.work_item,
            work_order_path=item.identity.work_order_path,
            branch=branch,
            base_sha=base_sha,
            pr_number=pr.number,
            head_sha=pr.head_sha,
            failed_checks=tuple(sorted(failed)),
            reason=(
                "retryable terminal CI failure on required checks "
                + ", ".join(sorted(failed))
                + f" at governed PR #{pr.number} head {pr.head_sha[:12]}"
            ),
        )

    def _prove_retry_session(
        self,
        item: GovernedWorkItem,
        session: ZaiWorkerSession,
        pr: GithubPullRequest,
        base_sha: str,
    ) -> None:
        """Prove the carried worker-session binding for the retry request.

        Proves exactly the FZ-CTRL005-001 doctrine facts (session
        repository, work item, and dispatch base against authority and
        the carried base reference) plus PR identity when the session
        reports one: a session claiming a different PR or head than the
        exact correlated governed PR is stale or forked evidence and
        fails closed rather than being reinterpreted. Provenance is NOT
        proven here — the consuming boundary re-establishes it from
        live provider state (the FZ-CTRL005-002 doctrine applied to
        retries).
        """
        if session.repository != item.identity.repository:
            raise EvidenceContradictionError(
                f"carried worker session '{session.session_id}' is bound to "
                f"repository '{session.repository}', but repository authority "
                f"identifies '{item.identity.repository}'"
            )
        if session.work_item != item.identity.work_item:
            raise EvidenceContradictionError(
                f"carried worker session '{session.session_id}' is bound to work "
                f"item '{session.work_item}', but repository authority identifies "
                f"'{item.identity.work_item}' as the active item"
            )
        if session.base_sha != base_sha:
            raise EvidenceContradictionError(
                f"carried worker session '{session.session_id}' is bound to base "
                f"{session.base_sha}, but the dispatch base is {base_sha}"
            )
        if session.pr_number is not None and session.pr_number != pr.number:
            raise EvidenceContradictionError(
                f"carried worker session '{session.session_id}' claims PR "
                f"#{session.pr_number}, but the correlated governed PR is #{pr.number}"
            )
        if session.head_sha is not None and session.head_sha != pr.head_sha:
            raise EvidenceContradictionError(
                f"carried worker session '{session.session_id}' claims head "
                f"{session.head_sha}, but the correlated governed head is {pr.head_sha}"
            )


# ---------------------------------------------------------------------------
# Deterministic classification core (AC3/AC4)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _CheckDetail:
    """Sorted per-classification check-context lists (internal)."""

    successful: tuple[str, ...] = ()
    pending: tuple[str, ...] = ()
    failed: tuple[str, ...] = ()
    missing: tuple[str, ...] = ()
    blocked: tuple[str, ...] = ()
    unrelated: tuple[str, ...] = ()


def _classify(
    policy: EvidencePolicy, status: GithubCommitStatus
) -> tuple[EvidenceClassification, _CheckDetail]:
    """Apply the frozen classification rules to one observed status.

    Pure function of ``(policy, status)``: identical inputs yield
    identical classification and check detail, so restart replays the
    same decision (AC7) and the aggregate precedence is exactly the
    documented rule order.
    """
    observed: dict[str, list[str]] = {}
    for context, check_state in status.statuses:
        observed.setdefault(context, []).append(check_state)

    successful: list[str] = []
    pending: list[str] = []
    failed: list[str] = []
    missing: list[str] = []
    blocked: list[str] = []

    # A missing required check can only still appear while the combined
    # status is explicitly pending; a terminal or unrecognized combined
    # state makes the absent required evidence structurally
    # unsatisfiable — fail closed instead of guessing a pending that
    # never ends.
    suite_pending = status.state == _PENDING_STATE

    for check in policy.required_checks:
        entries = observed.get(check)
        if entries is None:
            missing.append(check)
            if not suite_pending:
                blocked.append(check)
            else:
                pending.append(check)
            continue
        if len(entries) > 1:
            # The same context reported twice is ambiguous evidence: the
            # gate never guesses which entry governs (fail closed).
            blocked.append(check)
            continue
        check_state = entries[0]
        if check_state == _SUCCESS_STATE:
            successful.append(check)
        elif check_state in _FAILURE_STATES:
            failed.append(check)
        elif check_state == _PENDING_STATE:
            pending.append(check)
        else:
            # Unrecognized state value: never guessed into a known class.
            blocked.append(check)

    required = set(policy.required_checks)
    unrelated = sorted(context for context in observed if context not in required)

    if blocked:
        classification = EvidenceClassification.POLICY_BLOCKED
    elif failed:
        classification = EvidenceClassification.TERMINAL_FAILURE
    elif pending:
        classification = EvidenceClassification.PENDING
    else:
        classification = EvidenceClassification.TERMINAL_SUCCESS

    detail = _CheckDetail(
        successful=tuple(sorted(successful)),
        pending=tuple(sorted(pending)),
        failed=tuple(sorted(failed)),
        missing=tuple(sorted(missing)),
        blocked=tuple(sorted(blocked)),
        unrelated=tuple(unrelated),
    )
    return classification, detail
