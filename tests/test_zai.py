"""Unit tests: the CTRL-004 Z.ai worker adapter boundary.

All behavior is exercised against deterministic fakes — no network, no
credentials, no live provider access (AC7). Covers: the typed transport
contract, exact work-context binding before provider I/O (AC2), resume
identity and fork refusal (AC3), fail-closed provider errors (AC4), the
repository authority boundary (AC5), the worker safety boundary (AC6),
deterministic normalization, and domain compatibility.
"""

from __future__ import annotations

import dataclasses
import inspect
import unittest

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
from controller.zai import DEFAULT_API_ROOT as ZAI_ROOT
from controller.zai import (
    UrllibZaiTransport,
    ZaiWorkerContext,
    _http_error,
    _normalize_session,
    _require_payload_policy,
)
from controller.zai import (
    ZaiAdapter as Adapter,
)
from tests.util import REPO_ROOT
from tests.zai_fakes import (
    BASE_SHA,
    HEAD_SHA,
    REPO,
    SESSION_ID,
    START_PATH,
    WORK_ITEM,
    WORK_ORDER,
    FakeZaiTransport,
    resume_path,
    worker_session,
)


def _context(
    work_item: str = WORK_ITEM,
    repository: str = REPO,
    work_order_path: str = WORK_ORDER,
    base_sha: str = BASE_SHA,
    work_order_content: str | None = None,
    pr_number: int | None = None,
    head_sha: str | None = None,
    review_findings: tuple[str, ...] = (),
) -> ZaiWorkerContext:
    return ZaiWorkerContext(
        repository=repository,
        work_item=work_item,
        work_order_path=work_order_path,
        base_sha=base_sha,
        work_order_content=work_order_content,
        pr_number=pr_number,
        head_sha=head_sha,
        review_findings=review_findings,
    )


class TransportErrorMappingTests(unittest.TestCase):
    """AC4: provider HTTP failures map to the typed error taxonomy."""

    def test_401_maps_to_auth_error(self) -> None:
        self.assertIsInstance(_http_error(401, "Unauthorized", "/x"), ZaiAuthError)

    def test_403_maps_to_auth_error(self) -> None:
        self.assertIsInstance(_http_error(403, "Forbidden", "/x"), ZaiAuthError)

    def test_429_maps_to_rate_limit(self) -> None:
        self.assertIsInstance(_http_error(429, "Too Many Requests", "/x"), ZaiRateLimitError)

    def test_5xx_maps_to_transport_error(self) -> None:
        self.assertIsInstance(_http_error(502, "Bad Gateway", "/x"), ZaiTransportError)

    def test_other_4xx_maps_to_rejected_request(self) -> None:
        self.assertIsInstance(_http_error(422, "Unprocessable", "/x"), ZaiRejectedRequestError)

    def test_all_mappings_are_adapter_errors(self) -> None:
        for code in (400, 401, 403, 404, 409, 422, 429, 500, 502, 503):
            self.assertIsInstance(_http_error(code, "body", "/x"), ZaiAdapterError)

    def test_transport_configuration_requires_http_root(self) -> None:
        with self.assertRaises(ZaiConfigurationError):
            UrllibZaiTransport("not-a-url", "token")

    def test_transport_configuration_requires_token(self) -> None:
        with self.assertRaises(ZaiConfigurationError):
            UrllibZaiTransport("https://api.z.ai", "")

    def test_default_api_root_is_zai(self) -> None:
        transport = UrllibZaiTransport("https://api.z.ai", "provider-token")
        self.assertEqual(transport._api_root, "https://api.z.ai")
        self.assertEqual(ZAI_ROOT, "https://api.z.ai")

    def test_adapter_rejects_malformed_repository(self) -> None:
        with self.assertRaises(ZaiConfigurationError):
            Adapter(FakeZaiTransport(), "pectoraux")


