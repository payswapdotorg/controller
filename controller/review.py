"""Architect review loop (CTRL-007).

Governed, fail-closed handling of the Architect's review evidence for
the active Work Order: exact decision correlation, the durable
machine-readable review packet for ``REQUEST_CHANGES``, and the typed
same-worker/same-PR handoff — without ever authoring a decision.

Module doctrine (each clause maps to a frozen work-order acceptance
criterion):

* **Authority first (AC1).** Every evaluation reconstructs the governed
  work item from repository machine state through the CTRL-002 domain
  layer. Structural authority defects and authority contradictions fail
  closed before any packet construction or worker-resume routing.
* **Exact review correlation (AC2).** The decision channel is the
  accepted CTRL-003 review evidence on the exactly correlated governed
  PR: only reviews authored by the carried architect reviewer identity
  are authoritative, the latest is selected by the deterministic
  ``(submitted_at, review_id)`` order, and a decision binds to the
  PR's exact current head through the review's ``commit_id`` — a
  decision for an older head, another PR, or a foreign author is not
  the current Architect decision and is never reinterpreted.
* **Architect authority preservation (AC3).** The loop maps only the
  observed GitHub review states ``APPROVED`` and ``CHANGES_REQUESTED``
  to the protocol decisions APPROVE and REQUEST_CHANGES. It never
  creates, infers, or upgrades a decision; every other observed state
  is a non-decision (pure observation), and APPROVE is never a merge
  command — merge execution belongs to a later governed stage.
* **Durable review packet (AC4).** For ``REQUEST_CHANGES`` the
  Architect's machine-readable packet — a fenced ``review-packet``
  block in an architect comment on the governed PR, matching the
  frozen grammar below, which instantiates the packet of
  ``spec/governance/review-protocol.md`` — is parsed strictly,
  cross-validated field-by-field against the observed evidence, and
  transported verbatim as a typed :class:`ReviewPacket`. Structural
  packet fields are never guessed: a block that does not match the
  current evidence exactly (work item, PR, head, base, iteration,
  decision) is not the current packet; findings are never dropped,
  rewritten, or invented.
* **Same-worker/same-PR handoff (AC5).** A validated packet plus the
  carried worker-session evidence produce a typed :class:`ReviewHandoff`
  only after the carried session's **ordinary binding** (repository, work
  item, dispatch base, PR identity when reported) is proven locally
  against authority and the session's **adapter-issued provenance** is
  verified locally (FZ-CTRL007-001/002): the carried value must be
  :class:`controller.zai.ZaiIssuedWorkerSession` — evidence sealed at the
  CTRL-004 boundary when the adapter normalized the provider response —
  and its construction-path proof must verify (a pure local check with
  no source-reproducible key material). A structurally exact session value
  constructed by hand (the public ``ZaiWorkerSession`` form), a
  caller-constructed value of the issued type, or a genuine proof
  transplanted onto different fields, therefore cannot produce a
  handoff. The loop establishes provenance **without any Z.ai provider
  I/O** — it performs zero worker-provider calls of any kind
  (observation-only contract): live provider re-proof/resume belongs to
  the consuming worker boundary, which re-establishes the execution
  through the accepted CTRL-004 contracts before acting. The handoff is
  a *request* for that boundary, never an execution. Identity, base,
  head, packet, or provenance drift fails closed; the loop never
  dispatches an alternate worker or creates a new PR.
* **Deterministic iteration control (AC6).** At most one governed
  transition per evaluation — APPROVE or REQUEST_CHANGES from
  REVIEW_PENDING, both already authorized by the frozen CTRL-001
  table via the CTRL-002 domain model — and pure observation
  otherwise. Re-observing the same evidence is idempotent: the
  iteration number is the deterministic count of the architect's
  CHANGES_REQUESTED reviews on the governed PR, and a new iteration
  requires a new current head and a new authoritative packet.
* **Runtime non-authority (AC7).** The loop holds only the injected
  GitHub adapter — no packet registry, decision cache, scheduler, or
  queue. Durable evidence lives on the repository/GitHub review
  surface (the packet block itself); restart re-observes and
  reconstructs the identical decision.

The machine-readable packet grammar (strict; any deviation fails
closed with :class:`controller.errors.ReviewPacketError`)::

    ```review-packet
    work_item: CTRL-007
    pr: 17
    head_sha: <40 lowercase hex>
    base_sha: <40 lowercase hex>
    iteration: 2
    decision: REQUEST_CHANGES
    findings:
      - id: CTRL007-F01
        severity: HIGH
        path: controller/review.py
        criterion: AC4
        required_change: <specific action>
    ```

Keys appear exactly once and in exactly this order; finding keys
likewise (id, severity, path, criterion, required_change). A
``REQUEST_CHANGES`` packet must carry at least one finding; an
APPROVE/ESCALATE packet carries ``findings: []``. ``decision`` is one
of APPROVE / REQUEST_CHANGES / ESCALATE; ``severity`` is one of HIGH
/ MEDIUM / LOW; ``pr`` is a non-negative integer and ``iteration`` a
positive integer.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Final

from controller.commands import CommandName
from controller.domain import DomainCommand, DomainEvent, GovernedWorkItem, reconstruct_domain
from controller.errors import (
    GithubNotFoundError,
    ReviewContradictionError,
    ReviewLoopPositionError,
    ReviewMissingReferenceError,
    ReviewPacketError,
)
from controller.github import GithubAdapter, GithubComment, GithubPullRequest, GithubReview
from controller.orchestrator import OrchestrationReferences
from controller.states import LifecycleState
from controller.zai import ZaiIssuedWorkerSession, ZaiWorkerSession

#: The lifecycle positions the review loop owns: the Architect's
#: decision position and the change-iteration handoff position.
_LOOP_POSITIONS: Final[frozenset[LifecycleState]] = frozenset(
    {LifecycleState.REVIEW_PENDING, LifecycleState.CHANGES_REQUESTED}
)

#: 40-character lowercase hexadecimal SHA.
_SHA_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{40}$")

#: The fenced-block tag introducing a machine-readable review packet.
_PACKET_TAG: Final = "```review-packet"

#: Top-level packet keys, in the exact frozen order.
_PACKET_KEYS: Final[tuple[str, ...]] = (
    "work_item",
    "pr",
    "head_sha",
    "base_sha",
    "iteration",
    "decision",
)

#: Finding keys, in the exact frozen order.
_FINDING_KEYS: Final[tuple[str, ...]] = (
    "id",
    "severity",
    "path",
    "criterion",
    "required_change",
)


class ReviewDecision(str, Enum):
    """The Architect's protocol decisions (never authored by the loop)."""

    APPROVE = "APPROVE"
    REQUEST_CHANGES = "REQUEST_CHANGES"
    ESCALATE = "ESCALATE"


