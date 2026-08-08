#!/usr/bin/env python3
"""Auto-bump tier versions for STAGED changes. Runs as the pre-commit
hook (.githooks/pre-commit); safe to run by hand before committing:

    python3 scripts/bump_versions.py

For each tier (webapp, worker — see version_rules.TIERS): if the
staged diff touches that tier and does NOT already change its
package.json version, bump the patch version, write the file, and
`git add` it so the bump rides along in the same commit.

The schema tier needs no bumping — a new numbered migration file is
its version (check_version_bump.py enforces that on PRs).

Note: the bump rewrites the tier's package.json from its STAGED
content, so any unstaged edits to that file get folded into the
commit. Keep package.json edits staged and this never surprises you.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from version_rules import TIERS, bump_patch


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), *args], text=True, stderr=subprocess.PIPE
    )


def _staged_files(repo: Path) -> list[str]:
    out = _git(repo, "diff", "--cached", "--name-only")
    return [line.strip() for line in out.splitlines() if line.strip()]


def _show(repo: Path, spec: str) -> str | None:
    """`git show <spec>` — None when the object doesn't exist (e.g.
    the file is new in this commit)."""
    try:
        return _git(repo, "show", spec)
    except subprocess.CalledProcessError:
        return None


def _version_of(content: str | None) -> str | None:
    if content is None:
        return None
    try:
        return str(json.loads(content)["version"])
    except (KeyError, json.JSONDecodeError):
        return None


def _bump_package_json(content: str, new_version: str) -> str:
    """Rewrite only the top-level "version" value, preserving the
    file's formatting (a json.dumps round-trip would reformat it)."""
    replaced = re.sub(
        r'("version"\s*:\s*")[^"]+(")',
        rf"\g<1>{new_version}\g<2>",
        content,
        count=1,
    )
    if _version_of(replaced) != new_version:
        raise RuntimeError("failed to rewrite version field")
    return replaced


def run(repo: Path) -> list[str]:
    """Bump every tier the staged diff touches. Returns bumped tier
    names (empty when nothing needed)."""
    staged = _staged_files(repo)
    if not staged:
        return []

    bumped: list[str] = []
    for tier in TIERS:
        if not any(tier.matches(p) for p in staged):
            continue

        staged_pkg = _show(repo, f":{tier.version_file}")
        head_pkg = _show(repo, f"HEAD:{tier.version_file}")
        staged_v = _version_of(staged_pkg)
        head_v = _version_of(head_pkg)
        if staged_v is None:
            # Version file missing/unparsable in the index — leave it
            # to the CI check to complain with full context.
            continue
        if head_v is None or staged_v != head_v:
            # New file, or already bumped in this commit — done.
            continue

        new_v = bump_patch(staged_v)
        # Rewrite from the staged content (not the worktree) so the
        # bump composes with whatever is actually being committed.
        assert staged_pkg is not None
        (repo / tier.version_file).write_text(
            _bump_package_json(staged_pkg, new_v), encoding="utf-8"
        )
        _git(repo, "add", tier.version_file)
        bumped.append(tier.name)
    return bumped


def main() -> int:
    repo = Path(
        subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], text=True
        ).strip()
    )
    for name in run(repo):
        print(f"[bump_versions] {name}: patch version bumped (staged)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
