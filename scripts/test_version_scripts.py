#!/usr/bin/env python3
"""Tests for version_rules.py + bump_versions.py.

Run locally or in CI:

    python3 -m unittest discover -s scripts -v
"""

from __future__ import annotations

import json
import os
import shutil
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
    # write_bytes, not write_text: text mode would rewrite "\n" as
    # "\r\n" on Windows and make byte-level assertions platform-
    # dependent.
    p = repo / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content.encode("utf-8"))


def _pkg(version: str) -> str:
    return json.dumps({"name": "x", "version": version}, indent=2) + "\n"


def _staged_version(repo: Path, rel: str) -> str:
    staged = _git(repo, "show", f":{rel}")
    return json.loads(staged)["version"]


def _staged_json(repo: Path, rel: str) -> dict:
    return json.loads(_git(repo, "show", f":{rel}"))


def _worktree_json(repo: Path, rel: str) -> dict:
    return json.loads((repo / rel).read_bytes().decode("utf-8"))


class BaseRepo(unittest.TestCase):
    """A two-tier repo with one commit of history."""

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


class BumpInRepo(BaseRepo):
    """End-to-end against a real temporary git repo — the same code
    path the pre-commit hook runs."""

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


# The scripts the bumper is asked to preserve. This is the concrete
# case that was lost once: two scripts added to webapp/package.json in
# the worktree, never staged, silently erased by a commit of unrelated
# files.
UNSTAGED_SCRIPTS = {
    "help:test": "playwright test --project=help",
    "help:validate": "vitest run src/help",
}


def _add_unstaged_scripts(repo: Path, rel: str) -> None:
    """Add scripts to a package.json in the WORKTREE ONLY."""
    pkg = json.loads((repo / rel).read_bytes().decode("utf-8"))
    pkg["scripts"] = dict(UNSTAGED_SCRIPTS)
    _write(repo, rel, json.dumps(pkg, indent=2) + "\n")


class PreservesUnstagedEdits(BaseRepo):
    """Regression guard: the bump must edit the version field and
    nothing else. It used to rewrite the whole worktree file from the
    staged content, silently destroying unstaged edits."""

    def test_unstaged_webapp_edit_survives_unrelated_bump(self):
        _add_unstaged_scripts(self.repo, "webapp/package.json")
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _git(self.repo, "add", "webapp/src/App.tsx")  # package.json NOT staged

        self.assertEqual(bv.run(self.repo), ["webapp"])

        worktree = _worktree_json(self.repo, "webapp/package.json")
        self.assertEqual(worktree["scripts"], UNSTAGED_SCRIPTS)
        self.assertEqual(worktree["version"], "0.0.2")

        # The index gets the bump but NOT the unstaged edit — staging
        # is still the developer's decision.
        staged = _staged_json(self.repo, "webapp/package.json")
        self.assertEqual(staged["version"], "0.0.2")
        self.assertNotIn("scripts", staged)

    def test_unstaged_backend_edit_survives_unrelated_bump(self):
        # backend/package.json runs the identical code path.
        _add_unstaged_scripts(self.repo, "backend/package.json")
        _write(self.repo, "backend/src/index.ts", "export const b = 2\n")
        _git(self.repo, "add", "backend/src/index.ts")

        self.assertEqual(bv.run(self.repo), ["worker"])

        worktree = _worktree_json(self.repo, "backend/package.json")
        self.assertEqual(worktree["scripts"], UNSTAGED_SCRIPTS)
        self.assertEqual(worktree["version"], "0.0.2")
        self.assertNotIn("scripts", _staged_json(self.repo, "backend/package.json"))

    def test_partly_staged_package_json_keeps_both_halves(self):
        # deps staged, scripts left unstaged — the bump must not
        # collapse the two states into one.
        pkg = json.loads((self.repo / "webapp/package.json").read_bytes())
        pkg["dependencies"] = {"left-pad": "^1.0.0"}
        _write(self.repo, "webapp/package.json", json.dumps(pkg, indent=2) + "\n")
        _git(self.repo, "add", "webapp/package.json")
        pkg["scripts"] = dict(UNSTAGED_SCRIPTS)
        _write(self.repo, "webapp/package.json", json.dumps(pkg, indent=2) + "\n")

        self.assertEqual(bv.run(self.repo), ["webapp"])

        worktree = _worktree_json(self.repo, "webapp/package.json")
        self.assertEqual(worktree["scripts"], UNSTAGED_SCRIPTS)
        self.assertEqual(worktree["dependencies"], {"left-pad": "^1.0.0"})
        self.assertEqual(worktree["version"], "0.0.2")

        staged = _staged_json(self.repo, "webapp/package.json")
        self.assertEqual(staged["dependencies"], {"left-pad": "^1.0.0"})
        self.assertNotIn("scripts", staged)
        self.assertEqual(staged["version"], "0.0.2")

    def test_unstaged_version_edit_is_not_overwritten(self):
        # The one case the bumper cannot reconcile: the worktree's own
        # version field is unstaged-edited. It must leave the file
        # alone and complain rather than retype the field.
        pkg = json.loads((self.repo / "webapp/package.json").read_bytes())
        pkg["version"] = "9.9.9"
        _write(self.repo, "webapp/package.json", json.dumps(pkg, indent=2) + "\n")
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _git(self.repo, "add", "webapp/src/App.tsx")

        self.assertEqual(bv.run(self.repo), ["webapp"])

        self.assertEqual(_worktree_json(self.repo, "webapp/package.json")["version"], "9.9.9")
        self.assertEqual(_staged_version(self.repo, "webapp/package.json"), "0.0.2")

    def test_root_package_json_is_never_touched(self):
        # The root package.json is not a tier version_file, so no tier
        # can rewrite it. Guard the claim.
        self.assertNotIn("package.json", [t.version_file for t in vr.TIERS])
        _write(self.repo, "package.json", '{"name": "root", "version": "0.0.1"}\n')
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-m", "root pkg")
        _write(self.repo, "package.json", '{"name": "root", "version": "0.0.1", "x": 1}\n')
        before = (self.repo / "package.json").read_bytes()
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _git(self.repo, "add", "webapp/src/App.tsx")

        self.assertEqual(bv.run(self.repo), ["webapp"])

        self.assertEqual((self.repo / "package.json").read_bytes(), before)


