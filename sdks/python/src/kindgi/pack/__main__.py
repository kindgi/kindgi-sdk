# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`python -m kindgi.pack index …` / `python -m kindgi.pack serve …`."""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

USAGE = """usage:
  python -m kindgi.pack index --pack-dir <path> [--config <pyproject.toml>] [--output <index.json>]
                              [--artifact-version <str>] [--published-at <iso>] [--json]
                              [--strict]
  python -m kindgi.pack serve [--index <path>] [--module-root <dir>] [--host <address>]"""


def _index(argv: Sequence[str]) -> int:
    from .index import run_indexer

    options: dict[str, str] = {}
    flags = {"--pack-dir", "--config", "--output", "--artifact-version", "--published-at"}
    as_json = False
    strict = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--json":
            as_json = True
            i += 1
        elif arg == "--strict":
            strict = True
            i += 1
        elif arg in ("-h", "--help"):
            print(USAGE)
            return 0
        elif arg in flags and i + 1 < len(argv):
            options[arg] = argv[i + 1]
            i += 2
        else:
            print(f"kindgi.pack index: unexpected argument {arg}\n{USAGE}", file=sys.stderr)
            return 2
    if "--pack-dir" not in options:
        print(f"kindgi.pack index: --pack-dir is required\n{USAGE}", file=sys.stderr)
        return 2
    outcome = run_indexer(
        Path(options["--pack-dir"]),
        config_path=Path(options["--config"]) if "--config" in options else None,
        output_path=Path(options["--output"]) if "--output" in options else None,
        artifact_version=options.get("--artifact-version"),
        published_at=options.get("--published-at"),
    )
    if as_json:
        # One line, the shape `kindgi dev` reads from its indexer child.
        print(json.dumps(outcome, separators=(",", ":")))
        if outcome["kind"] != "ok":
            return 1
    elif outcome["kind"] == "err":
        error = outcome["error"]
        print(f"kindgi.pack index: {error['code']}: {error['message']}", file=sys.stderr)
        return 1
    else:
        print(json.dumps(outcome["value"], indent=2))
    file_errors = outcome["value"]["fileErrors"]
    if strict and file_errors:
        return _strict(file_errors)
    return 0


_DEV_GROUP_FIX = (
    "a pack's image installs its main dependencies only (uv sync --no-dev, or Poetry's main "
    "group), so if that module is a package pyproject.toml lists only in a dev group, move it to "
    "[project].dependencies (in a Poetry 1 app, [tool.poetry.dependencies]) and lock again."
)


def _strict(file_errors: Sequence[dict[str, Any]]) -> int:
    """`--strict`'s report and exit code: each file error, then the likely fix for a missing module.

    A pack image's build runs the indexer with `--strict`, after the CLI's own index of the same
    files had no file errors. So a module that won't import there most likely imports a package
    the image doesn't install. A helper module whose name starts with `_` (`tools/_db.py`) and
    won't import doesn't fail the build on its own: a module that imports it fails too, since a
    failed import isn't kept and the next one fails again. If it defines tools itself, they're
    left out of this index, and the build stops when the index is checked against the local one.
    """
    failing = [e for e in file_errors if not _helper_import_failed(e)]
    for error in file_errors:
        print(f"kindgi.pack index: {error['code']}: {error['message']}", file=sys.stderr)
        if _helper_import_failed(error):
            print(
                f"kindgi.pack index: {error['filePath']}'s name starts with an underscore, so on "
                "its own this doesn't fail the build: a file that imports it fails too. If it "
                "defines tools itself, they're missing from this index, and the build stops "
                "when it's checked against the local one.",
                file=sys.stderr,
            )
    if _a_module_is_missing(failing):
        hint = f"a file above imports a module that isn't installed here: {_DEV_GROUP_FIX}"
    elif _a_module_is_missing(file_errors):
        hint = (
            "a module above whose name starts with an underscore imports a module that isn't "
            f"installed here. If it defines tools, they're left out: {_DEV_GROUP_FIX}"
        )
    else:
        hint = None
    if hint is not None:
        print(f"kindgi.pack index: {hint}", file=sys.stderr)
    return 1 if failing else 0


def _a_module_is_missing(file_errors: Sequence[Mapping[str, Any]]) -> bool:
    return any(e.get("cause", {}).get("name") == "ModuleNotFoundError" for e in file_errors)


def _helper_import_failed(error: Mapping[str, Any]) -> bool:
    """A helper module's import failure: a discovered file whose name starts with `_`."""
    return error["code"] == "file-import-failed" and Path(error["filePath"]).name.startswith("_")


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help"):
        print(USAGE)
        return 0 if args else 2
    command, rest = args[0], args[1:]
    if command == "index":
        return _index(rest)
    if command == "serve":
        from .serve import main as serve_main

        return serve_main(rest)
    print(f"kindgi.pack: unknown command {command}\n{USAGE}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
