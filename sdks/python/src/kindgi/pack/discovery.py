# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Discovery globs — which files under a pack root are primitives.

Same syntax and semantics as `@kindgi/handler-runtime`'s `discovery.ts`:
`**` (any depth, including none), `*` (within one segment), `?` (one
character), `{a,b}` alternation. Each pattern is walked from its static
prefix only, so a pack embedded in a large application (`kindgi/**`) never
crawls the whole repository.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path

__all__ = ["TEST_FILE", "discover", "glob_static_prefix", "glob_to_regex"]

_GLOB_CHARS = re.compile(r"[*?{\[]")

# Tests sit next to primitives and are never primitives.
TEST_FILE = re.compile(r"(?:^|/)(?:test_[^/]*|[^/]*_test|conftest)\.py$")

# Never walked: virtualenvs, caches, vendored trees.
_SKIP_DIRS = frozenset({"node_modules", "__pycache__", "venv", "site-packages"})


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    out: list[str] = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*" and pattern[i + 1 : i + 2] == "*":
            if pattern[i + 2 : i + 3] == "/":
                out.append("(?:.*/)?")
                i += 3
            else:
                out.append(".*")
                i += 2
            continue
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "{" and (close := pattern.find("}", i)) != -1:
            options = pattern[i + 1 : close].split(",")
            out.append("(?:" + "|".join(re.escape(o) for o in options) + ")")
            i = close + 1
            continue
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("^" + "".join(out) + "$")


def glob_static_prefix(pattern: str) -> str:
    segments = pattern.split("/")
    first_glob = next((i for i, s in enumerate(segments) if _GLOB_CHARS.search(s)), -1)
    dirs = segments[:-1] if first_glob == -1 else segments[:first_glob]
    return "/".join(s for s in dirs if s not in ("", "."))


def discover(root: Path, pattern: str) -> list[str]:
    """Relative `/`-separated paths under `root` matching `pattern`, tests excluded."""
    regex = glob_to_regex(pattern)
    prefix = glob_static_prefix(pattern)
    start = root / prefix if prefix else root
    matches: list[str] = []
    for rel in _walk(root, start):
        if regex.match(rel) and not TEST_FILE.search(rel):
            matches.append(rel)
    return matches


def _walk(root: Path, start: Path) -> Iterable[str]:
    if not start.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(start):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in _SKIP_DIRS)
        base = Path(dirpath).relative_to(root).as_posix()
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            yield name if base == "." else f"{base}/{name}"
