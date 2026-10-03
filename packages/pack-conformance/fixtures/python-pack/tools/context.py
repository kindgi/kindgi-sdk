# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import ToolContext, tool


@tool(id="conformance.context")
def context(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Returns the call context it received."""
    out: dict[str, Any] = {
        "tenantId": ctx.tenant_id,
        "runId": ctx.run_id,
        "env": dict(ctx.env),
        "secrets": dict(ctx.secrets),
        "config": dict(ctx.config),
    }
    if ctx.request_id is not None:
        out["requestId"] = ctx.request_id
    return out
