# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import ToolFailure, tool


@tool(id="conformance.fails-on-purpose")
def fails_on_purpose(input: dict[str, Any]) -> dict[str, Any]:
    """Fails the call on purpose: no order Z-9."""
    code = "Order Not Found" if input.get("bad") is True else "order-not-found"
    raise ToolFailure(code, "No order Z-9", details={"orderId": "Z-9"})