class ContextBindingTests(unittest.TestCase):
    """AC2: a missing/contradictory/stale context is rejected before I/O."""

    def _adapter(self) -> tuple[Adapter, FakeZaiTransport]:
        transport = FakeZaiTransport({START_PATH: worker_session()})
        return Adapter(transport, REPO), transport

    def test_wrong_repository_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(repository="other/owner"))
        self.assertEqual(transport.calls, [])

    def test_missing_work_item_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(work_item=""))
        self.assertEqual(transport.calls, [])

    def test_missing_work_order_reference_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(work_order_path=""))
        self.assertEqual(transport.calls, [])

    def test_malformed_base_sha_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(base_sha="short"))
        self.assertEqual(transport.calls, [])

    def test_uppercase_base_sha_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(base_sha="A" * 40))
        self.assertEqual(transport.calls, [])

    def test_pr_without_head_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(pr_number=7))
        self.assertEqual(transport.calls, [])

    def test_head_without_pr_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(head_sha=HEAD_SHA))
        self.assertEqual(transport.calls, [])

    def test_empty_review_finding_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(review_findings=("",)))
        self.assertEqual(transport.calls, [])

    def test_non_context_object_is_refused_before_io(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker("CTRL-004")  # type: ignore[arg-type]
        self.assertEqual(transport.calls, [])

    def test_start_with_review_packet_is_refused(self) -> None:
        """A fresh start carries no review packet; findings belong to a
        resume of a change iteration (AC2/AC3)."""
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiContextMismatchError):
            adapter.start_worker(_context(review_findings=("FZ-1",)))
        self.assertEqual(transport.calls, [])

    def test_resume_requires_session_identity(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiMissingSessionError):
            adapter.resume_worker(_context(pr_number=7, head_sha=HEAD_SHA), "")
        self.assertEqual(transport.calls, [])

    def test_resume_rejects_malformed_session_identity(self) -> None:
        adapter, transport = self._adapter()
        with self.assertRaises(ZaiMissingSessionError):
            adapter.resume_worker(_context(pr_number=7, head_sha=HEAD_SHA), "bad id!")
        self.assertEqual(transport.calls, [])


class StartWorkerTests(unittest.TestCase):
    """AC1/AC2: start semantics over the exact Work Order context."""

    def test_start_issues_worker_session_for_exact_context(self) -> None:
        transport = FakeZaiTransport({START_PATH: worker_session()})
        session = Adapter(transport, REPO).start_worker(_context(work_order_content="# order"))
        self.assertEqual(session.session_id, SESSION_ID)
        self.assertEqual(session.work_item, WORK_ITEM)
        self.assertEqual(session.repository, REPO)
        self.assertEqual(session.base_sha, BASE_SHA)
        self.assertIsNone(session.pr_number)
        self.assertIsNone(session.head_sha)
        self.assertEqual(session.status, "active")
        self.assertEqual(session.updated_at, "2026-09-04T15:00:00Z")
        self.assertEqual(len(transport.calls_matching(START_PATH)), 1)

    def test_start_payload_carries_repository_facts_and_role_contract(self) -> None:
        transport = FakeZaiTransport({START_PATH: worker_session()})
        Adapter(transport, REPO).start_worker(_context(work_order_content="# frozen order"))
        path, payload = transport.calls[0]
        self.assertEqual(path, START_PATH)
        self.assertEqual(payload["kind"], "start_worker")
        self.assertEqual(payload["repository"], REPO)
        self.assertEqual(payload["work_item"], WORK_ITEM)
        self.assertEqual(
            payload["work_order"],
            {"path": WORK_ORDER, "content": "# frozen order"},
        )
        self.assertEqual(payload["base_sha"], BASE_SHA)
        self.assertIsNone(payload["pr"])
        self.assertEqual(payload["review_findings"], [])
        role = payload["worker_role"]
        assert isinstance(role, dict)
        self.assertIn("merge pull requests", role["may_not"])
        self.assertIn("respond to review findings", role["may"])

    def test_start_payload_omits_session_id(self) -> None:
        transport = FakeZaiTransport({START_PATH: worker_session()})
        Adapter(transport, REPO).start_worker(_context())
        self.assertNotIn("session_id", transport.calls[0][1])

    def test_start_refuses_provider_reported_foreign_work_item(self) -> None:
        """AC2/AC5: a provider session for a different work context is a
        contradiction, not a success."""
        transport = FakeZaiTransport({START_PATH: worker_session(work_item="CTRL-005")})
        with self.assertRaises(ZaiContextMismatchError):
            Adapter(transport, REPO).start_worker(_context())
        self.assertEqual(len(transport.calls), 1)

    def test_start_refuses_provider_reported_drifted_base(self) -> None:
        transport = FakeZaiTransport({START_PATH: worker_session(base_sha="c" * 40)})
        with self.assertRaises(ZaiContextMismatchError):
            Adapter(transport, REPO).start_worker(_context())

    def test_start_missing_session_id_in_response(self) -> None:
        response = worker_session()
        del response["session_id"]
        transport = FakeZaiTransport({START_PATH: response})
        with self.assertRaises(ZaiMalformedResponseError):
            Adapter(transport, REPO).start_worker(_context())

    def test_start_malformed_response_types(self) -> None:
        cases: list[dict[str, object]] = [
            {**worker_session(), "pr_number": "7"},
            {**worker_session(), "status": ""},
            {**worker_session(), "work_item": 4},
            {**worker_session(), "updated_at": None},
        ]
        for response in cases:
            with self.subTest(response=response):
                transport = FakeZaiTransport({START_PATH: response})
                with self.assertRaises(ZaiMalformedResponseError):
                    Adapter(transport, REPO).start_worker(_context())

    def test_start_non_object_response(self) -> None:
        transport = FakeZaiTransport({START_PATH: ["not", "an", "object"]})
        with self.assertRaises(ZaiMalformedResponseError):
            Adapter(transport, REPO).start_worker(_context())


