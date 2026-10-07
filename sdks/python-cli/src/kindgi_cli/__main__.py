# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`kindgi`: run the CLI this wheel carries with the Node that nodejs-wheel-binaries ships."""

from __future__ import annotations

import os
import sys
from pathlib import Path

#: The CLI, as npm installs it (node_modules/@kindgi/cli): the CLI then knows
#: it's a published one.
CLI = Path(__file__).parent / "_cli" / "node_modules" / "@kindgi" / "cli" / "dist" / "cli.js"


def node_path() -> str:
    """The node binary nodejs-wheel-binaries installed."""
    import nodejs_wheel.executable as nodejs

    root = Path(nodejs.__file__).parent
    return str(root / "node.exe") if os.name == "nt" else str(root / "bin" / "node")


def command(argv: list[str]) -> list[str]:
    """The node command line for `kindgi <argv>`."""
    return [node_path(), str(CLI), *argv]


def main() -> None:
    """Run the CLI. The CLI is told it's the PyPI one (`KINDGI_CLI_INSTALL=pypi`):
    its hints then say `uv run kindgi`, not npx."""
    argv = command(sys.argv[1:])
    env = {**os.environ, "KINDGI_CLI_INSTALL": "pypi"}
    if os.name == "nt":
        import subprocess

        sys.exit(subprocess.call(argv, env=env))
    # POSIX: become node, so Ctrl+C and SIGTERM reach the CLI itself. A Python
    # parent would turn Ctrl+C into KeyboardInterrupt and kill the CLI
    # mid-shutdown (`kindgi dev` stops its runtime first).
    os.execve(argv[0], argv, env)


if __name__ == "__main__":
    main()
