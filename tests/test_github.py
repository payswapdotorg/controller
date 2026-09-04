"""Unit tests: the CTRL-003 GitHub adapter boundary.

All behavior is exercised against deterministic fakes — no network, no
credentials, no live GitHub access (AC7). Covers: typed contract,
deterministic normalization, work-order correlation, fail-closed remote
errors, policy-gated mutations, the merge authorization gate (including
the FZ-CTRL003-004 non-forgeable capability invariant), and domain
compatibility.
"""

from __future__ import annotations

import ast
import copy
import dataclasses
import unittest

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
from controller.github import GithubAdapter as Adapter
from controller.github import (
    MergeAuthorization,
    UrllibGithubTransport,
    _http_error,
    _normalize_pull_request,
)
from tests.github_fakes import (
    BASE_SHA,
    HEAD_SHA,
    REPO,
    FakeTransport,
    adapter_responses,
    comment,
    commit,
    commit_status,
    created_ref,
    merge_success,
    pull_request,
    ref,
    review,
)
from tests.util import REPO_ROOT

ARCHITECT = "pectoraux"


def _eligible(
    work_item: str = "CTRL-003",
    eligible: bool = True,
    basis: tuple[str, ...] = ("machine state and work-order status agree",),
) -> DispatchEligibility:
    """Authority-derived eligibility fixture (CTRL-002 typed value)."""
    return DispatchEligibility(
        work_item=work_item, eligible=eligible, basis=basis or ("fixture basis",)
    )


class TransportErrorMappingTests(unittest.TestCase):
    """AC4: HTTP failures map to the typed error taxonomy (pure function)."""

    def test_404_maps_to_not_found(self) -> None:
        self.assertIsInstance(_http_error(404, "Not Found", "/x"), GithubNotFoundError)

    def test_401_maps_to_auth_error(self) -> None:
        self.assertIsInstance(_http_error(401, "Bad credentials", "/x"), GithubAuthError)

    def test_plain_403_maps_to_auth_error(self) -> None:
        self.assertIsInstance(_http_error(403, "Forbidden", "/x"), GithubAuthError)

    def test_rate_limited_403_maps_to_rate_limit(self) -> None:
        error = _http_error(403, "API rate limit exceeded", "/x")
        self.assertIsInstance(error, GithubRateLimitError)

    def test_429_maps_to_rate_limit(self) -> None:
        self.assertIsInstance(_http_error(429, "Too Many Requests", "/x"), GithubRateLimitError)

    def test_5xx_maps_to_transport_error(self) -> None:
        self.assertIsInstance(_http_error(502, "Bad Gateway", "/x"), GithubTransportError)

    def test_all_mappings_are_adapter_errors(self) -> None:
        for code in (400, 401, 403, 404, 422, 429, 500, 502):
            self.assertIsInstance(_http_error(code, "body", "/x"), GithubAdapterError)

    def test_default_api_root_is_github(self) -> None:
        transport = UrllibGithubTransport()
        self.assertEqual(transport._api_root, "https://api.github.com")

    def test_token_defaults_to_unauthenticated(self) -> None:
        transport = UrllibGithubTransport()
        self.assertIsNone(transport._token)


class NormalizationTests(unittest.TestCase):
    """AC2: deterministic, strictly validated normalization."""

    def test_pull_request_normalization_is_deterministic(self) -> None:
        first = _normalize_pull_request(pull_request())
        second = _normalize_pull_request(pull_request())
        self.assertEqual(first, second)

    def test_pull_request_fields_are_typed(self) -> None:
        pr = _normalize_pull_request(pull_request())
        self.assertIsInstance(pr.number, int)
        self.assertIsInstance(pr.head_sha, str)
        self.assertIsInstance(pr.draft, bool)
        self.assertEqual(pr.mergeable_state, "clean")

    def test_mergeable_state_none_is_preserved_not_defaulted(self) -> None:
        pr = _normalize_pull_request(pull_request(mergeable_state=None))
        self.assertIsNone(pr.mergeable_state)

    def test_commit_message_is_first_line_only(self) -> None:
        data = commit("a" * 40, "subject line\n\nbody text", [])
        from controller.github import GithubCommit, _normalize_commit

        normalized = _normalize_commit(data, "commit")
        self.assertEqual(normalized.message_first_line, "subject line")
        self.assertIsInstance(normalized, GithubCommit)
        self.assertEqual(normalized.parent_shas, ())

    def test_commit_parents_are_ordered_tuples(self) -> None:
        from controller.github import _normalize_commit

        data = commit("a" * 40, "subject", ["1" * 40, "2" * 40])
        normalized = _normalize_commit(data, "commit")
        self.assertEqual(normalized.parent_shas, ("1" * 40, "2" * 40))

    def test_status_contexts_are_sorted(self) -> None:
        from controller.github import _normalize_commit_status

        data = commit_status(
            "success", [("zeta", "success"), ("alpha", "success"), ("mid", "success")]
        )
        normalized = _normalize_commit_status(data, "status")
        self.assertEqual(
            normalized.statuses,
            (("alpha", "success"), ("mid", "success"), ("zeta", "success")),
        )

    def test_reviews_preserve_iso_timestamps_as_strings(self) -> None:
        from controller.github import _normalize_review

        normalized = _normalize_review(review(3, submitted_at="2026-09-04T11:31:42Z"), "review")
        self.assertEqual(normalized.submitted_at, "2026-09-04T11:31:42Z")

    def test_malformed_pull_request_fails_closed(self) -> None:
        bad_cases: list[object] = [
            "not a dict",
            {},
            {"number": 1, "state": "open", "title": "t", "head": {}, "base": {}},
            pull_request() | {"number": "seven"},
            pull_request() | {"draft": "no"},
            pull_request() | {"head": {"ref": "x"}},  # head.sha missing
        ]
        for bad in bad_cases:
            with self.subTest(bad=bad):
                with self.assertRaises(GithubMalformedResponseError):
                    _normalize_pull_request(bad)

    def test_malformed_review_fails_closed(self) -> None:
        from controller.github import _normalize_review

        with self.assertRaises(GithubMalformedResponseError):
            _normalize_review({"id": 1, "state": "APPROVED"}, "review")

    def test_malformed_status_fails_closed(self) -> None:
        from controller.github import _normalize_commit_status

        with self.assertRaises(GithubMalformedResponseError):
            _normalize_commit_status({"state": "success", "total_count": "two"}, "status")


