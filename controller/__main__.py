"""Command-line entry point: controller validate / controller domain.

Local, offline tooling. ``validate`` validates repository authority
(fail-closed on any contradiction) and prints the reconstructed
controller state. ``domain`` reconstructs and prints the governed
work-item domain model (CTRL-002). Exit code 0 means authority is
consistent and reconstructable; exit code 1 means the controller refuses
to proceed.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from controller import __version__, reconstruct
from controller.authority import verify_authority
from controller.domain import reconstruct_domain
from controller.errors import ControllerError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="controller",
        description="Pectoraux Controller (CTRL-001 foundation, CTRL-002 domain). "
        "Offline repository-authority validation and domain reconstruction.",
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
    return parser


def _run_validate(repo_root: Path) -> int:
    try:
        program = verify_authority(repo_root)
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


def main(argv: list[str] | None = None) -> int:
    """Run the CLI. Returns a process exit code."""
    args = _build_parser().parse_args(argv)

    if args.command == "validate":
        return _run_validate(args.repo)
    if args.command == "domain":
        return _run_domain(args.repo)

    # Unreachable: argparse enforces the subcommand choice.
    raise AssertionError(f"unhandled command: {args.command}")  # pragma: no cover


if __name__ == "__main__":
    raise SystemExit(main())
