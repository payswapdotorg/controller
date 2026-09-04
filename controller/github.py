"""GitHub adapter boundary (CTRL-003).

The typed seam between the Controller and GitHub. Layering and doctrine:

* **Transport (dependency-injected).** :class:`GithubTransport` is a
  Protocol; :class:`UrllibGithubTransport` is the only network component in
  the whole controller package. Tests inject deterministic fakes, so the
  suite never touches the network and never needs credentials
  (:class:`UrllibGithubTransport` takes a token only as a constructor
  argument — never from repository files or defaults).
* **Observation (AC2).** GitHub JSON is normalized into frozen, typed
  values (:class:`GithubRef`, :class:`GithubCommit`, :class:`GithubReview`,
  :class:`GithubComment`, :class:`GithubCommitStatus`,
  :class:`GithubPullRequest`). Normalization is deterministic: lists are
  sorted by stable IDs, timestamps are preserved verbatim as ISO strings
  (never parsed into mutable clock-dependent types), and equivalent GitHub
  observations produce equal normalized values.
* **Correlation (AC3).** :meth:`GithubAdapter.correlate_work_pull_request`
  ties the active Work Order to exactly one open PR by branch and verifies
  the exact base (and optionally head) SHA. Zero matches, multiple matches
  (one-PR-per-work-item rule), or SHA drift fail closed with typed errors.
* **Repository authority boundary (AC5).** The adapter never reads
  repository authority, keeps no cache, and treats GitHub as evidence —
  never as roadmap/work-order/machine-state authority. Authority-derived
  facts (expected SHAs, work item, machine status) are always caller
  inputs produced from repository authority by the domain layer.
* **Mutations (AC6).** Exactly three, all policy-gated:
  :meth:`create_branch` (explicit base SHA, never a default),
  :meth:`open_pull_request` (refuses to violate the one-PR rule or open
  against a drifted base), and :meth:`merge_pull_request` — which executes
  only after it *independently re-establishes the complete merge-policy
  proof* (FZ-CTRL003-004A, the Architect-accepted execution-time re-proof
  path): the frozen architecture's merge predicate (intended base, exact
  head, one-PR, terminal-success CI for required checks, no unresolved
  blocking review after the Architect's APPROVE, repository machine state
  still identifying the work item as the active eligible item) is
  re-evaluated from live GitHub state plus the authority-derived
  eligibility immediately before the remote mutation. The presented
  :class:`MergeAuthorization` is a merge *request* — the target identity
  to execute against — never evidence: possession of a fabricated or
  altered authorization cannot bypass policy, because policy is
  re-proven from observations the caller cannot fabricate (remote PR,
  review, and check state).
* **Fail closed (AC4).** Every failure — authentication, rate limit,
  missing resource, malformed response, ambiguity, drift, contradiction,
  policy refusal — is a typed :class:`controller.errors.GithubAdapterError`
  subclass. No silent fallback, guessing, retry, or fabricated evidence.

No Z.ai integration, no persistence, no autonomous review, and no
credential material exist here (CTRL-003 non-goals). The worker role
boundary (workerCannotMerge) is governance-enforced: the adapter performs
merge only through the authorization gate, which requires an Architect
APPROVE review observed on GitHub — evidence the worker cannot produce for
its own PR.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, Protocol

from controller.domain import DispatchEligibility
from controller.errors import (
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
)

DEFAULT_API_ROOT = "https://api.github.com"


class GithubTransport(Protocol):
    """Minimal transport contract the adapter depends on (DI seam)."""

    def get_json(self, path: str) -> object:
        """GET a JSON resource; raise typed adapter errors on failure."""
        ...

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        """POST a JSON payload; raise typed adapter errors on failure."""
        ...

    def put_json(self, path: str, payload: Mapping[str, object]) -> object:
        """PUT a JSON payload; raise typed adapter errors on failure."""
        ...


def _http_error(code: int, body: str, path: str) -> GithubAdapterError:
    """Map an HTTP failure to the typed adapter error taxonomy."""
    excerpt = body.strip()[:200]
    if code == 404:
        return GithubNotFoundError(f"{path}: resource not found")
    if code == 429:
        return GithubRateLimitError(f"{path}: rate limit exceeded")
    if code == 403:
        if "rate limit" in body.lower():
            return GithubRateLimitError(f"{path}: rate limit exceeded")
        return GithubAuthError(f"{path}: forbidden ({excerpt})")
    if code == 401:
        return GithubAuthError(f"{path}: unauthorized ({excerpt})")
    return GithubTransportError(f"{path}: HTTP {code} ({excerpt})")


class UrllibGithubTransport:
    """The only network component in the controller package.

    The token is injected via constructor and used solely for the
    Authorization header; it is never read from files, environment, or
    defaults inside the package, and never logged.
    """

    def __init__(
        self,
        api_root: str = DEFAULT_API_ROOT,
        token: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._api_root = api_root.rstrip("/")
        self._token = token
        self._timeout = timeout

    def _request(self, method: str, path: str, payload: Mapping[str, object] | None) -> object:
        url = f"{self._api_root}{path}"
        headers = {"Accept": "application/vnd.github+json"}
        data: bytes | None = None
        if payload is not None:
            data = json.dumps(dict(payload)).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self._token is not None:
            headers["Authorization"] = f"Bearer {self._token}"
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                body = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise _http_error(exc.code, raw, path) from exc
        except urllib.error.URLError as exc:
            raise GithubTransportError(f"{path}: network failure ({exc.reason})") from exc
        except TimeoutError as exc:
            raise GithubTransportError(f"{path}: timed out") from exc
        if not body:
            return {}
        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise GithubMalformedResponseError(f"{path}: response is not JSON") from exc

    def get_json(self, path: str) -> object:
        return self._request("GET", path, None)

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        return self._request("POST", path, payload)

    def put_json(self, path: str, payload: Mapping[str, object]) -> object:
        return self._request("PUT", path, payload)


# ---------------------------------------------------------------------------
# Normalized observation values (AC2)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GithubRef:
    """A branch ref: name plus exact commit SHA."""

    ref_name: str
    sha: str


@dataclass(frozen=True)
class GithubCommit:
    """A commit: SHA, first message line, and parent SHAs."""

    sha: str
    message_first_line: str
    parent_shas: tuple[str, ...]


@dataclass(frozen=True)
class GithubReview:
    """A pull-request review.

    ``commit_id`` is the exact head SHA the review was submitted against
    (GitHub's ``commit_id``); it may be ``None`` when GitHub does not
    report one, in which case the review cannot prove it applies to a
    specific head and the merge gate treats it as not binding
    (fail closed). ``submitted_at`` is the raw ISO string.
    """

    review_id: int
    author: str
    state: str
    submitted_at: str
    commit_id: str | None


@dataclass(frozen=True)
class GithubComment:
    """An issue comment on a pull request. ``created_at`` is the raw ISO string."""

    comment_id: int
    author: str
    created_at: str
    body: str


@dataclass(frozen=True)
class GithubCommitStatus:
    """Combined commit status for one SHA.

    ``statuses`` are (context, state) pairs sorted by context; timestamps
    and other mutable metadata are intentionally not normalized.
    """

    state: str
    total_count: int
    statuses: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class GithubPullRequest:
    """A pull request with the identity fields the controller correlates on.

    ``mergeable_state`` is GitHub's computed mergeability (``clean``,
    ``dirty``, ``unknown``, ...) and may legitimately be ``None`` while
    GitHub computes it; the merge gate treats anything other than ``clean``
    as blocked (fail closed).

    ``merge_commit_sha`` is the merge commit GitHub reports for a merged
    PR (``None`` for an unmerged one). It is observed evidence — the
    exact merge SHA the CTRL-008 reconciliation records — extracted
    verbatim from the same raw pull-request observation as the other
    fields and never synthesized. Normalization stays deterministic:
    equivalent raw observations produce equal normalized values.
    """

    number: int
    state: str
    title: str
    head_ref: str
    head_sha: str
    base_ref: str
    base_sha: str
    draft: bool
    merged: bool
    mergeable_state: str | None
    merge_commit_sha: str | None = None


#: The only merge method the frozen merge predicate ever authorizes.
_POLICY_MERGE_METHOD: Final = "merge"

#: Field names (and expected runtime types) of :class:`MergeAuthorization`.
_AUTHORIZATION_FIELDS: Final[tuple[str, ...]] = (
    "pr_number",
    "work_item",
    "base_ref",
    "base_sha",
    "head_sha",
    "merge_method",
)


@dataclass(frozen=True)
class MergeAuthorization:
    """A merge *request*: the exact target identity of a merge to execute.

    FZ-CTRL003-004A: an authorization is **not** evidence and carries no
    trust. Python offers no construction boundary a caller cannot reach
    (module-private names remain importable), so this type deliberately
    makes no attempt to be an unforgeable capability. Instead,
    :meth:`GithubAdapter.merge_pull_request` independently re-establishes
    the *complete* merge-policy proof from live GitHub state and the
    authority-derived eligibility before any remote mutation, and requires
    the presented authorization to be field-identical to what
    :meth:`GithubAdapter.authorize_merge` would issue right now. A caller
    with access to every public and module symbol can construct this
    value freely — but possession of it cannot bypass policy, because the
    merge only executes when the re-proven predicate (including the
    Architect APPROVE bound to the exact head) actually holds.

    The fields record the exact PR, refs and SHAs, work item, and merge
    method the predicate was evaluated (or will be re-evaluated) against,
    so the executed mutation cannot drift from the evaluated policy.
    Authorizations are in-process values: they are never serialized,
    stored, or reconstructed from external data.
    """

    pr_number: int
    work_item: str
    base_ref: str
    base_sha: str
    head_sha: str
    merge_method: str


def _as_merge_request(authorization: MergeAuthorization) -> MergeAuthorization:
    """Normalize a presented authorization into a well-typed merge request.

    This grants no trust (FZ-CTRL003-004A): it only guarantees that the
    presented object is a structurally complete ``MergeAuthorization``
    value — every field present with the expected non-degenerate type —
    so the execution-time policy re-proof can be evaluated against it.
    A non-authorization object, or a value forged via ``object.__new__``
    with missing or malformed fields, fails closed with
    :class:`GithubAuthorizationForgedError` before any remote call.

    The normalized value is a freshly constructed plain
    ``MergeAuthorization`` built from the extracted fields, so
    subclasses with overridden attribute behavior cannot influence the
    policy evaluation or the later field comparison.
    """
    if not isinstance(authorization, MergeAuthorization):
        raise GithubAuthorizationForgedError(
            f"merge request must be a MergeAuthorization value, not {type(authorization).__name__}"
        )
    pr_number = getattr(authorization, "pr_number", None)
    if isinstance(pr_number, bool) or not isinstance(pr_number, int):
        raise GithubAuthorizationForgedError(
            "merge request field 'pr_number' is missing or not an integer"
        )
    fields: list[str] = []
    for name in _AUTHORIZATION_FIELDS:
        if name == "pr_number":
            continue
        value = getattr(authorization, name, None)
        if not isinstance(value, str) or not value:
            raise GithubAuthorizationForgedError(
                f"merge request field '{name}' is missing or not a non-empty string"
            )
        fields.append(value)
    work_item, base_ref, base_sha, head_sha, merge_method = fields
    return MergeAuthorization(
        pr_number=pr_number,
        work_item=work_item,
        base_ref=base_ref,
        base_sha=base_sha,
        head_sha=head_sha,
        merge_method=merge_method,
    )


# ---------------------------------------------------------------------------
# Strict normalization helpers (AC2/AC4)
# ---------------------------------------------------------------------------


def _as_mapping(value: object, context: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise GithubMalformedResponseError(f"{context}: expected a JSON object")
    return value


def _as_list(value: object, context: str) -> list[object]:
    if not isinstance(value, list):
        raise GithubMalformedResponseError(f"{context}: expected a JSON array")
    return value


def _require_str(data: Mapping[str, object], key: str, context: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise GithubMalformedResponseError(f"{context}: '{key}' must be a non-empty string")
    return value


def _require_optional_str(data: Mapping[str, object], key: str, context: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise GithubMalformedResponseError(f"{context}: '{key}' must be a string or null")
    return value


def _require_int(data: Mapping[str, object], key: str, context: str) -> int:
    value = data.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise GithubMalformedResponseError(f"{context}: '{key}' must be an integer")
    return value


def _require_bool(data: Mapping[str, object], key: str, context: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise GithubMalformedResponseError(f"{context}: '{key}' must be a boolean")
    return value


def _normalize_ref(data: object, context: str) -> GithubRef:
    mapping = _as_mapping(data, context)
    return GithubRef(
        ref_name=_require_str(mapping, "name", context),
        sha=_require_str(
            _as_mapping(mapping.get("commit"), f"{context}.commit"), "sha", f"{context}.commit"
        ),
    )


def _normalize_commit(data: object, context: str) -> GithubCommit:
    mapping = _as_mapping(data, context)
    commit = _as_mapping(mapping.get("commit"), f"{context}.commit")
    message = _require_str(commit, "message", f"{context}.commit.message")
    parents = _as_list(mapping.get("parents"), f"{context}.parents")
    parent_shas = []
    for index, parent in enumerate(parents):
        parent_shas.append(
            _require_str(_as_mapping(parent, f"{context}.parents[{index}]"), "sha", context)
        )
    return GithubCommit(
        sha=_require_str(mapping, "sha", context),
        message_first_line=message.splitlines()[0],
        parent_shas=tuple(parent_shas),
    )


def _normalize_review(data: object, context: str) -> GithubReview:
    mapping = _as_mapping(data, context)
    user = _as_mapping(mapping.get("user"), f"{context}.user")
    return GithubReview(
        review_id=_require_int(mapping, "id", context),
        author=_require_str(user, "login", f"{context}.user"),
        state=_require_str(mapping, "state", context),
        submitted_at=_require_optional_str(mapping, "submitted_at", context) or "",
        commit_id=_require_optional_str(mapping, "commit_id", context),
    )


def _normalize_comment(data: object, context: str) -> GithubComment:
    mapping = _as_mapping(data, context)
    user = _as_mapping(mapping.get("user"), f"{context}.user")
    return GithubComment(
        comment_id=_require_int(mapping, "id", context),
        author=_require_str(user, "login", f"{context}.user"),
        created_at=_require_str(mapping, "created_at", context),
        body=_require_str(mapping, "body", context),
    )


def _normalize_commit_status(data: object, context: str) -> GithubCommitStatus:
    mapping = _as_mapping(data, context)
    statuses = _as_list(mapping.get("statuses"), f"{context}.statuses")
    pairs: list[tuple[str, str]] = []
    for index, entry in enumerate(statuses):
        entry_context = f"{context}.statuses[{index}]"
        entry_mapping = _as_mapping(entry, entry_context)
        pairs.append(
            (
                _require_str(entry_mapping, "context", entry_context),
                _require_str(entry_mapping, "state", entry_context),
            )
        )
    return GithubCommitStatus(
        state=_require_str(mapping, "state", context),
        total_count=_require_int(mapping, "total_count", context),
        statuses=tuple(sorted(pairs)),
    )


def _normalize_pull_request(data: object) -> GithubPullRequest:
    context = "pull request"
    mapping = _as_mapping(data, context)
    head = _as_mapping(mapping.get("head"), f"{context}.head")
    base = _as_mapping(mapping.get("base"), f"{context}.base")
    return GithubPullRequest(
        number=_require_int(mapping, "number", context),
        state=_require_str(mapping, "state", context),
        title=_require_str(mapping, "title", context),
        head_ref=_require_str(head, "ref", f"{context}.head"),
        head_sha=_require_str(head, "sha", f"{context}.head"),
        base_ref=_require_str(base, "ref", f"{context}.base"),
        base_sha=_require_str(base, "sha", f"{context}.base"),
        draft=_require_bool(mapping, "draft", context),
        merged=_merged_flag(mapping, context),
        mergeable_state=_require_optional_str(mapping, "mergeable_state", context),
        merge_commit_sha=_require_optional_str(mapping, "merge_commit_sha", context),
    )


def _merged_flag(mapping: Mapping[str, object], context: str) -> bool:
    """Read the ``merged`` boolean, tolerating GitHub's shape variants.

    The pulls API guarantees ``merged``; list endpoints include it as well.
    A missing or non-boolean value fails closed as malformed.
    """
    value = mapping.get("merged")
    if not isinstance(value, bool):
        raise GithubMalformedResponseError(f"{context}: 'merged' must be a boolean")
    return value


# ---------------------------------------------------------------------------
# The adapter (AC1)
# ---------------------------------------------------------------------------


class GithubAdapter:
    """Typed GitHub adapter for one governed repository.

    Observation, correlation, and policy-gated mutation live here; policy
    *decisions* remain with the controller core (domain/authority layers).
    """

    def __init__(self, transport: GithubTransport, repository: str) -> None:
        if not isinstance(repository, str) or repository.count("/") != 1:
            raise GithubAdapterError(
                f"repository must be formatted 'owner/name', got '{repository}'"
            )
        self._transport = transport
        self._repository = repository
        self._owner = repository.split("/", 1)[0]

    # -- observation (AC2) -------------------------------------------------

    def get_branch(self, branch: str) -> GithubRef:
        data = self._transport.get_json(f"/repos/{self._repository}/branches/{branch}")
        return _normalize_ref(data, f"branch {branch}")

    def get_commit(self, sha: str) -> GithubCommit:
        data = self._transport.get_json(f"/repos/{self._repository}/commits/{sha}")
        return _normalize_commit(data, f"commit {sha[:12]}")

    def get_pull_request(self, number: int) -> GithubPullRequest:
        data = self._transport.get_json(f"/repos/{self._repository}/pulls/{number}")
        return _normalize_pull_request(data)

    def list_pull_requests(
        self, *, state: str, head_branch: str | None = None
    ) -> tuple[GithubPullRequest, ...]:
        path = f"/repos/{self._repository}/pulls?state={state}"
        if head_branch is not None:
            path += f"&head={self._owner}:{head_branch}"
        data = self._transport.get_json(path)
        items = _as_list(data, f"pull requests ({state})")
        prs = [_normalize_pull_request(item) for item in items]
        return tuple(sorted(prs, key=lambda pr: pr.number))

    def get_reviews(self, pr_number: int) -> tuple[GithubReview, ...]:
        data = self._transport.get_json(f"/repos/{self._repository}/pulls/{pr_number}/reviews")
        items = _as_list(data, f"reviews of PR #{pr_number}")
        reviews = [_normalize_review(item, f"review of PR #{pr_number}") for item in items]
        return tuple(sorted(reviews, key=lambda review: review.review_id))

    def get_comments(self, pr_number: int) -> tuple[GithubComment, ...]:
        data = self._transport.get_json(f"/repos/{self._repository}/issues/{pr_number}/comments")
        items = _as_list(data, f"comments of PR #{pr_number}")
        comments = [_normalize_comment(item, f"comment of PR #{pr_number}") for item in items]
        return tuple(sorted(comments, key=lambda comment: comment.comment_id))

    def get_commit_status(self, sha: str) -> GithubCommitStatus:
        data = self._transport.get_json(f"/repos/{self._repository}/commits/{sha}/status")
        return _normalize_commit_status(data, f"commit status {sha[:12]}")

    # -- correlation (AC3) ---------------------------------------------------

    def correlate_work_pull_request(
        self, *, branch: str, base_sha: str, expected_head_sha: str | None = None
    ) -> GithubPullRequest:
        """Correlate the active Work Order to exactly one open PR.

        Fails closed with :class:`GithubNotFoundError` (no PR yet),
        :class:`GithubAmbiguityError` (one-PR-per-work-item violation), or
        :class:`GithubStaleBaseError` (base/head SHA drift).
        """
        matches = self.list_pull_requests(state="open", head_branch=branch)
        if not matches:
            raise GithubNotFoundError(f"no open pull request for work-order branch '{branch}'")
        if len(matches) > 1:
            numbers = ", ".join(str(pr.number) for pr in matches)
            raise GithubAmbiguityError(
                f"one-PR-per-work-item violated: open PRs {numbers} all target branch '{branch}'"
            )
        pr = matches[0]
        if pr.base_sha != base_sha:
            raise GithubStaleBaseError(
                f"PR #{pr.number} base {pr.base_sha} does not match the expected base {base_sha}"
            )
        if expected_head_sha is not None and pr.head_sha != expected_head_sha:
            raise GithubStaleBaseError(
                f"PR #{pr.number} head {pr.head_sha} does not match the "
                f"expected head {expected_head_sha}"
            )
        return pr

    # -- mutations (AC6) -----------------------------------------------------

    def create_branch(self, *, branch: str, from_sha: str) -> GithubRef:
        """Create a work branch at an explicit base SHA.

        The SHA must be supplied by the caller from repository authority —
        it is never defaulted to a remote branch head. Remote failures
        (including an already-existing ref) surface as typed errors.
        """
        payload: dict[str, object] = {"ref": f"refs/heads/{branch}", "sha": from_sha}
        data = self._transport.post_json(f"/repos/{self._repository}/git/refs", payload)
        mapping = _as_mapping(data, "created ref")
        obj = _as_mapping(mapping.get("object"), "created ref.object")
        return GithubRef(
            ref_name=branch,
            sha=_require_str(obj, "sha", "created ref.object"),
        )

    def open_pull_request(
        self,
        *,
        branch: str,
        base_branch: str,
        base_sha: str,
        title: str,
        body: str,
    ) -> GithubPullRequest:
        """Open the one work-order PR, gated by the one-PR rule and base identity.

        Refuses when any open PR already exists for the branch
        (:class:`GithubAmbiguityError`) or when the base branch head does
        not match the authority-derived ``base_sha``
        (:class:`GithubStaleBaseError`).
        """
        existing = self.list_pull_requests(state="open", head_branch=branch)
        if existing:
            raise GithubAmbiguityError(
                f"one-PR-per-work-item violated: open PR #{existing[0].number} "
                f"already exists for branch '{branch}'"
            )
        base_head = self.get_branch(base_branch)
        if base_head.sha != base_sha:
            raise GithubStaleBaseError(
                f"base branch '{base_branch}' head {base_head.sha} does not match "
                f"the expected base {base_sha}"
            )
        payload: dict[str, object] = {
            "title": title,
            "head": branch,
            "base": base_branch,
            "body": body,
        }
        data = self._transport.post_json(f"/repos/{self._repository}/pulls", payload)
        return _normalize_pull_request(data)

    def _require_merge_policy(
        self,
        *,
        pr_number: int,
        work_item: str,
        expected_base_ref: str,
        expected_base_sha: str,
        expected_head_sha: str,
        eligibility: DispatchEligibility,
        architect_reviewer: str,
        required_checks: tuple[str, ...] = (),
    ) -> None:
        """Evaluate the complete frozen merge predicate (AC6), fail-closed.

        This is the *single source of truth* for merge policy in the
        adapter (FZ-CTRL003-004A): :meth:`authorize_merge` evaluates it to
        issue a merge request, and :meth:`merge_pull_request` re-evaluates
        it — in full, from live GitHub state — immediately before the
        remote mutation, so neither caller data nor issuance-time state
        is trusted at execution time.

        GitHub-side checks: PR open, non-draft, unmerged, the intended base
        *ref and SHA*, exact head SHA, mergeable state ``clean``, exactly
        one open PR for the branch, required CI checks terminal-success,
        an APPROVE review by ``architect_reviewer`` **that applies to the
        exact expected head SHA** (the review's ``commit_id`` must match;
        an approval of an older commit does not survive a head change),
        and no CHANGES_REQUESTED review submitted after that approval.

        Repository-side facts are bound through ``eligibility`` — the
        CTRL-002 authority-derived value the domain layer produces from
        repository machine state — which must identify exactly
        ``work_item`` as the active, eligible (READY, not completed) work
        item (FZ-CTRL003-001). GitHub is never the source of this fact.

        Any unsatisfied predicate fails closed with a typed error and
        nothing is auto-repaired or retried.
        """
        pr = self.get_pull_request(pr_number)
        if pr.merged:
            raise GithubMergeBlockedError(f"PR #{pr_number} is already merged")
        if pr.state != "open":
            raise GithubMergeBlockedError(f"PR #{pr_number} is {pr.state}, not open")
        if pr.draft:
            raise GithubMergeBlockedError(f"PR #{pr_number} is a draft")
        if pr.head_sha != expected_head_sha:
            raise GithubStaleBaseError(
                f"PR #{pr_number} head {pr.head_sha} does not match the "
                f"authorized head {expected_head_sha}"
            )
        if pr.base_ref != expected_base_ref:
            raise GithubStaleBaseError(
                f"PR #{pr_number} targets base ref '{pr.base_ref}', not the "
                f"intended base ref '{expected_base_ref}'"
            )
        if pr.base_sha != expected_base_sha:
            raise GithubStaleBaseError(
                f"PR #{pr_number} base {pr.base_sha} does not match the "
                f"authorized base {expected_base_sha}"
            )
        if pr.mergeable_state != "clean":
            raise GithubMergeBlockedError(
                f"PR #{pr_number} mergeable state is {pr.mergeable_state!r}, not 'clean'"
            )
        matches = self.list_pull_requests(state="open", head_branch=pr.head_ref)
        if len(matches) != 1 or matches[0].number != pr.number:
            numbers = ", ".join(str(match.number) for match in matches)
            raise GithubAmbiguityError(
                f"one-PR-per-work-item violated: open PRs ({numbers}) for branch '{pr.head_ref}'"
            )

        status = self.get_commit_status(pr.head_sha)
        for check in required_checks:
            contexts = {context: state for context, state in status.statuses}
            if check not in contexts:
                raise GithubMergeBlockedError(
                    f"required check '{check}' is missing for head {pr.head_sha[:12]}"
                )
            if contexts[check] != "success":
                raise GithubMergeBlockedError(
                    f"required check '{check}' is {contexts[check]}, not success"
                )
        if required_checks and status.state != "success":
            raise GithubMergeBlockedError(
                f"combined commit status is {status.state!r}, not 'success'"
            )

        reviews = self.get_reviews(pr_number)
        approvals = [
            review
            for review in reviews
            if review.author == architect_reviewer and review.state == "APPROVED"
        ]
        if not approvals:
            raise GithubMergeBlockedError(
                f"PR #{pr_number} has no APPROVED review by '{architect_reviewer}'"
            )
        latest_approval = max(approvals, key=lambda review: (review.submitted_at, review.review_id))
        if latest_approval.commit_id != expected_head_sha:
            reported = latest_approval.commit_id or "(unreported)"
            raise GithubMergeBlockedError(
                f"APPROVE review {latest_approval.review_id} applies to commit "
                f"{reported[:12]}, not the current head {expected_head_sha[:12]}; "
                f"the reviewed head must match exactly"
            )
        for review in reviews:
            after = (review.submitted_at, review.review_id) > (
                latest_approval.submitted_at,
                latest_approval.review_id,
            )
            if after and review.state == "CHANGES_REQUESTED":
                raise GithubMergeBlockedError(
                    f"review {review.review_id} (CHANGES_REQUESTED) is unresolved "
                    f"after the latest approval"
                )

        if eligibility.work_item != work_item:
            raise GithubContradictionError(
                f"repository authority identifies '{eligibility.work_item}' as the "
                f"active work item; '{work_item}' is not the active item seeking "
                f"merge authorization"
            )
        if not eligibility.eligible:
            raise GithubContradictionError(
                f"repository authority does not mark '{work_item}' as the active "
                f"eligible item: " + "; ".join(eligibility.basis)
            )

    def authorize_merge(
        self,
        *,
        pr_number: int,
        expected_base_ref: str,
        expected_base_sha: str,
        expected_head_sha: str,
        work_item: str,
        eligibility: DispatchEligibility,
        architect_reviewer: str,
        required_checks: tuple[str, ...] = (),
    ) -> MergeAuthorization:
        """Evaluate the frozen merge predicate (AC6) and record the result.

        Runs the complete policy predicate (:meth:`_require_merge_policy`)
        against live GitHub state and the authority-derived eligibility.
        Any unsatisfied predicate fails closed with a typed error and no
        authorization is issued. Nothing is auto-repaired or retried.

        The returned :class:`MergeAuthorization` is a merge *request* —
        the exact target identity the predicate was evaluated against.
        It is not evidence of anything: :meth:`merge_pull_request`
        re-establishes the complete policy proof at execution time
        (FZ-CTRL003-004A), so issuing (or fabricating) this value never
        substitutes for the predicate actually holding at execution.
        """
        self._require_merge_policy(
            pr_number=pr_number,
            work_item=work_item,
            expected_base_ref=expected_base_ref,
            expected_base_sha=expected_base_sha,
            expected_head_sha=expected_head_sha,
            eligibility=eligibility,
            architect_reviewer=architect_reviewer,
            required_checks=required_checks,
        )
        return MergeAuthorization(
            pr_number=pr_number,
            work_item=work_item,
            base_ref=expected_base_ref,
            base_sha=expected_base_sha,
            head_sha=expected_head_sha,
            merge_method=_POLICY_MERGE_METHOD,
        )

    def merge_pull_request(
        self,
        authorization: MergeAuthorization,
        *,
        eligibility: DispatchEligibility,
        architect_reviewer: str,
        required_checks: tuple[str, ...] = (),
    ) -> GithubPullRequest:
        """Execute a governed merge by re-proving policy at execution time.

        FZ-CTRL003-004A (Architect-accepted resolution path 2): the
        presented ``authorization`` is a merge *request* — target
        identity, never evidence. Possession of a fabricated or altered
        authorization cannot bypass policy, because this method
        *independently re-establishes the complete merge-policy proof*
        before any remote mutation:

        1. The request is normalized (:func:`_as_merge_request`); a
           non-authorization object or an incomplete forgery fails closed
           with :class:`GithubAuthorizationForgedError`.
        2. The complete frozen predicate
           (:meth:`_require_merge_policy`) is re-evaluated **in full**
           from live GitHub state — PR open/non-draft/unmerged, intended
           base ref and SHA, exact head, clean mergeability, one-PR,
           required CI checks, an Architect APPROVE bound to the exact
           head with no later CHANGES_REQUESTED — plus the
           authority-derived ``eligibility`` identifying the work item
           as the active eligible item. Any failure is a typed refusal
           with zero remote mutations.
        3. The request must be field-identical to what
           :meth:`authorize_merge` would issue right now for that
           target — in particular the merge method. A mismatch fails
           closed with :class:`GithubAuthorizationForgedError`.

        Policy parameters (``eligibility``, ``architect_reviewer``,
        ``required_checks``) are execution-time inputs, deliberately not
        carried in the authorization: everything that gates the merge is
        re-supplied and re-verified here, so nothing in the presented
        object can weaken the re-proof.

        The worker role (Z.ai) must never call this method — enforcement
        of that role rule is governance plus the predicate, which
        requires an Architect APPROVE review observed on GitHub, bound
        to the exact head SHA, evidence the worker cannot produce for
        its own PR.
        """
        request = _as_merge_request(authorization)
        self._require_merge_policy(
            pr_number=request.pr_number,
            work_item=request.work_item,
            expected_base_ref=request.base_ref,
            expected_base_sha=request.base_sha,
            expected_head_sha=request.head_sha,
            eligibility=eligibility,
            architect_reviewer=architect_reviewer,
            required_checks=required_checks,
        )
        reissued = MergeAuthorization(
            pr_number=request.pr_number,
            work_item=request.work_item,
            base_ref=request.base_ref,
            base_sha=request.base_sha,
            head_sha=request.head_sha,
            merge_method=_POLICY_MERGE_METHOD,
        )
        if request != reissued:
            raise GithubAuthorizationForgedError(
                "presented authorization is not identical to the freshly "
                "re-established merge-policy proof (e.g. a merge method "
                f"other than '{_POLICY_MERGE_METHOD}'); it cannot command "
                "this merge"
            )
        payload: dict[str, object] = {
            "sha": request.head_sha,
            "merge_method": request.merge_method,
        }
        data = self._transport.put_json(
            f"/repos/{self._repository}/pulls/{request.pr_number}/merge", payload
        )
        mapping = _as_mapping(data, "merge result")
        if not _require_bool(mapping, "merged", "merge result"):
            raise GithubMergeBlockedError(f"GitHub refused the merge of PR #{request.pr_number}")
        return self.get_pull_request(request.pr_number)
