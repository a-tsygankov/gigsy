#!/usr/bin/env python3
"""Tests for version_rules.py + bump_versions.py.

Run locally or in CI:

    python3 -m unittest discover -s scripts -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import bump_versions as bv
import version_rules as vr


class DocClassification(unittest.TestCase):
    def test_markdown_anywhere_is_doc(self):
        self.assertTrue(vr.is_doc_file("webapp/README.md"))
        self.assertTrue(vr.is_doc_file("backend/notes.md"))

    def test_docs_dir_is_doc(self):
        self.assertTrue(vr.is_doc_file("docs/plan.md"))

    def test_handoff_is_doc(self):
        self.assertTrue(vr.is_doc_file("gigsy-handoff.md"))

    def test_source_is_not_doc(self):
        self.assertFalse(vr.is_doc_file("webapp/src/App.tsx"))
        self.assertFalse(vr.is_doc_file("backend/src/index.ts"))


class TierMatching(unittest.TestCase):
    def tier(self, name: str) -> vr.Tier:
        return next(t for t in vr.TIERS if t.name == name)

    def test_webapp_matches_webapp_source(self):
        self.assertTrue(self.tier("webapp").matches("webapp/src/App.tsx"))

    def test_webapp_ignores_webapp_docs(self):
        self.assertFalse(self.tier("webapp").matches("webapp/README.md"))

    def test_worker_matches_backend_source(self):
        self.assertTrue(self.tier("worker").matches("backend/src/index.ts"))

    def test_worker_excludes_migrations(self):
        # Migrations are the SCHEMA tier — its version is the migration
        # filename itself, so the worker tier must not claim them.
        self.assertFalse(
            self.tier("worker").matches("backend/migrations/0001_x.sql")
        )

    def test_tiers_declare_version_files(self):
        self.assertEqual(self.tier("webapp").version_file, "webapp/package.json")
        self.assertEqual(self.tier("worker").version_file, "backend/package.json")


class BumpPatch(unittest.TestCase):
    def test_bumps_patch(self):
        self.assertEqual(vr.bump_patch("0.0.1"), "0.0.2")

    def test_carries_double_digits(self):
        self.assertEqual(vr.bump_patch("1.2.9"), "1.2.10")

    def test_non_semver_appends(self):
        self.assertEqual(vr.bump_patch("abc"), "abc.1")


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


def _staged_version(repo: Path, rel: str) -> str:
    staged = _git(repo, "show", f":{rel}")
    return json.loads(staged)["version"]


class BumpInRepo(unittest.TestCase):
    """End-to-end against a real temporary git repo — the same code
    path the pre-commit hook runs."""

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
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "base")

    def tearDown(self):
        self._tmp.cleanup()

    def test_bumps_webapp_when_webapp_source_staged(self):
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _git(self.repo, "add", "webapp/src/App.tsx")

        bumped = bv.run(self.repo)

        self.assertEqual(bumped, ["webapp"])
        self.assertEqual(_staged_version(self.repo, "webapp/package.json"), "0.0.2")
        # Untouched tier stays put.
        self.assertEqual(_staged_version(self.repo, "backend/package.json"), "0.0.1")

    def test_bumps_both_tiers_independently(self):
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _write(self.repo, "backend/src/index.ts", "export const b = 2\n")
        _git(self.repo, "add", "-A")

        bumped = bv.run(self.repo)

        self.assertEqual(sorted(bumped), ["webapp", "worker"])
        self.assertEqual(_staged_version(self.repo, "webapp/package.json"), "0.0.2")
        self.assertEqual(_staged_version(self.repo, "backend/package.json"), "0.0.2")

    def test_no_double_bump_when_version_already_staged(self):
        # User (or a previous hook run) already bumped in this commit.
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _write(self.repo, "webapp/package.json", _pkg("0.0.5"))
        _git(self.repo, "add", "-A")

        bumped = bv.run(self.repo)

        self.assertEqual(bumped, [])
        self.assertEqual(_staged_version(self.repo, "webapp/package.json"), "0.0.5")

    def test_migration_bumps_neither_package(self):
        # Schema's "version" is the new migration file itself.
        _write(self.repo, "backend/migrations/0001_x.sql", "CREATE TABLE t(x);\n")
        _git(self.repo, "add", "-A")

        bumped = bv.run(self.repo)

        self.assertEqual(bumped, [])
        self.assertEqual(_staged_version(self.repo, "backend/package.json"), "0.0.1")

    def test_dependency_only_package_json_change_bumps(self):
        # Editing deps in package.json IS a webapp change — the hook
        # should bump even though the only staged file is package.json.
        pkg = json.loads(_pkg("0.0.1"))
        pkg["dependencies"] = {"left-pad": "^1.0.0"}
        _write(
            self.repo,
            "webapp/package.json",
            json.dumps(pkg, indent=2) + "\n",
        )
        _git(self.repo, "add", "webapp/package.json")

        bumped = bv.run(self.repo)

        self.assertEqual(bumped, ["webapp"])
        self.assertEqual(_staged_version(self.repo, "webapp/package.json"), "0.0.2")

    def test_doc_only_changes_bump_nothing(self):
        _write(self.repo, "webapp/README.md", "# hi\n")
        _git(self.repo, "add", "-A")

        bumped = bv.run(self.repo)

        self.assertEqual(bumped, [])
        self.assertEqual(_staged_version(self.repo, "webapp/package.json"), "0.0.1")


if __name__ == "__main__":
    unittest.main()
