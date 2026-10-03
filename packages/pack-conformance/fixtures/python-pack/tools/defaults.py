# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import tool

INPUT = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "greeting": {"type": "string", "default": "Hello"},
        "options": {
            "type": "object",
            "properties": {"loud": {"type": "boolean", "default": False}},
            "default": {},
        },
    },
    "required": ["name"],
}


@tool(id="conformance.defaults", input=INPUT, output={"type": "object"})
def defaults(input: dict[str, Any]) -> dict[str, Any]:
    """Returns its input as the handler received it, defaults filled in."""
    return input
