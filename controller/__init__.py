"""Pectoraux Controller — orchestration runtime for governed delivery.

CTRL-001 foundation: typed lifecycle states, deterministic fail-closed
transitions, a command/event boundary for future adapters, and repository
authority loading/reconstruction. CTRL-002 domain model: typed work-item
identity, authority-derived dispatch eligibility, the governed execution
context, and domain commands/events with deterministic serialization.
CTRL-003 GitHub adapter: a typed, dependency-injected observation/mutation
boundary with strict normalization, work-order correlation, and a
policy-gated merge authorization enforcing the frozen merge predicate.
No Z.ai integration, no merging by workers, no database — those belong
to later work orders.
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
    GithubAdapterError,
    GithubAmbiguityError,
    GithubAuthError,
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
    "GithubAdapter",
    "GithubAdapterError",
    "GithubAmbiguityError",
    "GithubAuthError",
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
    "ProgramState",
    "STATE_FILE",
    "SUPPORTED_SCHEMA_VERSION",
    "SpecError",
    "TERMINAL_EXCEPTION_STATES",
    "TRANSITIONS",
    "UrllibGithubTransport",
    "WORK_ITEMS_DIR",
    "WorkItemIdentity",
    "allowed_commands",
    "dispatch",
    "load_program_state",
    "load_work_item_status",
    "reconstruct",
    "reconstruct_domain",
    "target_state",
    "verify_authority",
]
