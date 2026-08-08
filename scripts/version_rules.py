#!/usr/bin/env python3
"""Single source of truth for tier/versioning rules.

Consumed by:
  bump_versions.py       — pre-commit auto-bump (writes versions)
  check_version_bump.py  — CI gate (verifies versions)

Tiers and their version sources:
  webapp   webapp/package.json   `.version`
  worker   backend/package.json  `.version`
  schema   backend/migrations/   the numbered .sql filename IS the
                                 version — no file to bump, so it has
                                 no Tier entry here; both consumers
                                 special-case it via SCHEMA_DIR.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

# Doc-only files never trigger a version change.
DOC_SUFFIXES = (".md", ".txt")
DOC_PATHS = (
    "gigsy-handoff.md",
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/",
)

SCHEMA_DIR = "backend/migrations/"


def is_doc_file(path: str) -> bool:
    return path.endswith(DOC_SUFFIXES) or any(
        path == p or path.startswith(p) for p in DOC_PATHS
    )


def _in_webapp(p: str) -> bool:
    return p.startswith("webapp/") and not is_doc_file(p)


def _in_worker(p: str) -> bool:
    # backend/migrations/ is the SCHEMA tier; the worker tier excludes
    # it so a pure-migration change only concerns schema.
    return p.startswith("backend/") and not p.startswith(SCHEMA_DIR) and not is_doc_file(p)


@dataclass(frozen=True)
class Tier:
    name: str
    version_file: str
    _matches: Callable[[str], bool] = field(repr=False)

    def matches(self, path: str) -> bool:
        # The tier's own package.json counts too (dependency edits are
        # real changes). No bump loop: the bumper skips tiers whose
        # staged version already differs from HEAD.
        return self._matches(path)


TIERS: list[Tier] = [
    Tier(name="webapp", version_file="webapp/package.json", _matches=_in_webapp),
    Tier(name="worker", version_file="backend/package.json", _matches=_in_worker),
]


def bump_patch(v: str) -> str:
    """Next patch version (M.m.p → M.m.p+1). Best-effort; if the
    version doesn't look like semver we append '.1' so callers still
    produce a changed value."""
    parts = v.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        return f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"
    return f"{v}.1"
