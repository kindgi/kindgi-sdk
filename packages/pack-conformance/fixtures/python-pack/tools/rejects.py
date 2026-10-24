# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import tool


@tool(
    id="conformance.rejects",
    needs_spec={
        "connections": {
            "mail": {"app": "google", "permissions": ["gmail.send"], "as": "person"},
        },
    },
)
def rejects(input: dict[str, Any]) -> dict[str, Any]:
    """Says the app refused the connection mail, or wraps that refusal."""
    # Imported here, not at the top: the 0.1.1 compatibility suite indexes
    # this pack with an SDK that has no ConnectionRejected, and never calls it.
    from kindgi import ConnectionRejected

    refused = ConnectionRejected("mail", "refused")
    if input.get("wrapped") is True:
        raise RuntimeError("send failed") from refused
    raise refused
