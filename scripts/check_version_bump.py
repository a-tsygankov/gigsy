#!/usr/bin/env python3
"""CI gate: verify every tier touched by this PR bumped its version.

Runs as the `version-check` GitHub Actions job (see
.github/workflows/version-check.yml). Local invocation:

    BASE_REF=main python3 scripts/check_version_bump.py

Tier definitions live in version_rules.py (shared with the pre-commit
auto-bumper, scripts/bump_versions.py — with the hook installed this
check should never fire; it's the backstop for commits made without
hooks, e.g. via the GitHub web UI).

  webapp   webapp/package.json   `.version`
  worker   backend/package.json  `.version`
  schema   backend/migrations/   a NEW numbered .sql file is the bump

Pure-doc PRs (README, handoff, *.md, docs/) are exempt. Exits non-zero
if ANY touched tier skipped its bump, with `::error::` annotations the
GitHub UI surfaces in the file diff.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))

from version_rules import SCHEMA_DIR, TIERS, bump_patch, is_doc_file


def package_json_version(content: str) -> Optional[str]:
    try:
        return str(json.loads(content)["version"])
    except (KeyError, json.JSONDecodeError):
        return None


def sh(cmd: list[str]) -> str:
    """Run `cmd`, return stdout. Raises on non-zero exit."""
    out = subprocess.check_output(cmd, text=True, stderr=subprocess.PIPE)
    return out


def diff_files(base_ref: str) -> list[str]:
    """All paths touched in this PR vs. `base_ref`."""
    out = sh(["git", "diff", "--name-only", f"{base_ref}...HEAD"])
    return [line.strip() for line in out.splitlines() if line.strip()]


def added_files(base_ref: str) -> list[str]:
    """Subset of diff_files that's NEW (status A)."""
    out = sh([
        "git", "diff", "--name-only", "--diff-filter=A",
        f"{base_ref}...HEAD",
    ])
    return [line.strip() for line in out.splitlines() if line.strip()]


def show_at(path: str, ref: str) -> Optional[str]:
    """`git show ref:path` — returns None when the file doesn't exist
    at that ref (e.g. the version file was added in this PR)."""
    try:
        return sh(["git", "show", f"{ref}:{path}"])
    except subprocess.CalledProcessError:
        return None


def check_schema(touched: list[str], added: list[str]) -> Optional[str]:
    """Return an error message if backend/migrations/ was touched but
    no NEW migration file was added (schema "version" = highest
    numbered migration file)."""
    touched_migrations = [
        p for p in touched
        if p.startswith(SCHEMA_DIR) and not is_doc_file(p)
    ]
    if not touched_migrations:
        return None
    new_migrations = [
        p for p in added
        if p.startswith(SCHEMA_DIR) and p.endswith(".sql")
    ]
    if new_migrations:
        return None
    return (
        f"{SCHEMA_DIR} touched without a new migration .sql file. "
        "Schema changes need a new numbered migration; edit-in-place "
        "would skip Wrangler's d1_migrations tracker and fail to apply "
        "in production."
    )


def main() -> int:
    base_ref = os.environ.get("BASE_REF", "origin/main")
    # Allow callers to pass `main` and we'll prepend `origin/`. In CI
    # we run with fetch-depth: 0 so origin/main is materialised.
    if "/" not in base_ref:
        base_ref = f"origin/{base_ref}"

    try:
        files = diff_files(base_ref)
    except subprocess.CalledProcessError as e:
        print(f"::error::git diff failed: {e.stderr}", file=sys.stderr)
        return 2

    if not files:
        print("No files changed — nothing to check.")
        return 0

    errors: list[tuple[str, str]] = []

    for tier in TIERS:
        touched = [p for p in files if tier.matches(p)]
        if not touched:
            continue

        head_content = show_at(tier.version_file, "HEAD")
        base_content = show_at(tier.version_file, base_ref)

        if head_content is None:
            errors.append((
                tier.name,
                f"{tier.version_file} not found at HEAD",
            ))
            continue
        if base_content is None:
            # Version file is new to this PR — that's a bump by
            # definition. Nothing to compare against.
            continue

        head_v = package_json_version(head_content)
        base_v = package_json_version(base_content)
        if head_v is None or base_v is None:
            errors.append((
                tier.name,
                f"could not parse version from {tier.version_file}",
            ))
            continue
        if head_v == base_v:
            sample = ", ".join(touched[:3])
            more = f" (+{len(touched) - 3} more)" if len(touched) > 3 else ""
            errors.append((
                tier.name,
                f"{tier.version_file} version unchanged ({head_v}). "
                f"This PR touches {len(touched)} file(s) in {tier.name} "
                f"({sample}{more}); bump the patch version (e.g. {head_v} → "
                f"{bump_patch(head_v)}), or install the auto-bump hook "
                f"(pnpm install sets core.hooksPath).",
            ))

    try:
        added = added_files(base_ref)
    except subprocess.CalledProcessError as e:
        print(f"::error::git diff --diff-filter=A failed: {e.stderr}",
              file=sys.stderr)
        return 2
    schema_err = check_schema(files, added)
    if schema_err:
        errors.append(("schema", schema_err))

    if errors:
        for name, msg in errors:
            print(f"::error title=Missing version bump ({name})::{msg}",
                  file=sys.stderr)
        return 1

    print("All touched tiers bumped their version.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
