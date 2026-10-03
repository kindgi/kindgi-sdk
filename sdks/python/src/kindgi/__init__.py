# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Kindgi™ for Python.

Write a pack's tools and guardrail checks in Python:

    from kindgi import ToolContext, tool

A tool that is one HTTP request needs no code: `http_tool(...)`.

Agents and flows are data (`Agent`, `Flow`). `python -m kindgi.pack index`
writes the pack's index; `python -m kindgi.pack serve` runs its code for a
Kindgi runtime (`kindgi dev` does both for you).
"""

from __future__ import annotations

from ._version import __version__
from .pack.context import CallCancelled, Cancellation, ToolContext
from .pack.define import (
    Agent,
    DefinitionError,
    Flow,
    Guardrail,
    Tool,
    guardrail,
    http_tool,
    tool,
)
from .pack.trace import CheckResult, ModelCallRecord, RunTrace, ToolCallRecord, ToolResultRecord

__all__ = [
    "Agent",
    "CallCancelled",
    "Cancellation",
    "CheckResult",
    "DefinitionError",
    "Flow",
    "Guardrail",
    "ModelCallRecord",
    "RunTrace",
    "Tool",
    "ToolCallRecord",
    "ToolContext",
    "ToolResultRecord",
    "__version__",
    "guardrail",
    "http_tool",
    "tool",
]
