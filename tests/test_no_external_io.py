"""Forbidden-surface guard: network, persistence, and credential scoping.

CTRL-001 banned all network imports from the controller package. CTRL-003
(the frozen GitHub adapter work order) authorizes exactly ONE network
module: ``controller/github.py`` (the injected transport). This guard
enforces that scoping rather than the original blanket ban:

* network imports (socket/http/urllib/requests/...) are allowed ONLY in
  ``controller/github.py`` and remain forbidden in every other module;
* subprocess and persistence machinery (subprocess/sqlite3/shelve/pickle/
  dbm) remains forbidden everywhere, including the adapter;
* credential *material* (literal token/secret patterns or string literals
  assigned to credential-like names) is banned in all sources; the word
  "token" as a parameter name in the authorized transport module is not
  credential material;
* tests import only the standard library, ``controller``, and ``tests``
  (fakes — no network, no credentials — AC7).
"""

from __future__ import annotations

import ast
import re
import sys
import unittest
from pathlib import Path

from tests.util import REPO_ROOT

#: Imports whose presence means network access.
_NETWORK_IMPORT_ROOTS: frozenset[str] = frozenset(
    {
        "socket",
        "http",
        "urllib",
        "requests",
        "ftplib",
        "smtplib",
        "xmlrpc",
    }
)

#: Imports that mean process control or durable state (still forbidden).
_PERSISTENCE_IMPORT_ROOTS: frozenset[str] = frozenset(
    {
        "subprocess",
        "sqlite3",
        "shelve",
        "pickle",
        "dbm",
    }
)

#: The single module authorized for network imports (CTRL-003 transport).
_NETWORK_ALLOWED_MODULE = "github.py"

#: Credential-like words banned as *source markers* outside the transport.
_CREDENTIAL_WORDS: tuple[str, ...] = (
    "password",
    "secret",
    "api_key",
    "apikey",
    "credential",
)

#: Literal credential material patterns banned everywhere.
_CREDENTIAL_LITERALS: tuple[re.Pattern[str], ...] = (
    re.compile(r"ghp_[A-Za-z0-9]{16,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(
        r"(?i)\b(token|password|secret|api[_-]?key|credential)\s*=\s*['\"][A-Za-z0-9+/_-]{16,}['\"]"
    ),
)


def _import_roots(tree: ast.Module) -> set[str]:
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                roots.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module is not None:
                roots.add(node.module.split(".")[0])
    return roots


def _package_sources() -> list[Path]:
    return sorted((REPO_ROOT / "controller").glob("*.py"))


def _test_sources() -> list[Path]:
    return sorted((REPO_ROOT / "tests").glob("*.py"))


class NetworkScopingTests(unittest.TestCase):
    """Network imports exist ONLY in the authorized adapter transport."""

    def test_network_imports_only_in_github_module(self) -> None:
        offenders: list[str] = []
        for path in _package_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            roots = _import_roots(tree)
            if path.name == _NETWORK_ALLOWED_MODULE:
                continue  # authorized (CTRL-003)
            if roots & _NETWORK_IMPORT_ROOTS:
                offenders.append(f"{path.name}: {sorted(roots & _NETWORK_IMPORT_ROOTS)}")
        self.assertEqual(offenders, [])

    def test_adapter_has_no_persistence_or_subprocess(self) -> None:
        for path in _package_sources():
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                roots = _import_roots(tree)
                self.assertEqual(roots & _PERSISTENCE_IMPORT_ROOTS, set())

    def test_github_module_imports_only_stdlib_and_controller(self) -> None:
        allowed = set(sys.stdlib_module_names) | {"controller"}
        tree = ast.parse((REPO_ROOT / "controller" / "github.py").read_text(encoding="utf-8"))
        roots = _import_roots(tree)
        self.assertEqual(roots - allowed, set())

    def test_other_modules_remain_stdlib_and_controller_only(self) -> None:
        allowed = set(sys.stdlib_module_names) | {"controller"}
        for path in _package_sources():
            if path.name == _NETWORK_ALLOWED_MODULE:
                continue
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                roots = _import_roots(tree)
                self.assertEqual(roots - allowed, set())

    def test_tests_use_only_stdlib_controller_and_fakes(self) -> None:
        """The suite runs with zero external dependencies or services."""
        allowed = set(sys.stdlib_module_names) | {"controller", "tests"}
        for path in _test_sources():
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                roots = _import_roots(tree)
                self.assertEqual(roots - allowed, set())

    def test_tests_have_no_network_imports(self) -> None:
        for path in _test_sources():
            with self.subTest(module=path.name):
                tree = ast.parse(path.read_text(encoding="utf-8"))
                roots = _import_roots(tree)
                self.assertEqual(roots & _NETWORK_IMPORT_ROOTS, set())


class CredentialGuardTests(unittest.TestCase):
    """No credential material anywhere; no credential words outside transport."""

    def test_no_credential_literals_in_any_source(self) -> None:
        for path in _package_sources() + _test_sources():
            with self.subTest(module=path.name):
                source = path.read_text(encoding="utf-8")
                for pattern in _CREDENTIAL_LITERALS:
                    self.assertIsNone(pattern.search(source), msg=pattern.pattern)

    def test_no_credential_words_outside_the_transport(self) -> None:
        for path in _package_sources():
            if path.name == _NETWORK_ALLOWED_MODULE:
                continue
            with self.subTest(module=path.name):
                source = path.read_text(encoding="utf-8").lower()
                for marker in _CREDENTIAL_WORDS:
                    self.assertNotIn(marker, source)


if __name__ == "__main__":
    unittest.main()
