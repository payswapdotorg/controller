"""Pectoraux Controller — orchestration runtime for governed delivery.

CTRL-001 foundation: typed lifecycle states, deterministic fail-closed
transitions, a command/event boundary for future adapters, and repository
authority loading/reconstruction. CTRL-002 domain model: typed work-item
identity, authority-derived dispatch eligibility, the governed execution
context, and domain commands/events with deterministic serialization.
No GitHub, no Z.ai, no merging, no database — those belong to later work
orders.
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
    IneligibleDispatchError,
    InvalidTransitionError,
    SpecError,
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
    "DispatchEligibility",
    "DomainCommand",
    "DomainError",
    "DomainEvent",
    "Event",
    "EXCEPTION_COMMANDS",
    "GovernedWorkItem",
    "IneligibleDispatchError",
    "InvalidTransitionError",
    "SpecError",
    "LIFECYCLE_SEQUENCE",
    "LifecycleState",
    "ProgramState",
    "STATE_FILE",
    "SUPPORTED_SCHEMA_VERSION",
    "TERMINAL_EXCEPTION_STATES",
    "TRANSITIONS",
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
