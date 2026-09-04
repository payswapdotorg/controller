"""Domain model for governed work-item execution (CTRL-002).

This module defines the controller's domain level: typed objects that
represent ONE active governed work item and its execution context,
projected deterministically from repository authority on top of the
CTRL-001 lifecycle primitives.

Layering (explicit, for audit):

* ``controller.authority`` — loads and cross-validates repository
  authority (machine-state JSON + work-order file). Everything in this
  module trusts it exclusively.
* ``controller.commands`` / ``controller.transitions`` — the CTRL-001
  command/event boundary and the frozen transition table. The domain
  layer DELEGATES lifecycle semantics to them and never redefines
  transition policy (AC5).
* ``controller.domain`` (this module) — work-item identity, dispatch
  eligibility, the governed execution context, domain-level
  commands/events with deterministic serialization, and reconstruction
  from repository authority.

Doctrine:

* Repository authority is the only durable truth. The domain model is a
  pure projection: no database, queue, cache, or other persistence is
  introduced, and no runtime state survives a restart. Equivalent
  authority reconstructs to an equal domain object on any machine (AC3).
* Eligibility is derived from repository authority — an item that is not
  explicitly READY (machine state and its work order agreeing) and not
  already recorded in ``completed`` cannot be dispatched by the domain
  model (AC2).
* Malformed, missing, contradictory, or semantically invalid state fails
  closed with typed errors; nothing is guessed, repaired silently, or
  defaulted to a fallback work item (AC4).
* Domain commands/events are frozen values with explicit
  serialize/deserialize contracts so future adapters (GitHub CTRL-003,
  Z.ai CTRL-004) can exchange them deterministically. No transport,
  client, or integration exists here (AC6).
* All operations are pure: repeated reconstruction of unchanged
  authority yields an equal object, and re-applying an already-applied
  event fails deterministically rather than producing divergent state
  (AC7).

External evidence (base SHA, PR state, CI results) is NOT modeled here:
it enters the domain later through adapter-produced commands. Inventing
placeholder representations for it would exceed the frozen work order.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from controller.authority import WORK_ITEMS_DIR, verify_authority
from controller.commands import Command, CommandName, Event
from controller.errors import (
    CommandTargetError,
    DomainError,
    IneligibleDispatchError,
)
from controller.states import LifecycleState
from controller.transitions import TRANSITIONS, allowed_commands, dispatch

#: Basis note recorded when eligibility is derived from a full authority
#: reconstruction (machine state cross-checked against the work order).
_AUTHORITY_AGREEMENT = "machine state and work-order status agree (authority cross-check passed)"


@dataclass(frozen=True)
class WorkItemIdentity:
    """Repository-resolved identity of the active governed work item.

    Carried by every domain command and event so future adapters can
    address the governed item without ambiguity.
    """

    repository: str
    work_item: str
    work_order_path: str

    def serialize(self) -> dict[str, str]:
        """Deterministic value form (string-to-string, fixed keys)."""
        return {
            "repository": self.repository,
            "workItem": self.work_item,
            "workOrderPath": self.work_order_path,
        }

    @classmethod
    def deserialize(cls, data: object) -> WorkItemIdentity:
        """Rebuild an identity from a serialized value, or fail closed."""
        if not isinstance(data, dict):
            raise DomainError("WorkItemIdentity: expected a JSON object")
        keys = set(data)
        if keys != {"repository", "workItem", "workOrderPath"}:
            raise DomainError(
                "WorkItemIdentity: expected exactly keys repository, workItem, "
                f"workOrderPath; found {sorted(str(k) for k in keys)}"
            )
        values: list[str] = []
        for key in ("repository", "workItem", "workOrderPath"):
            value = data[key]
            if not isinstance(value, str) or not value:
                raise DomainError(f"WorkItemIdentity: '{key}' must be a non-empty string")
            values.append(value)
        return cls(repository=values[0], work_item=values[1], work_order_path=values[2])


@dataclass(frozen=True)
class AuthorityContext:
    """The authoritative documents governing the active work item.

    Pure reference data projected from machine state; the domain layer
    never mutates or reinterprets these.
    """

    roadmap: str
    architecture: str
    build_process: str
    automation_stage: str


@dataclass(frozen=True)
class DispatchEligibility:
    """Whether the active work item may be dispatched, and why.

    ``basis`` records the authority-derived facts behind the decision so
    the eligibility verdict is auditable, not a bare boolean.
    """

    work_item: str
    eligible: bool
    basis: tuple[str, ...]

    def require(self) -> None:
        """Fail closed unless the item is explicitly eligible."""
        if not self.eligible:
            raise IneligibleDispatchError(
                f"work item {self.work_item} is not eligible for dispatch: " + "; ".join(self.basis)
            )


def _eligibility(
    work_item: str,
    lifecycle: LifecycleState,
    completed: tuple[str, ...],
    agreement: str,
) -> DispatchEligibility:
    """Derive eligibility from authority-derived facts.

    An item is eligible only when its lifecycle position is READY and it
    is not already recorded in ``completed``. Both disqualifiers are
    authority facts, not runtime guesses.
    """
    if lifecycle == LifecycleState.READY and work_item not in completed:
        return DispatchEligibility(
            work_item=work_item,
            eligible=True,
            basis=(
                agreement,
                "lifecycle state is READY",
                "work item is not recorded in completed",
            ),
        )
    disqualifiers: list[str] = []
    if lifecycle != LifecycleState.READY:
        disqualifiers.append(f"lifecycle state is {lifecycle.value}, not READY")
    if work_item in completed:
        disqualifiers.append("work item is already recorded in completed")
    return DispatchEligibility(
        work_item=work_item, eligible=False, basis=(agreement, *disqualifiers)
    )


@dataclass(frozen=True)
class DomainCommand:
    """A domain-level command for the active governed work item.

    Wraps the CTRL-001 lifecycle command vocabulary with explicit work
    item addressing and a deterministic serialization contract for
    future adapters. A domain command is a request, never a guarantee:
    eligibility, targeting, and transition validity are all enforced
    before an event is produced.
    """

    work_item: str
    command: CommandName

    def to_lifecycle_command(self) -> Command:
        """Project onto the CTRL-001 boundary command."""
        return Command(name=self.command, work_item=self.work_item)

    def serialize(self) -> dict[str, str]:
        """Deterministic value form (string-to-string, fixed keys)."""
        return {"workItem": self.work_item, "command": self.command.value}

    @classmethod
    def deserialize(cls, data: object) -> DomainCommand:
        """Rebuild a command from a serialized value, or fail closed."""
        if not isinstance(data, dict):
            raise DomainError("DomainCommand: expected a JSON object")
        keys = set(data)
        if keys != {"workItem", "command"}:
            raise DomainError(
                "DomainCommand: expected exactly keys workItem, command; "
                f"found {sorted(str(k) for k in keys)}"
            )
        work_item = data["workItem"]
        command_value = data["command"]
        if not isinstance(work_item, str) or not work_item:
            raise DomainError("DomainCommand: 'workItem' must be a non-empty string")
        if not isinstance(command_value, str):
            raise DomainError("DomainCommand: 'command' must be a string")
        try:
            command = CommandName(command_value)
        except ValueError:
            raise DomainError(f"DomainCommand: unknown command '{command_value}'") from None
        return cls(work_item=work_item, command=command)


@dataclass(frozen=True)
class DomainEvent:
    """The deterministic outcome of an accepted domain command.

    Mirrors the CTRL-001 event semantics with explicit serialization for
    adapter exchange. Immutable and timeless: no timestamps, UUIDs, or
    random data, so equivalent command histories produce equal events.

    Semantic validity is enforced against the frozen CTRL-001 transition
    table on deserialization and on application (see
    :func:`_validate_event_semantics`): a structurally valid but
    transition-impossible event — e.g. APPROVE issued from READY — fails
    closed instead of entering the domain (FZ-CTRL002-001).
    """

    work_item: str
    command: CommandName
    from_state: LifecycleState
    to_state: LifecycleState

    @classmethod
    def from_lifecycle_event(cls, event: Event) -> DomainEvent:
        """Lift a CTRL-001 boundary event into the domain layer."""
        return cls(
            work_item=event.work_item,
            command=event.command,
            from_state=event.from_state,
            to_state=event.to_state,
        )

    def serialize(self) -> dict[str, str]:
        """Deterministic value form (string-to-string, fixed keys)."""
        return {
            "workItem": self.work_item,
            "command": self.command.value,
            "fromState": self.from_state.value,
            "toState": self.to_state.value,
        }

    @classmethod
    def deserialize(cls, data: object) -> DomainEvent:
        """Rebuild an event from a serialized value, or fail closed."""
        if not isinstance(data, dict):
            raise DomainError("DomainEvent: expected a JSON object")
        expected = {"workItem", "command", "fromState", "toState"}
        keys = set(data)
        if keys != expected:
            raise DomainError(
                f"DomainEvent: expected exactly keys {sorted(expected)}; "
                f"found {sorted(str(k) for k in keys)}"
            )
        work_item = data["workItem"]
        if not isinstance(work_item, str) or not work_item:
            raise DomainError("DomainEvent: 'workItem' must be a non-empty string")
        field_values: list[str] = []
        for key in ("command", "fromState", "toState"):
            value = data[key]
            if not isinstance(value, str):
                raise DomainError(f"DomainEvent: '{key}' must be a string")
            field_values.append(value)
        try:
            command = CommandName(field_values[0])
        except ValueError:
            raise DomainError(f"DomainEvent: unknown command '{field_values[0]}'") from None
        try:
            from_state = LifecycleState(field_values[1])
        except ValueError:
            raise DomainError(f"DomainEvent: unknown from-state '{field_values[1]}'") from None
        try:
            to_state = LifecycleState(field_values[2])
        except ValueError:
            raise DomainError(f"DomainEvent: unknown to-state '{field_values[2]}'") from None
        event = cls(
            work_item=work_item,
            command=command,
            from_state=from_state,
            to_state=to_state,
        )
        _validate_event_semantics(event)
        return event


def _validate_event_semantics(event: DomainEvent) -> None:
    """Validate event semantics against the frozen CTRL-001 transition table.

    The single shared validation path (FZ-CTRL002-001): both
    :meth:`DomainEvent.deserialize` and :meth:`GovernedWorkItem.advance`
    route through this function, so deserialized and in-memory events
    carry identical semantics. The frozen table is referenced directly —
    never duplicated or reinterpreted.

    Raises :class:`DomainError` when ``(from_state, command)`` is not a
    table entry, or when ``to_state`` is not that entry's successor.
    """
    expected = TRANSITIONS.get((event.from_state, event.command))
    if expected is None:
        raise DomainError(
            f"DomainEvent: command {event.command.value} is not valid from "
            f"state {event.from_state.value} under the frozen transition table"
        )
    if event.to_state != expected:
        raise DomainError(
            f"DomainEvent: command {event.command.value} from "
            f"{event.from_state.value} must transition to {expected.value}, "
            f"not {event.to_state.value}"
        )


@dataclass(frozen=True)
class GovernedWorkItem:
    """The domain aggregate: one active governed work item.

    An immutable, authority-derived snapshot: identity, lifecycle
    position, dispatch eligibility, governing authority references, and
    the completed-item record. Runtime advancement produces new
    snapshots (:meth:`advance`) — nothing is mutated in place.
    """

    identity: WorkItemIdentity
    lifecycle: LifecycleState
    eligibility: DispatchEligibility
    authority: AuthorityContext
    completed: tuple[str, ...]

    def allowed_commands(self) -> frozenset[CommandName]:
        """Commands the frozen transition table permits from this position.

        Delegates to the CTRL-001 machine; the domain layer never
        redefines transition policy (AC5).
        """
        return allowed_commands(self.lifecycle)

    def handle(self, command: DomainCommand) -> DomainEvent:
        """Validate and apply a domain command, producing the domain event.

        Enforcement order (all fail closed, nothing is guessed):
        1. the command must target THIS active work item;
        2. DISPATCH additionally requires explicit authority-derived
           eligibility (AC2) — this domain gate also refuses items that
           are READY but already recorded in ``completed``, a case the
           lifecycle table alone cannot detect;
        3. the CTRL-001 frozen transition table decides validity and the
           successor state (AC5).
        """
        if command.work_item != self.identity.work_item:
            raise CommandTargetError(
                f"command targets work item '{command.work_item}', but the "
                f"active governed item is '{self.identity.work_item}'"
            )
        if command.command == CommandName.DISPATCH:
            self.eligibility.require()
        lifecycle_event = dispatch(self.lifecycle, command.to_lifecycle_command())
        return DomainEvent.from_lifecycle_event(lifecycle_event)

    def advance(self, event: DomainEvent) -> GovernedWorkItem:
        """Project this snapshot through an applied domain event (pure).

        Refuses forged events before positioning is even considered
        (FZ-CTRL002-001): the event's ``(from_state, command)`` pair and
        successor state are validated against the frozen CTRL-001
        transition table via the same shared path used on deserialization.
        Re-applying an already-applied event then fails deterministically
        (the from-state no longer matches) rather than silently
        duplicating or diverging state (AC7).
        """
        if event.work_item != self.identity.work_item:
            raise CommandTargetError(
                f"event belongs to work item '{event.work_item}', but the "
                f"active governed item is '{self.identity.work_item}'"
            )
        _validate_event_semantics(event)
        if event.from_state != self.lifecycle:
            raise DomainError(
                f"event {event.command.value} starts from "
                f"{event.from_state.value}, but the current lifecycle "
                f"position is {self.lifecycle.value}"
            )
        agreement = f"lifecycle advanced by applied domain event {event.command.value}"
        return replace(
            self,
            lifecycle=event.to_state,
            eligibility=_eligibility(
                self.identity.work_item, event.to_state, self.completed, agreement
            ),
        )


def reconstruct_domain(repo_root: Path) -> GovernedWorkItem:
    """Reconstruct the governed work item from repository authority.

    The only construction path for the domain aggregate: repository
    files in, typed domain object out. Structural defects raise
    ``SpecError`` and authority disagreements raise
    ``ContradictionError`` (both fail closed); no local state is
    consulted, cached, or written (AC3, AC4).
    """
    program = verify_authority(repo_root)
    identity = WorkItemIdentity(
        repository=program.repository,
        work_item=program.active_work_item,
        work_order_path=f"{WORK_ITEMS_DIR}/{program.active_work_item}.md",
    )
    return GovernedWorkItem(
        identity=identity,
        lifecycle=program.status,
        eligibility=_eligibility(
            program.active_work_item,
            program.status,
            program.completed,
            _AUTHORITY_AGREEMENT,
        ),
        authority=AuthorityContext(
            roadmap=program.roadmap,
            architecture=program.architecture,
            build_process=program.build_process,
            automation_stage=program.automation_stage,
        ),
        completed=program.completed,
    )
