# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import ToolContext, tool


@tool(
    id="conformance.store",
    stores_files=True,
    input={
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "contentType": {"type": "string"},
            "text": {"type": "string"},
        },
        "required": ["name", "contentType", "text"],
        "additionalProperties": False,
    },
    output={
        "type": "object",
        "properties": {"stored": {"type": "boolean"}, "answer": {"type": "object"}},
        "required": ["stored"],
    },
)
def store(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Stores a text as a file, and answers what the store answered."""
    # No store: the call came from a runtime before pack protocol 2.10.0.
    if ctx.files is None:
        return {"stored": False}
    answer = ctx.files.store(
        name=input["name"], content_type=input["contentType"], data=input["text"].encode()
    )
    if answer.file is not None:
        return {"stored": True, "answer": {"file": dict(answer.file)}}
    return {"stored": True, "answer": {"notStored": answer.not_stored}}
