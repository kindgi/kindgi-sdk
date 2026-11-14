# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import ToolContext, tool


@tool(
    id="conformance.update",
    updates_files=True,
    input={
        "type": "object",
        "properties": {
            "fileId": {"type": "string"},
            "expectedVersion": {"type": "integer", "minimum": 1},
            "name": {"type": "string"},
            "contentType": {"type": "string"},
            "text": {"type": "string"},
        },
        "required": ["fileId", "expectedVersion", "contentType", "text"],
        "additionalProperties": False,
    },
    output={
        "type": "object",
        "properties": {"updated": {"type": "boolean"}, "answer": {"type": "object"}},
        "required": ["updated"],
    },
)
def update(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Adds a text as a version of a file, and answers what the update answered."""
    # No update: the call came from a runtime before pack protocol 2.13.0, or has no
    # idempotency key.
    if ctx.files is None or not ctx.files.updates:
        return {"updated": False}
    answer = ctx.files.update(
        file_id=input["fileId"],
        expected_version=input["expectedVersion"],
        name=input.get("name"),
        content_type=input["contentType"],
        data=input["text"].encode(),
    )
    if answer.file is not None:
        return {"updated": True, "answer": {"file": dict(answer.file)}}
    if answer.same is not None:
        return {"updated": True, "answer": {"same": dict(answer.same)}}
    if answer.conflict is not None:
        return {"updated": True, "answer": {"conflict": dict(answer.conflict)}}
    return {"updated": True, "answer": {"notUpdated": answer.not_updated}}