class FindingSeverity(str, Enum):
    """The severity vocabulary of a review finding."""

    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


#: The GitHub review states that map to protocol decisions; every
#: other observed state is a non-decision the loop refuses to infer
#: from (AC3).
_DECISION_STATES: Final[dict[str, ReviewDecision]] = {
    "APPROVED": ReviewDecision.APPROVE,
    "CHANGES_REQUESTED": ReviewDecision.REQUEST_CHANGES,
}


@dataclass(frozen=True)
class ReviewFinding:
    """One Architect finding, transported verbatim (AC4).

    ``finding_id`` keeps the stable identifier the Architect assigned;
    ``severity``, ``path``, ``criterion``, and ``required_change``
    carry the exact declared semantics. The loop never rewrites,
    reorders (beyond the Architect's own order), drops, or invents a
    finding.
    """

    finding_id: str
    severity: FindingSeverity
    path: str
    criterion: str
    required_change: str

    def serialize(self) -> dict[str, str]:
        """Deterministic value form (string-to-string, fixed keys)."""
        return {
            "id": self.finding_id,
            "severity": self.severity.value,
            "path": self.path,
            "criterion": self.criterion,
            "required_change": self.required_change,
        }

    @classmethod
    def deserialize(cls, data: object) -> ReviewFinding:
        """Rebuild a finding from a serialized value, or fail closed."""
        if not isinstance(data, dict):
            raise ReviewPacketError("ReviewFinding: expected a JSON object")
        keys = set(data)
        expected = set(_FINDING_KEYS)
        if keys != expected:
            raise ReviewPacketError(
                f"ReviewFinding: expected exactly keys {sorted(expected)}; "
                f"found {sorted(str(k) for k in keys)}"
            )
        values: list[str] = []
        for key in _FINDING_KEYS:
            value = data[key]
            if not isinstance(value, str) or not value:
                raise ReviewPacketError(f"ReviewFinding: '{key}' must be a non-empty string")
            values.append(value)
        try:
            severity = FindingSeverity(values[1])
        except ValueError:
            raise ReviewPacketError(f"ReviewFinding: unknown severity '{values[1]}'") from None
        return cls(
            finding_id=values[0],
            severity=severity,
            path=values[2],
            criterion=values[3],
            required_change=values[4],
        )


