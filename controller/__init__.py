"""Pectoraux Controller — orchestration runtime for governed delivery.

CTRL-001 foundation: typed lifecycle states, deterministic fail-closed
transitions, a command/event boundary for future adapters, and repository
authority loading/reconstruction. CTRL-002 domain model: typed work-item
identity, authority-derived dispatch eligibility, the governed execution
context, and domain commands/events with deterministic serialization.
CTRL-003 GitHub adapter: a typed, dependency-injected observation/mutation
boundary with strict normalization, work-order correlation, and a
policy-gated merge authorization enforcing the frozen merge predicate.
CTRL-005 orchestration boundary and CTRL-006 CI/evidence gate: one-step
governed orchestration over the accepted adapters, deterministic
classification of required CI evidence, and typed retry handoffs. No
worker merging, no database, no scheduler — those stay outside the
frozen authority.
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
from controller.orchestrator import (
    OrchestrationOutcome,
    OrchestrationReferences,
    Orchestrator,
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
    ZaiTransport,
    ZaiWorkerContext,
    ZaiWorkerSession,
)

__version__ = "0.1.0"

__all__ = [
    "ALL_STATES",
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
    "OrchestrationContradictionError",
    "OrchestrationError",
    "OrchestrationMissingReferenceError",
    "OrchestrationOutcome",
    "OrchestrationReferences",
    "Orchestrator",
    "ProgramState",
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
