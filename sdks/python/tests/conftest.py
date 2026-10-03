# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

import textwrap
from collections.abc import Callable
from pathlib import Path

import pytest

PYPROJECT = """
[tool.kindgi.pack]
id = "acme"
version = "1.2.3"
"""


@pytest.fixture
def make_pack(tmp_path: Path) -> Callable[..., Path]:
    """Write a pack: `make_pack({"tools/echo.py": "..."}, pyproject=...)` → its root."""
    counter = iter(range(1_000_000))

    def make(files: dict[str, str], pyproject: str = PYPROJECT) -> Path:
        root = tmp_path / f"pack{next(counter)}"
        root.mkdir()
        (root / "pyproject.toml").write_text(textwrap.dedent(pyproject))
        for rel, text in files.items():
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(textwrap.dedent(text))
        return root

    return make