@dataclass(frozen=True)
class ReviewPacket:
    """The durable machine-readable review packet (AC4).

    Structural fields (work item, PR, head, base, iteration, decision)
    are cross-validated against observed evidence whenever the loop
    constructs or accepts a packet; findings ride verbatim. The packet
    is the machine-readable input to the next worker iteration, per
    ``spec/governance/review-protocol.md``.
    """

    work_item: str
    pr_number: int
    head_sha: str
    base_sha: str
    iteration: int
    decision: ReviewDecision
    findings: tuple[ReviewFinding, ...]

    def __post_init__(self) -> None:
        if not self.work_item:
            raise ReviewPacketError("ReviewPacket: work_item must be non-empty")
        if not isinstance(self.pr_number, int) or self.pr_number < 0:
            raise ReviewPacketError("ReviewPacket: pr must be a non-negative integer")
        for field_name in ("head_sha", "base_sha"):
            value = getattr(self, field_name)
            if not _SHA_PATTERN.match(value):
                raise ReviewPacketError(
                    f"ReviewPacket: {field_name} must be 40 lowercase hex characters"
                )
        if not isinstance(self.iteration, int) or self.iteration < 1:
            raise ReviewPacketError("ReviewPacket: iteration must be a positive integer")
        if self.decision is ReviewDecision.REQUEST_CHANGES and not self.findings:
            raise ReviewPacketError("ReviewPacket: REQUEST_CHANGES must carry at least one finding")
        if self.decision is not ReviewDecision.REQUEST_CHANGES and self.findings:
            raise ReviewPacketError("ReviewPacket: only REQUEST_CHANGES may carry findings")

    def serialize(self) -> dict[str, object]:
        """Deterministic value form for boundary exchange."""
        return {
            "work_item": self.work_item,
            "pr": self.pr_number,
            "head_sha": self.head_sha,
            "base_sha": self.base_sha,
            "iteration": self.iteration,
            "decision": self.decision.value,
            "findings": [finding.serialize() for finding in self.findings],
        }

    @classmethod
    def deserialize(cls, data: object) -> ReviewPacket:
        """Rebuild a packet from a serialized value, or fail closed."""
        if not isinstance(data, dict):
            raise ReviewPacketError("ReviewPacket: expected a JSON object")
        keys = set(data)
        expected = set(_PACKET_KEYS) | {"findings"}
        if keys != expected:
            raise ReviewPacketError(
                f"ReviewPacket: expected exactly keys {sorted(expected)}; "
                f"found {sorted(str(k) for k in keys)}"
            )
        work_item = data["work_item"]
        if not isinstance(work_item, str) or not work_item:
            raise ReviewPacketError("ReviewPacket: 'work_item' must be a non-empty string")
        pr_number = data["pr"]
        if not isinstance(pr_number, int) or isinstance(pr_number, bool) or pr_number < 0:
            raise ReviewPacketError("ReviewPacket: 'pr' must be a non-negative integer")
        shas: dict[str, str] = {}
        for field_name in ("head_sha", "base_sha"):
            value = data[field_name]
            if not isinstance(value, str) or not _SHA_PATTERN.match(value):
                raise ReviewPacketError(
                    f"ReviewPacket: '{field_name}' must be 40 lowercase hex characters"
                )
            shas[field_name] = value
        iteration = data["iteration"]
        if not isinstance(iteration, int) or isinstance(iteration, bool) or iteration < 1:
            raise ReviewPacketError("ReviewPacket: 'iteration' must be a positive integer")
        decision_value = data["decision"]
        if not isinstance(decision_value, str):
            raise ReviewPacketError("ReviewPacket: 'decision' must be a string")
        try:
            decision = ReviewDecision(decision_value)
        except ValueError:
            raise ReviewPacketError(f"ReviewPacket: unknown decision '{decision_value}'") from None
        findings_value = data["findings"]
        if not isinstance(findings_value, list):
            raise ReviewPacketError("ReviewPacket: 'findings' must be a list")
        findings = tuple(ReviewFinding.deserialize(item) for item in findings_value)
        return cls(
            work_item=work_item,
            pr_number=pr_number,
            head_sha=shas["head_sha"],
            base_sha=shas["base_sha"],
            iteration=iteration,
            decision=decision,
            findings=findings,
        )


