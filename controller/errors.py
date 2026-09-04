"""Fail-closed error types for the Controller.

Every controller failure raises one of these exceptions and stops. State is
never guessed, silently repaired, or coerced into a valid shape. Callers are
expected to treat any ``ControllerError`` as a hard stop requiring explicit
human/Architect attention, per the frozen architecture's recovery rule.
"""

from __future__ import annotations


class ControllerError(Exception):
    """Base class for all deterministic controller failures."""


class SpecError(ControllerError):
    """A controller repository authority file is missing or malformed.

    Raised when specification/state files cannot be parsed or do not conform
    to the expected schema. This is a structural defect, not a disagreement
    between sources.
    """


class ContradictionError(ControllerError):
    """Controller repository authority sources disagree with each other.

    Raised when separately authoritative files make incompatible claims
    (for example machine state says a work item is READY while the work
    order file says DISPATCHED). Contradictions must stop the controller;
    they must never be auto-repaired.
    """


class InvalidTransitionError(ControllerError):
    """A command is not permitted from the current lifecycle state.

    Raised for any (state, command) pair that is not present in the frozen
    transition table, including commands issued from terminal states.
    """


class DomainError(ControllerError):
    """Domain-level validation failure (CTRL-002).

    Raised when domain objects cannot be constructed, deserialized, or
    applied consistently — for example malformed serialized values, events
    that do not match the current lifecycle position, or other semantically
    invalid domain state.
    """


class IneligibleDispatchError(DomainError):
    """A command attempts to dispatch a work item that is not READY and eligible.

    The domain model refuses to dispatch any work item whose eligibility
    (derived from repository authority) is not explicitly affirmed.
    """


class CommandTargetError(DomainError):
    """A command targets a work item other than the active governed item.

    The domain model executes exactly one active work item; commands for
    any other identifier fail closed rather than being routed or guessed.
    """