class ObservationTests(unittest.TestCase):
    """AC2: observation through the fake transport; correct API paths."""

    def test_get_branch(self) -> None:
        transport = FakeTransport({f"/repos/{REPO}/branches/main": ref("main", BASE_SHA)})
        branch = Adapter(transport, REPO).get_branch("main")
        self.assertEqual((branch.ref_name, branch.sha), ("main", BASE_SHA))
        self.assertIn(("GET", f"/repos/{REPO}/branches/main", None), transport.calls)

    def test_get_commit(self) -> None:
        transport = FakeTransport(
            {f"/repos/{REPO}/commits/{HEAD_SHA}": commit(HEAD_SHA, "subject\nbody", [BASE_SHA])}
        )
        observed = Adapter(transport, REPO).get_commit(HEAD_SHA)
        self.assertEqual(
            (observed.sha, observed.message_first_line, observed.parent_shas),
            (HEAD_SHA, "subject", (BASE_SHA,)),
        )

    def test_get_reviews_sorted_by_id(self) -> None:
        path = f"/repos/{REPO}/pulls/7/reviews"
        transport = FakeTransport({path: [review(12), review(10), review(11)]})
        reviews = Adapter(transport, REPO).get_reviews(7)
        self.assertEqual([r.review_id for r in reviews], [10, 11, 12])

    def test_get_comments_sorted_by_id(self) -> None:
        path = f"/repos/{REPO}/issues/7/comments"
        transport = FakeTransport({path: [comment(31), comment(30)]})
        comments = Adapter(transport, REPO).get_comments(7)
        self.assertEqual([c.comment_id for c in comments], [30, 31])

    def test_list_pull_requests_sorted_by_number(self) -> None:
        prs = [pull_request(9), pull_request(7), pull_request(8)]
        path = f"/repos/{REPO}/pulls?state=open&head={REPO.split('/')[0]}:ctrl-003-github-adapter"
        transport = FakeTransport({path: prs})
        listed = Adapter(transport, REPO).list_pull_requests(
            state="open", head_branch="ctrl-003-github-adapter"
        )
        self.assertEqual([pr.number for pr in listed], [7, 8, 9])

    def test_not_found_propagates(self) -> None:
        transport = FakeTransport(
            raise_for={f"/repos/{REPO}/branches/x": GithubNotFoundError("404")}
        )
        with self.assertRaises(GithubNotFoundError):
            Adapter(transport, REPO).get_branch("x")

    def test_transport_failure_propagates_fail_closed(self) -> None:
        transport = FakeTransport(
            raise_for={f"/repos/{REPO}/pulls/7": GithubTransportError("boom")}
        )
        with self.assertRaises(GithubTransportError):
            Adapter(transport, REPO).get_pull_request(7)

    def test_malformed_list_response_fails_closed(self) -> None:
        path = f"/repos/{REPO}/pulls?state=open"
        transport = FakeTransport({path: {"not": "a list"}})
        with self.assertRaises(GithubMalformedResponseError):
            Adapter(transport, REPO).list_pull_requests(state="open")

    def test_repeated_observation_is_equal(self) -> None:
        transport = FakeTransport(adapter_responses(pr=pull_request()))
        adapter = Adapter(transport, REPO)
        self.assertEqual(adapter.get_pull_request(7), adapter.get_pull_request(7))


