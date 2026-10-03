# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from pydantic import BaseModel, Field

from kindgi import CheckResult, RunTrace, guardrail


class MinLength(BaseModel):
    minLength: int = Field(1, ge=0)


@guardrail(
    id="conformance.min-length",
    name="Output is long enough",
    check_id="conformance.checks.min-length",
    on_violation="halt",
    severity="error",
)
def min_length(config: MinLength, trace: RunTrace) -> CheckResult:
    length = len((trace.output or "").strip())
    if length >= config.minLength:
        return CheckResult(passed=True)
    return CheckResult(passed=False, reason="too short")


@guardrail(id="conformance.check-throws", check_id="conformance.checks.throws", on_violation="log-only")
def check_throws(config: dict[str, Any], trace: RunTrace) -> bool:
    raise RuntimeError("check boom")
