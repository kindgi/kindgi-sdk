# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import ToolContext, tool


@tool(
    id="conformance.read",
    reads_files=True,
    input={
        "type": "object",
        "properties": {"artifactId": {"type": "string"}},
        "required": ["artifactId"],
        "additionalProperties": False,
    },
    output={
        "type": "object",
        "properties": {"read": {"type": "boolean"}, "answer": {"type": "object"}},
        "required": ["read"],
    },
)
def read(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Reads a file as text, and answers what the read answered."""
    # No read: the call came from a runtime before pack protocol 2.10.0.
    if ctx.files is None or not ctx.files.reads:
        return {"read": False}
    answer = ctx.files.read(input["artifactId"])
    if answer.data is not None:
        return {"read": True, "answer": {"text": answer.data.decode()}}
    return {"read": True, "answer": {"notRead": answer.not_read}}
