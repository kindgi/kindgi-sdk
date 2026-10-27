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
from .pack.context import (
    CallCancelled,
    Cancellation,
    ConnectionAccount,
    ConnectionRejected,
    PauseAnswer,
    PauseNotAvailable,
    ToolConnection,
    ToolContext,
    WaitToken,
)
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
from .pack.files import (
    MAX_STORED_FILE_BYTES,
    MAX_STORED_FILES_PER_CALL,
    FileStore,
    FileStoreAnswer,
    FileStoreError,
)
from .pack.trace import CheckResult, ModelCallRecord, RunTrace, ToolCallRecord, ToolResultRecord

__all__ = [
    "MAX_STORED_FILES_PER_CALL",
    "MAX_STORED_FILE_BYTES",
    "Agent",
    "CallCancelled",
    "Cancellation",
    "CheckResult",
    "ConnectionAccount",
    "ConnectionRejected",
    "DefinitionError",
    "FileStore",
    "FileStoreAnswer",
    "FileStoreError",
    "Flow",
    "Guardrail",
    "ModelCallRecord",
    "PauseAnswer",
    "PauseNotAvailable",
    "RunTrace",
    "Tool",
    "ToolCallRecord",
    "ToolConnection",
    "ToolContext",
    "ToolResultRecord",
    "WaitToken",
    "__version__",
    "guardrail",
    "http_tool",
    "tool",
]