class ResumeWorkerTests(unittest.TestCase):
    """AC3: resume targets the same governed worker/PR context."""

    def _pr_context(
        self, findings: tuple[str, ...] = ("FZ-CTRL004-001: fix X",)
    ) -> ZaiWorkerContext:
        return _context(pr_number=7, head_sha=HEAD_SHA, review_findings=findings)

    def test_resume_targets_the_named_session_with_exact_context(self) -> None:
        transport = FakeZaiTransport(
            {resume_path(): worker_session(pr_number=7, head_sha=HEAD_SHA, status="resumed")}
        )
        session = Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)
        self.assertEqual(session.session_id, SESSION_ID)
        self.assertEqual(session.pr_number, 7)
        self.assertEqual(session.head_sha, HEAD_SHA)
        self.assertEqual(len(transport.calls_matching(resume_path())), 1)

    def test_resume_propagates_review_packet_verbatim(self) -> None:
        """AC3: the applicable review packet is never dropped, filtered,
        or reordered — findings travel to the provider exactly as given."""
        findings = ("FZ-CTRL004-001: HIGH — binding gap", "FZ-CTRL004-002: LOW — docs")
        transport = FakeZaiTransport(
            {resume_path(): worker_session(pr_number=7, head_sha=HEAD_SHA)}
        )
        Adapter(transport, REPO).resume_worker(
            _context(pr_number=7, head_sha=HEAD_SHA, review_findings=findings), SESSION_ID
        )
        payload = transport.calls[0][1]
        self.assertEqual(
            payload["review_findings"],
            ["FZ-CTRL004-001: HIGH — binding gap", "FZ-CTRL004-002: LOW — docs"],
        )

    def test_resume_payload_carries_session_and_pr_context(self) -> None:
        transport = FakeZaiTransport(
            {resume_path(): worker_session(pr_number=7, head_sha=HEAD_SHA)}
        )
        Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)
        path, payload = transport.calls[0]
        self.assertEqual(path, resume_path())
        self.assertEqual(payload["kind"], "resume_worker")
        self.assertEqual(payload["session_id"], SESSION_ID)
        self.assertEqual(payload["pr"], {"number": 7, "head_sha": HEAD_SHA})

    def test_resume_without_findings_is_allowed(self) -> None:
        """A mid-implementation session recovery may carry no new review
        packet; the context identity still binds exactly."""
        transport = FakeZaiTransport(
            {resume_path(): worker_session(pr_number=7, head_sha=HEAD_SHA)}
        )
        session = Adapter(transport, REPO).resume_worker(
            _context(pr_number=7, head_sha=HEAD_SHA), SESSION_ID
        )
        self.assertEqual(session.session_id, SESSION_ID)

    def test_resume_refuses_provider_fork_to_different_work_item(self) -> None:
        """AC3 duplicate/fork refusal: the provider session belongs to a
        different work item — the adapter never silently continues."""
        transport = FakeZaiTransport(
            {resume_path(): worker_session(pr_number=7, head_sha=HEAD_SHA, work_item="CTRL-003")}
        )
        with self.assertRaises(ZaiContextMismatchError):
            Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)

    def test_resume_refuses_provider_fork_to_different_pr(self) -> None:
        transport = FakeZaiTransport(
            {resume_path(): worker_session(pr_number=9, head_sha=HEAD_SHA)}
        )
        with self.assertRaises(ZaiContextMismatchError):
            Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)

    def test_resume_refuses_provider_fork_to_headless_session(self) -> None:
        transport = FakeZaiTransport({resume_path(): worker_session()})
        with self.assertRaises(ZaiContextMismatchError):
            Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)

    def test_resume_refuses_contradictory_execution_identity(self) -> None:
        """The provider returned a different session than the one the
        resume targeted — the governed execution identity is contradictory
        (AC4/AC5) and the operation stops."""
        other = "zai-sess-999"
        transport = FakeZaiTransport(
            {resume_path(): worker_session(session_id=other, pr_number=7, head_sha=HEAD_SHA)}
        )
        with self.assertRaises(ZaiContradictionError):
            Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)

    def test_resume_refuses_malformed_provider_session_id(self) -> None:
        transport = FakeZaiTransport(
            {resume_path(): worker_session(session_id="bad id!", pr_number=7, head_sha=HEAD_SHA)}
        )
        with self.assertRaises(ZaiMalformedResponseError):
            Adapter(transport, REPO).resume_worker(self._pr_context(), SESSION_ID)


