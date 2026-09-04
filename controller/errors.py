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
    """A presented merge authorization is not a valid merge request.

    FZ-CTRL003-004A: ``merge_pull_request`` treats the presented
    ``MergeAuthorization`` as a merge request, never as evidence, and
    independently re-establishes the complete merge-policy proof before
    the remote mutation. This error fires closed when the presented
    object is not a structurally complete ``MergeAuthorization`` value
    (a non-authorization object, or a forgery with missing or malformed
    fields), or when it is not field-identical to the freshly
    re-established proof (for example a merge method the frozen policy
    never issues). Possession of such a value can never substitute for
    the predicate actually holding at execution time.
    """


# ---------------------------------------------------------------------------
# Z.ai adapter errors (CTRL-004) — typed fail-closed provider boundary
# ---------------------------------------------------------------------------


class ZaiAdapterError(ControllerError):
    """Base class for every Z.ai adapter boundary failure (CTRL-004).

    The adapter is the typed seam between the Controller and the Z.ai
    implementation-worker provider. Every failure — configuration,
    authentication, transport, rejected request, malformed response,
    context mismatch, missing session identity, contradiction, or worker
    safety violation — surfaces as a typed subclass of this error. No
    silent fallback, fabricated success, or guessed identity is
    permitted (AC4).
    """


class ZaiConfigurationError(ZaiAdapterError):
    """The adapter or its transport was constructed with invalid inputs.

    For example: a repository not formatted 'owner/name', an empty API
    root, or a provider identity that is not a non-empty string.
    """


class ZaiAuthError(ZaiAdapterError):
    """The provider rejected the adapter's authentication."""


class ZaiRateLimitError(ZaiAdapterError):
    """The provider declined the request due to rate limiting."""


class ZaiTransportError(ZaiAdapterError):
    """A provider transport failure (network error, 5xx, timeout).

    The adapter never retries silently; the caller decides policy.
    """


class ZaiRejectedRequestError(ZaiAdapterError):
    """The provider refused the request for a non-auth, non-rate reason.

    Raised for 4xx refusals other than authentication/rate-limit
    responses; the provider's reason is carried in the message.
    """


class ZaiMalformedResponseError(ZaiAdapterError):
    """A provider response does not satisfy the typed response schema.

    Deterministic normalization refuses to guess: missing fields, wrong
    types, or inconsistent values fail closed rather than being patched.
    """


class ZaiMissingSessionError(ZaiAdapterError):
    """A worker/session identity is missing where one is required.

    Resume requires an explicit session identifier supplied by the
    caller; start requires the provider response to identify the worker
    execution. Absence is never guessed or defaulted (AC3/AC4).
    """


class ZaiContextMismatchError(ZaiAdapterError):
    """The presented work context does not match the governed context.

    For example: the caller-supplied repository/work item does not match
    the adapter's repository binding, the provider-reported session
    belongs to a different work item or PR (a fork), or the base/PR
    identity drifted from the repository-derived facts. The adapter
    never silently continues into a different work context (AC2/AC3).
    """


class ZaiContradictionError(ZaiAdapterError):
    """Provider-reported state contradicts repository-derived authority.

    The adapter never treats provider/session state as authoritative
    (AC5): a contradiction stops the operation for governance review
    rather than being resolved by guessing.
    """


class ZaiPolicyViolationError(ZaiAdapterError):
    """The worker safety boundary would be violated (AC6).

    The adapter may only send controller-approved worker instructions
    built from repository-derived facts, the Work Order reference, and
    review findings — it cannot merge, approve, mark work items
    complete, or authorize architecture changes. A payload that would
    exceed the frozen worker role (for example, carrying unknown fields
    or token-like provider material) fails closed with this error.
    """


# ---------------------------------------------------------------------------
# Orchestrator errors (CTRL-005) — typed fail-closed coordination boundary
# ---------------------------------------------------------------------------


class OrchestrationError(ControllerError):
    """Base class for every orchestrator boundary failure (CTRL-005).

    The orchestrator coordinates the accepted domain, GitHub, and Z.ai
    abstractions for exactly one active governed Work Order. It is never
    an authority source: repository authority outranks its projections,
    and every failure — contradiction or a missing non-authoritative
    carried reference — fails closed with a typed error. No guessed
    recovery, alternate-item dispatch, or silent continuation.
    """


class OrchestrationContradictionError(OrchestrationError):
    """Repository authority and observed remote evidence contradict.

    For example: machine state records a PR-open (or later) lifecycle
    position while no governed pull request is observed, or the recorded
    CHANGES_REQUESTED position no longer matches the review evidence.
    Repository authority outranks remote observation (AC5); the
    orchestration run stops for governance attention.
    """


class OrchestrationMissingReferenceError(OrchestrationError):
    """A required non-authoritative carried reference was not supplied.

    The orchestrator keeps no runtime state (AC6): the governed branch,
    dispatch base SHA, worker session reference, and architect reviewer
    identity are caller-carried inputs, cross-validated against authority
    and remote evidence. When a cycle requires one and it is absent, the
    run fails closed rather than guessing the correlation.
    """
