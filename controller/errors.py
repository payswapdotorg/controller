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


class GithubAdapterError(ControllerError):
    """Base class for GitHub adapter failures (CTRL-003).

    Every adapter failure — transport, authentication, missing resource,
    malformed response, ambiguity, drift, contradiction, or policy
    refusal — raises a subclass of this type and stops the operation.
    Nothing is guessed, retried implicitly, or silently defaulted.
    """


class GithubTransportError(GithubAdapterError):
    """Network/timeout/unexpected-HTTP failure in the GitHub transport."""


class GithubAuthError(GithubAdapterError):
    """Authentication or permission failure (HTTP 401 / plain 403)."""


class GithubRateLimitError(GithubAdapterError):
    """GitHub rate limit exceeded (HTTP 429 or rate-limited 403)."""


class GithubNotFoundError(GithubAdapterError):
    """A requested GitHub resource does not exist (HTTP 404)."""


class GithubMalformedResponseError(GithubAdapterError):
    """A GitHub response did not match the shape required for normalization.

    Missing fields, wrong types, or non-object/list bodies fail closed
    rather than being defaulted or partially parsed.
    """


class GithubAmbiguityError(GithubAdapterError):
    """GitHub state is ambiguous where exactly one match is required.

    Primary case: more than one open pull request for a work-order branch,
    violating the one-PR-per-work-item rule.
    """


class GithubStaleBaseError(GithubAdapterError):
    """A base or head SHA does not match the expected, authority-derived SHA.

    Raised for base drift, head drift, and stale-SHA conditions; the
    adapter never guesses which SHA was intended.
    """


class GithubContradictionError(GithubAdapterError):
    """Repository authority and GitHub state contradict each other.

    For example: the merge predicate requires the work item to be the
    active eligible item in machine state, but the provided authority
    snapshot says otherwise. Contradictions stop the operation.
    """


class GithubMergeBlockedError(GithubAdapterError):
    """The frozen merge predicate is not satisfied.

    Raised by the adapter's merge authorization gate when GitHub-side
    evidence (PR state, CI, reviews, mergeability) does not satisfy the
    frozen architecture's merge predicate. Never bypassed.
    """


class GithubAuthorizationForgedError(GithubAdapterError):
    """A MergeAuthorization was not issued by the adapter's merge gate.

    FZ-CTRL003-004: ``merge_pull_request`` is executable only with an
    authorization issued by ``GithubAdapter.authorize_merge``. That
    invariant is enforced — not documented — through a module-private,
    non-forgeable issuance proof carried by every genuine
    ``MergeAuthorization``. A caller-manufactured or altered
    authorization (structurally valid or not) fails closed with this
    error before any remote mutation executes.
    """
