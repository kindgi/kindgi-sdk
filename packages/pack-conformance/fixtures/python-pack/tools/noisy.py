# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

import sys
from typing import Any

from kindgi import tool


@tool(id="conformance.noisy", output={"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]})
def noisy(input: dict[str, Any]) -> dict[str, Any]:
    """Writes to stdout and stderr, then succeeds."""
    print("noisy: a line on stdout")
    print('{"v":2,"kind":"result","output":{"ok":false}}')
    print("noisy: a line on stderr", file=sys.stderr)
    return {"ok": True}