@dataclass(frozen=True)
class ReviewHandoff:
    """A typed same-worker/same-PR resume request handed to the boundary
    (AC5).

    The loop never executes this request: the consuming boundary (the
    CTRL-005 orchestrator/operator loop) re-establishes the session
    provenance from live provider state through the accepted CTRL-004
    adapter before any resume, mirroring the request/re-proof doctrine
    of the merge authorization and the CTRL-006 retry boundary. The
    handoff carries only facts the loop itself proved: the locally
    proven worker-session binding with verified adapter-issued
    evidence, the exactly correlated PR identity, and the validated
    durable packet with its verbatim findings.
    """

    session_id: str
    repository: str
    work_item: str
    work_order_path: str
    branch: str
    base_sha: str
    pr_number: int
    head_sha: str
    packet: ReviewPacket
    reason: str


@dataclass(frozen=True)
class ReviewLoopOutcome:
    """One deterministic review-loop decision.

    ``lifecycle`` is the authority-reconstructed state at the start of
    the evaluation; ``decision`` is the observed Architect decision
    (``None`` for pure observations — no decision is ever inferred);
    ``packet`` is the validated REQUEST_CHANGES packet (``None``
    otherwise); ``event`` is the single governed transition applied by
    this evaluation; ``handoff`` is the typed resume request (present
    only with a validated packet and a proven carried session); and
    ``reviews`` carries the observed architect review evidence for
    downstream inspection.
    """

    work_item: str
    repository: str
    lifecycle: LifecycleState
    decision: ReviewDecision | None
    packet: ReviewPacket | None
    event: DomainEvent | None
    handoff: ReviewHandoff | None
    reviews: tuple[GithubReview, ...]
    iteration: int


