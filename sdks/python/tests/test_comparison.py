# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`comparison_of` reads a comparison eval run's result as the OpenAPI `JudgedComparisonResult`."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from kindgi.client import comparison_of, models

# A comparison's result as the runtime returns it.
RESULT: dict[str, Any] = {
    "summary": {
        "evalRunId": "er-1",
        "status": "completed",
        "completedAt": "2026-10-06T08:00:00.000Z",
        "suite": {"id": "acme.set", "version": "1.0.0"},
        "candidate": {
            "kind": "flow",
            "flowId": "acme.intake",
            "version": "1.1.0",
            "versions": {"agents": {"acme.drafter": "0.2.0"}},
        },
        "baseline": {
            "kind": "recorded",
            "versions": [{"flowId": "acme.intake", "version": "1.0.0", "cases": 2}],
        },
        "scope": {"projectId": "p-1"},
        "cases": 2,
        "diverged": 0,
        "refusedWrites": 1,
        "errors": 0,
        "stopped": 1,
        "reads": "recorded",
        "sampling": {"models": [{"providerId": "acme", "model": "m-1", "runs": 1}]},
        "repetitions": 1,
        "metrics": {
            "weightedYesShare": {
                "baseline": 0.5,
                "candidate": 0.75,
                "delta": 0.25,
                "n": 2,
                "weight": 2,
                "baselineN": 2,
                "baselineWeight": 2,
                "direction": "higher",
            },
            "judgedCoverage": {
                "baseline": 1,
                "candidate": 1,
                "delta": 0,
                "n": 2,
                "weight": 2,
                "baselineN": 2,
                "baselineWeight": 2,
                "direction": "higher",
            },
            "weightedPrecisionAtK": {
                "baseline": 0.5,
                "candidate": 0.75,
                "delta": 0.25,
                "n": 2,
                "weight": 2,
                "baselineN": 2,
                "baselineWeight": 2,
                "direction": "higher",
                "k": 10,
            },
        },
    },
    "perCase": [
        {
            "caseId": "run-1",
            "runIds": ["replay-1"],
            "baseline": {
                "yesWeight": 1,
                "totalWeight": 2,
                "items": 2,
                "judgedItems": 2,
                "topK": {"yesWeight": 1, "totalWeight": 2},
            },
            "candidate": [
                {
                    "yesWeight": 1.5,
                    "totalWeight": 2,
                    "items": 2,
                    "judgedItems": 2,
                    "topK": {"yesWeight": 1.5, "totalWeight": 2},
                }
            ],
            "changes": {
                "kept": [{"key": "m1", "rankBefore": 0, "rank": 0}],
                "dropped": [],
                "new": [{"key": "m3", "pointer": "/matches/1", "rank": 1}],
            },
            "tools": [
                {
                    "step": 0,
                    "callId": "look",
                    "toolId": "acme.lookup",
                    "toolVersion": "1.0.0",
                    "arguments": {"q": "x"},
                    "source": "recorded",
                }
            ],
            "diverged": False,
            "refusedWrites": 0,
            "noContext": False,
            "approvalSkipped": False,
        },
        {
            "caseId": "run-2",
            "runIds": ["replay-2"],
            "baseline": {
                "yesWeight": 0,
                "totalWeight": 1,
                "items": 1,
                "judgedItems": 1,
                "topK": {"yesWeight": 0, "totalWeight": 1},
            },
            "candidate": [],
            "changes": {"kept": [], "dropped": [], "new": []},
            "diverged": False,
            "refusedWrites": 1,
            "noContext": False,
            "approvalSkipped": False,
            "stopped": {
                "toolId": "acme.send",
                "arguments": {"to": "desk"},
                "reason": "no recorded result",
            },
        },
    ],
}

RUN: dict[str, Any] = {
    "runId": "00000000-0000-4000-8000-00000000e001",
    "tenantId": "00000000-0000-4000-8000-000000000002",
    "suiteId": "acme.set",
    "suiteVersion": "1.0.0",
    "kind": "judged",
    "flowRef": {"flowId": "acme.intake", "version": "1.1.0"},
    "status": "completed",
    "dryRun": False,
    "startedAt": "2026-10-06T08:00:00Z",
}


def test_reads_a_comparisons_result_typed() -> None:
    result = comparison_of(models.EvalRun.model_validate({**RUN, "result": RESULT}))
    assert result is not None
    assert result.summary.metrics.weighted_yes_share.delta == 0.25
    assert result.summary.stopped == 1
    assert result.per_case[1].stopped is not None
    assert result.per_case[1].stopped.tool_id == "acme.send"


def test_none_for_another_kind_a_dry_run_or_one_not_finished() -> None:
    assert comparison_of(models.EvalRun.model_validate({**RUN, "kind": "accuracy"})) is None
    dry = {**RUN, "dryRun": True, "result": {"dryRun": True, "cases": 2}}
    assert comparison_of(models.EvalRun.model_validate(dry)) is None
    assert comparison_of(models.EvalRun.model_validate({**RUN, "status": "running"})) is None


def test_a_result_that_does_not_fit_is_an_error() -> None:
    broken = {**RESULT, "summary": {**RESULT["summary"], "cases": "two"}}
    with pytest.raises(ValidationError):
        comparison_of(models.EvalRun.model_validate({**RUN, "result": broken}))
