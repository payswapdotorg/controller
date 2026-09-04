"""Governed merge + post-merge reconciliation boundary (CTRL-008).

Coordinates the accepted CTRL-003 GitHub adapter (merge authorization,
execution-time re-proof, and merge-result evidence), the CTRL-002 domain
model, and repository authority for the terminal segment of exactly one
active governed Work Order: the merge boundary. Doctrine:

* **Authority-first (AC1).** Every evaluation begins from a full
  repository-authority reconstruction through
  :func:`controller.domain.reconstruct_domain`. Malformed, missing, or
  contradictory authority fails closed with typed errors *before any
  remote call or mutation*. A lifecycle position outside the merge
  boundary (``APPROVED``..``RECONCILING``) is a governance misuse and
  fails closed with :class:`controller.errors.MergeLoopPositionError`.
* **Exact correlation (AC2).** The governed PR is the unique PR for the
  carried governed branch (across its whole history — open or merged),
  targeting the intended ``main`` base at the exact carried dispatch-base
  SHA. Zero, multiple, or drifted correlation fails closed with
  :class:`controller.errors.MergeContradictionError`.
* **Complete frozen predicate (AC3).** The merge mutation is executed
  only through the CTRL-003 adapter, whose frozen predicate is evaluated
  in full from live GitHub state: PR open/non-draft/unmerged, intended
  base ref and SHA, exact head, clean mergeability, the one-PR rule,
  terminal-success required CI checks, an Architect ``APPROVE`` bound to
  the exact current head, no later ``CHANGES_REQUESTED``, and the
  authority-derived active-item binding. ``APPROVE`` alone never merges.
* **Execution-time drift protection + one attempt (AC4/AC5).**
  :meth:`GithubAdapter.merge_pull_request` re-establishes the complete
  policy proof immediately before the single ``PUT`` mutation, so any
  drift since authorization refuses execution with a typed error. The
  loop performs **at most one merge attempt per evaluation for one exact
  authorized head** — there is no intra-loop retry of any kind; a
  refused, failed, or contradictory merge surfaces typed for governance
  attention, and a later evaluation is a fresh governed cycle.
* **External execution evidence (AC5).** Only the observed GitHub merge
  result establishes ``MERGED``: the merged flag, the closed state, the
  intended base ref, and the reported merge commit SHA on the governed
  PR. A merge that already landed (an earlier cycle whose state write
  did not survive, or an externally performed authorized merge) is
  recorded — never re-attempted; a missing, contradictory, or unmerged
  observation at a post-execution position fails closed.
* **Deterministic reconciliation (AC6).** The reconciliation record is
  derived — never guessed — from repository authority plus the observed
  merge evidence: the completed ledger extended by exactly the active
  work item, the exact merge SHA, the deterministic next eligible work
  item (the unique not-completed work order declaring ``READY``), and
  the automation stage preserved verbatim. The record is a typed value
  the runtime persists through the governed commit; the loop itself
  mutates no authority file.
* **Restart/idempotency safety (AC7).** The loop holds only the
  injected GitHub adapter — no state, cache, database, scheduler, or
  queue. Repeating an evaluation against unchanged authority and
  evidence reproduces an equal outcome (the same event, the same
  record); the reconciliation record is always *re-derived* from
  authority and evidence and never deserialized from external data.
* **Worker-merge prohibition (worker boundary).** The worker (Z.ai)
  never executes this loop: the frozen predicate demands an Architect
  ``APPROVE`` review — observed on GitHub and bound to the exact head —
  authored by the carried architect reviewer identity, evidence a
  worker cannot produce for its own PR, and the loop's merge mutation
  surface is exactly the one adapter operation the predicate guards.
* **No Z.ai surface.** The merge boundary performs zero worker-provider
  I/O: it imports nothing from ``controller.zai`` and holds no worker
  adapter of any kind.

One governed transition per evaluation (``MERGE`` from ``APPROVED``,
``RECORD_MERGE`` from ``MERGING``, ``RECONCILE`` from ``MERGED``,
``RECORD_RECONCILIATION`` from ``RECONCILING``), each already authorized
by the frozen CTRL-001 table through the CTRL-002 domain model — the
loop never invents a transition the table refuses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from controller.authority import WORK_ITEMS_DIR, load_work_item_status
from controller.commands import CommandName
from controller.domain import (
    DispatchEligibility,
    DomainCommand,
    DomainEvent,
    GovernedWorkItem,
    reconstruct_domain,
)
from controller.errors import (
    MergeContradictionError,
    MergeLoopPositionError,
    MergeMissingReferenceError,
    MergePolicyError,
)
from controller.github import GithubAdapter, GithubPullRequest, MergeAuthorization
from controller.orchestrator import OrchestrationReferences
from controller.states import LifecycleState

#: The intended base branch of every governed merge (frozen architecture:
#: all work items dispatch from and merge into ``main``).
_BASE_BRANCH = "main"

#: The lifecycle positions the merge boundary owns: from the recorded
#: Architect approval through post-merge reconciliation.
_LOOP_POSITIONS: frozenset[LifecycleState] = frozenset(
    {
        LifecycleState.APPROVED,
        LifecycleState.MERGING,
        LifecycleState.MERGED,
        LifecycleState.RECONCILING,
    }
)

#: 40-character lowercase hexadecimal SHA (observed merge-evidence form).
_SHA_PATTERN: re.Pattern[str] = re.compile(r"^[0-9a-f]{40}$")

#: The pull-request listing state that covers a governed PR's whole
#: history — the merge boundary observes the PR before and after the
#: merge mutation, so the correlation must not be open-PR-only.
_ALL_STATES = "all"


@dataclass(frozen=True)
class MergePolicy:
    """The frozen required-evidence policy for one merge evaluation.

    ``required_checks`` names the exact check contexts the frozen merge
    predicate requires at terminal success — the same vocabulary the
    CTRL-006 evidence gate consumes (the merge predicate re-proves the
    checks through the CTRL-003 adapter at authorization *and* at
    execution time; the loop duplicates no classification logic). The
    policy is a caller-supplied fresh input per evaluation: the loop
    executes policy, it never invents repository facts.

    Tuples are canonicalized to sorted order at construction, so any
    permutation of the same names yields an equal (and therefore
    deterministic) value.
    """

    required_checks: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "required_checks", tuple(sorted(self.required_checks)))
        if not self.required_checks:
            raise MergePolicyError("required_checks must name at least one required check context")
        declared: set[str] = set()
        for name in self.required_checks:
            if not isinstance(name, str) or not name:
                raise MergePolicyError(
                    f"required check context {name!r} must be a non-empty string"
                )
            if name in declared:
                raise MergePolicyError(f"required check context {name!r} is declared twice")
            declared.add(name)


@dataclass(frozen=True)
class ReconciliationRecord:
    """The deterministic post-merge reconciliation result (AC6/AC7).

    Everything the governed reconciliation commit records, derived from
    repository authority plus the observed merge evidence: the completed
    work item's identity and exact PR/head/merge SHAs, the completed
    ledger before and after, the deterministically selected next
    eligible work item (``None`` when no not-completed work order
    declares ``READY`` — the next item is not yet defined/activated, as
    in the bootstrap flow), and the automation stage preserved verbatim
    (completion never silently advances the stage). ``basis`` records
    the authority-derived facts behind the selection verbatim.

    The record is a *derived output*: it is always recomputed from
    authority and evidence (never deserialized from external data), so
    repeated evaluation against unchanged inputs is idempotent by
    construction. ``serialize`` produces the deterministic value form
    for the durable evidence transcript.
    """

    work_item: str
    repository: str
    branch: str
    base_sha: str
    pr_number: int
    head_sha: str
    merge_commit_sha: str
    completed_before: tuple[str, ...]
    completed_after: tuple[str, ...]
    next_work_item: str | None
    automation_stage: str
    basis: tuple[str, ...]

    def serialize(self) -> dict[str, object]:
        """Deterministic value form for the durable evidence transcript."""
        return {
            "work_item": self.work_item,
            "repository": self.repository,
            "branch": self.branch,
            "base_sha": self.base_sha,
            "pr": self.pr_number,
            "head_sha": self.head_sha,
            "merge_commit_sha": self.merge_commit_sha,
            "completed_before": list(self.completed_before),
            "completed_after": list(self.completed_after),
            "next_work_item": self.next_work_item,
            "automation_stage": self.automation_stage,
            "basis": list(self.basis),
        }


@dataclass(frozen=True)
class MergeLoopOutcome:
    """One deterministic merge/reconciliation-loop decision.

    ``lifecycle`` is the authority-reconstructed state at the start of
    the evaluation; ``event`` is the single governed transition applied
    (every owned position advances exactly one step); ``pull_request``
    is the exactly correlated governed PR as observed this evaluation;
    ``merge_commit_sha`` is the observed merge commit (present whenever
    merge evidence was observed); ``merge_attempted`` records whether
    *this* evaluation executed the merge mutation; ``authorization`` is
    the adapter-issued merge request (present only when this evaluation
    authorized and executed the merge); ``record`` is the deterministic
    reconciliation result (present only at ``RECONCILING``).
    """

    work_item: str
    repository: str
    lifecycle: LifecycleState
    event: DomainEvent
    branch: str
    base_sha: str
    pull_request: GithubPullRequest
    merge_commit_sha: str | None
    merge_attempted: bool
    authorization: MergeAuthorization | None
    record: ReconciliationRecord | None


class MergeReconciliationLoop:
    """The governed merge + post-merge reconciliation loop.

    One :meth:`evaluate` reconstructs authority, correlates the exact
    governed PR, and performs at most one governed lifecycle step of the
    merge boundary. The instance holds only the injected GitHub adapter
    (no Z.ai surface, no state, no cache) — restart with the same
    repository, evidence, references, and policy reproduces the same
    decision. The loop never authors a decision, never retries a merge,
    and never mutates repository authority: the reconciliation record it
    derives is persisted by the runtime through the governed commit.
    """

    def __init__(self, *, github: GithubAdapter) -> None:
        self._github = github

    def evaluate(
        self,
        repo_root: Path,
        references: OrchestrationReferences,
        policy: MergePolicy,
    ) -> MergeLoopOutcome:
        """Evaluate one merge-boundary step for the active Work Order.

        Fails closed with typed errors on authority defects, position
        misuse, missing carried references, correlation failures,
        unsatisfied merge predicates (the adapter's typed refusals
        propagate), and authority/merge-evidence contradictions. The only
        remote mutation this evaluation can perform is the single
        adapter-guarded merge ``PUT`` at ``APPROVED``.
        """
        item = reconstruct_domain(repo_root)
        state = item.lifecycle
        if state not in _LOOP_POSITIONS:
            raise MergeLoopPositionError(
                "the merge/reconciliation loop applies at the merge boundary "
                "positions (APPROVED, MERGING, MERGED, RECONCILING); "
                f"'{item.identity.work_item}' is {state.value}, which belongs "
                "to another governed stage"
            )
        branch, base_sha = self._require_correlation_refs(references)
        pr = self._correlate_pull_request(item, branch, base_sha)

        if state is LifecycleState.APPROVED:
            return self._at_approved(item, references, policy, pr, branch, base_sha)
        merge_sha = self._require_merge_evidence(item, pr)
        if state is LifecycleState.MERGING:
            event = item.handle(DomainCommand(item.identity.work_item, CommandName.RECORD_MERGE))
            return MergeLoopOutcome(
                work_item=item.identity.work_item,
                repository=item.identity.repository,
                lifecycle=state,
                event=event,
                branch=branch,
                base_sha=base_sha,
                pull_request=pr,
                merge_commit_sha=merge_sha,
                merge_attempted=False,
                authorization=None,
                record=None,
            )
        if state is LifecycleState.MERGED:
            event = item.handle(DomainCommand(item.identity.work_item, CommandName.RECONCILE))
            return MergeLoopOutcome(
                work_item=item.identity.work_item,
                repository=item.identity.repository,
                lifecycle=state,
                event=event,
                branch=branch,
                base_sha=base_sha,
                pull_request=pr,
                merge_commit_sha=merge_sha,
                merge_attempted=False,
                authorization=None,
                record=None,
            )
        record = self._reconciliation_record(repo_root, item, pr, merge_sha)
        event = item.handle(
            DomainCommand(item.identity.work_item, CommandName.RECORD_RECONCILIATION)
        )
        return MergeLoopOutcome(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            event=event,
            branch=branch,
            base_sha=base_sha,
            pull_request=pr,
            merge_commit_sha=merge_sha,
            merge_attempted=False,
            authorization=None,
            record=record,
        )

    # -- internal: the APPROVED step (AC3/AC4/AC5) ---------------------------

    def _at_approved(
        self,
        item: GovernedWorkItem,
        references: OrchestrationReferences,
        policy: MergePolicy,
        pr: GithubPullRequest,
        branch: str,
        base_sha: str,
    ) -> MergeLoopOutcome:
        """Evaluate the complete predicate and execute the one merge attempt.

        A PR that already shows a successful merge is *recorded*, never
        re-attempted (AC5 external-evidence doctrine: the observed
        GitHub merge result — merged flag, closed state, intended base
        ref, reported merge commit SHA — establishes the merge; this is
        the restart-safe continuation for an earlier cycle whose state
        write did not survive and for an externally performed authorized
        merge). An unmerged PR goes through the frozen CTRL-003
        predicate: :meth:`authorize_merge` evaluates it in full, then
        :meth:`merge_pull_request` re-establishes the complete proof at
        execution time before the single ``PUT`` — so drift between
        authorization and execution refuses the mutation (AC4).
        """
        if pr.merged:
            merge_sha = self._require_merge_evidence(item, pr)
            event = item.handle(DomainCommand(item.identity.work_item, CommandName.MERGE))
            return MergeLoopOutcome(
                work_item=item.identity.work_item,
                repository=item.identity.repository,
                lifecycle=LifecycleState.APPROVED,
                event=event,
                branch=branch,
                base_sha=base_sha,
                pull_request=pr,
                merge_commit_sha=merge_sha,
                merge_attempted=False,
                authorization=None,
                record=None,
            )
        reviewer = self._require_reviewer(references)
        eligibility = _merge_boundary_eligibility(item)
        authorization = self._github.authorize_merge(
            pr_number=pr.number,
            expected_base_ref=_BASE_BRANCH,
            expected_base_sha=base_sha,
            expected_head_sha=pr.head_sha,
            work_item=item.identity.work_item,
            eligibility=eligibility,
            architect_reviewer=reviewer,
            required_checks=policy.required_checks,
        )
        merged_pr = self._github.merge_pull_request(
            authorization,
            eligibility=eligibility,
            architect_reviewer=reviewer,
            required_checks=policy.required_checks,
        )
        merge_sha = self._require_merge_evidence(item, merged_pr)
        event = item.handle(DomainCommand(item.identity.work_item, CommandName.MERGE))
        return MergeLoopOutcome(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=LifecycleState.APPROVED,
            event=event,
            branch=branch,
            base_sha=base_sha,
            pull_request=merged_pr,
            merge_commit_sha=merge_sha,
            merge_attempted=True,
            authorization=authorization,
            record=None,
        )

    # -- internal: references and correlation (AC2) --------------------------

    def _require_correlation_refs(self, references: OrchestrationReferences) -> tuple[str, str]:
        if references.branch is None or references.base_sha is None:
            raise MergeMissingReferenceError(
                "correlating the governed pull request requires the carried "
                "branch and dispatch-base references; they are never guessed"
            )
        return references.branch, references.base_sha

    def _require_reviewer(self, references: OrchestrationReferences) -> str:
        if references.architect_reviewer is None:
            raise MergeMissingReferenceError(
                "evaluating the frozen merge predicate requires the architect "
                "reviewer identity reference; it is never guessed"
            )
        return references.architect_reviewer

    def _correlate_pull_request(
        self, item: GovernedWorkItem, branch: str, base_sha: str
    ) -> GithubPullRequest:
        """Correlate the exact governed PR across its whole history.

        The merge boundary observes the PR before and after the merge
        mutation, so correlation lists the governed branch's PRs with
        state ``all`` (not open-only): the one-PR-per-work-item rule
        holds across the work order's whole history — a second PR for
        the same governed branch is a governance violation, and the
        unique PR must target the carried dispatch base exactly. Zero
        matches, multiple matches, or base drift fail closed.
        """
        matches = self._github.list_pull_requests(state=_ALL_STATES, head_branch=branch)
        if not matches:
            raise MergeContradictionError(
                f"machine state records {item.lifecycle.value} for "
                f"'{item.identity.work_item}' but no governed pull request "
                f"is observed for branch '{branch}'"
            )
        if len(matches) > 1:
            numbers = ", ".join(f"#{match.number}" for match in matches)
            raise MergeContradictionError(
                f"one-PR-per-work-item violated: pull requests ({numbers}) "
                f"are observed for the governed branch '{branch}'"
            )
        pr = matches[0]
        if pr.base_sha != base_sha:
            raise MergeContradictionError(
                f"governed PR #{pr.number} base {pr.base_sha} does not match "
                f"the carried dispatch base {base_sha}"
            )
        return pr

    # -- internal: observed merge evidence (AC5) ------------------------------

    def _require_merge_evidence(self, item: GovernedWorkItem, pr: GithubPullRequest) -> str:
        """Validate the observed successful-merge evidence; return the merge SHA.

        Only the observed GitHub merge result establishes ``MERGED``:
        the merged flag, the closed state, the intended base ref, and a
        reported merge commit SHA in the exact canonical form. Anything
        else — unmerged, partially merged, contradictory, or malformed —
        fails closed and never advances authority or fabricates
        completion.
        """
        context = f"PR #{pr.number} for '{item.identity.work_item}'"
        if not pr.merged:
            raise MergeContradictionError(
                f"machine state records {item.lifecycle.value} for "
                f"'{item.identity.work_item}' but {context} is not merged; "
                "the single authorized merge attempt did not land — "
                "governance attention is required (the loop never re-attempts)"
            )
        if pr.state != "closed":
            raise MergeContradictionError(
                f"{context} reports merged with state {pr.state!r}; a merged "
                "pull request must be closed — contradictory evidence"
            )
        if pr.base_ref != _BASE_BRANCH:
            raise MergeContradictionError(
                f"{context} merged into base ref {pr.base_ref!r}, not the "
                f"intended base ref '{_BASE_BRANCH}'"
            )
        merge_sha = pr.merge_commit_sha
        if merge_sha is None or not _SHA_PATTERN.match(merge_sha):
            reported = "absent" if merge_sha is None else merge_sha
            raise MergeContradictionError(
                f"{context} reports no canonical merge commit SHA "
                f"(found {reported}); the exact merge SHA is required evidence"
            )
        return merge_sha

    # -- internal: the deterministic reconciliation record (AC6/AC7) ----------

    def _reconciliation_record(
        self,
        repo_root: Path,
        item: GovernedWorkItem,
        pr: GithubPullRequest,
        merge_sha: str,
    ) -> ReconciliationRecord:
        """Derive the reconciliation record from authority + merge evidence.

        Idempotent by construction: the completed ledger is the
        authority's own ``completed`` tuple extended by exactly the
        active work item (a duplicate completion is a contradiction, not
        a no-op, so a drifted authority stops for governance attention),
        the next eligible work item is re-derived from the work-order
        files, and the automation stage is preserved verbatim.
        """
        work_item = item.identity.work_item
        if work_item in item.completed:
            raise MergeContradictionError(
                f"machine state records RECONCILING for '{work_item}' but the "
                "completed ledger already records it; a duplicate completion "
                "record is a contradiction, never an idempotent no-op"
            )
        completed_after = (*item.completed, work_item)
        next_work_item, basis = _next_eligible_work_item(repo_root, completed_after)
        return ReconciliationRecord(
            work_item=work_item,
            repository=item.identity.repository,
            branch=pr.head_ref,
            base_sha=pr.base_sha,
            pr_number=pr.number,
            head_sha=pr.head_sha,
            merge_commit_sha=merge_sha,
            completed_before=item.completed,
            completed_after=completed_after,
            next_work_item=next_work_item,
            automation_stage=item.authority.automation_stage,
            basis=basis,
        )


# ---------------------------------------------------------------------------
# Deterministic helpers (AC6)
# ---------------------------------------------------------------------------


def _merge_boundary_eligibility(item: GovernedWorkItem) -> DispatchEligibility:
    """Derive the authority-bound eligibility the frozen merge predicate binds.

    The CTRL-003 predicate (FZ-CTRL003-001 doctrine) requires the
    caller-supplied CTRL-002 eligibility value to answer one question
    with authority-derived facts: *does repository authority identify
    exactly this work item as the active, not-yet-completed item seeking
    merge authorization?* The value below is derived — never
    hand-authored — from the very reconstruction that produced the
    governed item: the active-item identity is authority-recorded
    (``activeWorkItem``, already cross-validated against the work order
    by ``verify_authority``), and the completion ledger is authority
    fact. The CTRL-002 dispatch-eligibility ``READY`` flag governs the
    DISPATCH boundary (the orchestrator's ``DISPATCH`` command); this
    loop has already enforced the merge boundary's own position
    discipline (``APPROVED``..``RECONCILING``) before this value is
    constructed, so the eligible flag here answers the merge
    predicate's frozen question with the basis recorded verbatim for
    audit. An item already recorded in ``completed`` is refused —
    a completed work item can never again be the subject of a merge.
    """
    work_item = item.identity.work_item
    if work_item in item.completed:
        return DispatchEligibility(
            work_item=work_item,
            eligible=False,
            basis=(
                "machine state and work-order status agree (authority cross-check passed)",
                "work item is already recorded in completed",
                f"lifecycle state is {item.lifecycle.value}, inside the merge boundary",
            ),
        )
    return DispatchEligibility(
        work_item=work_item,
        eligible=True,
        basis=(
            "machine state and work-order status agree (authority cross-check passed)",
            f"machine state identifies '{work_item}' as the active work item",
            "work item is not recorded in completed",
            f"lifecycle state is {item.lifecycle.value}, inside the merge boundary",
        ),
    )


def _next_eligible_work_item(
    repo_root: Path, completed: tuple[str, ...]
) -> tuple[str | None, tuple[str, ...]]:
    """Select the next eligible work item deterministically (AC6).

    Per the roadmap sequencing rule, a later item is eligible only when
    repository authority has explicitly defined and activated it: the
    deterministic selection scans the work-order directory in sorted
    order and selects the unique not-completed work order that declares
    ``Status: READY``. Zero matches — the bootstrap norm right after a
    reconciliation, before the Architect defines the successor —
    selects nothing; more than one match violates the one-active-item
    rule and fails closed. Malformed work-order files fail closed
    through the authority loader's typed errors.
    """
    work_items_dir = repo_root / WORK_ITEMS_DIR
    ready: list[str] = []
    for path in sorted(work_items_dir.glob("*.md")):
        work_item = path.stem
        if work_item in completed:
            continue
        status = load_work_item_status(repo_root, work_item)
        if status is LifecycleState.READY:
            ready.append(work_item)
    if len(ready) > 1:
        listed = ", ".join(sorted(ready))
        raise MergeContradictionError(
            f"multiple work orders declare READY ({listed}); repository "
            "authority must identify exactly one active eligible item"
        )
    if not ready:
        return None, (
            "no not-completed work order declares READY; the next item is "
            "not yet defined/activated by governance",
        )
    return ready[0], (f"work order {ready[0]} declares READY",)
