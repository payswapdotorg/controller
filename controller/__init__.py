"""Pectoraux Controller — orchestration runtime for governed delivery.

CTRL-001 foundation: typed lifecycle states, deterministic fail-closed
transitions, a command/event boundary for future adapters, and repository
authority loading/reconstruction. CTRL-002 domain model: typed work-item
identity, authority-derived dispatch eligibility, the governed execution
context, and domain commands/events with deterministic serialization.
CTRL-003 GitHub adapter: a typed, dependency-injected observation/mutation
boundary with strict normalization, work-order correlation, and a
policy-gated merge authorization enforcing the frozen merge predicate.
CTRL-005 orchestration boundary, CTRL-006 CI/evidence gate, and CTRL-007
Architect review loop: one-step governed orchestration over the accepted
adapters, deterministic classification of required CI evidence with typed
retry handoffs, and durable machine-readable review packets with
same-worker/same-PR change-iteration handoffs. CTRL-008 merge +
reconciliation boundary: the frozen merge-predicate evaluation and
single authorized merge attempt through the CTRL-003 adapter, observed
merge evidence, and the deterministic idempotent post-merge
reconciliation record. No worker merging, no database, no scheduler —
those stay outside the frozen authority.
"""

from __future__ import annotations

from controller.authority import (
    STATE_FILE,
    SUPPORTED_SCHEMA_VERSION,
    WORK_ITEMS_DIR,
    ControllerState,
    ProgramState,
    load_program_state,
    load_work_item_status,
    reconstruct,
    verify_authority,
)
from controller.commands import (
    EXCEPTION_COMMANDS,
    Command,
    CommandName,
    Event,
)
from controller.domain import (
    AuthorityContext,
    DispatchEligibility,
    DomainCommand,
    DomainEvent,
    GovernedWorkItem,
    WorkItemIdentity,
    reconstruct_domain,
)
from controller.errors import (
    CommandTargetError,
    ContradictionError,
    ControllerError,
    DomainError,
    EvidenceContradictionError,
    EvidenceGateError,
    EvidenceGatePositionError,
    EvidenceMissingReferenceError,
    EvidencePolicyError,
    GithubAdapterError,
    GithubAmbiguityError,
    GithubAuthError,
    GithubAuthorizationForgedError,
    GithubContradictionError,
    GithubMalformedResponseError,
    GithubMergeBlockedError,
    GithubNotFoundError,
    GithubRateLimitError,
    GithubStaleBaseError,
    GithubTransportError,
    IneligibleDispatchError,
    InvalidTransitionError,
    MergeContradictionError,
    MergeLoopError,
    MergeLoopPositionError,
    MergeMissingReferenceError,
    MergePolicyError,
    ReviewContradictionError,
    ReviewLoopError,
    ReviewLoopPositionError,
    ReviewMissingReferenceError,
    ReviewPacketError,
    SpecError,
)
from controller.evidence import (
    EvidenceClassification,
    EvidenceGate,
    EvidenceGateOutcome,
    EvidencePolicy,
    EvidenceRetryRequest,
)
from controller.github import (
    DEFAULT_API_ROOT,
    GithubAdapter,
    GithubComment,
    GithubCommit,
    GithubCommitStatus,
    GithubPullRequest,
    GithubRef,
    GithubReview,
    GithubTransport,
    MergeAuthorization,
    UrllibGithubTransport,
)
from controller.merge import (
    MergeLoopOutcome,
    MergePolicy,
    MergeReconciliationLoop,
    ReconciliationRecord,
)
from controller.orchestrator import (
    OrchestrationOutcome,
    OrchestrationReferences,
    Orchestrator,
)
from controller.review import (
    ArchitectReviewLoop,
    FindingSeverity,
    ReviewDecision,
    ReviewFinding,
    ReviewHandoff,
    ReviewLoopOutcome,
    ReviewPacket,
)
from controller.states import (
    ALL_STATES,
    LIFECYCLE_SEQUENCE,
    TERMINAL_EXCEPTION_STATES,
    LifecycleState,
)
from controller.transitions import (
    TRANSITIONS,
    allowed_commands,
    dispatch,
    target_state,
)
from controller.zai import DEFAULT_API_ROOT as ZAI_DEFAULT_API_ROOT
from controller.zai import (
    UrllibZaiTransport,
    ZaiAdapter,
    ZaiIssuedWorkerSession,
    ZaiTransport,
    ZaiWorkerContext,
    ZaiWorkerSession,
)

