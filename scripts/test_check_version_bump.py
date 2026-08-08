#!/usr/bin/env python3
"""Characterization tests for check_version_bump.py (the CI gate) —
run it as a subprocess against a temp repo, exactly like CI does.

    python3 -m unittest discover -s scripts -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parent / "check_version_bump.py"


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], text=True, stderr=subprocess.PIPE
    )


def _write(repo: Path, rel: str, content: str) -> None:
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def _pkg(version: str) -> str:
    return json.dumps({"name": "x", "version": version}, indent=2) + "\n"


def _run_check(repo: Path) -> int:
    """Run the CI check with BASE_REF pointing at local main (the
    slash keeps the script from prepending origin/)."""
    env = dict(os.environ, BASE_REF="refs/heads/main")
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
    )
    return proc.returncode


class CheckVersionBump(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        _git(self.repo, "init", "-b", "main")
        _git(self.repo, "config", "user.email", "t@example.com")
        _git(self.repo, "config", "user.name", "t")
        _write(self.repo, "webapp/package.json", _pkg("0.0.1"))
        _write(self.repo, "backend/package.json", _pkg("0.0.1"))
        _write(self.repo, "webapp/src/App.tsx", "export {}\n")
        _write(self.repo, "backend/src/index.ts", "export {}\n")
        _write(self.repo, "backend/migrations/0000_init.sql", "SELECT 1;\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "base")
        _git(self.repo, "checkout", "-b", "feat")

    def tearDown(self):
        self._tmp.cleanup()

    def _commit(self, msg: str = "wip") -> None:
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", msg)

    def test_fails_when_webapp_changed_without_bump(self):
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        self._commit()
        self.assertEqual(_run_check(self.repo), 1)

    def test_passes_when_webapp_bumped(self):
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _write(self.repo, "webapp/package.json", _pkg("0.0.2"))
        self._commit()
        self.assertEqual(_run_check(self.repo), 0)

    def test_fails_when_migration_edited_in_place(self):
        _write(self.repo, "backend/migrations/0000_init.sql", "SELECT 2;\n")
        self._commit()
        self.assertEqual(_run_check(self.repo), 1)

    def test_passes_when_new_migration_added(self):
        _write(self.repo, "backend/migrations/0001_more.sql", "SELECT 2;\n")
        self._commit()
        self.assertEqual(_run_check(self.repo), 0)

    def test_passes_on_doc_only_change(self):
        _write(self.repo, "docs/notes.md", "# notes\n")
        self._commit()
        self.assertEqual(_run_check(self.repo), 0)


if __name__ == "__main__":
    unittest.main()