CRLF_PKG = b'{\r\n  "name": "x",\r\n  "version": "0.0.1"\r\n}\r\n'


class LineEndingsPreserved(BaseRepo):
    """Only the version substring may change. Python text-mode I/O
    applies universal-newline translation on read and os.linesep
    translation on write, which would rewrite every line in the file."""

    def _commit_crlf_pkg(self, autocrlf: str) -> None:
        _git(self.repo, "config", "core.autocrlf", autocrlf)
        (self.repo / "webapp/package.json").write_bytes(CRLF_PKG)
        _git(self.repo, "add", "webapp/package.json")
        # --allow-empty: under autocrlf=true the CRLF file normalises
        # to the blob the base commit already has, so there is no diff
        # to record — the point is to reach a clean HEAD either way.
        _git(self.repo, "commit", "--allow-empty", "-m", "crlf package.json")
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _git(self.repo, "add", "webapp/src/App.tsx")

    def test_crlf_worktree_survives_verbatim_blob(self):
        # core.autocrlf=false — the blob is CRLF too, so the bump
        # round-trips CRLF through the index as well.
        self._commit_crlf_pkg("false")

        self.assertEqual(bv.run(self.repo), ["webapp"])

        self.assertEqual(
            (self.repo / "webapp/package.json").read_bytes(),
            CRLF_PKG.replace(b"0.0.1", b"0.0.2"),
        )

    def test_crlf_worktree_survives_normalized_blob(self):
        # core.autocrlf=true (this repo's actual setting): worktree
        # CRLF, blob LF. Both endings must be preserved on their own
        # side of the index.
        self._commit_crlf_pkg("true")

        self.assertEqual(bv.run(self.repo), ["webapp"])

        self.assertEqual(
            (self.repo / "webapp/package.json").read_bytes(),
            CRLF_PKG.replace(b"0.0.1", b"0.0.2"),
        )
        blob = subprocess.check_output(
            ["git", "-C", str(self.repo), "show", ":webapp/package.json"]
        )
        self.assertNotIn(b"\r\n", blob)
        self.assertEqual(json.loads(blob)["version"], "0.0.2")


class HookEndToEnd(BaseRepo):
    """Drives a real `git commit` through the real .githooks/pre-commit
    — the exact path that lost work, not just the library function."""

    def setUp(self):
        super().setUp()
        src = Path(__file__).parent
        (self.repo / "scripts").mkdir(exist_ok=True)
        for f in ("bump_versions.py", "version_rules.py"):
            shutil.copy(src / f, self.repo / "scripts" / f)
        (self.repo / ".githooks").mkdir(exist_ok=True)
        hook = self.repo / ".githooks" / "pre-commit"
        shutil.copy(src.parent / ".githooks" / "pre-commit", hook)
        os.chmod(hook, 0o755)
        _git(self.repo, "config", "core.hooksPath", ".githooks")

    def _commit(self, message: str) -> str:
        """Commit, returning the hook's combined output."""
        proc = subprocess.run(
            ["git", "-C", str(self.repo), "commit", "-m", message],
            capture_output=True,
            text=True,
        )
        out = proc.stdout + proc.stderr
        if "no working python found" in out:
            self.skipTest("pre-commit hook found no usable python interpreter")
        self.assertEqual(proc.returncode, 0, out)
        return out

    def test_unstaged_package_json_edit_survives_a_real_commit(self):
        _add_unstaged_scripts(self.repo, "webapp/package.json")
        _write(self.repo, "webapp/src/App.tsx", "export const a = 1\n")
        _git(self.repo, "add", "webapp/src/App.tsx")  # package.json NOT staged

        self._commit("unrelated change")

        # The unstaged scripts are still on disk, and still unstaged.
        worktree = _worktree_json(self.repo, "webapp/package.json")
        self.assertEqual(worktree["scripts"], UNSTAGED_SCRIPTS)
        self.assertEqual(worktree["version"], "0.0.2")

        committed = json.loads(_git(self.repo, "show", "HEAD:webapp/package.json"))
        self.assertEqual(committed["version"], "0.0.2")
        self.assertNotIn("scripts", committed)

        # And a follow-up commit that DOES stage package.json carries
        # them into history — the original two-commit sequence.
        _git(self.repo, "add", "webapp/package.json")
        self._commit("add help scripts")
        landed = json.loads(_git(self.repo, "show", "HEAD:webapp/package.json"))
        self.assertEqual(landed["scripts"], UNSTAGED_SCRIPTS)


if __name__ == "__main__":
    unittest.main()
