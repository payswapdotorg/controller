"""Deterministic orchestration boundary (CTRL-005).

Coordinates the already-accepted domain model (CTRL-001/002), GitHub
adapter (CTRL-003), and Z.ai worker adapter (CTRL-004) for exactly one
active governed Work Order. Doctrine:

* **Authority reconstruction first (AC1).** Every cycle begins from
  current repository machine state via :func:`controller.domain.
  reconstruct_domain` — missing, malformed, stale, or contradictory
  authority fails closed with typed errors *before any remote action*.
  The orchestrator never mutates authority files.
* **Exact active-item correlation (AC2).** The work-item identity flows
  from repository authority into every GitHub PR correlation and every
  Z.ai worker context; foreign, ambiguous, or drifted correlation is
  refused by the underlying adapters and re-checked here. The worker
  execution reference is carried as **typed** adapter-issued
  :class:`ZaiWorkerSession` evidence (never a bare session-id string) and
  its binding — session id, repository, active Work Item, and dispatch
  base SHA — is re-proved against reconstructed authority before any
  lifecycle event that depends on it (FZ-CTRL005-001).
* **Adapter coordination (AC3).** Remote I/O happens only through the
  injected adapters. Start/resume calls carry the exact repository-
  derived context and preserve the same governed worker/PR identity
  across a change iteration.
* **Deterministic lifecycle control (AC4).** One governed transition per
  cycle, mapped from evidence to the frozen transition table via the
  domain model. Identical (authority, evidence, references) inputs yield
  identical outcomes. Pure observations issue no command.
* **Fail-closed contradictions (AC5).** Repository authority outranks
  remote observation; contradictions stop the run with typed outcomes
  (:class:`controller.errors.OrchestrationContradictionError`).
* **Runtime non-authority (AC6).** No state, cache, or database: the
  orchestrator holds only the two adapters. Non-authoritative carried
  references (:class:`OrchestrationReferences` — the governed branch,
  dispatch base, the typed worker-session evidence, architect reviewer)
  are caller inputs, cross-validated against evidence; restart with the
  same inputs reproduces the same decision.
* **Downstream policy boundary (AC7).** Review approval, merge,
  reconciliation, and advance are *exposed* (typed handoff outcomes),
  never executed. CI/evidence gate policy belongs to CTRL-006.
* **Single remote mutation surface.** The only remote mutations the
  orchestrator can perform are starting/identifying and resuming the
  Z.ai worker through the accepted adapter — only inside a governed
  cycle, with authority validated first and lifecycle events emitted
  only on proven evidence. Branch/PR creation belongs to the worker;
  merge belongs to the Architect (CTRL-008).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from controller.commands import CommandName
from controller.domain import DomainCommand, DomainEvent, GovernedWorkItem, reconstruct_domain
from controller.errors import (
    GithubNotFoundError,
    OrchestrationContradictionError,
    OrchestrationError,
    OrchestrationMissingReferenceError,
)
from controller.github import GithubAdapter, GithubCommitStatus, GithubPullRequest, GithubReview
from controller.states import LifecycleState
from controller.zai import ZaiAdapter, ZaiWorkerContext, ZaiWorkerSession

#: The base branch every governed work item dispatches from.
_BASE_BRANCH = "main"


@dataclass(frozen=True)
class OrchestrationReferences:
    """Non-authoritative carried references for one orchestration cycle.

    The orchestrator keeps no runtime state (AC6), so the governed facts
    that live outside repository authority are supplied by the caller
    (the controller runtime / operator) and cross-validated against
    authority and remote evidence:

    * ``branch`` — the governed implementation branch (PR correlation);
    * ``base_sha`` — the exact dispatch base SHA (PR correlation and the
      worker-session binding proof);
    * ``worker_session`` — the **typed** :class:`ZaiWorkerSession`
      evidence returned by the accepted Z.ai adapter at dispatch; a bare
      session-id string is deliberately not accepted (FZ-CTRL005-001),
      because the typed value is the only carried form whose repository,
      work-item, and base binding the orchestrator can re-prove against
      authority before emitting a lifecycle event;
    * ``architect_reviewer`` — the GitHub identity whose reviews are the
      Architect's authority-recorded decisions.
    """

    branch: str | None = None
    base_sha: str | None = None
    worker_session: ZaiWorkerSession | None = None
    architect_reviewer: str | None = None


@dataclass(frozen=True)
class OrchestrationOutcome:
    """Base class for one deterministic orchestration decision.

    ``lifecycle`` is the authority-reconstructed state at the start of
    the cycle; ``event`` is the governed transition applied this cycle
    (``None`` for pure observations, which issue no command), already
    validated against the frozen table; ``findings``/evidence fields on
    subclasses expose exactly what downstream stages (CTRL-006+)
    consume.
    """

    work_item: str
    lifecycle: LifecycleState
    event: DomainEvent | None


@dataclass(frozen=True)
class WorkerDispatched(OrchestrationOutcome):
    """READY + eligible: the worker was started for the exact Work Order."""

    session: ZaiWorkerSession


@dataclass(frozen=True)
class ImplementationStarted(OrchestrationOutcome):
    """DISPATCHED + proven worker-session evidence: implementation began."""

    session_id: str


@dataclass(frozen=True)
class AwaitingWorker(OrchestrationOutcome):
    """DISPATCHED without a worker-session reference: observation only."""


@dataclass(frozen=True)
class AwaitingPullRequest(OrchestrationOutcome):
    """IMPLEMENTING and no governed PR is open yet: observation only."""


@dataclass(frozen=True)
class PullRequestOpened(OrchestrationOutcome):
    """IMPLEMENTING + exact PR correlation: the governed PR is open."""

    pull_request: GithubPullRequest


@dataclass(frozen=True)
class AwaitingCI(OrchestrationOutcome):
    """CI is not terminal-success yet (or PR_OPEN just began waiting)."""

    status: GithubCommitStatus


@dataclass(frozen=True)
class EvidenceRecorded(OrchestrationOutcome):
    """CI_PENDING + terminal-success evidence: RECORD_CI_SUCCESS applied."""

    status: GithubCommitStatus


@dataclass(frozen=True)
class AwaitingReview(OrchestrationOutcome):
    """REVIEW_PENDING without a qualifying Architect decision yet."""

    reviews: tuple[GithubReview, ...]


@dataclass(frozen=True)
class ChangesRequested(OrchestrationOutcome):
    """REVIEW_PENDING + Architect CHANGES_REQUESTED evidence."""

    findings: tuple[str, ...]


@dataclass(frozen=True)
class ReviewApproved(OrchestrationOutcome):
    """REVIEW_PENDING + Architect APPROVE bound to the exact head."""

    review: GithubReview


@dataclass(frozen=True)
class WorkerResumed(OrchestrationOutcome):
    """CHANGES_REQUESTED: the same governed worker/PR context resumed."""

    session: ZaiWorkerSession
    findings: tuple[str, ...]


@dataclass(frozen=True)
class DownstreamHandoff(OrchestrationOutcome):
    """The lifecycle position belongs to a downstream stage (CTRL-006+).

    Merge, reconciliation, and advancement are exposed — never executed
    — by the orchestrator; the reason names the owning stage.
    """

    reason: str


class Orchestrator:
    """Deterministic single-run orchestrator over the accepted adapters.

    One :meth:`run_cycle` reconstructs authority, observes evidence, and
    performs exactly one governed step (one frozen transition, or one
    pure observation). The instance holds no runtime state beyond the
    two injected adapters; restart with the same repository, evidence,
    and references reproduces the same decision (AC6).
    """

    def __init__(self, *, github: GithubAdapter, zai: ZaiAdapter) -> None:
        self._github = github
        self._zai = zai

    # -- one governed step per run (AC4) --------------------------------------

    def run_cycle(
        self,
        repo_root: Path,
        references: OrchestrationReferences | None = None,
    ) -> OrchestrationOutcome:
        """Advance the active governed Work Order by exactly one step.

        Authority is reconstructed first (AC1); every failure —
        authority contradiction, foreign/stale correlation, adapter
        failure, missing carried reference — propagates as a typed
        :class:`controller.errors.ControllerError` after zero or fully
        validated remote effects. Never merges, approves, reconciles,
        or advances (AC7).
        """
        refs = references if references is not None else OrchestrationReferences()
        item = reconstruct_domain(repo_root)
        state = item.lifecycle
        if state is LifecycleState.READY:
            return self._dispatch_worker(item, repo_root)
        if state is LifecycleState.DISPATCHED:
            return self._begin_implementation(item, repo_root, refs)
        if state is LifecycleState.IMPLEMENTING:
            return self._observe_pull_request(item, refs)
        if state is LifecycleState.PR_OPEN:
            return self._begin_ci_wait(item, refs)
        if state is LifecycleState.CI_PENDING:
            return self._observe_ci(item, refs)
        if state is LifecycleState.REVIEW_PENDING:
            return self._observe_review(item, refs)
        if state is LifecycleState.CHANGES_REQUESTED:
            return self._resume_worker(item, refs)
        return DownstreamHandoff(
            work_item=item.identity.work_item,
            lifecycle=state,
            event=None,
            reason=_downstream_reason(state),
        )

    # -- cycle implementations -------------------------------------------------

    def _dispatch_worker(self, item: GovernedWorkItem, repo_root: Path) -> OrchestrationOutcome:
        """READY + eligible: validate the DISPATCH command, then start the
        worker with the exact repository-derived context (AC1: the command
        validates before the remote mutation)."""
        command = DomainCommand(item.identity.work_item, CommandName.DISPATCH)
        event = item.handle(command)  # typed refusal (e.g. IneligibleDispatchError) before I/O
        base = self._github.get_branch(_BASE_BRANCH)
        context = self._dispatch_context(item, repo_root, None, base_sha=base.sha)
        session = self._zai.start_worker(context)
        return WorkerDispatched(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=event,
            session=session,
        )

    def _dispatch_context(
        self,
        item: GovernedWorkItem,
        repo_root: Path,
        refs: OrchestrationReferences | None,
        *,
        base_sha: str | None = None,
    ) -> ZaiWorkerContext:
        """The exact repository-derived worker context for the active item.

        At dispatch the base is the live branch head; on the DISPATCHED
        provenance re-observation the base is the carried dispatch-base
        reference (the provider-identified session must still be bound to
        exactly that base, or the adapter refuses)."""
        resolved_base = base_sha if base_sha is not None else self._carried_base(item, refs)
        content = _read_work_order(repo_root, item.identity.work_order_path)
        return ZaiWorkerContext(
            repository=item.identity.repository,
            work_item=item.identity.work_item,
            work_order_path=item.identity.work_order_path,
            base_sha=resolved_base,
            work_order_content=content,
        )

    def _carried_base(self, item: GovernedWorkItem, refs: OrchestrationReferences | None) -> str:
        if refs is None or refs.base_sha is None:
            raise OrchestrationMissingReferenceError(
                f"proving the worker execution for '{item.identity.work_item}' "
                "requires the carried dispatch-base reference; it is never guessed"
            )
        return refs.base_sha

    def _begin_implementation(
        self, item: GovernedWorkItem, repo_root: Path, refs: OrchestrationReferences
    ) -> OrchestrationOutcome:
        """DISPATCHED: emit BEGIN_IMPLEMENTATION only on proven execution
        evidence (FZ-CTRL005-001 + FZ-CTRL005-002).

        The carried typed session is a *request*, not proof: its binding
        (session id, repository, active Work Item, dispatch base SHA) is
        checked against reconstructed authority first (foreign binding
        refuses with zero provider calls), and its **provenance** is then
        re-established from live provider state through the accepted
        CTRL-004 adapter contract — ``start_worker`` with the exact
        repository-derived context *identifies* the worker execution for
        that exact Work Order, and the provider-identified session must
        be the very session the caller carried (fork guard, mirroring the
        adapter's own resume fork refusal). Only then does the lifecycle
        event emit. No session value constructed by hand — however
        structurally exact — can pass without the provider identifying
        it right now; no PR identity is invented while still DISPATCHED."""
        if refs.worker_session is None:
            return AwaitingWorker(
                work_item=item.identity.work_item,
                lifecycle=item.lifecycle,
                event=None,
            )
        session = self._prove_worker_session(item, refs)
        if session.pr_number is not None or session.head_sha is not None:
            raise OrchestrationContradictionError(
                f"worker session '{session.session_id}' reports PR identity "
                f"(#{session.pr_number}) while '{item.identity.work_item}' is "
                "still DISPATCHED and authority records no governed pull request"
            )
        observed = self._zai.start_worker(self._dispatch_context(item, repo_root, refs))
        if observed.session_id != session.session_id:
            raise OrchestrationContradictionError(
                f"the provider identifies worker session '{observed.session_id}' for "
                f"the exact '{item.identity.work_item}' context, but the carried "
                f"evidence names '{session.session_id}': the carried session was "
                "not issued for this governed context (or the execution forked)"
            )
        event = item.handle(
            DomainCommand(item.identity.work_item, CommandName.BEGIN_IMPLEMENTATION)
        )
        return ImplementationStarted(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=event,
            session_id=observed.session_id,
        )

    def _observe_pull_request(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> OrchestrationOutcome:
        """IMPLEMENTING: correlate the governed PR exactly; absent PR is a
        pure observation, foreign/ambiguous/drifted correlation refuses."""
        pr = self._find_pull_request(item, refs)
        if pr is None:
            return AwaitingPullRequest(
                work_item=item.identity.work_item,
                lifecycle=item.lifecycle,
                event=None,
            )
        event = item.handle(DomainCommand(item.identity.work_item, CommandName.OPEN_PR))
        return PullRequestOpened(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=event,
            pull_request=pr,
        )

    def _begin_ci_wait(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> OrchestrationOutcome:
        """PR_OPEN: the PR exists by authority; begin awaiting CI and expose
        the observed status (terminal-success recording happens next cycle)."""
        pr = self._require_pull_request(item, refs)
        status = self._github.get_commit_status(pr.head_sha)
        event = item.handle(DomainCommand(item.identity.work_item, CommandName.AWAIT_CI))
        return AwaitingCI(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=event,
            status=status,
        )

    def _observe_ci(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> OrchestrationOutcome:
        """CI_PENDING: only terminal-success evidence authorizes
        RECORD_CI_SUCCESS; every other observed status is exposed for the
        downstream CI/evidence gate (CTRL-006) — no retry policy here."""
        pr = self._require_pull_request(item, refs)
        status = self._github.get_commit_status(pr.head_sha)
        if status.state == "success":
            event = item.handle(
                DomainCommand(item.identity.work_item, CommandName.RECORD_CI_SUCCESS)
            )
            return EvidenceRecorded(
                work_item=item.identity.work_item,
                lifecycle=item.lifecycle,
                event=event,
                status=status,
            )
        return AwaitingCI(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=None,
            status=status,
        )

    def _observe_review(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> OrchestrationOutcome:
        """REVIEW_PENDING: the Architect's latest review is the authority-
        recorded decision. CHANGES_REQUESTED maps to REQUEST_CHANGES; an
        APPROVE bound to the exact head maps to APPROVE; anything else
        (no reviews, non-architect reviews, stale approval) observes."""
        pr = self._require_pull_request(item, refs)
        reviews = self._github.get_reviews(pr.number)
        reviewer = self._require_reviewer(refs)
        architect_reviews = [review for review in reviews if review.author == reviewer]
        if not architect_reviews:
            return AwaitingReview(
                work_item=item.identity.work_item,
                lifecycle=item.lifecycle,
                event=None,
                reviews=reviews,
            )
        latest = max(architect_reviews, key=lambda review: (review.submitted_at, review.review_id))
        if latest.state == "APPROVED":
            if latest.commit_id != pr.head_sha:
                return AwaitingReview(
                    work_item=item.identity.work_item,
                    lifecycle=item.lifecycle,
                    event=None,
                    reviews=reviews,
                )
            event = item.handle(DomainCommand(item.identity.work_item, CommandName.APPROVE))
            return ReviewApproved(
                work_item=item.identity.work_item,
                lifecycle=item.lifecycle,
                event=event,
                review=latest,
            )
        if latest.state == "CHANGES_REQUESTED":
            findings = _findings_from_reviews((latest,))
            event = item.handle(DomainCommand(item.identity.work_item, CommandName.REQUEST_CHANGES))
            return ChangesRequested(
                work_item=item.identity.work_item,
                lifecycle=item.lifecycle,
                event=event,
                findings=findings,
            )
        return AwaitingReview(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=None,
            reviews=reviews,
        )

    def _resume_worker(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> OrchestrationOutcome:
        """CHANGES_REQUESTED: re-observe the review evidence (restart-safe:
        findings come from GitHub, never stored state), prove the carried
        typed worker-session evidence against authority (FZ-CTRL005-001:
        before the lifecycle event), validate the RESUME_IMPLEMENTATION
        command, then resume the *same* governed worker/PR context with
        the verbatim review packet (AC3). The adapter re-proves the
        session identity from live provider state on the resume call."""
        pr = self._require_pull_request(item, refs)
        reviews = self._github.get_reviews(pr.number)
        reviewer = self._require_reviewer(refs)
        architect_reviews = [review for review in reviews if review.author == reviewer]
        if not architect_reviews:
            raise OrchestrationContradictionError(
                f"machine state records CHANGES_REQUESTED for '{item.identity.work_item}' "
                f"but no review by the architect '{reviewer}' is observed"
            )
        latest = max(architect_reviews, key=lambda review: (review.submitted_at, review.review_id))
        if latest.state != "CHANGES_REQUESTED":
            raise OrchestrationContradictionError(
                f"machine state records CHANGES_REQUESTED for '{item.identity.work_item}' "
                f"but the latest architect review is {latest.state}"
            )
        if refs.worker_session is None:
            raise OrchestrationMissingReferenceError(
                "resuming the governed worker requires the carried typed "
                "worker-session evidence (returned at dispatch); a bare session "
                "id is never guessed or trusted"
            )
        session = self._prove_worker_session(item, refs)
        findings = _findings_from_reviews((latest,))
        event = item.handle(
            DomainCommand(item.identity.work_item, CommandName.RESUME_IMPLEMENTATION)
        )
        context = ZaiWorkerContext(
            repository=item.identity.repository,
            work_item=item.identity.work_item,
            work_order_path=item.identity.work_order_path,
            base_sha=refs.base_sha if refs.base_sha is not None else pr.base_sha,
            pr_number=pr.number,
            head_sha=pr.head_sha,
            review_findings=findings,
        )
        reported = self._zai.resume_worker(context, session.session_id)
        return WorkerResumed(
            work_item=item.identity.work_item,
            lifecycle=item.lifecycle,
            event=event,
            session=reported,
            findings=findings,
        )

    # -- correlation helpers (AC2/AC5) -----------------------------------------

    def _require_correlation_refs(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> tuple[str, str]:
        if refs.branch is None or refs.base_sha is None:
            raise OrchestrationMissingReferenceError(
                f"correlating the governed pull request for "
                f"'{item.identity.work_item}' requires the carried branch and "
                "dispatch-base references; they are never guessed"
            )
        return refs.branch, refs.base_sha

    def _find_pull_request(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> GithubPullRequest | None:
        """Correlate the governed PR; a missing PR is a valid observation
        (returns None). Ambiguity and base drift propagate typed adapter
        errors (fail closed, never guessed)."""
        branch, base_sha = self._require_correlation_refs(item, refs)
        try:
            return self._github.correlate_work_pull_request(branch=branch, base_sha=base_sha)
        except GithubNotFoundError:
            return None

    def _require_pull_request(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> GithubPullRequest:
        """Correlate the governed PR at a lifecycle position where authority
        already records it; absence is an authority/remote contradiction."""
        branch, base_sha = self._require_correlation_refs(item, refs)
        try:
            return self._github.correlate_work_pull_request(branch=branch, base_sha=base_sha)
        except GithubNotFoundError as exc:
            raise OrchestrationContradictionError(
                f"machine state records {item.lifecycle.value} for "
                f"'{item.identity.work_item}' but no governed pull request "
                f"is observed for branch '{branch}'"
            ) from exc

    def _prove_worker_session(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> ZaiWorkerSession:
        """Re-prove the carried typed worker-session evidence against
        reconstructed authority and the dispatch-base reference before any
        lifecycle event that depends on it (FZ-CTRL005-001, AC2/AC5).

        Proves exactly: the session id (present and well-formed by the
        frozen CTRL-004 value type), the repository, the active Work Item,
        and the dispatch base SHA. A foreign, swapped, or forged binding
        fails closed with a typed error *before* event emission and
        before any remote mutation.
        """
        session = refs.worker_session
        if session is None:
            raise OrchestrationMissingReferenceError(
                f"'{item.identity.work_item}' requires the carried typed "
                "worker-session evidence; it is never guessed"
            )
        if refs.base_sha is None:
            raise OrchestrationMissingReferenceError(
                "proving the worker-session binding requires the carried "
                "dispatch-base reference; it is never guessed"
            )
        if session.repository != item.identity.repository:
            raise OrchestrationContradictionError(
                f"carried worker session '{session.session_id}' is bound to "
                f"repository '{session.repository}', but repository authority "
                f"identifies '{item.identity.repository}'"
            )
        if session.work_item != item.identity.work_item:
            raise OrchestrationContradictionError(
                f"carried worker session '{session.session_id}' is bound to work "
                f"item '{session.work_item}', but repository authority identifies "
                f"'{item.identity.work_item}' as the active item"
            )
        if session.base_sha != refs.base_sha:
            raise OrchestrationContradictionError(
                f"carried worker session '{session.session_id}' is bound to base "
                f"{session.base_sha}, but the dispatch base is {refs.base_sha}"
            )
        return session

    def _require_reviewer(self, refs: OrchestrationReferences) -> str:
        if refs.architect_reviewer is None:
            raise OrchestrationMissingReferenceError(
                "interpreting review evidence requires the architect reviewer "
                "identity reference; it is never guessed"
            )
        return refs.architect_reviewer


# ---------------------------------------------------------------------------
# Deterministic helpers
# ---------------------------------------------------------------------------


def _read_work_order(repo_root: Path, relative: str) -> str:
    """Read the frozen Work Order text (repository-derived context input)."""
    try:
        return (repo_root / relative).read_text(encoding="utf-8")
    except OSError as exc:
        raise OrchestrationError(
            f"work order '{relative}' could not be read from the repository"
        ) from exc


def _findings_from_reviews(reviews: tuple[GithubReview, ...]) -> tuple[str, ...]:
    """Compose the review packet deterministically from typed evidence.

    The finding text is fully derived from the observed review values —
    nothing is invented, and identical evidence produces identical
    findings (restart-safe: the packet is reconstructed from GitHub on
    every resume, never stored).
    """
    return tuple(
        f"review {review.review_id} by {review.author} at {review.submitted_at}: "
        f"{review.state} (commit {review.commit_id or 'unreported'})"
        for review in reviews
    )


def _downstream_reason(state: LifecycleState) -> str:
    """The downstream stage owning a lifecycle position (AC7 boundary)."""
    if state is LifecycleState.APPROVED:
        return "merge execution is owned by the merge gate (CTRL-008); exposed only"
    if state in (LifecycleState.MERGING, LifecycleState.MERGED):
        return "merge recording is owned by merge/reconciliation automation (CTRL-008)"
    if state is LifecycleState.RECONCILING:
        return "reconciliation is owned by the reconciliation engine (CTRL-008/009)"
    if state is LifecycleState.COMPLETE:
        return "advancement is owned by governed activation, not the runtime orchestrator"
    if state is LifecycleState.NEXT_READY:
        return "the next item is activated through repository authority, not orchestration"
    return f"lifecycle state {state.value} requires governance attention; no action"
