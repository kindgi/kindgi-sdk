# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The vendored schemas in `kindgi/_specs` match `@kindgi/specs` (when run inside the repository)."""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path

import pytest

SPECS = Path(__file__).resolve().parents[3] / "packages" / "specs" / "schemas"
VENDORED = sorted(
    p.name for p in resources.files("kindgi._specs").iterdir() if p.name.endswith(".schema.json")
)


@pytest.mark.skipif(not SPECS.is_dir(), reason="not inside the kindgi-sdk repository")
@pytest.mark.parametrize("name", VENDORED)
def test_vendored_schema_matches_the_spec(name: str) -> None:
    vendored = json.loads(resources.files("kindgi._specs").joinpath(name).read_text("utf-8"))
    assert vendored == json.loads((SPECS / name).read_text("utf-8")), (
        f"{name} drifted: copy packages/specs/schemas/{name} to sdks/python/src/kindgi/_specs/"
    )


def test_the_vendored_set() -> None:
    assert VENDORED == [
        "flow.schema.json",
        "pack-index.schema.json",
        "pack-protocol.schema.json",
        "tool.schema.json",
    ]
