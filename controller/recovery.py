"""Governed recovery boundary (CTRL-009).

Deterministic restart/interruption recovery for exactly one active
governed Work Item: after any restart or interruption, this module
reconstructs repository authority, correlates the observed GitHub
evidence, and classifies the recovery condition — naming the FIRST
incomplete governed boundary and the already-observed facts — so the
runtime resumes mechanical work through the boundary that owns it,
never through a parallel path. Doctrine:

* **Authority-first (AC1).** Every recovery evaluation begins from a
  full authority reconstruction through the CTRL-002 domain layer
  (:func:`controller.domain.reconstruct_domain`). Missing, malformed,
  stale, or contradictory authority fails closed with the CTRL-001/002
  typed errors *before any remote observation*. The recovery boundary
  mutates no authority file.
* **First-incomplete-step reconstruction (AC2).** The plan names the
  owning governed boundary for the next step of the frozen lifecycle:
  the orchestrator (READY through CI_PENDING and the
  CHANGES_REQUESTED resume), the CTRL-006 evidence gate (CI_PENDING),
  the CTRL-007 review loop (REVIEW_PENDING), and the CTRL-008 merge
  boundary (APPROVED through RECONCILING). COMPLETE and NEXT_READY are
  Architect-side (post-reconciliation advancement) — the worker never
  advances or claims completion. Terminal exception states have no
  recovery by definition. At READY/DISPATCHED with an already observed
  governed PR the plan directs NO next step: the PR is durable
  evidence the dispatch/start work already ran, the orchestrator's
  READY/DISPATCHED cycles re-perform the provider start, and a second
  worker/provider execution for one Work Item is never caused by the
  recovery continuation (FZ-CTRL009-001).
* **Evidence-correlated classification (AC3).** The governed pull
  request is observed across its whole history (the CTRL-008
  correlation vocabulary: unique PR for the carried branch, intended
  ``main`` base ref). Pre-merge positions apply the frozen CTRL-003
  exact-dispatch-base doctrine (a drifted or closed PR is a
  contradiction the owning boundaries already refuse); merge-boundary
  positions apply the FZ-CTRL008-001 doctrine (the observed current
  base is the identity; the dispatch SHA is provenance). A carried
  worker session, when present, has its ordinary binding
  (repository, Work Item, dispatch base, PR identity when reported —
  the FZ-CTRL005-001 doctrine facts) proven locally against
  reconstructed authority and the observed PR, and its adapter-issued
  provenance verified locally through the sealed CTRL-004 verifier
  (exact-type pin, the FZ-CTRL007-005 doctrine: the virtual
  ``is_adapter_issued`` method is never trusted). Foreign, stale, or
  drifted identity fails closed — history is never permission.
* **No fabricated semantic decisions (AC4).** Recovery only *observes*
  and transports decision facts (the latest architect-authored review
  state, selected by the deterministic ``(submitted_at, review_id)``
  order, bound to the exact PR head). It never parses packets (the
  CTRL-007 loop owns that), never authors, infers, or upgrades a
  decision, and never applies a lifecycle command: the boundary holds
  zero ``item.handle`` call sites. Missing semantic evidence leaves
  the plan at IN_PROGRESS — the review loop observes it when invoked.
* **Partial-operation safety (AC5).** A post-mutation position whose
  external outcome is not observed (MERGING with an unmerged PR) is
  classified PARTIAL_MUTATION_UNRESOLVED — stop, governance attention,
  never a retry. An observed successful merge is accepted only in the
  exact CTRL-008 observed-evidence form (merged flag, closed state,
  intended base ref, canonical 40-hex merge commit SHA) and classified
  EXTERNAL_COMPLETION_OBSERVED for the merge boundary's external-merge
  continuation (record, never re-attempt).
* **Deterministic idempotency (AC6).** ``evaluate`` is a pure function
  of (repository authority, observed GitHub evidence, carried
  references): no clocks, randomness, memory, or hidden state. Repeated
  evaluation against unchanged inputs returns an equal plan and
  performs zero mutations — the boundary issues only GET observations
  through the CTRL-003 adapter (list PRs, commit status, reviews).
* **Existing lifecycle authority preserved (AC7).** The plan's
  ``next_step`` names the frozen-table transition the owning boundary
  applies; recovery applies none. No parallel lifecycle, no alternate
  merge/review semantics, no new predicates — every resume is executed
  by the existing boundary whose frozen predicate authorizes it.

The boundary holds only the injected GitHub adapter — no Z.ai adapter
instance, no worker-provider call of any kind, no database, cache,
queue, scheduler, or registry. The typed :class:`RecoveryPlan` is
always derived, never deserialized.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from controller.domain import GovernedWorkItem, reconstruct_domain
from controller.errors import (
    RecoveryContradictionError,
    RecoveryMissingReferenceError,
    RecoveryTerminalStateError,
)
from controller.github import GithubAdapter, GithubPullRequest
from controller.orchestrator import OrchestrationReferences
from controller.states import TERMINAL_EXCEPTION_STATES, LifecycleState
from controller.zai import (
    ZaiAdapter,
    ZaiIssuedWorkerSession,
    ZaiWorkerSession,
    _ordinary_field_values,
)

#: The intended base branch for every governed pull request (frozen
#: vocabulary shared with the CTRL-008 merge-boundary correlation).
_BASE_BRANCH = "main"

#: Canonical 40-lowercase-hex SHA form (the CTRL-003/CTRL-008 identity
#: vocabulary, mirrored for merge-evidence validation).
_SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")

#: Review states that map to protocol decisions (the frozen CTRL-007
#: decision channel vocabulary: only APPROVED and CHANGES_REQUESTED are
#: decisions; every other state is a non-decision).
_DECISION_STATES = ("APPROVED", "CHANGES_REQUESTED")

#: The frozen-table next step owned by the orchestrator at each
#: pre-merge position (the boundary that performs it when invoked).
_ORCHESTRATOR_NEXT_STEP: dict[LifecycleState, str] = {
    LifecycleState.READY: "DISPATCH",
    LifecycleState.DISPATCHED: "BEGIN_IMPLEMENTATION",
    LifecycleState.IMPLEMENTING: "OPEN_PR",
    LifecycleState.PR_OPEN: "AWAIT_CI",
    LifecycleState.CI_PENDING: "RECORD_CI_SUCCESS",
    LifecycleState.CHANGES_REQUESTED: "RESUME_IMPLEMENTATION",
}

#: Lifecycle positions at which the pre-merge exact-dispatch-base
#: correlation doctrine applies (a closed or base-drifted PR is a
#: contradiction the frozen pre-merge boundaries already refuse).
_PRE_MERGE_POSITIONS = frozenset(
    {
        LifecycleState.READY,
        LifecycleState.DISPATCHED,
        LifecycleState.IMPLEMENTING,
        LifecycleState.PR_OPEN,
        LifecycleState.CI_PENDING,
        LifecycleState.REVIEW_PENDING,
        LifecycleState.CHANGES_REQUESTED,
    }
)

#: Merge-boundary positions (the CTRL-008 ownership).
_MERGE_POSITIONS = frozenset(
    {
        LifecycleState.APPROVED,
        LifecycleState.MERGING,
        LifecycleState.MERGED,
        LifecycleState.RECONCILING,
    }
)

#: Positions whose review evidence recovery consults.
_REVIEW_POSITIONS = frozenset({LifecycleState.REVIEW_PENDING, LifecycleState.CHANGES_REQUESTED})

#: Positions whose CI evidence recovery observes (raw, verbatim).
_CI_POSITIONS = frozenset({LifecycleState.PR_OPEN, LifecycleState.CI_PENDING})

#: Positions at which a governed pull request must already be observed
#: (authority records a PR-open-or-later position).
_PR_REQUIRED_POSITIONS = frozenset(
    {
        LifecycleState.PR_OPEN,
        LifecycleState.CI_PENDING,
        LifecycleState.REVIEW_PENDING,
        LifecycleState.CHANGES_REQUESTED,
    }
)

#: Positions at which the worker-session reference is required for the
#: owning boundary's next step (the CHANGES_REQUESTED resume). An
#: absent required session fails closed with the typed
#: missing-reference error — a resume directive without the exact
#: session identity is never emitted (FZ-CTRL009-002).
_SESSION_REQUIRED_POSITIONS = frozenset({LifecycleState.CHANGES_REQUESTED})

#: Pre-merge positions whose frozen orchestrator step performs the
#: worker provider start. When a governed PR is already observed at
#: one of these positions the start work is durably performed — the
#: PR is its evidence — so the plan directs NO next step: the
#: orchestrator's READY/DISPATCHED cycles re-perform the provider
#: start, and a second worker/provider execution for one Work Item is
#: never caused by the recovery continuation (FZ-CTRL009-001).
_START_PERFORMING_POSITIONS = frozenset({LifecycleState.READY, LifecycleState.DISPATCHED})


class RecoveryCondition(str, Enum):
    """The classified restart/interruption condition (frozen vocabulary).

    The condition is a deterministic function of authority plus observed
    evidence — never of process memory — so the same snapshot always
    classifies the same way, on any machine, after any number of
    restarts (AC6).
    """

    #: READY with no governed PR observed — nothing has been performed;
    #: the orchestrator's dispatch boundary owns the first step.
    FRESH_START = "FRESH_START"

    #: Machine state and observed evidence agree; the owning boundary
    #: proceeds with its own normal evaluation (observation, wait, or
    #: its frozen predicate).
    IN_PROGRESS = "IN_PROGRESS"

    #: Durable evidence of work already performed but not yet reflected
    #: in machine state (an open PR before PR_OPEN, terminal-success CI
    #: before REVIEW_PENDING, an observed current architect decision at
    #: REVIEW_PENDING). The owning boundary records it — never repeats
    #: it.
    EVIDENCE_AHEAD = "EVIDENCE_AHEAD"

    #: A successful merge is observed in the exact CTRL-008
    #: evidence form while machine state sits before/at the merge
    #: boundary. The merge boundary's external-merge continuation
    #: records it; the mutation is never re-attempted.
    EXTERNAL_COMPLETION_OBSERVED = "EXTERNAL_COMPLETION_OBSERVED"

    #: A post-mutation position whose external outcome is not observed
    #: (MERGING with an unmerged PR). Stop: governance attention, never
    #: an automatic retry across the governance boundary (AC5).
    PARTIAL_MUTATION_UNRESOLVED = "PARTIAL_MUTATION_UNRESOLVED"

    #: The lifecycle is complete; the next act (post-reconciliation
    #: advancement, next-item activation) is Architect-side governance.
    #: The worker never advances or claims completion.
    AWAITING_GOVERNANCE = "AWAITING_GOVERNANCE"


class GovernedBoundary(str, Enum):
    """The existing boundary that owns the next governed step (AC2/AC7).

    Recovery never performs the step itself: the named boundary's own
    frozen predicate validates and executes it when invoked.
    """

    ORCHESTRATOR = "ORCHESTRATOR"
    EVIDENCE_GATE = "EVIDENCE_GATE"
    REVIEW_LOOP = "REVIEW_LOOP"
    MERGE_BOUNDARY = "MERGE_BOUNDARY"
    ARCHITECT_GOVERNANCE = "ARCHITECT_GOVERNANCE"


class SessionBinding(str, Enum):
    """The verified form of a carried worker-session reference."""

    #: Exactly :class:`ZaiIssuedWorkerSession` (exact dynamic type) with
    #: a construction-path proof that verifies through the sealed
    #: CTRL-004 verifier — adapter-issued evidence (FZ-CTRL007-001/005).
    VERIFIED_ISSUED = "VERIFIED_ISSUED"

    #: The ordinary :class:`ZaiWorkerSession` request form (exact
    #: dynamic type): the binding is proven locally, and provenance is
    #: re-established from live provider state by the consuming worker
    #: boundary (the orchestrator's start/resume fork guard,
    #: FZ-CTRL005-002) — never by this boundary.
    REQUEST_FORM = "REQUEST_FORM"


@dataclass(frozen=True)
class ObservedArchitectDecision:
    """An observed architect-review decision, transported verbatim.

    The latest review authored by the carried architect reviewer
    identity, selected by the deterministic ``(submitted_at,
    review_id)`` order (the frozen CTRL-007 selection vocabulary) and
    bound to the exact observed PR head. This is observed decision
    *evidence* for the plan's classification — the CTRL-007 review loop
    remains the decision authority; recovery never authors, infers, or
    upgrades a decision (AC4).
    """

    state: str
    author: str
    review_id: int
    submitted_at: str
    head_sha: str


@dataclass(frozen=True)
class RecoveryPlan:
    """The typed recovery contract: one deterministic resume directive.

    Every field is derived from repository authority, observed GitHub
    evidence, and the carried references — nothing from process memory
    — so equivalent inputs produce equal plans on any machine (AC6).
    The plan is a *direction* for the runtime, never an execution: the
    named boundary's own frozen predicate performs and authorizes the
    resumed step (AC7), and recovery itself performs zero mutations.
    """

    work_item: str
    repository: str
    lifecycle: LifecycleState
    condition: RecoveryCondition
    boundary: GovernedBoundary
    branch: str
    dispatch_base: str
    #: The observed governed PR (whole-history correlation), or None
    #: when none is observed. ``base_sha`` below is its observed
    #: current base — distinct from ``dispatch_base`` provenance
    #: (FZ-CTRL008-001).
    pull_request: GithubPullRequest | None
    base_sha: str | None
    #: The observed current architect decision (review positions),
    #: transported verbatim; None when none is current-and-bound.
    architect_decision: ObservedArchitectDecision | None
    #: The validated observed merge commit SHA (CTRL-008 evidence form),
    #: present exactly when a successful merge is observed.
    merge_commit_sha: str | None
    #: The raw observed combined-status state (verbatim; the CTRL-006
    #: evidence gate remains the classification authority).
    ci_state: str | None
    #: The frozen-table transition the owning boundary applies next
    #: (None when the condition has no worker-side step: awaiting
    #: governance, unresolved partial mutation, pure observation, or
    #: evidence ahead of the start boundary — the dispatch/start work
    #: is already durably performed and is never replayed,
    #: FZ-CTRL009-001).
    next_step: str | None
    #: The carried session id and its verified binding form, when a
    #: session reference is carried.
    session_id: str | None
    session_binding: SessionBinding | None
    #: True when the owning boundary's next step requires the worker
    #: session reference (the CHANGES_REQUESTED resume).
    session_required: bool
    #: Deterministic audit basis (the DispatchEligibility precedent):
    #: the authority/evidence facts behind the classification.
    basis: tuple[str, ...]


class RecoveryBoundary:
    """The governed recovery boundary: classify, direct, never execute.

    ``evaluate(repo_root, references)`` performs exactly the read-only
    observations the classification needs (PR correlation across whole
    history; the combined status at CI positions; architect reviews at
    review positions), proves the carried identities, and returns the
    deterministic :class:`RecoveryPlan`. It applies no lifecycle
    command, performs no remote mutation, holds no state, and makes no
    worker-provider call — the resumed step runs through the boundary
    named in the plan, whose frozen predicate authorizes it.
    """

    def __init__(self, *, github: GithubAdapter) -> None:
        self._github = github

    # -- the single evaluation ----------------------------------------------

    def evaluate(self, repo_root: Path, references: OrchestrationReferences) -> RecoveryPlan:
        """Classify the restart/interruption condition for the active item.

        Authority is reconstructed first (AC1): CTRL-001/002 typed
        errors propagate before any remote call. The governed branch
        and dispatch-base provenance references are required (never
        guessed). Observations are made exactly where the position's
        classification needs them, and every identity — Work Item,
        branch, PR, base, head, reviewer, session — is correlated
        before it reaches the plan (AC3).
        """
        item = reconstruct_domain(repo_root)
        state = item.lifecycle
        if state in TERMINAL_EXCEPTION_STATES:
            raise RecoveryTerminalStateError(
                f"'{item.identity.work_item}' is in the terminal exception state "
                f"{state.value}: the lifecycle is over and only an explicit "
                "governed act can restart it — there is no recovery to direct"
            )
        branch, dispatch_base = self._require_correlation_refs(item, references)
        pr = self._observe_pull_request(item, branch)
        session_id, session_binding = self._verify_session(
            item, references, pr, branch, dispatch_base
        )
        self._check_position_identity(item, state, pr, dispatch_base)

        if state in _PRE_MERGE_POSITIONS:
            return self._classify_pre_merge(
                item, state, references, pr, branch, dispatch_base, session_id, session_binding
            )
        if state in _MERGE_POSITIONS:
            return self._classify_merge_band(
                item, state, pr, branch, dispatch_base, session_id, session_binding
            )
        return self._classify_completed(
            item, state, pr, branch, dispatch_base, session_id, session_binding
        )

    # -- references and identity (AC3) ---------------------------------------

    def _require_correlation_refs(
        self, item: GovernedWorkItem, refs: OrchestrationReferences
    ) -> tuple[str, str]:
        """Require the carried branch and dispatch-base provenance.

        The branch is the whole-history PR correlation key; the dispatch
        base is provenance (FZ-CTRL008-001), never the PR's current
        base identity. Neither is ever guessed.
        """
        if refs.branch is None or refs.base_sha is None:
            raise RecoveryMissingReferenceError(
                f"classifying the recovery condition for "
                f"'{item.identity.work_item}' requires the carried branch "
                "and dispatch-base references; they are never guessed"
            )
        return refs.branch, refs.base_sha

    def _verify_session(
        self,
        item: GovernedWorkItem,
        refs: OrchestrationReferences,
        pr: GithubPullRequest | None,
        branch: str,
        dispatch_base: str,
    ) -> tuple[str | None, SessionBinding | None]:
        """Prove the carried worker session's identity, if one is carried.

        Ordinary binding first (the FZ-CTRL005-001 doctrine facts —
        repository, Work Item, dispatch base — proven locally against
        reconstructed authority with zero provider calls), then
        construction-path provenance for the issued form through the
        sealed CTRL-004 verifier with the exact dynamic type pinned
        (FZ-CTRL007-005: the virtual ``is_adapter_issued`` method is
        never trusted; a subclass is refused before verification).
        A plain request-form session is carried as REQUEST_FORM — its
        live provenance re-proof belongs to the consuming worker
        boundary (FZ-CTRL005-002), never to this boundary. A position
        that requires the session (the CHANGES_REQUESTED resume) fails
        closed at classification when none is carried — absence is
        never tolerated into a resume directive (FZ-CTRL009-002).
        """
        session = refs.worker_session
        if session is None:
            return None, None
        if session.repository != item.identity.repository:
            raise RecoveryContradictionError(
                f"carried worker session '{session.session_id}' is bound to "
                f"repository '{session.repository}', but repository authority "
                f"identifies '{item.identity.repository}'"
            )
        if session.work_item != item.identity.work_item:
            raise RecoveryContradictionError(
                f"carried worker session '{session.session_id}' is bound to work "
                f"item '{session.work_item}', but repository authority identifies "
                f"'{item.identity.work_item}' as the active item"
            )
        if session.base_sha != dispatch_base:
            raise RecoveryContradictionError(
                f"carried worker session '{session.session_id}' is bound to base "
                f"{session.base_sha}, but the dispatch base is {dispatch_base}"
            )
        if session.pr_number is not None and (pr is None or session.pr_number != pr.number):
            reported = f"#{session.pr_number}"
            actual = "none observed" if pr is None else f"#{pr.number}"
            raise RecoveryContradictionError(
                f"carried worker session '{session.session_id}' reports PR "
                f"{reported}, but the governed pull request correlation observes "
                f"{actual} for branch '{branch}' — stale session identity is "
                "history, not permission"
            )
        if session.head_sha is not None and pr is not None and session.head_sha != pr.head_sha:
            raise RecoveryContradictionError(
                f"carried worker session '{session.session_id}' reports head "
                f"{session.head_sha}, but the governed pull request observes "
                f"head {pr.head_sha} — stale session identity is history, "
                "not permission"
            )
        if type(session) is ZaiIssuedWorkerSession:
            if not ZaiAdapter._verify_issuance(session._proof, _ordinary_field_values(session)):
                raise RecoveryContradictionError(
                    f"carried worker session '{session.session_id}' claims the "
                    "adapter-issued evidence form, but its construction-path "
                    "proof does not verify: the proof binds the exact fields it "
                    "was sealed for, so a transplanted or hand-built value is "
                    "refused (FZ-CTRL007-001)"
                )
            return session.session_id, SessionBinding.VERIFIED_ISSUED
        if type(session) is ZaiWorkerSession:
            return session.session_id, SessionBinding.REQUEST_FORM
        raise RecoveryContradictionError(
            f"carried worker session '{session.session_id}' has dynamic type "
            f"{type(session).__name__}: only the exact ordinary request form or "
            "the exact adapter-issued evidence type are accepted carried forms"
        )

    # -- observations (read-only, AC3/AC5) ------------------------------------

    def _observe_pull_request(
        self, item: GovernedWorkItem, branch: str
    ) -> GithubPullRequest | None:
        """Correlate the governed PR across its whole history, or None.

        The CTRL-008 correlation vocabulary: the unique PR for the
        governed branch in any state (the boundary observes the PR
        before and after the merge mutation), with the intended
        ``main`` base ref. Zero matches is a valid observation (None);
        multiple matches or a foreign base ref is a contradiction, and
        the failure fails closed with a typed error.
        """
        matches = self._github.list_pull_requests(state="all", head_branch=branch)
        if not matches:
            return None
        if len(matches) > 1:
            numbers = ", ".join(f"#{pr.number}" for pr in matches)
            raise RecoveryContradictionError(
                f"one-PR-per-work-item violated across history: PRs {numbers} "
                f"are all observed for the governed branch '{branch}' of "
                f"'{item.identity.work_item}' — ambiguous evidence is a "
                "contradiction, never a guess"
            )
        pr = matches[0]
        if pr.base_ref != _BASE_BRANCH:
            raise RecoveryContradictionError(
                f"governed PR #{pr.number} targets base ref {pr.base_ref!r}, "
                f"not the intended base ref '{_BASE_BRANCH}'"
            )
        return pr

    def _require_merge_evidence(self, item: GovernedWorkItem, pr: GithubPullRequest) -> str:
        """Validate the observed successful-merge evidence (CTRL-008 form).

        The exact observed-evidence vocabulary of the accepted merge
        boundary: merged flag, closed state, intended base ref, and a
        canonical 40-hex merge commit SHA. Recovery validates the
        observed form for classification only — it authorizes nothing.
        """
        context = f"PR #{pr.number} for '{item.identity.work_item}'"
        if not pr.merged:
            raise RecoveryContradictionError(
                f"{context} is not merged — no merge evidence to classify"
            )
        if pr.state != "closed":
            raise RecoveryContradictionError(
                f"{context} reports merged with state {pr.state!r}; a merged "
                "pull request must be closed — contradictory evidence"
            )
        merge_sha = pr.merge_commit_sha
        if merge_sha is None or not _SHA_PATTERN.match(merge_sha):
            reported = "absent" if merge_sha is None else merge_sha
            raise RecoveryContradictionError(
                f"{context} reports no canonical merge commit SHA (found "
                f"{reported}); the exact merge SHA is required evidence"
            )
        return merge_sha

    # -- position identity doctrine (AC3/AC7) ---------------------------------

    def _check_position_identity(
        self,
        item: GovernedWorkItem,
        state: LifecycleState,
        pr: GithubPullRequest | None,
        dispatch_base: str,
    ) -> None:
        """Enforce the position-appropriate correlation doctrine.

        Pre-merge positions apply the frozen CTRL-003 exact-dispatch-base
        doctrine: a governed PR must be open (the pre-merge correlation
        is open-only — a closed PR is unsupported and stops for
        governance) with its base exactly at the dispatch base (drift is
        a contradiction the owning boundaries already refuse). Positions
        that record a PR-open-or-later state require the PR to be
        observed at all. Merge-boundary and completed positions apply
        the FZ-CTRL008-001 doctrine (observed current base; dispatch
        SHA is provenance) and are classified in their own handlers.
        """
        context = f"'{item.identity.work_item}' at {state.value}"
        if state in _PRE_MERGE_POSITIONS:
            if state in _PR_REQUIRED_POSITIONS and pr is None:
                raise RecoveryContradictionError(
                    f"machine state records {context}, but no governed pull "
                    "request is observed — authority is ahead of the evidence "
                    "and nothing is guessed"
                )
            if pr is not None:
                if pr.state != "open":
                    raise RecoveryContradictionError(
                        f"machine state records {context}, but governed PR "
                        f"#{pr.number} is {pr.state}"
                        + (" (merged)" if pr.merged else "")
                        + ": the frozen pre-merge correlation observes open "
                        "PRs only, so a closed PR is an unsupported recovery "
                        "condition — governance attention is required"
                    )
                if pr.base_sha != dispatch_base:
                    raise RecoveryContradictionError(
                        f"governed PR #{pr.number} base {pr.base_sha} does not "
                        f"match the carried dispatch base {dispatch_base} at a "
                        f"pre-merge position ({state.value}): the frozen "
                        "pre-merge correlation refuses base drift, so recovery "
                        "fails closed rather than guessing"
                    )

    # -- classification: pre-merge band (AC2) ----------------------------------

    def _classify_pre_merge(
        self,
        item: GovernedWorkItem,
        state: LifecycleState,
        refs: OrchestrationReferences,
        pr: GithubPullRequest | None,
        branch: str,
        dispatch_base: str,
        session_id: str | None,
        session_binding: SessionBinding | None,
    ) -> RecoveryPlan:
        """Classify READY through CHANGES_REQUESTED (orchestrator-owned
        positions, plus the CI evidence gate and review loop subsets)."""
        basis: list[str] = [f"lifecycle state is {state.value}"]
        ci_state: str | None = None
        decision: ObservedArchitectDecision | None = None
        condition: RecoveryCondition
        boundary: GovernedBoundary
        next_step: str | None = None

        if pr is None:
            # READY/DISPATCHED/IMPLEMENTING with nothing performed yet.
            condition = (
                RecoveryCondition.FRESH_START
                if state is LifecycleState.READY
                else RecoveryCondition.IN_PROGRESS
            )
            boundary = GovernedBoundary.ORCHESTRATOR
            next_step = _ORCHESTRATOR_NEXT_STEP.get(state)
            basis.append("no governed pull request observed for the branch")
        else:
            basis.append(
                f"governed PR #{pr.number} observed open at head {pr.head_sha} "
                f"on the exact dispatch base"
            )
            condition = RecoveryCondition.EVIDENCE_AHEAD
            boundary = GovernedBoundary.ORCHESTRATOR
            if state in _PR_REQUIRED_POSITIONS:
                condition = RecoveryCondition.IN_PROGRESS
                next_step = _ORCHESTRATOR_NEXT_STEP.get(state)
            elif state in _START_PERFORMING_POSITIONS:
                next_step = None
                basis.append(
                    "the observed governed PR is durable evidence the "
                    "dispatch/start work already ran, and the orchestrator's "
                    "READY/DISPATCHED cycles re-perform the provider start: "
                    "no next step is directed, so the recovery continuation "
                    "can never cause a second worker/provider execution for "
                    "one Work Item"
                )
            else:
                next_step = _ORCHESTRATOR_NEXT_STEP.get(state)

        if state in _CI_POSITIONS and pr is not None:
            status = self._github.get_commit_status(pr.head_sha)
            ci_state = status.state
            basis.append(f"observed combined status state is {ci_state!r}")
            if state is LifecycleState.PR_OPEN:
                next_step = "AWAIT_CI"
            else:
                boundary = GovernedBoundary.EVIDENCE_GATE
                next_step = "RECORD_CI_SUCCESS"
            if ci_state == "success":
                condition = RecoveryCondition.EVIDENCE_AHEAD
                basis.append(
                    "terminal-success CI is already observed while machine "
                    "state records " + state.value
                )
        elif state is LifecycleState.PR_OPEN:
            next_step = "AWAIT_CI"

        if state in _REVIEW_POSITIONS:
            decision = self._observe_decision(item, refs, pr)
            boundary = GovernedBoundary.REVIEW_LOOP
            if state is LifecycleState.CHANGES_REQUESTED:
                boundary = GovernedBoundary.ORCHESTRATOR
                next_step = "RESUME_IMPLEMENTATION"
                self._check_changes_requested_stability(item, decision)
                if session_id is None:
                    raise RecoveryMissingReferenceError(
                        f"the CHANGES_REQUESTED resume for "
                        f"'{item.identity.work_item}' requires the carried "
                        "worker-session reference, but none is carried: a "
                        "resume directive without the exact session identity "
                        "is never emitted (AC3 — required session evidence "
                        "must correlate exactly)"
                    )
                condition = RecoveryCondition.IN_PROGRESS
            else:
                next_step = None
                if decision is not None:
                    condition = RecoveryCondition.EVIDENCE_AHEAD
                    next_step = "APPROVE" if decision.state == "APPROVED" else "REQUEST_CHANGES"
                    basis.append(
                        f"the current architect decision ({decision.state}, review "
                        f"#{decision.review_id}) is bound to the exact head while "
                        "machine state records REVIEW_PENDING"
                    )
                else:
                    condition = RecoveryCondition.IN_PROGRESS
                    basis.append("no current architect decision is bound to the exact head")

        session_required = state in _SESSION_REQUIRED_POSITIONS
        if session_required:
            # Unreachable with no carried session: the CHANGES_REQUESTED
            # classification above fails closed when the required carried
            # worker session is absent (FZ-CTRL009-002).
            basis.append(
                "the CHANGES_REQUESTED resume requires the worker-session "
                "reference (carried and verified)"
            )

        return RecoveryPlan(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            condition=condition,
            boundary=boundary,
            branch=branch,
            dispatch_base=dispatch_base,
            pull_request=pr,
            base_sha=pr.base_sha if pr is not None else None,
            architect_decision=decision,
            merge_commit_sha=None,
            ci_state=ci_state,
            next_step=next_step,
            session_id=session_id,
            session_binding=session_binding,
            session_required=session_required,
            basis=tuple(basis),
        )

    def _observe_decision(
        self, item: GovernedWorkItem, refs: OrchestrationReferences, pr: GithubPullRequest | None
    ) -> ObservedArchitectDecision | None:
        """Observe the current architect decision, or None.

        Only reviews authored by the carried architect reviewer identity
        are authoritative (the CTRL-007 decision channel); the latest is
        selected by the deterministic ``(submitted_at, review_id)``
        order; a decision must be bound to the exact observed PR head
        (``commit_id``) to be current — a stale binding is history, not
        permission; and only the observed states APPROVED and
        CHANGES_REQUESTED are decisions (every other state is a
        non-decision the classification never infers from). Recovery
        transports the observed facts verbatim; the CTRL-007 loop owns
        the decision.
        """
        if pr is None:
            return None
        if refs.architect_reviewer is None:
            raise RecoveryMissingReferenceError(
                f"classifying review evidence for '{item.identity.work_item}' "
                "requires the architect reviewer identity reference; it is "
                "never guessed"
            )
        reviews = self._github.get_reviews(pr.number)
        architect_reviews = [
            review for review in reviews if review.author == refs.architect_reviewer
        ]
        if not architect_reviews:
            return None
        latest = max(architect_reviews, key=lambda review: (review.submitted_at, review.review_id))
        if latest.state not in _DECISION_STATES:
            return None
        if latest.commit_id != pr.head_sha:
            return None
        return ObservedArchitectDecision(
            state=latest.state,
            author=latest.author,
            review_id=latest.review_id,
            submitted_at=latest.submitted_at,
            head_sha=pr.head_sha,
        )

    def _check_changes_requested_stability(
        self, item: GovernedWorkItem, decision: ObservedArchitectDecision | None
    ) -> None:
        """CHANGES_REQUESTED requires the observed decision to still stand.

        The frozen CTRL-005/CTRL-007 doctrine: a vanished or flipped
        decision at CHANGES_REQUESTED is a contradiction, not a no-op —
        recovery fails closed instead of guessing a resume.
        """
        if decision is None:
            raise RecoveryContradictionError(
                f"machine state records CHANGES_REQUESTED for "
                f"'{item.identity.work_item}', but no current architect "
                "decision is observed — a vanished decision is a "
                "contradiction, never a guessed resume"
            )
        if decision.state != "CHANGES_REQUESTED":
            raise RecoveryContradictionError(
                f"machine state records CHANGES_REQUESTED for "
                f"'{item.identity.work_item}', but the current architect "
                f"decision is {decision.state} — a flipped decision is a "
                "contradiction, never a guessed resume"
            )

    # -- classification: merge band (AC5) ---------------------------------------

    def _classify_merge_band(
        self,
        item: GovernedWorkItem,
        state: LifecycleState,
        pr: GithubPullRequest | None,
        branch: str,
        dispatch_base: str,
        session_id: str | None,
        session_binding: SessionBinding | None,
    ) -> RecoveryPlan:
        """Classify APPROVED through RECONCILING (the CTRL-008 boundary).

        The merge-boundary correlation doctrine (FZ-CTRL008-001) applies:
        the observed current base is the PR's base identity and the
        dispatch SHA is provenance only. An observed successful merge
        (validated in the exact CTRL-008 evidence form) classifies
        EXTERNAL_COMPLETION_OBSERVED for the boundary's external-merge
        continuation; an unobserved outcome at MERGING classifies
        PARTIAL_MUTATION_UNRESOLVED — stop, never retry.
        """
        if pr is None:
            raise RecoveryContradictionError(
                f"machine state records {state.value} for "
                f"'{item.identity.work_item}', but no governed pull request "
                "is observed across its whole history — authority is ahead of "
                "the evidence and nothing is guessed"
            )
        basis: list[str] = [
            f"lifecycle state is {state.value}",
            f"governed PR #{pr.number} observed (state {pr.state}, "
            f"merged={pr.merged}, base {pr.base_sha})",
        ]
        merge_sha: str | None = None
        condition: RecoveryCondition
        next_step: str | None

        if pr.merged:
            merge_sha = self._require_merge_evidence(item, pr)
            basis.append(
                f"observed merge evidence: merged, closed, base ref "
                f"{_BASE_BRANCH}, merge commit {merge_sha}"
            )
            if state is LifecycleState.APPROVED:
                condition = RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED
                next_step = "MERGE"
                basis.append(
                    "the merge already landed while machine state records "
                    "APPROVED: the merge boundary records it (external-merge "
                    "continuation), never re-attempts it"
                )
            elif state is LifecycleState.MERGING:
                condition = RecoveryCondition.EXTERNAL_COMPLETION_OBSERVED
                next_step = "RECORD_MERGE"
                basis.append(
                    "the authorized merge attempt landed while machine state "
                    "records MERGING: the merge boundary records it, never "
                    "re-attempts it"
                )
            elif state is LifecycleState.MERGED:
                condition = RecoveryCondition.IN_PROGRESS
                next_step = "RECONCILE"
            else:
                condition = RecoveryCondition.IN_PROGRESS
                next_step = "RECORD_RECONCILIATION"
        elif state is LifecycleState.APPROVED:
            condition = RecoveryCondition.IN_PROGRESS
            next_step = "MERGE"
            basis.append(
                "no merge evidence is observed: the merge boundary evaluates "
                "the complete frozen predicate and performs at most the one "
                "authorized attempt"
            )
        elif state is LifecycleState.MERGING:
            condition = RecoveryCondition.PARTIAL_MUTATION_UNRESOLVED
            next_step = None
            basis.append(
                "machine state records MERGING but the governed PR is not "
                "merged: the merge mutation's outcome is unobserved — stop "
                "for governance attention; the mutation is never retried "
                "automatically across the governance boundary"
            )
        else:
            raise RecoveryContradictionError(
                f"machine state records {state.value} for "
                f"'{item.identity.work_item}', but the governed PR "
                f"#{pr.number} is not merged — authority is ahead of the "
                "merge evidence and nothing is guessed"
            )

        boundary = (
            GovernedBoundary.MERGE_BOUNDARY
            if condition is not RecoveryCondition.PARTIAL_MUTATION_UNRESOLVED
            else GovernedBoundary.ARCHITECT_GOVERNANCE
        )
        return RecoveryPlan(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            condition=condition,
            boundary=boundary,
            branch=branch,
            dispatch_base=dispatch_base,
            pull_request=pr,
            base_sha=pr.base_sha,
            architect_decision=None,
            merge_commit_sha=merge_sha,
            ci_state=None,
            next_step=next_step,
            session_id=session_id,
            session_binding=session_binding,
            session_required=False,
            basis=tuple(basis),
        )

    # -- classification: completed band ------------------------------------------

    def _classify_completed(
        self,
        item: GovernedWorkItem,
        state: LifecycleState,
        pr: GithubPullRequest | None,
        branch: str,
        dispatch_base: str,
        session_id: str | None,
        session_binding: SessionBinding | None,
    ) -> RecoveryPlan:
        """Classify COMPLETE / NEXT_READY: Architect-side governance.

        The lifecycle is finished; the next act (post-reconciliation
        advancement and next-item activation) is the Architect's, per
        the frozen roadmap. The worker never advances and never claims
        completion. The observed merge evidence is validated and carried
        so the governance report is complete.
        """
        if pr is None:
            raise RecoveryContradictionError(
                f"machine state records {state.value} for "
                f"'{item.identity.work_item}', but no governed pull request "
                "is observed across its whole history — authority is ahead of "
                "the evidence and nothing is guessed"
            )
        merge_sha = self._require_merge_evidence(item, pr)
        basis: list[str] = [
            f"lifecycle state is {state.value}",
            f"governed PR #{pr.number} observed merged with merge commit {merge_sha}",
            "post-reconciliation advancement is Architect-side governance; "
            "the worker never advances or claims completion",
        ]
        return RecoveryPlan(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            condition=RecoveryCondition.AWAITING_GOVERNANCE,
            boundary=GovernedBoundary.ARCHITECT_GOVERNANCE,
            branch=branch,
            dispatch_base=dispatch_base,
            pull_request=pr,
            base_sha=pr.base_sha,
            architect_decision=None,
            merge_commit_sha=merge_sha,
            ci_state=None,
            next_step="ADVANCE" if state is LifecycleState.COMPLETE else None,
            session_id=session_id,
            session_binding=session_binding,
            session_required=False,
            basis=tuple(basis),
        )


__all__ = [
    "GovernedBoundary",
    "ObservedArchitectDecision",
    "RecoveryBoundary",
    "RecoveryCondition",
    "RecoveryPlan",
    "SessionBinding",
]
