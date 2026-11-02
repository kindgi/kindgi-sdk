# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from typing import Any

from kindgi import RunTrace, guardrail


# The runtime judges an llm-judge guardrail with a model, by its `config`; it never calls this check.
@guardrail(
    id="conformance.judged",
    check_id="conformance.checks.judged",
    kind="llm-judge",
    on_violation="log-only",
    config={"rubric": "The reply answers the message.", "responseFormat": "pass-fail"},
    judge_capabilities={"needs": [{"feature": "structured-output"}]},
)
def judged(config: dict[str, Any], trace: RunTrace) -> bool:
    return True