class CorrelationTests(unittest.TestCase):
    """AC3: exact identity correlation, fail closed on drift/ambiguity."""

    def _transport(self, prs: list[dict[str, object]]) -> FakeTransport:
        return FakeTransport(adapter_responses(prs=prs, pr=prs[0] if prs else None))

    def test_single_match_with_exact_base_returns_pr(self) -> None:
        pr = pull_request(base_sha=BASE_SHA, head_sha=HEAD_SHA)
        adapter = Adapter(self._transport([pr]), REPO)
        correlated = adapter.correlate_work_pull_request(
            branch="ctrl-003-github-adapter", base_sha=BASE_SHA
        )
        self.assertEqual(correlated.number, 7)

    def test_head_drift_fails_closed(self) -> None:
        pr = pull_request(base_sha=BASE_SHA, head_sha=HEAD_SHA)
        adapter = Adapter(self._transport([pr]), REPO)
        with self.assertRaises(GithubStaleBaseError):
            adapter.correlate_work_pull_request(
                branch="ctrl-003-github-adapter", base_sha=BASE_SHA, expected_head_sha="d" * 40
            )

    def test_base_drift_fails_closed(self) -> None:
        pr = pull_request(base_sha=BASE_SHA)
        adapter = Adapter(self._transport([pr]), REPO)
        with self.assertRaises(GithubStaleBaseError):
            adapter.correlate_work_pull_request(branch="ctrl-003-github-adapter", base_sha="9" * 40)

    def test_no_pr_yet_fails_closed(self) -> None:
        transport = FakeTransport(
            {f"/repos/{REPO}/pulls?state=open&head=pectoraux:ctrl-003-github-adapter": []}
        )
        with self.assertRaises(GithubNotFoundError):
            Adapter(transport, REPO).correlate_work_pull_request(
                branch="ctrl-003-github-adapter", base_sha=BASE_SHA
            )

    def test_two_prs_violate_one_pr_rule(self) -> None:
        prs = [pull_request(7), pull_request(8)]
        with self.assertRaises(GithubAmbiguityError):
            Adapter(self._transport(prs), REPO).correlate_work_pull_request(
                branch="ctrl-003-github-adapter", base_sha=BASE_SHA
            )


class MutationTests(unittest.TestCase):
    """AC6: policy-gated mutations; explicit identity; no bypasses."""

    def test_create_branch_posts_explicit_ref_and_sha(self) -> None:
        transport = FakeTransport({f"/repos/{REPO}/git/refs": created_ref("wip-branch", BASE_SHA)})
        created = Adapter(transport, REPO).create_branch(branch="wip-branch", from_sha=BASE_SHA)
        self.assertEqual((created.ref_name, created.sha), ("wip-branch", BASE_SHA))
        post_calls = transport.calls_matching("POST", f"/repos/{REPO}/git/refs")
        self.assertEqual(len(post_calls), 1)
        method, path, payload = post_calls[0]
        assert payload is not None
        self.assertEqual(payload["ref"], "refs/heads/wip-branch")
        self.assertEqual(payload["sha"], BASE_SHA)

    def test_open_pull_request_enforces_one_pr_rule(self) -> None:
        existing = pull_request(3, head_branch="busy-branch")
        transport = FakeTransport(adapter_responses(prs=[existing], pr=existing))
        with self.assertRaises(GithubAmbiguityError):
            Adapter(transport, REPO).open_pull_request(
                branch="busy-branch",
                base_branch="main",
                base_sha=BASE_SHA,
                title="t",
                body="b",
            )

    def test_open_pull_request_refuses_stale_base(self) -> None:
        transport = FakeTransport(
            {
                f"/repos/{REPO}/pulls?state=open&head=pectoraux:fresh-branch": [],
                f"/repos/{REPO}/branches/main": ref("main", "9" * 40),
            }
        )
        with self.assertRaises(GithubStaleBaseError):
            Adapter(transport, REPO).open_pull_request(
                branch="fresh-branch",
                base_branch="main",
                base_sha=BASE_SHA,
                title="t",
                body="b",
            )

    def test_open_pull_request_happy_path(self) -> None:
        new_pr = pull_request(head_branch="fresh-branch")
        transport = FakeTransport(
            {
                f"/repos/{REPO}/pulls?state=open&head=pectoraux:fresh-branch": [],
                f"/repos/{REPO}/branches/main": ref("main", BASE_SHA),
                f"/repos/{REPO}/pulls": new_pr,
            }
        )
        opened = Adapter(transport, REPO).open_pull_request(
            branch="fresh-branch",
            base_branch="main",
            base_sha=BASE_SHA,
            title="CTRL-003 — GitHub adapter",
            body="transcript",
        )
        self.assertEqual(opened.number, 7)
        post_calls = transport.calls_matching("POST", f"/repos/{REPO}/pulls")
        self.assertEqual(len(post_calls), 1)
        _, _, payload = post_calls[0]
        assert payload is not None
        self.assertEqual(payload["head"], "fresh-branch")
        self.assertEqual(payload["base"], "main")

    def test_remote_failure_on_mutation_fails_closed(self) -> None:
        transport = FakeTransport(
            raise_for={f"/repos/{REPO}/git/refs": GithubTransportError("422 reference exists")}
        )
        with self.assertRaises(GithubTransportError):
            Adapter(transport, REPO).create_branch(branch="x", from_sha=BASE_SHA)


