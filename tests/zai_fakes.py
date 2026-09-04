"""Deterministic Z.ai provider fakes and fixture builders (CTRL-004).

No network, no credentials: the fake transport serves canned JSON per
request path, records every call for payload assertions, and raises the
same typed adapter errors a real provider transport would raise for HTTP
failures.
"""

from __future__ import annotations

from collections.abc import Mapping

from controller.errors import ZaiAdapterError

REPO = "pectoraux/controller"
WORK_ITEM = "CTRL-004"
WORK_ORDER = "spec/work-items/CTRL-004.md"
BASE_SHA = "a" * 40
HEAD_SHA = "b" * 40
SESSION_ID = "zai-sess-001"


class FakeZaiTransport:
    """In-memory ZaiTransport: canned responses, recorded calls, errors."""

    def __init__(
        self,
        responses: Mapping[str, object] | None = None,
        raise_for: Mapping[str, ZaiAdapterError] | None = None,
    ) -> None:
        self._responses: dict[str, object] = dict(responses or {})
        self._raise_for: dict[str, ZaiAdapterError] = dict(raise_for or {})
        self.calls: list[tuple[str, Mapping[str, object]]] = []

    def post_json(self, path: str, payload: Mapping[str, object]) -> object:
        self.calls.append((path, payload))
        if path in self._raise_for:
            raise self._raise_for[path]
        if path not in self._responses:
            raise ZaiAdapterError(f"fake transport: no canned response for {path}")
        return self._responses[path]

    def calls_matching(self, prefix: str) -> list[tuple[str, Mapping[str, object]]]:
        return [c for c in self.calls if c[0].startswith(prefix)]


# ---------------------------------------------------------------------------
# Fixture builders: minimal, internally consistent provider-shaped JSON.
# ---------------------------------------------------------------------------


def worker_session(
    session_id: str = SESSION_ID,
    repository: str = REPO,
    work_item: str = WORK_ITEM,
    base_sha: str = BASE_SHA,
    pr_number: int | None = None,
    head_sha: str | None = None,
    status: str = "active",
    updated_at: str = "2026-09-04T15:00:00Z",
) -> dict[str, object]:
    return {
        "session_id": session_id,
        "repository": repository,
        "work_item": work_item,
        "base_sha": base_sha,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "status": status,
        "updated_at": updated_at,
    }


START_PATH = "/worker/sessions"


def resume_path(session_id: str = SESSION_ID) -> str:
    return f"/worker/sessions/{session_id}/resume"
