# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Pack protocol v2 — the messages a runtime exchanges with a pack service.

The contract is `@kindgi/specs/pack-protocol.schema.json`; this module is its
Python side. A request names a tool or check by id; the pack service resolves
it from its own index. One request, one response: every outcome of running
pack code is a response message, and transport problems are HTTP statuses.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal, cast

__all__ = [
    "PACK_HEADERS",
    "PACK_PROTOCOL_VERSION",
    "CheckInvoke",
    "PackErrorCode",
    "ToolInvoke",
    "pack_error",
    "parse_request",
]

PACK_PROTOCOL_VERSION: Final = 2

PackErrorCode = Literal[
    "input-validation-failed",
    "output-validation-failed",
    "handler-import-failed",
    "handler-shape-invalid",
    "handler-throw",
    "check-shape-invalid",
    "malformed-message",
    "unknown-protocol-version",
    "unexpected-message-kind",
    "tool-not-in-pack",
    "check-not-in-pack",
    "tool-version-mismatch",
    "deadline-exceeded",
    "cancelled",
]


class _Headers:
    """HTTP headers of the v2 transport (lower case, as HTTP/1.1 servers see them)."""

    protocol: Final = "kindgi-protocol"
    token: Final = "kindgi-pack-token"
    timeout_ms: Final = "kindgi-timeout-ms"
    run_id: Final = "kindgi-run-id"
    request_id: Final = "kindgi-request-id"
    artifact_version: Final = "kindgi-artifact-version"
    duration_ms: Final = "kindgi-duration-ms"


PACK_HEADERS: Final = _Headers()


@dataclass(frozen=True, slots=True)
class ToolInvoke:
    tool_id: str
    tool_version: str | None
    input: Any
    ctx: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class CheckInvoke:
    check_id: str
    config: Mapping[str, Any]
    trace: Any


def pack_error(code: PackErrorCode, message: str, **extra: Any) -> dict[str, Any]:
    """An error response message. `extra` adds `toolId`, `checkId`, `cause`, `issues`."""
    return {
        "v": PACK_PROTOCOL_VERSION,
        "kind": "error",
        "code": code,
        "message": message,
        **{key: value for key, value in extra.items() if value is not None},
    }


def parse_request(value: Any) -> ToolInvoke | CheckInvoke | dict[str, Any]:
    """A decoded request body as a request, or the error message to answer with."""
    if not isinstance(value, dict):
        return pack_error("malformed-message", "Message must be a JSON object")
    message = cast("dict[str, Any]", value)
    version = message.get("v")
    if isinstance(version, bool) or version != PACK_PROTOCOL_VERSION:
        return pack_error(
            "unknown-protocol-version",
            f"Expected protocol v{PACK_PROTOCOL_VERSION}, got {_json_repr(version)}",
        )
    kind = message.get("kind")
    if kind == "invoke":
        return _parse_tool_invoke(message)
    if kind == "check-invoke":
        return _parse_check_invoke(message)
    return pack_error("unexpected-message-kind", f"Unknown request kind {_json_repr(kind)}")


def _parse_tool_invoke(message: dict[str, Any]) -> ToolInvoke | dict[str, Any]:
    tool = message.get("tool")
    if not isinstance(tool, dict):
        return pack_error("malformed-message", "`tool.id` is required")
    tool_ref = cast("dict[str, Any]", tool)
    tool_id = tool_ref.get("id")
    if not isinstance(tool_id, str) or tool_id == "":
        return pack_error("malformed-message", "`tool.id` is required")
    version = tool_ref.get("version")
    if version is not None and not isinstance(version, str):
        return pack_error("malformed-message", "`tool.version` must be a string")
    ctx = message.get("ctx")
    if (
        not isinstance(ctx, dict)
        or not isinstance(cast("dict[str, Any]", ctx).get("tenantId"), str)
        or not isinstance(cast("dict[str, Any]", ctx).get("runId"), str)
    ):
        return pack_error("malformed-message", "`ctx` needs string `tenantId` and `runId`")
    return ToolInvoke(
        tool_id=tool_id,
        tool_version=version,
        input=message.get("input"),
        ctx=cast("dict[str, Any]", ctx),
    )


def _parse_check_invoke(message: dict[str, Any]) -> CheckInvoke | dict[str, Any]:
    check = message.get("check")
    check_id = cast("dict[str, Any]", check).get("id") if isinstance(check, dict) else None
    if not isinstance(check_id, str) or check_id == "":
        return pack_error("malformed-message", "`check.id` is required")
    config = message.get("config")
    if not isinstance(config, dict):
        return pack_error("malformed-message", "`config` must be an object")
    return CheckInvoke(
        check_id=check_id,
        config=cast("dict[str, Any]", config),
        trace=message.get("trace"),
    )


def _json_repr(value: Any) -> str:
    import json

    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return repr(value)