def _merge_ready_transport(
    *,
    pr: dict[str, object] | None = None,
    reviews: list[dict[str, object]] | None = None,
    status: dict[str, object] | None = None,
) -> FakeTransport:
    pr = pr or pull_request(base_sha=BASE_SHA, head_sha=HEAD_SHA)
    reviews = reviews if reviews is not None else [review(11, state="APPROVED")]
    return FakeTransport(
        adapter_responses(
            prs=[pr], pr=pr, reviews=reviews, status=status or commit_status("success", [])
        )
    )


class MergeGateTests(unittest.TestCase):
    """AC6: the frozen merge predicate, evaluated fail-closed."""

    def _authorize(
        self,
        transport: FakeTransport,
        *,
        expected_base_ref: str = "main",
        expected_base_sha: str = BASE_SHA,
        expected_head_sha: str = HEAD_SHA,
        eligibility: DispatchEligibility | None = None,
        required_checks: tuple[str, ...] = (),
    ) -> MergeAuthorization:
        adapter = Adapter(transport, REPO)
        return adapter.authorize_merge(
            pr_number=7,
            expected_base_ref=expected_base_ref,
            expected_base_sha=expected_base_sha,
            expected_head_sha=expected_head_sha,
            work_item="CTRL-003",
            eligibility=eligibility or _eligible(),
            architect_reviewer=ARCHITECT,
            required_checks=required_checks,
        )

    def _authorize_with_status(
        self,
        status: dict[str, object],
        *,
        eligibility: DispatchEligibility | None = None,
        required_checks: tuple[str, ...] = (),
    ) -> MergeAuthorization:
        return self._authorize(
            _merge_ready_transport(status=status),
            eligibility=eligibility,
            required_checks=required_checks,
        )

    def test_happy_path_issues_authorization(self) -> None:
        authorization = self._authorize(_merge_ready_transport())
        self.assertEqual(authorization.pr_number, 7)
        self.assertEqual(authorization.head_sha, HEAD_SHA)
        self.assertEqual(authorization.base_ref, "main")
        self.assertEqual(authorization.base_sha, BASE_SHA)
        self.assertEqual(authorization.work_item, "CTRL-003")
        self.assertEqual(authorization.merge_method, "merge")

    def test_merged_pr_is_blocked(self) -> None:
        pr = pull_request(merged=True)
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(pr=pr))

    def test_closed_pr_is_blocked(self) -> None:
        pr = pull_request(state="closed")
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(pr=pr))

    def test_draft_pr_is_blocked(self) -> None:
        pr = pull_request(draft=True)
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(pr=pr))

    def test_head_drift_is_blocked(self) -> None:
        with self.assertRaises(GithubStaleBaseError):
            self._authorize(_merge_ready_transport(), expected_head_sha="d" * 40)

    def test_base_drift_is_blocked(self) -> None:
        with self.assertRaises(GithubStaleBaseError):
            self._authorize(_merge_ready_transport(), expected_base_sha="9" * 40)

    def test_base_retarget_to_foreign_ref_at_same_sha_is_blocked(self) -> None:
        """FZ-CTRL003-003: a PR retargeted to another ref at the identical
        SHA must not be authorizable against an intended 'main' base."""
        pr = pull_request(base_branch="develop", base_sha=BASE_SHA)
        with self.assertRaises(GithubStaleBaseError):
            self._authorize(_merge_ready_transport(pr=pr))

    def test_dirty_mergeable_state_is_blocked(self) -> None:
        pr = pull_request(mergeable_state="dirty")
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(pr=pr))

    def test_unknown_mergeable_state_is_blocked(self) -> None:
        pr = pull_request(mergeable_state=None)
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(pr=pr))

    def test_one_pr_violation_is_blocked(self) -> None:
        pr = pull_request()
        second = pull_request(8, head_branch="ctrl-003-github-adapter")
        transport = FakeTransport(
            adapter_responses(prs=[pr, second], pr=pr, reviews=[review(11, state="APPROVED")])
        )
        with self.assertRaises(GithubAmbiguityError):
            self._authorize(transport)

    def test_missing_architect_approval_is_blocked(self) -> None:
        transport = _merge_ready_transport(reviews=[review(11, state="COMMENTED")])
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(transport)

    def test_unresolved_changes_requested_after_approval_is_blocked(self) -> None:
        reviews = [
            review(10, state="APPROVED", submitted_at="2026-09-04T10:00:00Z"),
            review(11, state="CHANGES_REQUESTED", submitted_at="2026-09-04T11:00:00Z"),
        ]
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(reviews=reviews))

    def test_changes_requested_before_approval_is_not_blocking(self) -> None:
        reviews = [
            review(10, state="CHANGES_REQUESTED", submitted_at="2026-09-04T09:00:00Z"),
            review(11, state="APPROVED", submitted_at="2026-09-04T10:00:00Z"),
        ]
        authorization = self._authorize(_merge_ready_transport(reviews=reviews))
        self.assertEqual(authorization.pr_number, 7)

    def test_approval_of_older_head_does_not_authorize_new_head(self) -> None:
        """FZ-CTRL003-002: an APPROVE submitted against an earlier commit
        must not survive a head change — the gate requires the review's
        commit_id to equal the exact expected head SHA."""
        reviews = [
            review(10, state="APPROVED", submitted_at="2026-09-04T09:00:00Z", commit_id="old" * 10),
            review(11, state="APPROVED", submitted_at="2026-09-04T10:00:00Z", commit_id=HEAD_SHA),
        ]
        # The LATEST approval (id 11) applies to the current head: passes.
        authorization = self._authorize(_merge_ready_transport(reviews=reviews))
        self.assertEqual(authorization.pr_number, 7)

    def test_approval_only_for_old_commit_is_blocked(self) -> None:
        """FZ-CTRL003-002 (core case): the only Architect APPROVE was
        submitted for an older head; the current head is unauthorized."""
        reviews = [
            review(10, state="APPROVED", submitted_at="2026-09-04T09:00:00Z", commit_id="old" * 10)
        ]
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(reviews=reviews))

    def test_approval_without_reported_commit_is_blocked(self) -> None:
        """FZ-CTRL003-002: an APPROVE that does not report commit identity
        cannot prove it applies to the head — fail closed."""
        reviews = [
            review(10, state="APPROVED", submitted_at="2026-09-04T10:00:00Z", commit_id=None)
        ]
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize(_merge_ready_transport(reviews=reviews))

    def test_head_change_after_approval_fails_closed_end_to_end(self) -> None:
        """FZ-CTRL003-002 (scenario): approval exists for the reviewed head;
        a later head change makes authorization fail closed."""
        pr_new_head = pull_request(head_sha="f" * 40)
        transport = FakeTransport(
            adapter_responses(
                prs=[pr_new_head],
                pr=pr_new_head,
                reviews=[review(10, state="APPROVED", commit_id=HEAD_SHA)],
            )
        )
        with self.assertRaises(GithubStaleBaseError):
            self._authorize(transport)  # expected_head_sha defaults to the old head

    def test_approval_commit_id_is_normalized(self) -> None:
        from controller.github import _normalize_review

        normalized = _normalize_review(review(10, commit_id=HEAD_SHA), "review")
        self.assertEqual(normalized.commit_id, HEAD_SHA)
        no_commit = _normalize_review(review(10, commit_id=None), "review")
        self.assertIsNone(no_commit.commit_id)

    def test_failing_required_check_is_blocked(self) -> None:
        status = commit_status("failure", [("ci/tests", "failure")])
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize_with_status(status, required_checks=("ci/tests",))

    def test_missing_required_check_is_blocked(self) -> None:
        status = commit_status("pending", [])
        with self.assertRaises(GithubMergeBlockedError):
            self._authorize_with_status(status, required_checks=("ci/required",))

    def test_passing_required_check_issues_authorization(self) -> None:
        status = commit_status("success", [("ci/tests", "success")])
        authorization = self._authorize_with_status(status, required_checks=("ci/tests",))
        self.assertEqual(authorization.pr_number, 7)

    def test_machine_state_not_eligible_is_a_contradiction(self) -> None:
        ineligible = _eligible(eligible=False, basis=("lifecycle state is COMPLETE, not READY",))
        with self.assertRaises(GithubContradictionError):
            self._authorize(_merge_ready_transport(), eligibility=ineligible)

    def test_different_active_item_cannot_authorize(self) -> None:
        """FZ-CTRL003-001: authority naming a different active work item
        must not authorize a merge for this PR's work item."""
        foreign = _eligible(work_item="CTRL-004")
        with self.assertRaises(GithubContradictionError):
            self._authorize(_merge_ready_transport(), eligibility=foreign)

    def test_contradiction_error_names_both_items(self) -> None:
        foreign = _eligible(work_item="CTRL-004")
        with self.assertRaises(GithubContradictionError) as ctx:
            self._authorize(_merge_ready_transport(), eligibility=foreign)
        message = str(ctx.exception)
        self.assertIn("CTRL-004", message)
        self.assertIn("CTRL-003", message)

    def test_merge_executes_with_exact_sha_and_method(self) -> None:
        pr = pull_request(base_sha=BASE_SHA, head_sha=HEAD_SHA)
        transport = FakeTransport(
            adapter_responses(
                prs=[pr],
                pr=pr,
                reviews=[review(11, state="APPROVED")],
                status=commit_status("success", []),
                merge_result=merge_success(7),
            )
        )
        adapter = Adapter(transport, REPO)
        authorization = adapter.authorize_merge(
            pr_number=7,
            expected_base_ref="main",
            expected_base_sha=BASE_SHA,
            expected_head_sha=HEAD_SHA,
            work_item="CTRL-003",
            eligibility=_eligible(),
            architect_reviewer=ARCHITECT,
        )
        merged = adapter.merge_pull_request(authorization)
        put_calls = transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge")
        self.assertEqual(len(put_calls), 1)
        _, _, payload = put_calls[0]
        assert payload is not None
        self.assertEqual(payload["sha"], HEAD_SHA)
        self.assertEqual(payload["merge_method"], "merge")
        self.assertEqual(merged.number, 7)

    def test_merge_refuses_head_drift_since_authorization(self) -> None:
        """FZ-CTRL003-004: authorizations must be *issued* by the gate —
        stale-state tests now use a genuinely issued authorization and
        drift the GitHub state between issuance and execution."""
        authorization = self._authorize(_merge_ready_transport())
        moved = pull_request(base_sha=BASE_SHA, head_sha="e" * 40)
        execute_transport = FakeTransport(
            adapter_responses(prs=[moved], pr=moved, reviews=[review(11, state="APPROVED")])
        )
        with self.assertRaises(GithubStaleBaseError):
            Adapter(execute_transport, REPO).merge_pull_request(authorization)
        self.assertEqual(
            execute_transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge"), []
        )

    def test_merge_refuses_base_retarget_since_authorization(self) -> None:
        """FZ-CTRL003-003: execution-time refusal when the PR is retargeted
        to another base ref after authorization (issued, not forged)."""
        authorization = self._authorize(_merge_ready_transport())
        retargeted = pull_request(base_branch="develop", base_sha=BASE_SHA, head_sha=HEAD_SHA)
        execute_transport = FakeTransport(
            adapter_responses(
                prs=[retargeted], pr=retargeted, reviews=[review(11, state="APPROVED")]
            )
        )
        with self.assertRaises(GithubStaleBaseError):
            Adapter(execute_transport, REPO).merge_pull_request(authorization)
        self.assertEqual(
            execute_transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge"), []
        )

    def test_merge_refuses_closed_pr_since_authorization(self) -> None:
        """Execution-time refusal when the PR was closed (not merged) after
        authorization."""
        authorization = self._authorize(_merge_ready_transport())
        closed = pull_request(state="closed", merged=False)
        execute_transport = FakeTransport(adapter_responses(prs=[], pr=closed, reviews=[]))
        with self.assertRaises(GithubMergeBlockedError):
            Adapter(execute_transport, REPO).merge_pull_request(authorization)
        self.assertEqual(
            execute_transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge"), []
        )

    def test_merge_refuses_already_merged_pr(self) -> None:
        authorization = self._authorize(_merge_ready_transport())
        merged_pr = pull_request(merged=True)
        execute_transport = FakeTransport(adapter_responses(prs=[], pr=merged_pr, reviews=[]))
        with self.assertRaises(GithubMergeBlockedError):
            Adapter(execute_transport, REPO).merge_pull_request(authorization)
        self.assertEqual(
            execute_transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge"), []
        )

    def test_merge_refuses_when_github_declines(self) -> None:
        pr = pull_request(base_sha=BASE_SHA, head_sha=HEAD_SHA)
        transport = FakeTransport(
            adapter_responses(
                prs=[pr],
                pr=pr,
                reviews=[review(11, state="APPROVED")],
                status=commit_status("success", []),
                merge_result={"merged": False, "message": "Pull Request is not mergeable"},
            )
        )
        adapter = Adapter(transport, REPO)
        authorization = adapter.authorize_merge(
            pr_number=7,
            expected_base_ref="main",
            expected_base_sha=BASE_SHA,
            expected_head_sha=HEAD_SHA,
            work_item="CTRL-003",
            eligibility=_eligible(),
            architect_reviewer=ARCHITECT,
        )
        with self.assertRaises(GithubMergeBlockedError):
            adapter.merge_pull_request(authorization)