class ArchitectReviewLoop:
    """The governed Architect-review loop over the accepted adapters.

    One :meth:`evaluate` reconstructs authority, correlates the exact
    governed PR, observes the Architect's review evidence and the
    machine-readable packet surface, and performs at most one governed
    lifecycle step. The instance holds only the injected GitHub adapter
    (AC7) — no Z.ai surface of any kind — and performs zero
    worker-provider calls: the loop is observation/request construction
    only. Restart with the same repository, evidence, and references
    reproduces the same decision. The loop never authors a decision and
    never resumes the worker: the handoff it produces is a typed request
    whose live provider re-proof belongs to the consuming boundary.
    """

    def __init__(self, *, github: GithubAdapter) -> None:
        self._github = github

    def evaluate(
        self,
        repo_root: Path,
        references: OrchestrationReferences,
    ) -> ReviewLoopOutcome:
        """Observe the Architect decision for the active Work Order.

        Fails closed with typed errors on authority defects, position
        misuse, missing carried references, correlation failures,
        missing or ambiguous machine-readable packets, and evidence
        contradictions. The loop performs no remote mutations and no
        worker-provider I/O at all.
        """
        item = reconstruct_domain(repo_root)
        state = item.lifecycle
        if state not in _LOOP_POSITIONS:
            raise ReviewLoopPositionError(
                "the review loop applies at the Architect decision positions "
                f"(REVIEW_PENDING, CHANGES_REQUESTED); '{item.identity.work_item}' "
                f"is {state.value}, which belongs to another governed stage"
            )
        branch, base_sha, reviewer = self._require_references(references)
        pr = self._correlate_pull_request(item, state, branch, base_sha)
        reviews = self._architect_reviews(pr.number, reviewer)
        decision, latest = self._latest_decision(reviews, pr.head_sha)

        if state is LifecycleState.CHANGES_REQUESTED:
            if decision is not ReviewDecision.REQUEST_CHANGES or latest is None:
                observed = "absent" if latest is None else latest.state
                raise ReviewContradictionError(
                    f"machine state records CHANGES_REQUESTED for "
                    f"'{item.identity.work_item}' but the latest architect review "
                    f"evidence is {observed}; the recorded change request is not "
                    "observed on the governed PR"
                )
            packet, iteration = self._require_packet(item, pr, reviewer, latest, reviews)
            handoff = self._handoff(item, references, pr, packet)
            return ReviewLoopOutcome(
                work_item=item.identity.work_item,
                repository=item.identity.repository,
                lifecycle=state,
                decision=decision,
                packet=packet,
                event=None,
                handoff=handoff,
                reviews=reviews,
                iteration=iteration,
            )

        if decision is None or latest is None:
            return self._outcome(item, state, reviews, decision=None, packet=None, event=None)

        if decision is ReviewDecision.APPROVE:
            event = item.handle(DomainCommand(item.identity.work_item, CommandName.APPROVE))
            return self._outcome(item, state, reviews, decision=decision, packet=None, event=event)

        packet, iteration = self._require_packet(item, pr, reviewer, latest, reviews)
        event = item.handle(DomainCommand(item.identity.work_item, CommandName.REQUEST_CHANGES))
        handoff = self._handoff(item, references, pr, packet)
        return ReviewLoopOutcome(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            decision=decision,
            packet=packet,
            event=event,
            handoff=handoff,
            reviews=reviews,
            iteration=iteration,
        )

    # -- internal: references and correlation (AC2/AC5) ----------------------

    def _require_references(self, references: OrchestrationReferences) -> tuple[str, str, str]:
        if references.branch is None or references.base_sha is None:
            raise ReviewMissingReferenceError(
                "correlating the governed pull request requires the carried "
                "branch and dispatch-base references; they are never guessed"
            )
        if references.architect_reviewer is None:
            raise ReviewMissingReferenceError(
                "observing the Architect decision requires the architect "
                "reviewer identity reference; it is never guessed"
            )
        return references.branch, references.base_sha, references.architect_reviewer

    def _correlate_pull_request(
        self, item: GovernedWorkItem, state: LifecycleState, branch: str, base_sha: str
    ) -> GithubPullRequest:
        try:
            return self._github.correlate_work_pull_request(branch=branch, base_sha=base_sha)
        except GithubNotFoundError as exc:
            raise ReviewContradictionError(
                f"machine state records {state.value} for "
                f"'{item.identity.work_item}' but no governed pull request "
                f"is observed for branch '{branch}'"
            ) from exc

    def _architect_reviews(self, pr_number: int, reviewer: str) -> tuple[GithubReview, ...]:
        reviews = self._github.get_reviews(pr_number)
        return tuple(review for review in reviews if review.author == reviewer)

    def _latest_decision(
        self, reviews: tuple[GithubReview, ...], head_sha: str
    ) -> tuple[ReviewDecision | None, GithubReview | None]:
        """The latest authoritative Architect decision, deterministically.

        Only APPROVED/CHANGES_REQUESTED states are decisions; every
        other state (COMMENTED, PENDING, DISMISSED, ...) is a
        non-decision and the loop refuses to infer one from it. A
        decision whose ``commit_id`` does not bind to the exact PR
        head is stale — not the current decision.
        """
        if not reviews:
            return None, None
        latest = max(reviews, key=lambda review: (review.submitted_at, review.review_id))
        decision = _DECISION_STATES.get(latest.state)
        if decision is None:
            return None, latest
        if latest.commit_id is None or latest.commit_id != head_sha:
            return None, latest
        return decision, latest

    # -- internal: packet correlation (AC4) -----------------------------------

    def _require_packet(
        self,
        item: GovernedWorkItem,
        pr: GithubPullRequest,
        reviewer: str,
        decision_review: GithubReview,
        reviews: tuple[GithubReview, ...],
    ) -> tuple[ReviewPacket, int]:
        """Find, validate, and cross-check the current machine-readable
        packet for the observed REQUEST_CHANGES decision.

        The packet block lives in an architect comment on the governed
        PR (the body-bearing accepted evidence surface). A block is
        *current* only when every structural field matches the
        observed evidence: work item from authority, the correlated PR
        number, the exact head the decision review binds to, the
        correlated base, the deterministic iteration count, and the
        observed decision. Foreign blocks (another work item or PR)
        are contradictions; stale blocks (older head/iteration) are
        history and never reinterpreted; zero current blocks means the
        required packet is missing — all fail closed.
        """
        comments: tuple[GithubComment, ...] = self._github.get_comments(pr.number)
        architect_comments = [comment for comment in comments if comment.author == reviewer]
        blocks: list[str] = []
        for architect_comment in architect_comments:
            blocks.extend(_packet_blocks(architect_comment.body))

        iteration = sum(1 for review in reviews if review.state == "CHANGES_REQUESTED")

        current: list[ReviewPacket] = []
        for block in blocks:
            packet = _parse_packet(block)
            if packet.work_item != item.identity.work_item or packet.pr_number != pr.number:
                raise ReviewContradictionError(
                    "a review packet block declares work item "
                    f"'{packet.work_item}' / PR #{packet.pr_number}, but repository "
                    f"authority identifies '{item.identity.work_item}' with "
                    f"governed PR #{pr.number}: foreign packet evidence"
                )
            if (
                packet.head_sha == decision_review.commit_id
                and packet.base_sha == pr.base_sha
                and packet.iteration == iteration
                and packet.decision is ReviewDecision.REQUEST_CHANGES
            ):
                current.append(packet)
        if not current:
            expected = (
                f"work item {item.identity.work_item}, PR #{pr.number}, "
                f"head {pr.head_sha}, base {pr.base_sha}, iteration {iteration}, "
                "decision REQUEST_CHANGES"
            )
            if blocks:
                raise ReviewPacketError(
                    "no machine-readable review packet matches the current "
                    f"evidence ({expected}); the observed blocks are stale or "
                    "inconsistent — the current packet is missing"
                )
            raise ReviewPacketError(
                "REQUEST_CHANGES decision requires a machine-readable review "
                f"packet ({expected}) in an architect comment; none was found"
            )
        if len(current) > 1:
            raise ReviewPacketError(
                f"ambiguous review packet evidence: {len(current)} architect "
                "blocks match the current evidence; exactly one is required"
            )
        return current[0], iteration

    # -- internal: the typed handoff (AC5) ------------------------------------

    def _handoff(
        self,
        item: GovernedWorkItem,
        references: OrchestrationReferences,
        pr: GithubPullRequest,
        packet: ReviewPacket,
    ) -> ReviewHandoff | None:
        """Produce the typed handoff, or expose the packet without one.

        The handoff exists only with carried worker-session evidence.
        Its ordinary binding is proven locally first (repository, work
        item, dispatch base, PR identity when reported — the
        FZ-CTRL005-001 doctrine facts), and its **adapter-issued
        provenance** is then verified locally against the sealed
        evidence (FZ-CTRL007-001): a pure computation over the carried
        value with zero worker-provider I/O. An absent session
        reference leaves the packet exposed for governance attention
        without a handoff. The loop never resumes the worker.
        """
        session = references.worker_session
        if session is None:
            return None
        self._prove_handoff_session(item, session, pr)
        issued = self._require_issued_evidence(session)
        return ReviewHandoff(
            session_id=issued.session_id,
            repository=item.identity.repository,
            work_item=item.identity.work_item,
            work_order_path=item.identity.work_order_path,
            branch=references.branch or "",
            base_sha=pr.base_sha,
            pr_number=pr.number,
            head_sha=pr.head_sha,
            packet=packet,
            reason=(
                f"REQUEST_CHANGES packet iteration {packet.iteration} with "
                f"{len(packet.findings)} finding(s) at governed PR #{pr.number} "
                f"head {pr.head_sha[:12]}"
            ),
        )

    def _require_issued_evidence(self, session: ZaiWorkerSession) -> ZaiIssuedWorkerSession:
        """Require the carried session to be adapter-issued evidence
        (FZ-CTRL007-001/002), verified locally with zero provider I/O.

        The carried value must be the evidence the CTRL-004 adapter
        sealed when it normalized the provider response
        (:class:`ZaiIssuedWorkerSession`), and its construction-path
        proof must verify — a pure local check over the carried value
        with no source-reproducible key material involved and no
        reachable mint operation anywhere (FZ-CTRL007-003). A
        structurally exact value built through the public
        ``ZaiWorkerSession`` constructor is not evidence of any
        provider-observed execution; a caller-constructed value of the
        issued type — including one carrying a genuine proof object
        transplanted onto different fields — fails verification,
        because the proof binds the exact fields it was sealed for.
        The loop never re-proves provenance by invoking Z.ai: live
        provider re-proof/resume is the consuming worker boundary's
        responsibility.
        """
        if not isinstance(session, ZaiIssuedWorkerSession):
            raise ReviewContradictionError(
                f"the carried worker session '{session.session_id}' is not "
                "adapter-issued evidence: the ordinary ZaiWorkerSession value "
                "form is constructible by hand, so only evidence sealed by the "
                "CTRL-004 adapter when normalizing a provider response produces "
                "a handoff (FZ-CTRL007-001)"
            )
        if not session.is_adapter_issued():
            raise ReviewContradictionError(
                f"the carried worker session '{session.session_id}' presents "
                "issued-shaped evidence that was not sealed by the CTRL-004 "
                "adapter's provider-response normalization path for exactly "
                "these fields: a caller-constructed value (or a proof "
                "transplanted onto different fields) does not establish "
                "adapter issuance (FZ-CTRL007-002/003)"
            )
        return session

    def _prove_handoff_session(
        self,
        item: GovernedWorkItem,
        session: ZaiWorkerSession,
        pr: GithubPullRequest,
    ) -> None:
        """Prove the carried worker-session binding for the handoff.

        The FZ-CTRL005-001 doctrine facts (repository, work item,
        dispatch base against authority and the correlated base) plus
        PR identity when the session reports one — all locally, with
        zero remote calls of any kind. Provenance is proven separately,
        also locally, by :meth:`_require_issued_evidence`; live
        provider re-proof belongs to the consuming boundary.
        """
        if session.repository != item.identity.repository:
            raise ReviewContradictionError(
                f"carried worker session '{session.session_id}' is bound to "
                f"repository '{session.repository}', but repository authority "
                f"identifies '{item.identity.repository}'"
            )
        if session.work_item != item.identity.work_item:
            raise ReviewContradictionError(
                f"carried worker session '{session.session_id}' is bound to work "
                f"item '{session.work_item}', but repository authority identifies "
                f"'{item.identity.work_item}' as the active item"
            )
        if session.base_sha != pr.base_sha:
            raise ReviewContradictionError(
                f"carried worker session '{session.session_id}' is bound to base "
                f"{session.base_sha}, but the dispatch base is {pr.base_sha}"
            )
        if session.pr_number is not None and session.pr_number != pr.number:
            raise ReviewContradictionError(
                f"carried worker session '{session.session_id}' claims PR "
                f"#{session.pr_number}, but the correlated governed PR is #{pr.number}"
            )
        if session.head_sha is not None and session.head_sha != pr.head_sha:
            raise ReviewContradictionError(
                f"carried worker session '{session.session_id}' claims head "
                f"{session.head_sha}, but the correlated governed head is {pr.head_sha}"
            )

    def _outcome(
        self,
        item: GovernedWorkItem,
        state: LifecycleState,
        reviews: tuple[GithubReview, ...],
        decision: ReviewDecision | None,
        packet: ReviewPacket | None,
        event: DomainEvent | None,
    ) -> ReviewLoopOutcome:
        iteration = sum(1 for review in reviews if review.state == "CHANGES_REQUESTED")
        return ReviewLoopOutcome(
            work_item=item.identity.work_item,
            repository=item.identity.repository,
            lifecycle=state,
            decision=decision,
            packet=packet,
            event=event,
            handoff=None,
            reviews=reviews,
            iteration=iteration,
        )


