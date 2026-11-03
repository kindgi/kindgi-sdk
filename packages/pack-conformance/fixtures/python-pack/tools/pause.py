# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import PauseAnswer, ToolContext, tool


@tool(
    id="conformance.pause",
    pauses=True,
    input={
        "type": "object",
        "properties": {"timeoutMs": {}, "name": {}, "answer": {"type": "boolean"}},
        "additionalProperties": False,
    },
    output={
        "type": "object",
        "properties": {"tokenId": {"type": "string"}},
        "required": ["tokenId"],
    },
)
def pause(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any] | PauseAnswer:
    """Pauses for another system's answer, or answers at once with its wait token's id."""
    # Read first: with no wait token, the call fails here.
    token_id = ctx.wait_token.id
    if input.get("answer") is True:
        return {"tokenId": token_id}
    return ctx.pause(timeout_ms=input.get("timeoutMs"), name=input.get("name"))