class AuthorizationCapabilityTests(unittest.TestCase):
    """FZ-CTRL003-004: MergeAuthorization is a non-forgeable capability.

    ``merge_pull_request`` must execute only with an authorization issued
    by ``authorize_merge``. A caller-manufactured — even structurally
    valid — authorization, or one altered after issuance, fails closed
    with ``GithubAuthorizationForgedError`` before any remote mutation.
    """

    def _issue(self) -> tuple[Adapter, FakeTransport, MergeAuthorization]:
        """Issue a genuine authorization over a merge-ready fake GitHub."""
        transport = FakeTransport(
            adapter_responses(
                prs=[pull_request()],
                pr=pull_request(),
                reviews=[review(11, state="APPROVED")],
                status=commit_status("success", []),
                merge_result=merge_success(7),
            )
        )
        adapter = Adapter(transport, REPO)
        authorization = adapter.authorize_merge(
            pr_number=7,
            expected_base_ref="main",
            expected_base_sha=BASE_SHA,
            expected_head_sha=HEAD_SHA,
            work_item="CTRL-003",
            eligibility=_eligible(),
            architect_reviewer=ARCHITECT,
        )
        return adapter, transport, authorization

    def test_authorize_merge_issues_valid_authorization(self) -> None:
        adapter, transport, authorization = self._issue()
        self.assertEqual(authorization.pr_number, 7)
        self.assertEqual(authorization.work_item, "CTRL-003")
        self.assertEqual(authorization.base_ref, "main")
        self.assertEqual(authorization.base_sha, BASE_SHA)
        self.assertEqual(authorization.head_sha, HEAD_SHA)
        self.assertEqual(authorization.merge_method, "merge")
        merged = adapter.merge_pull_request(authorization)
        self.assertEqual(merged.number, 7)
        self.assertEqual(len(transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge")), 1)

    def test_caller_constructed_authorization_fails_closed(self) -> None:
        """Required test 2: structurally valid caller-created data cannot
        even construct an authorization — construction itself fails."""
        with self.assertRaises(GithubAuthorizationForgedError):
            MergeAuthorization(
                pr_number=7,
                work_item="CTRL-003",
                base_ref="main",
                base_sha=BASE_SHA,
                head_sha=HEAD_SHA,
                merge_method="merge",
            )

    def test_structurally_valid_forgery_cannot_execute(self) -> None:
        """Required test 2 (core): an object built via ``object.__new__``
        with all public fields set bypasses ``__init__`` entirely — and
        still cannot cause ``merge_pull_request`` to execute."""
        adapter, transport, _ = self._issue()
        forged = object.__new__(MergeAuthorization)
        object.__setattr__(forged, "pr_number", 7)
        object.__setattr__(forged, "work_item", "CTRL-003")
        object.__setattr__(forged, "base_ref", "main")
        object.__setattr__(forged, "base_sha", BASE_SHA)
        object.__setattr__(forged, "head_sha", HEAD_SHA)
        object.__setattr__(forged, "merge_method", "merge")
        with self.assertRaises(GithubAuthorizationForgedError):
            adapter.merge_pull_request(forged)
        self.assertEqual(transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge"), [])

    def test_forged_proof_attribute_cannot_execute(self) -> None:
        """A forged object that also carries a bogus ``_proof`` value is
        refused the same way."""
        adapter, transport, _ = self._issue()
        forged = object.__new__(MergeAuthorization)
        object.__setattr__(forged, "pr_number", 7)
        object.__setattr__(forged, "work_item", "CTRL-003")
        object.__setattr__(forged, "base_ref", "main")
        object.__setattr__(forged, "base_sha", BASE_SHA)
        object.__setattr__(forged, "head_sha", HEAD_SHA)
        object.__setattr__(forged, "merge_method", "merge")
        object.__setattr__(forged, "_proof", object())
        with self.assertRaises(GithubAuthorizationForgedError):
            adapter.merge_pull_request(forged)
        self.assertEqual(transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge"), [])

    def test_altered_authorization_fails_closed(self) -> None:
        """``dataclasses.replace`` on a genuine authorization changes the
        public fields but not the proof — tamper detection fails closed."""
        _, _, authorization = self._issue()
        with self.assertRaises(GithubAuthorizationForgedError):
            dataclasses.replace(authorization, head_sha="e" * 40)

    def test_issued_authorization_copy_remains_valid(self) -> None:
        """Capability semantics: copying an authorization you already
        hold transfers it within the process; it forges nothing (the
        copy is field-identical and carries the same genuine proof)."""
        adapter, transport, authorization = self._issue()
        duplicate = copy.copy(authorization)
        merged = adapter.merge_pull_request(duplicate)
        self.assertEqual(merged.number, 7)
        self.assertEqual(len(transport.calls_matching("PUT", f"/repos/{REPO}/pulls/7/merge")), 1)

    def test_equivalent_issuance_produces_equal_authorizations(self) -> None:
        """Determinism: two identical gate evaluations produce equal
        authorization values (the opaque proof never affects equality)."""
        _, _, first = self._issue()
        _, _, second = self._issue()
        self.assertEqual(first, second)
        self.assertEqual(hash(first), hash(second))


def _github_tree() -> ast.Module:
    return ast.parse((REPO_ROOT / "controller" / "github.py").read_text(encoding="utf-8"))


def _adapter_methods(tree: ast.Module) -> dict[str, ast.FunctionDef]:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "GithubAdapter":
            return {item.name: item for item in node.body if isinstance(item, ast.FunctionDef)}
    return {}


def _calls_with_owner(tree: ast.Module) -> list[tuple[ast.Call, str]]:
    """All calls in the module with their enclosing function name."""
    owned: list[tuple[ast.Call, str]] = []

    class _Visitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self._name = "<module>"

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            previous, self._name = self._name, node.name
            self.generic_visit(node)
            self._name = previous

        def visit_Call(self, node: ast.Call) -> None:
            owned.append((node, self._name))
            self.generic_visit(node)

    _Visitor().visit(tree)
    return owned


def _mutation_path_text(call: ast.Call) -> str | None:
    """The endpoint path of a ``self._transport.put_json/post_json`` call,
    or None if the call is not a transport mutation."""
    func = call.func
    if (
        isinstance(func, ast.Attribute)
        and func.attr in ("put_json", "post_json")
        and isinstance(func.value, ast.Attribute)
        and func.value.attr == "_transport"
    ):
        if call.args:
            argument = call.args[0]
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                return argument.value
            if isinstance(argument, ast.JoinedStr):
                return "".join(
                    part.value
                    for part in argument.values
                    if isinstance(part, ast.Constant) and isinstance(part.value, str)
                )
    return None


class MergePathStructuralTests(unittest.TestCase):
    """FZ-CTRL003-004 (structural): the adapter offers exactly one merge
    path, it is reached only through ``merge_pull_request``, and it is
    gated by issuance verification before any remote call."""

    def test_merge_endpoint_appears_only_in_merge_pull_request(self) -> None:
        merge_calls: list[str] = []
        for call, owner in _calls_with_owner(_github_tree()):
            path = _mutation_path_text(call)
            if path is not None and "/merge" in path:
                merge_calls.append(owner)
        self.assertEqual(merge_calls, ["merge_pull_request"])

    def test_merge_pull_request_verifies_issuance_before_any_adapter_call(self) -> None:
        method = _adapter_methods(_github_tree())["merge_pull_request"]
        calls = [node for node in ast.walk(method) if isinstance(node, ast.Call)]
        calls.sort(key=lambda node: (node.lineno, node.col_offset))
        verify_positions = [
            index
            for index, call in enumerate(calls)
            if isinstance(call.func, ast.Name) and call.func.id == "_verify_issuance"
        ]
        self.assertEqual(len(verify_positions), 1)
        adapter_call_positions = [
            index
            for index, call in enumerate(calls)
            if isinstance(call.func, ast.Attribute)
            and isinstance(call.func.value, ast.Name)
            and call.func.value.id == "self"
        ]
        self.assertTrue(adapter_call_positions)
        self.assertLess(verify_positions[0], adapter_call_positions[0])

    def test_authorization_construction_confined_to_the_gate(self) -> None:
        """The only ``MergeAuthorization(...)`` construction site in the
        package is inside ``authorize_merge`` — no public issuance path
        other than the gate exists."""
        constructions = [
            owner
            for call, owner in _calls_with_owner(_github_tree())
            if isinstance(call.func, ast.Name) and call.func.id == "MergeAuthorization"
        ]
        self.assertEqual(constructions, ["authorize_merge"])

    def test_issuance_proof_type_is_not_exported(self) -> None:
        import controller

        self.assertFalse(hasattr(controller, "_IssuanceProof"))
        self.assertTrue(hasattr(controller, "MergeAuthorization"))


class DomainCompatibilityTests(unittest.TestCase):
    """AC5/AC8: authority boundary, typed surface, repository validation."""

    def test_invalid_repository_fails_closed(self) -> None:
        with self.assertRaises(GithubAdapterError):
            Adapter(FakeTransport(), "pectoraux")

    def test_adapter_never_takes_repository_paths_or_files(self) -> None:
        """The adapter receives authority facts as values, never file paths."""
        import inspect

        signature = inspect.signature(Adapter.__init__)
        self.assertNotIn("repo_root", signature.parameters)
        self.assertNotIn("path", " ".join(signature.parameters))

    def test_normalized_values_are_frozen_and_hashable(self) -> None:
        pr = _normalize_pull_request(pull_request())
        with self.assertRaises(dataclasses.FrozenInstanceError):
            pr.number = 99  # type: ignore[misc]
        self.assertIsInstance(hash(pr), int)

    def test_authorization_is_frozen(self) -> None:
        authorization = Adapter(_merge_ready_transport(), REPO).authorize_merge(
            pr_number=7,
            expected_base_ref="main",
            expected_base_sha=BASE_SHA,
            expected_head_sha=HEAD_SHA,
            work_item="CTRL-003",
            eligibility=_eligible(),
            architect_reviewer=ARCHITECT,
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            authorization.merge_method = "squash"  # type: ignore[misc]

    def test_adapter_does_not_cache_across_calls(self) -> None:
        """Every observation hits the transport — no runtime cache layer."""
        transport = FakeTransport(adapter_responses(pr=pull_request()))
        adapter = Adapter(transport, REPO)
        adapter.get_pull_request(7)
        adapter.get_pull_request(7)
        get_calls = transport.calls_matching("GET", f"/repos/{REPO}/pulls/7")
        self.assertEqual(len(get_calls), 2)


if __name__ == "__main__":
    unittest.main()
