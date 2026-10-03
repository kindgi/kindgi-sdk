# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`python -m kindgi.pack index …` / `python -m kindgi.pack serve …`."""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence
from pathlib import Path

USAGE = """usage:
  python -m kindgi.pack index --pack-dir <path> [--config <pyproject.toml>] [--output <index.json>]
                              [--artifact-version <str>] [--published-at <iso>] [--json]
  python -m kindgi.pack serve [--index <path>] [--module-root <dir>] [--host <address>]"""


def _index(argv: Sequence[str]) -> int:
    from .index import run_indexer

    options: dict[str, str] = {}
    flags = {"--pack-dir", "--config", "--output", "--artifact-version", "--published-at"}
    as_json = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--json":
            as_json = True
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
        return 0 if outcome["kind"] == "ok" else 1
    if outcome["kind"] == "err":
        error = outcome["error"]
        print(f"kindgi.pack index: {error['code']}: {error['message']}", file=sys.stderr)
        return 1
    print(json.dumps(outcome["value"], indent=2))
    return 0


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
