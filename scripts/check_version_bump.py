#!/usr/bin/env python3
"""Verify every component touched by this PR bumped its patch version.

Runs as the `version-check` GitHub Actions job (see
.github/workflows/version-check.yml). Local invocation:

    BASE_REF=main python3 scripts/check_version_bump.py

The three tracked components and their version sources:

  webapp         webapp/package.json            `.version`
  worker         backend/package.json           `.version`
  schema         backend/migrations/*.sql       new migration filename

A PR touching `webapp/**` (excluding docs / lockfiles) is required to
bump `webapp/package.json` `.version` vs. the base branch; same for
the worker. Schema is "bumped" by adding a new numbered migration file.

Pure-doc PRs (README, handoff, *.md) are exempt — they don't touch any
component's runtime artefact.

The script exits non-zero if ANY touched component skipped its bump,
with `::error::` annotations the GitHub UI surfaces in the file diff.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Optional


# Doc-only files don't trigger a version bump.
DOC_SUFFIXES = (".md", ".txt")
DOC_PATHS = (
    "gigsy-handoff.md",
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/",
)


def is_doc_file(path: str) -> bool:
    return path.endswith(DOC_SUFFIXES) or any(
        path == p or path.startswith(p) for p in DOC_PATHS
    )


@dataclass
class Check:
    name: str
    # Predicate: does this file path belong to this component?
    matches: Callable[[str], bool]
    # Path to the version-source file (always relative to repo root).
    version_file: str
    # Extract the version string from the file's full content. Returns
    # None if the parser can't find one (parse error / format change).
    extract: Callable[[str], Optional[str]]


def package_json_version(content: str) -> Optional[str]:
    try:
        return str(json.loads(content)["version"])
    except (KeyError, json.JSONDecodeError):
        return None


def in_webapp(p: str) -> bool:
    return p.startswith("webapp/") and not is_doc_file(p)


def in_worker(p: str) -> bool:
    # backend/migrations/ is the SCHEMA component; the worker check
    # excludes it so a pure-migration PR only fails the schema check
    # (not both). All other backend/** counts as worker code.
    return (
        p.startswith("backend/")
        and not p.startswith("backend/migrations/")
        and not is_doc_file(p)
    )


CHECKS: list[Check] = [
    Check(
        name="webapp",
        matches=in_webapp,
        version_file="webapp/package.json",
        extract=package_json_version,
    ),
    Check(
        name="worker",
        matches=in_worker,
        version_file="backend/package.json",
        extract=package_json_version,
    ),
]


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
        if p.startswith("backend/migrations/")
        and not is_doc_file(p)
    ]
    if not touched_migrations:
        return None
    new_migrations = [
        p for p in added
        if p.startswith("backend/migrations/") and p.endswith(".sql")
    ]
    if new_migrations:
        return None
    return (
        "backend/migrations/ touched without a new migration .sql file. "
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

    for check in CHECKS:
        touched = [p for p in files if check.matches(p)]
        if not touched:
            continue

        head_content = show_at(check.version_file, "HEAD")
        base_content = show_at(check.version_file, base_ref)

        if head_content is None:
            errors.append((
                check.name,
                f"{check.version_file} not found at HEAD",
            ))
            continue
        if base_content is None:
            # Version file is new to this PR — that's a bump by
            # definition. Nothing to compare against.
            continue

        head_v = check.extract(head_content)
        base_v = check.extract(base_content)
        if head_v is None or base_v is None:
            errors.append((
                check.name,
                f"could not parse version from {check.version_file}",
            ))
            continue
        if head_v == base_v:
            sample = ", ".join(touched[:3])
            more = f" (+{len(touched) - 3} more)" if len(touched) > 3 else ""
            errors.append((
                check.name,
                f"{check.version_file} version unchanged ({head_v}). "
                f"This PR touches {len(touched)} file(s) in {check.name} "
                f"({sample}{more}); bump the patch version (e.g. {head_v} → "
                f"{_bump_patch(head_v)}).",
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

    print("All touched components bumped their version.")
    return 0


def _bump_patch(v: str) -> str:
    """Suggest the next patch (M.m.p → M.m.p+1). Best-effort; if the
    version doesn't look like semver we just append '.1' so the error
    message stays useful."""
    parts = v.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        return f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"
    return f"{v}.1"


if __name__ == "__main__":
    sys.exit(main())
