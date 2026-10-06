# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool reads the settings blocks its calling agent version pins, as the runtime sends them."""

from __future__ import annotations

from kindgi import ToolContext
from kindgi.pack.context import Cancellation


def test_the_context_reads_settings_by_block_id() -> None:
    ctx = ToolContext.from_wire(
        {
            "tenantId": "t-1",
            "runId": "r-1",
            "settings": {"acme.weights": {"recency": 0.7, "relevance": 0.3}},
        },
        Cancellation(),
    )
    assert ctx.settings["acme.weights"]["recency"] == 0.7


def test_none_pinned_and_an_older_runtime_give_empty_settings() -> None:
    older = ToolContext.from_wire({"tenantId": "t-1", "runId": "r-1"}, Cancellation())
    assert dict(older.settings) == {}


def test_a_unit_test_passes_its_own() -> None:
    ctx = ToolContext.for_test(settings={"acme.weights": {"recency": 1}})
    assert ctx.settings["acme.weights"]["recency"] == 1
