"""Z.ai implementation-worker adapter boundary (CTRL-004).

The typed seam between the Controller and the Z.ai worker provider.
Layering and doctrine (mirroring the CTRL-003 GitHub adapter):

* **Transport (dependency-injected).** :class:`ZaiTransport` is a Protocol;
  :class:`UrllibZaiTransport` is the only Z.ai-provider network component in
  the whole controller package. Tests inject deterministic fakes, so the
  suite never touches the network and never needs credentials
  (:class:`UrllibZaiTransport` takes its token only as a constructor
  argument — never from repository files or defaults, never logged).
* **Exact work context (AC2).** Every start/resume request is bound to the
  repository-derived :class:`ZaiWorkerContext` supplied by the caller: the
  exact repository identity, Work Order reference (path and, optionally,
  content), active work-item identity, base SHA, and PR/head identity when a
  change iteration is in flight. A missing, contradictory, or stale identity
  is rejected with a typed error *before any provider I/O*.
* **Resume identity (AC3).** :meth:`ZaiAdapter.resume_worker` targets the
  same governed worker execution and exact PR/change context: the
  provider-reported session must match the presented work item, repository,
  base SHA, PR number, and head SHA, and must be the session the caller
  named. A mismatched session (a silent fork) or a dropped review packet is
  refused — the review findings supplied by the caller are propagated
  verbatim, never filtered or invented.
* **Repository authority boundary (AC5).** The adapter never reads
  repository files, keeps no cache or session database, and never treats
  provider/session state as authoritative. Authority-derived facts are
  always caller inputs; a provider report that contradicts them stops the
  operation with a typed error.
* **Worker safety boundary (AC6).** The adapter offers exactly two
  operations — start and resume. It has no merge, approval, completion, or
  architecture-mutation capability of any kind. Worker instructions are
  *constructed* by the adapter from the validated caller context plus the
  frozen worker-role contract (``_WORKER_ROLE_MAY``/``_WORKER_ROLE_MAY_NOT``);
  there is no free-text instruction channel, so only controller-approved,
  repository-derived instructions can ever be sent. A defense-in-depth
  payload policy check (:func:`_require_payload_policy`) fails closed on
  unknown payload fields or credential-like material.
* **Fail closed (AC4).** Every failure — configuration, authentication,
  rate limit, transport, rejected request, malformed response, missing
  session identity, context mismatch, contradiction, policy violation — is
  a typed :class:`controller.errors.ZaiAdapterError` subclass. No silent
  fallback, guessed identity, or fabricated success.
* **Adapter-issued evidence (FZ-CTRL007-001/002/003/004).**
  ``start_worker`` / ``resume_worker`` return
  :class:`ZaiIssuedWorkerSession` — the ordinary frozen
  ``ZaiWorkerSession`` value sealed with opaque construction-path
  evidence: a runtime capability captured in the closure that builds
  the adapter — not repository source material, not a module
  attribute, not importable, not stored on issued values. There is no
  public issuance function, no source-level secret, and **no reachable
  mint operation at all** (FZ-CTRL007-004): no module-level callable
  accepts provider-report data, and none turns ordinary fields or a
  session value into evidence — the normalization/issuance closure
  exists solely inside the two adapter operations, so evidence is
  created only when an actual provider response (the injected
  transport's return value) flows through ``start_worker`` /
  ``resume_worker``. The proof binds exactly the ordinary fields (a
  transplanted proof fails), and any boundary can verify locally
  (``is_adapter_issued()``, pure computation, zero provider I/O —
  verification is available to consumers; minting is not). A
  structurally identical hand-constructed session value — or a
  caller-constructed value of the issued type — is not evidence and
  fails such verification; a *subclass* of the issued type is not
  evidence either (FZ-CTRL007-005): the check pins the exact dynamic
  type before invoking the sealed verifier, and governing boundaries
  invoke the sealed verifier directly (never a value-supplied
  override of the virtual method). This is not a second session model,
  registry, cache, database, or persistence: it is the same frozen
  value type carrying proof of the path that constructed it.

No orchestration loop, scheduling, retry engine, or persistence exists here
(CTRL-005+ non-goals). The session identifier returned by the provider is
an explicit, non-authoritative execution reference the controller may carry
forward; it is never persisted by the adapter and never overrides
repository authority.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import ClassVar, Final, Protocol, TypeVar

from controller.errors import (
    ZaiAdapterError,
    ZaiAuthError,
    ZaiConfigurationError,
    ZaiContextMismatchError,
    ZaiContradictionError,
    ZaiMalformedResponseError,
    ZaiMissingSessionError,
    ZaiPolicyViolationError,
    ZaiRateLimitError,
    ZaiRejectedRequestError,
    ZaiTransportError,
)

DEFAULT_API_ROOT = "https://api.z.ai"

#: Provider session identifiers must be URL-path-safe opaque strings.
_SESSION_ID_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$")

#: Repository-derived SHAs are full lowercase hex (40 characters).
_SHA_PATTERN: Final[re.Pattern[str]] = re.compile(r"^[0-9a-f]{40}$")

#: The frozen worker role (architecture "Z.ai boundary", CTRL-004 AC6).
#: Included verbatim in every worker instruction payload.
_WORKER_ROLE_MAY: Final[tuple[str, ...]] = (
    "inspect repository state",
    "modify the assigned work-item surface",
    "run tests and validation",
    "push the implementation branch",
    "open and update the one work-item pull request",
    "respond to review findings",
)
_WORKER_ROLE_MAY_NOT: Final[tuple[str, ...]] = (
    "merge pull requests",
    "approve its own work",
    "mark a work item complete",
    "rewrite roadmap, architecture, or work orders",
    "fabricate validation evidence",
    "authorize architecture changes",
)

#: The exact fields a worker instruction payload may carry (AC6 allowlist).
_PAYLOAD_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {
        "kind",
        "session_id",
        "repository",
        "work_item",
        "work_order",
        "base_sha",
        "pr",
        "review_findings",
        "worker_role",
    }
)

#: Credential-like material must never appear in worker instructions.
_PAYLOAD_FORBIDDEN_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"ghp_[A-Za-z0-9]{16,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._-]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
)


class ZaiTransport(Protocol):
    """Minimal provider transport contract the adapter depends on (DI seam)."""

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        """POST a JSON payload; raise typed adapter errors on failure."""
        ...


@dataclass(frozen=True)
class ZaiWorkerContext:
    """Repository-derived facts binding a worker execution (AC2).

    Supplied by the caller from repository authority (machine state, work
    order, and the CTRL-003 GitHub correlation when a PR is already open).
    The adapter trusts these as *inputs* and never derives or repairs them.

    ``work_order_content`` is the optional frozen Work Order text (or its
    resolved reference excerpt); ``pr_number``/``head_sha`` carry the exact
    PR identity for a change iteration (both present or both absent);
    ``review_findings`` is the applicable Architect review packet, carried
    verbatim on resume and required to be empty on a fresh start.
    """

    repository: str
    work_item: str
    work_order_path: str
    base_sha: str
    work_order_content: str | None = None
    pr_number: int | None = None
    head_sha: str | None = None
    review_findings: tuple[str, ...] = ()


@dataclass(frozen=True)
class ZaiWorkerSession:
    """A normalized, non-authoritative worker-execution reference.

    The provider's report of the worker execution for the exact governed
    context: the session identifier the controller may carry forward, the
    bound work identity, the PR context when one exists, the provider
    status (verbatim), and the last update timestamp (ISO string, preserved
    verbatim — never parsed into clock-dependent types). Equivalent
    provider reports normalize to equal values.

    This is the ordinary public value form. Evidence of *issuance* — the
    proof that the value came from the adapter normalizing a provider
    response — is carried only by :class:`ZaiIssuedWorkerSession`, which
    only the adapter's normalization path creates (FZ-CTRL007-001/002/003).
    """

    session_id: str
    repository: str
    work_item: str
    base_sha: str
    pr_number: int | None
    head_sha: str | None
    status: str
    updated_at: str


def _ordinary_field_values(session: ZaiWorkerSession) -> tuple[object, ...]:
    """The canonical ordinary-field tuple of a session value — the exact
    tuple the issuance seal binds (FZ-CTRL007-001/002/003)."""
    return (
        session.session_id,
        session.repository,
        session.work_item,
        session.base_sha,
        session.pr_number,
        session.head_sha,
        session.status,
        session.updated_at,
    )


@dataclass(frozen=True)
class ZaiIssuedWorkerSession(ZaiWorkerSession):
    """Adapter-issued worker-session evidence (FZ-CTRL007-001/002/003/004).

    Created only inside the CTRL-004 adapter's provider-response
    operations (:meth:`ZaiAdapter.start_worker` /
    :meth:`ZaiAdapter.resume_worker`): the ordinary session fields plus
    an opaque proof object minted by the process-local issuance
    boundary, which binds exactly those fields. The public constructor
    cannot produce a verifying value: ``_proof`` must be the very proof
    object the boundary sealed for exactly these ordinary fields — an
    object that exists only at runtime inside the adapter's
    construction closure, is not reproducible from repository source,
    is not importable, and is not stored anywhere a caller can name it.
    There is also **no reachable mint operation**: no module-level
    callable accepts provider-report data or turns ordinary fields (or
    a session value) into evidence (FZ-CTRL007-004) — the seal exists
    solely inside the closure of the adapter's provider-response
    operations, reachable only by executing an actual provider round
    trip. A hand-constructed value of this type (or a structurally
    identical ``ZaiWorkerSession``) therefore fails
    :meth:`is_adapter_issued`, as does a genuine proof transplanted
    onto different fields. A *subclass* of this type is not evidence
    either (FZ-CTRL007-005): :meth:`is_adapter_issued` pins the exact
    dynamic type to this class before verifying, and consuming
    boundaries invoke the sealed adapter verifier directly against
    the carried proof and ordinary fields rather than trusting any
    value-supplied override of the virtual method. This is not a
    second session model: it is the same frozen value type carrying
    its construction-path evidence.
    """

    _proof: object

    def is_adapter_issued(self) -> bool:
        """True only when this exact value was sealed by the CTRL-004
        adapter's provider-response path — a pure local check (zero
        provider I/O) over the carried proof and fields. Verification
        is deliberately available to consumers; the mint is not
        (FZ-CTRL007-003/004). The exact dynamic type is pinned first
        (FZ-CTRL007-005): a subclass of the issued type never verifies
        here, even when it carries a genuine proof and overrides
        nothing — and a subclass that *does* override this method can
        never influence a governing boundary, because boundaries
        invoke the sealed adapter verifier
        (``ZaiAdapter._verify_issuance``) against the carried proof and
        ordinary fields with the exact type pinned instead of
        dispatching on this virtual method."""
        if type(self) is not ZaiIssuedWorkerSession:
            return False
        return ZaiAdapter._verify_issuance(self._proof, _ordinary_field_values(self))


# ---------------------------------------------------------------------------
# Context and payload validation (AC2/AC6) — before any provider I/O
# ---------------------------------------------------------------------------


def _require_sha(value: object, field: str) -> str:
    if not isinstance(value, str) or not _SHA_PATTERN.fullmatch(value):
        raise ZaiContextMismatchError(
            f"work context field '{field}' is not a full lowercase 40-hex SHA: {value!r}"
        )
    return value


def _require_session_id(session_id: object) -> str:
    if not isinstance(session_id, str) or not _SESSION_ID_PATTERN.fullmatch(session_id):
        raise ZaiMissingSessionError(
            "resume requires an explicit provider session identifier (URL-safe, "
            "6-128 characters); it is never guessed or defaulted"
        )
    return session_id


def _require_context(context: ZaiWorkerContext, *, repository: str) -> None:
    """Fail closed on a missing/contradictory/stale work context (AC2).

    Runs before any provider I/O: the caller-supplied repository must match
    the adapter's repository binding, the work-item and work-order identity
    must be present, the base SHA must be well-formed, a PR identity must
    carry both its number and its exact head SHA, and review findings must
    be present, non-empty strings.
    """
    if not isinstance(context, ZaiWorkerContext):
        raise ZaiContextMismatchError(
            f"work context must be a ZaiWorkerContext value, not {type(context).__name__}"
        )
    if context.repository != repository:
        raise ZaiContextMismatchError(
            f"work context repository '{context.repository}' does not match the "
            f"adapter's repository binding '{repository}'"
        )
    if not isinstance(context.work_item, str) or not context.work_item:
        raise ZaiContextMismatchError("work context is missing the active work-item identity")
    if not isinstance(context.work_order_path, str) or not context.work_order_path:
        raise ZaiContextMismatchError(
            f"work context for '{context.work_item}' is missing the Work Order reference"
        )
    _require_sha(context.base_sha, "base_sha")
    if context.work_order_content is not None and (
        not isinstance(context.work_order_content, str) or not context.work_order_content
    ):
        raise ZaiContextMismatchError(
            "work order content, when supplied, must be non-empty repository-derived text"
        )
    if context.pr_number is None:
        if context.head_sha is not None:
            raise ZaiContextMismatchError(
                "work context carries a head SHA without a PR number; the PR identity is incomplete"
            )
    else:
        if isinstance(context.pr_number, bool) or not isinstance(context.pr_number, int):
            raise ZaiContextMismatchError("work context PR number must be an integer")
        if context.pr_number <= 0:
            raise ZaiContextMismatchError("work context PR number must be positive")
        _require_sha(context.head_sha, "head_sha")
    for finding in context.review_findings:
        if not isinstance(finding, str) or not finding:
            raise ZaiContextMismatchError(
                "review findings must be non-empty strings; the review packet "
                "is carried verbatim or not at all"
            )


def _require_payload_policy(payload: Mapping[str, object]) -> None:
    """Defense-in-depth check of the constructed worker instruction (AC6).

    The payload is built by the adapter from validated typed inputs, so it
    is controller-approved by construction; this check fails closed if that
    construction ever drifts: unknown fields, or credential-like material
    in any string value, refuse the request before the transport call.
    """
    unknown = set(payload) - _PAYLOAD_ALLOWED_KEYS
    if unknown:
        raise ZaiPolicyViolationError(
            f"worker instruction payload carries fields outside the frozen "
            f"allowlist: {sorted(unknown)}"
        )

    def _scan(value: object) -> None:
        if isinstance(value, str):
            for pattern in _PAYLOAD_FORBIDDEN_PATTERNS:
                if pattern.search(value):
                    raise ZaiPolicyViolationError(
                        "worker instruction payload carries credential-like "
                        "material; credentials never travel in instructions"
                    )
        elif isinstance(value, Mapping):
            for item in value.values():
                _scan(item)
        elif isinstance(value, (list, tuple)):
            for item in value:
                _scan(item)

    _scan(payload)


def _worker_role_payload() -> dict[str, object]:
    """The frozen worker-role contract carried in every instruction."""
    return {
        "may": list(_WORKER_ROLE_MAY),
        "may_not": list(_WORKER_ROLE_MAY_NOT),
    }


def _instruction_payload(
    context: ZaiWorkerContext, *, kind: str, session_id: str | None
) -> dict[str, object]:
    """Build the worker instruction from validated repository-derived facts.

    There is no free-text instruction channel: every value is a typed
    caller input (repository facts, Work Order reference/content, review
    findings) or a frozen role-contract constant, so the adapter can only
    send controller-approved instructions (AC6).
    """
    payload: dict[str, object] = {
        "kind": kind,
        "repository": context.repository,
        "work_item": context.work_item,
        "work_order": {
            "path": context.work_order_path,
            "content": context.work_order_content,
        },
        "base_sha": context.base_sha,
        "review_findings": list(context.review_findings),
        "worker_role": _worker_role_payload(),
    }
    if session_id is not None:
        payload["session_id"] = session_id
    if context.pr_number is not None:
        payload["pr"] = {
            "number": context.pr_number,
            "head_sha": context.head_sha,
        }
    else:
        payload["pr"] = None
    return payload


# ---------------------------------------------------------------------------
# Strict response normalization (AC2/AC4)
# ---------------------------------------------------------------------------


def _as_mapping(value: object, context: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise ZaiMalformedResponseError(f"{context}: expected a JSON object")
    return value


def _require_str(data: Mapping[str, object], key: str, context: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ZaiMalformedResponseError(f"{context}: '{key}' must be a non-empty string")
    return value


def _require_optional_str(data: Mapping[str, object], key: str, context: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ZaiMalformedResponseError(f"{context}: '{key}' must be a string or null")
    return value


def _require_optional_int(data: Mapping[str, object], key: str, context: str) -> int | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ZaiMalformedResponseError(f"{context}: '{key}' must be an integer or null")
    return value


def _require_session_binding(
    session: ZaiWorkerSession, context: ZaiWorkerContext, *, expected_session_id: str | None
) -> None:
    """Bind the provider-reported session to the exact governed context.

    AC3 fork refusal: the session must report the same repository, work
    item, base SHA, and PR identity as the caller-supplied context, and —
    on resume — must be exactly the session the caller named. Any
    mismatch refuses the operation; the adapter never silently continues
    into a different work item, PR, or session.
    """
    mismatches: list[str] = []
    if session.repository != context.repository:
        mismatches.append(f"repository {session.repository!r} != {context.repository!r}")
    if session.work_item != context.work_item:
        mismatches.append(f"work item {session.work_item!r} != {context.work_item!r}")
    if session.base_sha != context.base_sha:
        mismatches.append(f"base SHA {session.base_sha!r} != {context.base_sha!r}")
    if session.pr_number != context.pr_number:
        mismatches.append(f"PR number {session.pr_number!r} != {context.pr_number!r}")
    if session.head_sha != context.head_sha:
        mismatches.append(f"head SHA {session.head_sha!r} != {context.head_sha!r}")
    if mismatches:
        raise ZaiContextMismatchError(
            "provider-reported worker session does not match the governed work "
            f"context ({'; '.join(mismatches)}); refusing to continue into a "
            "different worker/PR context"
        )
    if expected_session_id is not None and session.session_id != expected_session_id:
        raise ZaiContradictionError(
            f"provider returned session {session.session_id!r} while the resume "
            f"targeted session {expected_session_id!r}; the governed execution "
            "identity is contradictory and the operation stops"
        )


# ---------------------------------------------------------------------------
# Adapter operations (AC1/AC3) — the exact worker execution seam, sealed
# with the adapter-issued evidence boundary (FZ-CTRL007-001/002/003/004)
# ---------------------------------------------------------------------------

_T = TypeVar("_T")


def _install_provider_response_path(cls: type[_T]) -> type[_T]:
    """Install the CTRL-004 provider-response operations, with the sealed
    issuance boundary, onto the adapter class (FZ-CTRL007-001/002/003/004).

    The two operations installed here are the one and only issuance path:
    each performs the provider round trip through the injected transport
    and then calls the closure-local ``normalize`` with the transport's
    RESPONSE — never with caller-supplied data. ``normalize`` is not a
    module attribute, not a class attribute, not an instance attribute,
    and is returned to no one: it exists solely as a closure cell of the
    two operation bodies, so reaching the mint requires executing an
    actual provider-response round trip (FZ-CTRL007-004 action 1). The
    class statement below declares the typed surface (the contract); this
    decorator installs the sealed bodies; the placeholder bodies in the
    class statement never execute.

    The pure local check ``verify`` (FZ-CTRL007-004 action 2) is exposed
    to consuming boundaries as ``ZaiAdapter._verify_issuance`` — used by
    :meth:`ZaiIssuedWorkerSession.is_adapter_issued` — a caller may verify
    carried evidence but can never mint new evidence.

    The mint — the runtime capability (a fresh ``object()`` created at
    import inside this closure) and the proof class — exists only inside
    this closure and is returned to no one. It is not repository source
    material, not a module attribute, not importable, and not stored on
    issued values; merely reaching the module grants no path to it. No
    module-level callable accepts provider-report data, ordinary session
    fields, or a session value and produces evidence — the previous
    module-level ``_normalize_session`` binding is gone (FZ-CTRL007-004),
    and the only remaining path demands an actual provider response
    flowing through ``start_worker``/``resume_worker``. The proof also
    binds the exact ordinary fields, so a genuine proof transplanted onto
    different fields fails verification.

    Re-applying this decorator to another adapter-shaped class builds a
    *parallel* universe whose evidence does not verify against this
    boundary's ``_verify_issuance`` — the governing capability and proof
    class are the ones sealed when this module was imported, so a
    parallel invocation is never a forge of real evidence. This is not a
    registry, cache, database, or persistence: the closure holds one
    capability object and one class, creates nothing per issuance beyond
    the value itself, and accumulates no state. Issued evidence is
    in-process by construction (nothing persists sessions — persistence
    is forbidden — and a restart re-issues through the adapter, the only
    issuance path).
    """
    capability = object()

    class _SessionProof:
        """Opaque construction-path evidence binding the exact fields."""

        __slots__ = ("_fields",)
        _fields: tuple[object, ...]

        def __init__(self, cap: object, fields: tuple[object, ...]) -> None:
            if cap is not capability:
                raise ZaiPolicyViolationError(
                    "worker-session evidence can only be sealed inside the "
                    "CTRL-004 adapter's provider-response normalization path; "
                    "the issuance capability is never shared"
                )
            object.__setattr__(self, "_fields", fields)

        def __setattr__(self, name: str, value: object) -> None:
            raise ZaiPolicyViolationError(
                "worker-session evidence proofs are immutable after sealing"
            )

        def __eq__(self, other: object) -> bool:
            return isinstance(other, _SessionProof) and other._fields == self._fields

        def __hash__(self) -> int:
            return hash((_SessionProof, self._fields))

    def normalize(data: object, context: str) -> ZaiIssuedWorkerSession:
        """Normalize one provider worker-execution report into typed
        adapter-issued evidence (strict, deterministic, fail-closed).
        Reachable only from the adapter operations below, and only ever
        with the injected transport's response object (FZ-CTRL007-004)."""
        mapping = _as_mapping(data, context)
        session_id = _require_str(mapping, "session_id", context)
        if not _SESSION_ID_PATTERN.fullmatch(session_id):
            raise ZaiMalformedResponseError(
                f"{context}: session identifier {session_id!r} is malformed"
            )
        repository = _require_str(mapping, "repository", context)
        work_item = _require_str(mapping, "work_item", context)
        base_sha = _require_str(mapping, "base_sha", context)
        pr_number = _require_optional_int(mapping, "pr_number", context)
        head_sha = _require_optional_str(mapping, "head_sha", context)
        status = _require_str(mapping, "status", context)
        updated_at = _require_str(mapping, "updated_at", context)
        fields: tuple[object, ...] = (
            session_id,
            repository,
            work_item,
            base_sha,
            pr_number,
            head_sha,
            status,
            updated_at,
        )
        return ZaiIssuedWorkerSession(
            session_id=session_id,
            repository=repository,
            work_item=work_item,
            base_sha=base_sha,
            pr_number=pr_number,
            head_sha=head_sha,
            status=status,
            updated_at=updated_at,
            _proof=_SessionProof(capability, fields),
        )

    def start_worker(self: ZaiAdapter, context: ZaiWorkerContext) -> ZaiIssuedWorkerSession:
        """Start (or identify) the worker execution for the exact Work Order.

        The context is validated in full (AC2) before any provider I/O; a
        fresh start carries no review packet (findings belong to change
        iterations). The instruction payload is constructed from the
        repository-derived facts plus the frozen worker role; the
        provider-reported session must match the governed context exactly.
        The returned value is **adapter-issued evidence** — the transport's
        response normalized and sealed with its issuance proof right here
        (FZ-CTRL007-001/004) — so downstream boundaries can verify
        provenance locally.
        """
        _require_context(context, repository=self._repository)
        if context.review_findings:
            raise ZaiContextMismatchError(
                "a fresh worker start carries no review packet; review findings "
                "belong to a resume of a change iteration"
            )
        payload = _instruction_payload(context, kind="start_worker", session_id=None)
        _require_payload_policy(payload)
        data = self._transport.post_json("/worker/sessions", payload)
        session = normalize(data, "start worker response")
        _require_session_binding(session, context, expected_session_id=None)
        return session

    def resume_worker(
        self: ZaiAdapter, context: ZaiWorkerContext, session_id: str
    ) -> ZaiIssuedWorkerSession:
        """Resume the same governed worker execution for a change iteration.

        The session identifier is an explicit caller-supplied,
        non-authoritative execution reference — never guessed or defaulted
        (AC3/AC4). The context (including the exact PR identity and the
        applicable review packet) is validated before any provider I/O and
        propagated verbatim in the instruction; the provider-reported
        session must match the governed work item, repository, base, and PR
        identity and must be the session the caller named — a mismatched
        session (a silent fork) or contradictory execution identity refuses
        the operation. Like :meth:`start_worker`, the returned value is
        adapter-issued evidence carrying its issuance proof.
        """
        _require_context(context, repository=self._repository)
        session = _require_session_id(session_id)
        payload = _instruction_payload(context, kind="resume_worker", session_id=session)
        _require_payload_policy(payload)
        data = self._transport.post_json(f"/worker/sessions/{session}/resume", payload)
        reported = normalize(data, "resume worker response")
        _require_session_binding(reported, context, expected_session_id=session)
        return reported

    def verify(proof: object, fields: tuple[object, ...]) -> bool:
        return isinstance(proof, _SessionProof) and proof._fields == fields

    type.__setattr__(cls, "start_worker", start_worker)
    type.__setattr__(cls, "resume_worker", resume_worker)
    type.__setattr__(cls, "_verify_issuance", staticmethod(verify))
    return cls


