# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A comparison eval run's result, read as the OpenAPI `JudgedComparisonResult`."""

from __future__ import annotations

from ._models import EvalRun, JudgedComparisonResult

__all__ = ["comparison_of"]


def comparison_of(run: EvalRun) -> JudgedComparisonResult | None:
    """A comparison's result, typed: its `summary` and each case (`per_case`).

    `run` is a `judged` eval run (a test set compared with a version). `None`
    for another kind of eval run, a dry run, or one that hasn't finished.
    The same reading as `comparisonOf` in the TypeScript client.
    """
    result = run.result
    if run.kind != "judged" or not isinstance(result, dict) or "summary" not in result:
        return None
    return JudgedComparisonResult.model_validate(result)