__version__ = "0.1.0"

__all__ = [
    "ALL_STATES",
    "ArchitectReviewLoop",
    "AuthorityContext",
    "Command",
    "CommandName",
    "CommandTargetError",
    "ControllerError",
    "ControllerState",
    "ContradictionError",
    "DEFAULT_API_ROOT",
    "DispatchEligibility",
    "DomainCommand",
    "DomainError",
    "DomainEvent",
    "Event",
    "EXCEPTION_COMMANDS",
    "EvidenceClassification",
    "EvidenceContradictionError",
    "EvidenceGate",
    "EvidenceGateError",
    "EvidenceGateOutcome",
    "EvidenceGatePositionError",
    "EvidenceMissingReferenceError",
    "EvidencePolicy",
    "EvidencePolicyError",
    "EvidenceRetryRequest",
    "FindingSeverity",
    "GithubAdapter",
    "GithubAdapterError",
    "GithubAmbiguityError",
    "GithubAuthError",
    "GithubAuthorizationForgedError",
    "GithubComment",
    "GithubCommit",
    "GithubCommitStatus",
    "GithubContradictionError",
    "GithubMalformedResponseError",
    "GithubMergeBlockedError",
    "GithubNotFoundError",
    "GithubPullRequest",
    "GithubRateLimitError",
    "GithubRef",
    "GithubReview",
    "GithubStaleBaseError",
    "GithubTransport",
    "GithubTransportError",
    "GovernedWorkItem",
    "IneligibleDispatchError",
    "InvalidTransitionError",
    "LIFECYCLE_SEQUENCE",
    "LifecycleState",
    "MergeAuthorization",
    "MergeContradictionError",
    "MergeLoopError",
    "MergeLoopOutcome",
    "MergeLoopPositionError",
    "MergeMissingReferenceError",
    "MergePolicy",
    "MergePolicyError",
    "MergeReconciliationLoop",
    "OrchestrationContradictionError",
    "OrchestrationError",
    "OrchestrationMissingReferenceError",
    "OrchestrationOutcome",
    "OrchestrationReferences",
    "Orchestrator",
    "ProgramState",
    "ReconciliationRecord",
    "ReviewContradictionError",
    "ReviewDecision",
    "ReviewFinding",
    "ReviewHandoff",
    "ReviewLoopError",
    "ReviewLoopOutcome",
    "ReviewLoopPositionError",
    "ReviewMissingReferenceError",
    "ReviewPacket",
    "ReviewPacketError",
    "STATE_FILE",
    "SUPPORTED_SCHEMA_VERSION",
    "SpecError",
    "TERMINAL_EXCEPTION_STATES",
    "TRANSITIONS",
    "UrllibGithubTransport",
    "UrllibZaiTransport",
    "WORK_ITEMS_DIR",
    "WorkItemIdentity",
    "ZAI_DEFAULT_API_ROOT",
    "ZaiAdapter",
    "ZaiAdapterError",
    "ZaiAuthError",
    "ZaiConfigurationError",
    "ZaiContextMismatchError",
    "ZaiContradictionError",
    "ZaiIssuedWorkerSession",
    "ZaiMalformedResponseError",
    "ZaiMissingSessionError",
    "ZaiPolicyViolationError",
    "ZaiRateLimitError",
    "ZaiRejectedRequestError",
    "ZaiTransportError",
    "ZaiTransport",
    "ZaiWorkerContext",
    "ZaiWorkerSession",
    "allowed_commands",
    "dispatch",
    "load_program_state",
    "load_work_item_status",
    "reconstruct",
    "reconstruct_domain",
    "target_state",
    "verify_authority",
]
