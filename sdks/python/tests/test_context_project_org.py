# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A call's context and a check's trace name the run's project and org, as the runtime sends them."""

from __future__ import annotations

from kindgi import RunTrace, ToolContext
from kindgi.pack.context import Cancellation


def test_the_context_reads_the_project_and_org_from_the_wire() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "projectId": "project-1", "orgId": "org-1"},
        Cancellation(),
    )
    assert (ctx.project_id, ctx.org_id) == ("project-1", "org-1")


def test_a_project_without_an_org_and_an_older_runtime_give_none() -> None:
    no_org = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "projectId": "project-1"}, Cancellation()
    )
    assert (no_org.project_id, no_org.org_id) == ("project-1", None)
    older = ToolContext.from_wire({"tenantId": "t-1", "runId": "r-1"}, Cancellation())
    assert (older.project_id, older.org_id) == (None, None)


def test_a_unit_test_passes_its_own() -> None:
    ctx = ToolContext.for_test(project_id="project-1", org_id="org-1")
    assert (ctx.project_id, ctx.org_id) == ("project-1", "org-1")


def test_the_trace_has_the_org() -> None:
    trace = RunTrace.model_validate(
        {"runId": "r-1", "tenantId": "t-1", "projectId": "project-1", "orgId": "org-1"}
    )
    assert (trace.project_id, trace.org_id) == ("project-1", "org-1")
