"""Deterministic GitHub transport fakes and fixture builders (CTRL-003).

No network, no credentials: the fake transport serves canned JSON per API
path, records every call for path/payload assertions, and raises the same
typed adapter errors a real transport would raise for HTTP failures.
"""

from __future__ import annotations

from collections.abc import Mapping

from controller.errors import GithubAdapterError

REPO = "pectoraux/controller"
OWNER = "pectoraux"
BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40


class FakeTransport:
    """In-memory GithubTransport: canned responses, recorded calls, errors."""

    def __init__(
        self,
        responses: Mapping[str, object] | None = None,
        raise_for: Mapping[str, GithubAdapterError] | None = None,
    ) -> None:
        self._responses: dict[str, object] = dict(responses or {})
        self._raise_for: dict[str, GithubAdapterError] = dict(raise_for or {})
        self.calls: list[tuple[str, str, Mapping[str, object] | None]] = []

    def get_json(self, path: str) -> object:
        return self._serve("GET", path, None)

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        return self._serve("POST", path, payload)

    def put_json(self, path: str, payload: Mapping[str, object]) -> object:
        return self._serve("PUT", path, payload)

    def _serve(self, method: str, path: str, payload: Mapping[str, object] | None) -> object:
        self.calls.append((method, path, payload))
        if path in self._raise_for:
            raise self._raise_for[path]
        if path not in self._responses:
            raise GithubAdapterError(f"fake transport: no canned response for {path}")
        return self._responses[path]

    def calls_matching(
        self, method: str, prefix: str
    ) -> list[tuple[str, str, Mapping[str, object] | None]]:
        return [c for c in self.calls if c[0] == method and c[1].startswith(prefix)]


# ---------------------------------------------------------------------------
# Fixture builders: minimal, internally consistent GitHub-shaped JSON.
# ---------------------------------------------------------------------------


def ref(branch: str = "main", sha: str = "a" * 40) -> dict[str, object]:
    return {"name": branch, "commit": {"sha": sha}}


def created_ref(branch: str, sha: str) -> dict[str, object]:
    return {
        "ref": f"refs/heads/{branch}",
        "object": {"sha": sha, "type": "commit"},
    }


def commit(sha: str, message: str, parents: list[str]) -> dict[str, object]:
    return {
        "sha": sha,
        "commit": {"message": message},
        "parents": [{"sha": parent} for parent in parents],
    }


def review(
    review_id: int,
    author: str = "pectoraux",
    state: str = "APPROVED",
    submitted_at: str = "2026-09-04T10:00:00Z",
    commit_id: str | None = HEAD_SHA,
) -> dict[str, object]:
    return {
        "id": review_id,
        "user": {"login": author},
        "state": state,
        "submitted_at": submitted_at,
        "commit_id": commit_id,
    }


def comment(
    comment_id: int,
    author: str = "pectoraux",
    created_at: str = "2026-09-04T10:00:00Z",
    body: str = "comment body",
) -> dict[str, object]:
    return {
        "id": comment_id,
        "user": {"login": author},
        "created_at": created_at,
        "body": body,
    }


def commit_status(
    state: str = "success",
    statuses: list[tuple[str, str]] | None = None,
) -> dict[str, object]:
    entries = statuses or []
    return {
        "state": state,
        "total_count": len(entries),
        "statuses": [
            {"context": context, "state": status_state} for context, status_state in entries
        ],
    }


def pull_request(
    number: int = 7,
    state: str = "open",
    title: str = "CTRL-003 — GitHub adapter",
    head_branch: str = "ctrl-003-github-adapter",
    head_sha: str = "b" * 40,
    base_branch: str = "main",
    base_sha: str = "a" * 40,
    draft: bool = False,
    merged: bool = False,
    mergeable_state: str | None = "clean",
) -> dict[str, object]:
    return {
        "number": number,
        "state": state,
        "title": title,
        "head": {"ref": head_branch, "sha": head_sha},
        "base": {"ref": base_branch, "sha": base_sha},
        "draft": draft,
        "merged": merged,
        "mergeable_state": mergeable_state,
    }


def merge_success(pr_number: int = 7) -> dict[str, object]:
    return {
        "merged": True,
        "message": f"Pull Request #{pr_number} successfully merged",
        "sha": "c" * 40,
    }


def adapter_responses(
    prs: list[dict[str, object]] | None = None,
    pr: dict[str, object] | None = None,
    reviews: list[dict[str, object]] | None = None,
    status: dict[str, object] | None = None,
    base_ref: dict[str, object] | None = None,
    merge_result: dict[str, object] | None = None,
) -> dict[str, object]:
    """Build a coherent response map for the common PR correlation scenario."""
    prs = prs if prs is not None else ([pr] if pr is not None else [])
    single = pr if pr is not None else (prs[0] if prs else None)
    responses: dict[str, object] = {}
    if single is not None:
        head = single["head"]
        assert isinstance(head, dict)
        number = single["number"]
        head_branch = head["ref"]
        head_sha = head["sha"]
        responses[f"/repos/{REPO}/pulls/{number}"] = single
        responses[f"/repos/{REPO}/pulls?state=open&head={OWNER}:{head_branch}"] = prs
        responses[f"/repos/{REPO}/pulls/{number}/reviews"] = (
            reviews if reviews is not None else [review(11, state="APPROVED")]
        )
        if status is not None:
            responses[f"/repos/{REPO}/commits/{head_sha}/status"] = status
        if merge_result is not None:
            responses[f"/repos/{REPO}/pulls/{number}/merge"] = merge_result
    if base_ref is not None:
        responses[f"/repos/{REPO}/branches/{base_ref['name']}"] = base_ref
    return responses