# ---------------------------------------------------------------------------
# Deterministic packet-block parsing (AC4) — strict, fail-closed
# ---------------------------------------------------------------------------


def _packet_blocks(body: str) -> list[str]:
    """Extract the raw ``review-packet`` fenced blocks from a comment body.

    Deterministic scan: a block starts at a line whose stripped form
    is exactly the packet tag and ends at the next line whose
    stripped form is exactly a closing fence. Block content is
    returned verbatim; structural validation happens in
    :func:`_parse_packet`.
    """
    blocks: list[str] = []
    lines = body.splitlines()
    index = 0
    while index < len(lines):
        if lines[index].strip() == _PACKET_TAG:
            block: list[str] = []
            index += 1
            while index < len(lines) and lines[index].strip() != "```":
                block.append(lines[index])
                index += 1
            blocks.append("\n".join(block))
        index += 1
    return blocks


def _parse_packet(block: str) -> ReviewPacket:
    """Parse one raw block with the frozen grammar, or fail closed.

    Exact keys, exact order, exact indentation, exact vocabularies —
    any deviation raises :class:`ReviewPacketError`; nothing is
    guessed, defaulted, or repaired.
    """
    lines = [line for line in block.splitlines() if line.strip()]
    if len(lines) < len(_PACKET_KEYS) + 1:
        raise ReviewPacketError(
            "review packet block is incomplete: expected the keys "
            + ", ".join([*_PACKET_KEYS, "findings"])
        )
    values: dict[str, str] = {}
    position = 0
    for key in _PACKET_KEYS:
        line = lines[position]
        expected = f"{key}: "
        if not line.startswith(expected) or line == expected:
            raise ReviewPacketError(
                f"review packet expected '{key}: <value>' at line {position + 1}; found {line!r}"
            )
        values[key] = line[len(expected) :]
        position += 1
    findings_line = lines[position]
    if not findings_line.startswith("findings:") or findings_line.strip() != "findings:":
        if findings_line.strip() != "findings: []":
            raise ReviewPacketError(
                f"review packet expected 'findings:' or 'findings: []' at line "
                f"{position + 1}; found {findings_line!r}"
            )
    position += 1
    findings: list[ReviewFinding] = []
    if findings_line.strip() == "findings: []":
        if position != len(lines):
            raise ReviewPacketError(
                "review packet with 'findings: []' must end the block; "
                f"found {len(lines) - position} extra line(s)"
            )
    else:
        while position < len(lines):
            id_line = lines[position]
            if not id_line.startswith("  - id: ") or id_line == "  - id: ":
                raise ReviewPacketError(
                    f"review packet finding must start with '  - id: <value>'; found {id_line!r}"
                )
            finding_values: dict[str, str] = {"id": id_line[len("  - id: ") :]}
            position += 1
            for key in _FINDING_KEYS[1:]:
                if position >= len(lines):
                    raise ReviewPacketError(f"review packet finding is incomplete: missing '{key}'")
                field_line = lines[position]
                expected = f"    {key}: "
                if not field_line.startswith(expected) or field_line == expected:
                    raise ReviewPacketError(
                        f"review packet finding expected '{key}: <value>' "
                        f"(four-space indent); found {field_line!r}"
                    )
                finding_values[key] = field_line[len(expected) :]
                position += 1
            try:
                severity = FindingSeverity(finding_values["severity"])
            except ValueError:
                raise ReviewPacketError(
                    f"review packet finding severity must be one of "
                    f"HIGH/MEDIUM/LOW; found {finding_values['severity']!r}"
                ) from None
            findings.append(
                ReviewFinding(
                    finding_id=finding_values["id"],
                    severity=severity,
                    path=finding_values["path"],
                    criterion=finding_values["criterion"],
                    required_change=finding_values["required_change"],
                )
            )
        if not findings:
            raise ReviewPacketError("review packet declared findings but none were parsed")
    try:
        pr_number = int(values["pr"])
    except ValueError:
        raise ReviewPacketError(
            f"review packet 'pr' must be a non-negative integer; found {values['pr']!r}"
        ) from None
    if pr_number < 0:
        raise ReviewPacketError(
            f"review packet 'pr' must be a non-negative integer; found {values['pr']!r}"
        )
    try:
        iteration = int(values["iteration"])
    except ValueError:
        raise ReviewPacketError(
            f"review packet 'iteration' must be a positive integer; found {values['iteration']!r}"
        ) from None
    if iteration < 1:
        raise ReviewPacketError(
            f"review packet 'iteration' must be a positive integer; found {values['iteration']!r}"
        )
    for field_name in ("head_sha", "base_sha"):
        if not _SHA_PATTERN.match(values[field_name]):
            raise ReviewPacketError(
                f"review packet '{field_name}' must be 40 lowercase hex "
                f"characters; found {values[field_name]!r}"
            )
    decision: ReviewDecision
    try:
        decision = ReviewDecision(values["decision"])
    except ValueError:
        raise ReviewPacketError(
            "review packet 'decision' must be one of "
            f"APPROVE/REQUEST_CHANGES/ESCALATE; found {values['decision']!r}"
        ) from None
    return ReviewPacket(
        work_item=values["work_item"],
        pr_number=pr_number,
        head_sha=values["head_sha"],
        base_sha=values["base_sha"],
        iteration=iteration,
        decision=decision,
        findings=tuple(findings),
    )
