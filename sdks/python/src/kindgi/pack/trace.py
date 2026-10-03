# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""What a guardrail check evaluates (`RunTrace`) and returns (`CheckResult`).

Mirrors `RunTrace` / `CheckResult` in `@kindgi/guardrails`. Field names are
snake_case in Python and camelCase on the wire; unknown fields are kept, so a
newer runtime's trace still parses.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

__all__ = ["CheckResult", "ModelCallRecord", "RunTrace", "ToolCallRecord", "ToolResultRecord"]


class _Wire(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="allow")


class ToolCallRecord(_Wire):
    tool_id: str
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    at: str


class ToolResultRecord(_Wire):
    tool_call_id: str
    output: Any = None
    at: str


class ModelCallRecord(_Wire):
    provider_id: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    at: str


class RunTrace(_Wire):
    """The run a check evaluates: its output, tool calls and results, model calls."""

    run_id: str
    tenant_id: str
    project_id: str | None = None
    agent_id: str | None = None
    flow_id: str | None = None
    output: str | None = None
    """Final assistant output text, when the run produced text."""
    tool_calls: list[ToolCallRecord] = Field(default_factory=list[ToolCallRecord])
    tool_results: list[ToolResultRecord] = Field(default_factory=list[ToolResultRecord])
    model_calls: list[ModelCallRecord] = Field(default_factory=list[ModelCallRecord])
    user_input: str | None = None
    retrieved_fact_ids: list[str] | None = None
    conversation_id: str | None = None
    turn_number: int | None = None
    total_cost_usd: float | None = None
    duration_ms: float | None = None
    mode: Literal["ci", "runtime"] = "runtime"
    attributes: dict[str, Any] | None = None


class CheckResult(_Wire):
    """A check's verdict. `passed=False` with a `reason` fires the guardrail's action."""

    passed: bool
    reason: str | None = None
    judge_response: str | None = None
    attributes: dict[str, Any] | None = None

    def to_wire(self) -> dict[str, Any]:
        return self.model_dump(mode="json", by_alias=True, exclude_none=True)