@_install_provider_response_path
class ZaiAdapter:
    """Typed Z.ai worker provider adapter for one governed repository.

    Exactly two operations exist (AC1): :meth:`start_worker` creates or
    identifies the worker execution for the exact Work Order, and
    :meth:`resume_worker` targets the same governed worker/PR context with
    the applicable review packet. There is deliberately no merge, approval,
    completion, or architecture-mutation capability (AC6). The
    provider-response normalization — the one and only issuance path — is
    sealed onto this class by :func:`_install_provider_response_path`
    (FZ-CTRL007-004): no module-level callable accepts provider-report
    data, and evidence is created only when an actual provider response
    flows through these operations. The operation bodies below are typed
    placeholders; the sealed implementations installed at class
    construction are the real provider-response paths.
    """

    _verify_issuance: ClassVar[Callable[[object, tuple[object, ...]], bool]]

    def __init__(self, transport: ZaiTransport, repository: str) -> None:
        if not isinstance(repository, str) or repository.count("/") != 1:
            raise ZaiConfigurationError(
                f"repository must be formatted 'owner/name', got '{repository}'"
            )
        self._transport = transport
        self._repository = repository

    # -- worker execution (AC1/AC3) ------------------------------------------

    def start_worker(self, context: ZaiWorkerContext) -> ZaiIssuedWorkerSession:
        """Start (or identify) the worker execution for the exact Work Order.

        The context is validated in full (AC2) before any provider I/O; a
        fresh start carries no review packet (findings belong to change
        iterations). The instruction payload is constructed from the
        repository-derived facts plus the frozen worker role; the
        provider-reported session must match the governed context exactly.
        The returned value is **adapter-issued evidence** — the transport's
        response normalized and sealed with its issuance proof
        (FZ-CTRL007-001/004) — so downstream boundaries can verify
        provenance locally.
        """
        raise ZaiPolicyViolationError(
            "the sealed provider-response implementation is installed onto "
            "this class by _install_provider_response_path; this placeholder "
            "never executes"
        )

    def resume_worker(self, context: ZaiWorkerContext, session_id: str) -> ZaiIssuedWorkerSession:
        """Resume the same governed worker execution for a change iteration.

        The session identifier is an explicit caller-supplied,
        non-authoritative execution reference — never guessed or defaulted
        (AC3/AC4). The context (including the exact PR identity and the
        applicable review packet) is validated before any provider I/O and
        propagated verbatim in the instruction; the provider-reported
        session must match the governed work item, repository, base, and PR
        identity and must be the session the caller named — a mismatched
        session (a silent fork) or contradictory execution identity refuses
        the operation. Like :meth:`start_worker`, the returned value is
        adapter-issued evidence carrying its issuance proof.
        """
        raise ZaiPolicyViolationError(
            "the sealed provider-response implementation is installed onto "
            "this class by _install_provider_response_path; this placeholder "
            "never executes"
        )


