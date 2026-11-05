# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A call's context names the workspace's time zone, as the runtime sends it (pack protocol 2.12.0)."""

from __future__ import annotations

from kindgi import ToolContext
from kindgi.pack.context import Cancellation


def test_the_context_reads_the_time_zone_from_the_wire() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "timeZone": "America/Toronto"}, Cancellation()
    )
    assert ctx.time_zone == "America/Toronto"


def test_an_older_runtime_or_a_call_outside_a_turn_gives_none() -> None:
    older = ToolContext.from_wire({"tenantId": "t-1", "runId": "r-1"}, Cancellation())
    assert older.time_zone is None
    not_text = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "timeZone": 5}, Cancellation()
    )
    assert not_text.time_zone is None


def test_a_unit_test_passes_its_own() -> None:
    assert ToolContext.for_test(time_zone="Asia/Tokyo").time_zone == "Asia/Tokyo"
