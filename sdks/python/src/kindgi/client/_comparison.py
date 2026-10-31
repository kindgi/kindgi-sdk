# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A comparison test run's result, read as the OpenAPI `CorrectedComparisonResult`."""

from __future__ import annotations

from ._models import CorrectedComparisonResult, TestRun

__all__ = ["comparison_of"]


def comparison_of(run: TestRun) -> CorrectedComparisonResult | None:
    """A comparison's result, typed: its `summary` and each case (`per_case`).

    `run` is a `corrections` test run (a test set compared with a version). `None`
    for another kind of test run, a dry run, or one that hasn't finished.
    The same reading as `comparisonOf` in the TypeScript client.
    """
    result = run.result
    if run.kind != "corrections" or not isinstance(result, dict) or "summary" not in result:
        return None
    return CorrectedComparisonResult.model_validate(result)