class WorkerSafetyTests(unittest.TestCase):
    """AC6: the adapter cannot merge, approve, or complete work."""

    def test_adapter_exposes_exactly_start_and_resume(self) -> None:
        """No merge/approve/complete/mutate capability exists on the
        adapter — the worker safety boundary is structural."""
        public = {
            name
            for name in dir(Adapter)
            if not name.startswith("_") and callable(getattr(Adapter, name, None))
        }
        self.assertEqual(public, {"start_worker", "resume_worker"})

    def test_worker_context_has_no_free_text_instruction_channel(self) -> None:
        """Every context field is a typed repository fact or a review
        packet; instructions are constructed by the adapter, so callers
        cannot inject arbitrary directives."""
        fields = {f.name for f in dataclasses.fields(ZaiWorkerContext)}
        self.assertEqual(
            fields,
            {
                "repository",
                "work_item",
                "work_order_path",
                "base_sha",
                "work_order_content",
                "pr_number",
                "head_sha",
                "review_findings",
            },
        )

    def test_payload_policy_refuses_unknown_fields(self) -> None:
        with self.assertRaises(ZaiPolicyViolationError):
            _require_payload_policy({"kind": "start_worker", "merge_method": "squash"})

    def test_payload_policy_refuses_credential_material(self) -> None:
        with self.assertRaises(ZaiPolicyViolationError):
            _require_payload_policy(
                {"kind": "start_worker", "work_order": {"content": "use ghp_" + "A" * 30}}
            )

    def test_payload_policy_accepts_the_frozen_instruction_shape(self) -> None:
        _require_payload_policy(
            {
                "kind": "start_worker",
                "repository": REPO,
                "work_item": WORK_ITEM,
                "work_order": {"path": WORK_ORDER, "content": None},
                "base_sha": BASE_SHA,
                "pr": None,
                "review_findings": ["FZ-1: finding text mentioning merge gating"],
                "worker_role": {
                    "may": ["respond to review findings"],
                    "may_not": ["merge pull requests"],
                },
            }
        )


class AuthorityBoundaryTests(unittest.TestCase):
    """AC5: repository authority is caller-supplied; the adapter never
    reads files, keeps no state, and stops on provider contradiction."""

    def test_adapter_never_takes_repository_paths_or_files(self) -> None:
        for method in (Adapter.__init__, Adapter.start_worker, Adapter.resume_worker):
            signature = inspect.signature(method)
            self.assertNotIn("repo_root", signature.parameters)
            self.assertNotIn("path", " ".join(signature.parameters))
            self.assertNotIn("root", " ".join(signature.parameters))

    def test_adapter_holds_only_transport_and_repository(self) -> None:
        """No session registry or cache: the adapter keeps no runtime
        authoritative state (AC5 — non-persistence)."""
        adapter = Adapter(FakeZaiTransport(), REPO)
        self.assertEqual(
            {name for name in vars(adapter)},
            {"_transport", "_repository"},
        )

    def test_provider_contradiction_stops_the_operation(self) -> None:
        """A provider report contradicting repository-derived context is
        never repaired, retried, or guessed past (AC4/AC5)."""
        transport = FakeZaiTransport({START_PATH: worker_session(base_sha="d" * 40)})
        with self.assertRaises(ZaiContextMismatchError):
            Adapter(transport, REPO).start_worker(_context())
        self.assertEqual(len(transport.calls), 1)


class DeterminismTests(unittest.TestCase):
    """AC7: equivalent provider reports normalize to equal values."""

    def test_equivalent_responses_produce_equal_sessions(self) -> None:
        first = _normalize_session(worker_session(), "a")
        second = _normalize_session(worker_session(), "b")
        self.assertEqual(first, second)
        self.assertEqual(hash(first), hash(second))

    def test_sessions_are_frozen_values(self) -> None:
        session = _normalize_session(worker_session(), "a")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            session.status = "finished"  # type: ignore[misc]


class DomainCompatibilityTests(unittest.TestCase):
    """AC8: the context binds to real repository authority (CTRL-002 domain
    reconstruction) and the adapter reuses the typed error taxonomy."""

    def test_real_repository_context_starts_a_worker(self) -> None:
        from controller.domain import reconstruct_domain

        item = reconstruct_domain(REPO_ROOT)
        context = ZaiWorkerContext(
            repository=item.identity.repository,
            work_item=item.identity.work_item,
            work_order_path=item.identity.work_order_path,
            base_sha="a" * 40,
        )
        transport = FakeZaiTransport(
            {
                START_PATH: worker_session(
                    repository=item.identity.repository,
                    work_item=item.identity.work_item,
                )
            }
        )
        session = Adapter(transport, item.identity.repository).start_worker(context)
        self.assertEqual(session.work_item, item.identity.work_item)

    def test_zai_errors_are_controller_errors(self) -> None:
        from controller.errors import ControllerError

        for error in (
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
        ):
            self.assertTrue(issubclass(error, ControllerError))


if __name__ == "__main__":
    unittest.main()