# ---------------------------------------------------------------------------
# Urllib transport (the only provider network component)
# ---------------------------------------------------------------------------


def _http_error(code: int, body: str, path: str) -> ZaiAdapterError:
    """Map a provider HTTP failure to the typed adapter error taxonomy."""
    excerpt = body.strip()[:200]
    if code in (401, 403):
        return ZaiAuthError(f"{path}: provider rejected authentication ({code})")
    if code == 429:
        return ZaiRateLimitError(f"{path}: provider rate limit exceeded")
    if code >= 500:
        return ZaiTransportError(f"{path}: provider server error ({code}): {excerpt}")
    return ZaiRejectedRequestError(f"{path}: provider refused the request ({code}): {excerpt}")


class UrllibZaiTransport:
    """Standard-library HTTP transport for the Z.ai worker provider.

    The API root and the provider token are constructor-injected only —
    never read from repository files, environment defaults, or module
    state, and never logged. Every failure maps to the typed
    :class:`controller.errors.ZaiAdapterError` family; nothing is retried
    silently.
    """

    def __init__(self, api_root: str, token: str) -> None:
        if not isinstance(api_root, str) or not api_root.startswith(("http://", "https://")):
            raise ZaiConfigurationError(f"api_root must be an http(s) URL, got '{api_root}'")
        if not isinstance(token, str) or not token:
            raise ZaiConfigurationError("provider token must be a non-empty string")
        self._api_root = api_root.rstrip("/")
        self._token = token

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        url = f"{self._api_root}{path}"
        body = json.dumps(dict(payload)).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raise _http_error(exc.code, exc.read().decode("utf-8", "replace"), path) from exc
        except urllib.error.URLError as exc:
            raise ZaiTransportError(f"{path}: provider transport failure: {exc.reason}") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ZaiMalformedResponseError(f"{path}: response is not valid JSON") from exc
