# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import tool


@tool(id="conformance.bad-output", output={"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]})
def bad_output(input: dict[str, Any]) -> dict[str, Any]:
    """Returns output that breaks its own schema."""
    return {"message": 42}


@tool(id="conformance.throws")
def throws(input: dict[str, Any]) -> dict[str, Any]:
    """Always fails."""
    raise RuntimeError("boom")
