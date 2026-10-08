# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool reads the env values it declares (`needs_spec["env"]`), as the runtime resolves them."""

from __future__ import annotations

import pytest

from kindgi import ToolContext
from kindgi.pack.context import Cancellation


def test_the_context_reads_env_by_name() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "env": {"ACME_BASE_URL": "https://a.example"}},
        Cancellation(),
    )
    assert ctx.env["ACME_BASE_URL"] == "https://a.example"


def test_the_values_are_read_only() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "env": {"A": "1"}}, Cancellation()
    )
    with pytest.raises(TypeError):
        ctx.env["A"] = "2"  # type: ignore[index]


def test_no_env_declared_and_an_older_runtime_give_empty_env() -> None:
    older = ToolContext.from_wire({"tenantId": "t-1", "runId": "r-1"}, Cancellation())
    assert dict(older.env) == {}


def test_a_unit_test_passes_its_own() -> None:
    ctx = ToolContext.for_test(env={"ACME_REGION": "eu"})
    assert ctx.env["ACME_REGION"] == "eu"
