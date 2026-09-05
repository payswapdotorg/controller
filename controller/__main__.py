"""Command-line entry point: the Controller runtime commands (CTRL-011).

Offline, local tooling — ``validate`` validates repository authority
(fail-closed on any contradiction) and prints the reconstructed
controller state; ``domain`` reconstructs and prints the governed
work-item domain model (CTRL-002); ``status`` adds the offline routing
view (which boundary owns the next step). Exit code 0 means authority
is consistent and reconstructable.

Governed runtime (CTRL-011) — ``cycle`` executes exactly one governed
step against a controlled repository; ``run`` is the long-running mode
with bounded polling/backoff. Both load repository authority before
every action, route exactly one boundary step, project the returned
event through the guarded recorder, and emit structured operator
output (JSON with ``--json``, human lines otherwise). Provider
tokens are read ONLY from the process environment
(``CONTROLLER_GITHUB_TOKEN`` / ``CONTROLLER_ZAI_TOKEN``) — never from
repository files — and are never emitted. Every fail-closed condition
exits non-zero with a ``FAIL-CLOSED:`` line on stderr.

Exit codes: 0 = the requested command completed (including a clean
governance pause/complete); 1 = fail-closed (typed error surfaced);
2 = the long-running mode hit its configured cycle cap.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from controller import __version__
from controller.authority import verify_authority
from controller.domain import reconstruct_domain
from controller.errors import ControllerError
from controller.github import DEFAULT_API_ROOT as GITHUB_DEFAULT_API_ROOT
from controller.github import UrllibGithubTransport
from controller.runtime import (
    GITHUB_TOKEN_ENV,
    ZAI_TOKEN_ENV,
    ControllerRuntime,
    RuntimeConfiguration,
    RuntimeTokens,
)
from controller.states import LifecycleState
from controller.zai import DEFAULT_API_ROOT as ZAI_DEFAULT_API_ROOT
from controller.zai import UrllibZaiTransport


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="controller",
        description="Pectoraux Controller — the production governed runtime "
        "(CTRL-011) over the accepted Stage-7 orchestration boundaries, plus "
        "offline repository-authority validation.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser(
        "validate",
        help="Validate repository authority and print reconstructed state.",
    )
    validate.add_argument(
        "--repo",
        type=Path,
        default=Path("."),
        help="Controller repository root (default: current directory).",
    )

    domain = subparsers.add_parser(
        "domain",
        help="Reconstruct and print the governed work-item domain model.",
    )
    domain.add_argument(
        "--repo",
        type=Path,
        default=Path("."),
        help="Controller repository root (default: current directory).",
    )

    status = subparsers.add_parser(
        "status",
        help="Offline: authority, lifecycle position, and the owning boundary.",
    )
    status.add_argument(
        "--repo",
        type=Path,
        default=Path("."),
        help="Controller repository root (default: current directory).",
    )

    for name, help_text in (
        ("cycle", "Execute exactly one governed step against the repository."),
        ("run", "Long-running governed mode (bounded polling/backoff)."),
    ):
        command = subparsers.add_parser(name, help=help_text)
        command.add_argument(
            "--repo", type=Path, default=Path("."), help="Controlled repository root."
        )
        command.add_argument(
            "--repository",
            default=None,
            help="Controlled repository 'owner/name' (default: derived from "
            "verified repository authority — never guessed).",
        )
        command.add_argument(
            "--required-checks",
            required=True,
            help="Comma-separated required CI check contexts (external policy "
            "input; the runtime never invents required evidence).",
        )
        command.add_argument(
            "--retryable-checks",
            default="",
            help="Comma-separated retryable subset of the required checks.",
        )
        command.add_argument(
            "--architect-reviewer",
            required=True,
            help="The Architect's GitHub login (whose reviews are decisions).",
        )
        command.add_argument("--branch", default=None, help="Carried governed branch reference.")
        command.add_argument(
            "--base-sha", default=None, help="Carried dispatch-base SHA reference."
        )
        command.add_argument(
            "--session-id",
            default=None,
            help="Carried worker-session identity (request form; the provider "
            "re-proves provenance — supply after a restart).",
        )
        command.add_argument(
            "--github-api-root",
            default=GITHUB_DEFAULT_API_ROOT,
            help=f"GitHub API root (default: {GITHUB_DEFAULT_API_ROOT}).",
        )
        command.add_argument(
            "--zai-api-root",
            default=ZAI_DEFAULT_API_ROOT,
            help=f"Z.ai API root (default: {ZAI_DEFAULT_API_ROOT}).",
        )
        command.add_argument(
            "--json",
            action="store_true",
            help="Emit machine-readable JSON (one object per line).",
        )
        if name == "run":
            command.add_argument(
                "--poll-interval",
                type=float,
                default=60.0,
                help="Base polling interval seconds (default: 60).",
            )
            command.add_argument(
                "--poll-backoff",
                type=float,
                default=2.0,
                help="Backoff multiplier on unchanged evidence (default: 2.0).",
            )
            command.add_argument(
                "--poll-max",
                type=float,
                default=600.0,
                help="Maximum polling interval seconds (default: 600).",
            )
            command.add_argument(
                "--max-cycles",
                type=int,
                default=1000,
                help="Hard cap on governed cycles per invocation (default: 1000).",
            )
    return parser


def _run_validate(repo_root: Path) -> int:
    try:
        program = verify_authority(repo_root)
        from controller import reconstruct

        state = reconstruct(repo_root)
    except ControllerError as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        return 1
    print("controller authority: OK")
    print(f"repository: {program.repository}")
    print(f"schema version: {program.schema_version}")
    print(f"active work item: {program.active_work_item}")
    print(f"lifecycle state: {state.lifecycle.value}")
    print(f"automation stage: {program.automation_stage}")
    print(f"completed items: {len(program.completed)}")
    return 0


def _run_domain(repo_root: Path) -> int:
    try:
        item = reconstruct_domain(repo_root)
    except ControllerError as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        return 1
    print("domain model: OK")
    print(f"repository: {item.identity.repository}")
    print(f"active work item: {item.identity.work_item}")
    print(f"work order: {item.identity.work_order_path}")
    print(f"lifecycle state: {item.lifecycle.value}")
    verdict = "ELIGIBLE" if item.eligibility.eligible else "INELIGIBLE"
    print(f"dispatch eligibility: {verdict}")
    for line in item.eligibility.basis:
        print(f"  - {line}")
    print(f"roadmap: {item.authority.roadmap}")
    print(f"architecture: {item.authority.architecture}")
    print(f"build process: {item.authority.build_process}")
    print(f"automation stage: {item.authority.automation_stage}")
    print(f"completed: {', '.join(item.completed) if item.completed else '(none)'}")
    return 0


_POSITION_BOUNDARIES: dict[str, str] = {
    LifecycleState.READY.value: "ORCHESTRATOR",
    LifecycleState.DISPATCHED.value: "ORCHESTRATOR",
    LifecycleState.IMPLEMENTING.value: "ORCHESTRATOR",
    LifecycleState.PR_OPEN.value: "ORCHESTRATOR",
    LifecycleState.CI_PENDING.value: "EVIDENCE_GATE",
    LifecycleState.REVIEW_PENDING.value: "REVIEW_LOOP",
    LifecycleState.CHANGES_REQUESTED.value: "ORCHESTRATOR",
    LifecycleState.APPROVED.value: "MERGE_BOUNDARY",
    LifecycleState.MERGING.value: "MERGE_BOUNDARY",
    LifecycleState.MERGED.value: "MERGE_BOUNDARY",
    LifecycleState.RECONCILING.value: "MERGE_BOUNDARY",
    LifecycleState.COMPLETE.value: "ARCHITECT_GOVERNANCE",
    LifecycleState.NEXT_READY.value: "ARCHITECT_GOVERNANCE",
}


def _run_status(repo_root: Path) -> int:
    """Offline authority + position + owning-boundary report (no network,
    no provider tokens — the routing view mirrors the frozen CTRL-009 map)."""
    try:
        program = verify_authority(repo_root)
        item = reconstruct_domain(repo_root)
    except ControllerError as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        return 1
    boundary = _POSITION_BOUNDARIES.get(item.lifecycle.value, "ARCHITECT_GOVERNANCE")
    print("controller status: OK")
    print(f"repository: {program.repository}")
    print(f"active work item: {program.active_work_item}")
    print(f"lifecycle state: {item.lifecycle.value}")
    print(f"owning boundary (frozen routing): {boundary}")
    print(f"automation stage: {program.automation_stage}")
    print(f"next action (authority): {program.next_action}")
    return 0


def _comma_names(value: str) -> tuple[str, ...]:
    return tuple(name.strip() for name in value.split(",") if name.strip())


def _runtime_configuration(args: argparse.Namespace) -> RuntimeConfiguration:
    """Assemble the runtime configuration; the repository identity comes
    from verified authority when not explicitly supplied (never guessed,
    never read as a token)."""
    repository = args.repository
    if repository is None:
        program = verify_authority(args.repo)
        repository = program.repository
    return RuntimeConfiguration(
        repo_root=args.repo,
        repository=repository,
        required_checks=_comma_names(args.required_checks),
        retryable_checks=_comma_names(args.retryable_checks),
        architect_reviewer=args.architect_reviewer,
        branch=args.branch,
        base_sha=args.base_sha,
        session_id=args.session_id,
        poll_interval_seconds=getattr(args, "poll_interval", 60.0),
        poll_backoff_multiplier=getattr(args, "poll_backoff", 2.0),
        poll_max_seconds=getattr(args, "poll_max", 600.0),
        max_cycles=getattr(args, "max_cycles", 1000),
    )


def _emit(report: object, as_json: bool) -> None:
    if as_json:
        print(json.dumps(report.serialize()))  # type: ignore[attr-defined]
    else:
        print(report.human_summary())  # type: ignore[attr-defined]
        print(f"  guidance: {report.guidance}")  # type: ignore[attr-defined]


def _runtime(args: argparse.Namespace) -> ControllerRuntime:
    """Provider tokens from the environment ONLY (AC6), then the transports,
    then the runtime. A missing token is an unavailable mandatory
    dependency: fail closed before anything else happens."""
    tokens = RuntimeTokens.from_environment()
    configuration = _runtime_configuration(args)
    github_transport = UrllibGithubTransport(
        api_root=args.github_api_root, token=tokens.github_token
    )
    zai_transport = UrllibZaiTransport(api_root=args.zai_api_root, token=tokens.zai_token)
    print(
        f"provider tokens: {GITHUB_TOKEN_ENV}/{ZAI_TOKEN_ENV} "
        f"{tokens.masked()[GITHUB_TOKEN_ENV]} (environment-only)",
        file=sys.stderr,
    )
    return ControllerRuntime(
        configuration=configuration,
        github_transport=github_transport,
        zai_transport=zai_transport,
    )


def _run_cycle(args: argparse.Namespace) -> int:
    try:
        runtime = _runtime(args)
        report = runtime.run_one_cycle()
    except ControllerError as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        return 1
    _emit(report, args.json)
    return 0


def _run_long(args: argparse.Namespace) -> int:
    try:
        runtime = _runtime(args)
        reports = runtime.run()
    except ControllerError as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        return 1
    for report in reports:
        _emit(report, args.json)
    last = reports[-1]
    if last.status.value == "COMPLETED":
        print("run ended: lifecycle complete (advancement is Architect governance).")
        return 0
    if last.status.value == "PAUSED":
        print("run paused: governance attention required (fail-closed hold).")
        return 0
    print("run reached the configured cycle cap without a terminal position.")
    return 2


def main(argv: list[str] | None = None) -> int:
    """Run the CLI. Returns a process exit code."""
    args = _build_parser().parse_args(argv)

    if args.command == "validate":
        return _run_validate(args.repo)
    if args.command == "domain":
        return _run_domain(args.repo)
    if args.command == "status":
        return _run_status(args.repo)
    if args.command == "cycle":
        return _run_cycle(args)
    if args.command == "run":
        return _run_long(args)

    # Unreachable: argparse enforces the subcommand choice.
    raise AssertionError(f"unhandled command: {args.command}")  # pragma: no cover


if __name__ == "__main__":
    raise SystemExit(main())
