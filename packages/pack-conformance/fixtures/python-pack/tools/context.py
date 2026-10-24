# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import TYPE_CHECKING, Any

from kindgi import ToolContext, tool

if TYPE_CHECKING:
    # Imported for its type only: the 0.1.1 compatibility suite indexes this
    # pack with an SDK that has no connections.
    from kindgi import ToolConnection


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
    if ctx.idempotency_key is not None:
        out["idempotencyKey"] = ctx.idempotency_key
    if ctx.project_id is not None:
        out["projectId"] = ctx.project_id
    if ctx.org_id is not None:
        out["orgId"] = ctx.org_id
    if ctx.settings:
        out["settings"] = {block: dict(values) for block, values in ctx.settings.items()}
    if ctx.connections:
        out["connections"] = {name: _connection(c) for name, c in ctx.connections.items()}
    return out


def _connection(c: "ToolConnection") -> dict[str, Any]:
    out: dict[str, Any] = {
        "connectionId": c.connection_id,
        "app": c.app,
        "appName": c.app_name,
        "accessToken": c.access_token,
        "account": {"id": c.account.id, "label": c.account.label},
    }
    if c.expires_at is not None:
        out["expiresAt"] = c.expires_at
    return out
