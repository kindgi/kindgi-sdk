# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The Python pack service's records: a record per call with the call's ids and the caller's
trace, the handler's `ctx.log` beneath it, the lifecycle whatever the levels, and a context
that never prints its secrets. The TypeScript service's twin
(`handler-runtime/tests/pack-service-records.test.ts`)."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from kindgi import ToolContext
from kindgi.log import LogConfigError, create_logger
from kindgi.pack.index import run_indexer
from kindgi.pack.records import pack_service_logs
from kindgi.pack.service import PackService

SECRET = "s3cret-value-for-acme"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN = "00f067aa0ba902b7"

TOOLS = f'''
from typing import Any
from kindgi import ToolContext, tool

@tool(id="acme.logs", mutating=False)
def logs(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Logs a lookup, and reports what its context shows."""
    ctx.log.info("looked up order", {{"orderId": input["orderId"]}})
    return {{
        "repr_has_secret": "{SECRET}" in repr(ctx),
        "has_secret": ctx.secrets.get("API_KEY") == "{SECRET}",
    }}
'''


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def service(
    make_pack: Callable[..., Path],
) -> AsyncIterator[tuple[httpx.AsyncClient, list[str]]]:
    root = make_pack({"tools/tools.py": TOOLS})
    outcome = run_indexer(root, artifact_version="20261008.1", published_at="2026-10-08T00:00:00Z")
    assert outcome["kind"] == "ok" and outcome["value"]["fileErrors"] == [], outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    lines: list[str] = []
    logs, _ = pack_service_logs({"KINDGI_LOG_LEVEL": "debug"}, write=lines.append)
    pack = PackService(
        index,
        root,
        "tok",
        logger=lambda _event: None,
        log=logs.log.child(packId=index.get("packId"), artifactVersion="20261008.1"),
    )
    assert pack.prewarm() == []
    transport = httpx.ASGITransport(app=pack)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        yield http, lines
    pack.close()


async def invoke(http: httpx.AsyncClient) -> dict[str, Any]:
    response = await http.post(
        "/v1/invoke",
        json={
            "v": 2,
            "kind": "invoke",
            "tool": {"id": "acme.logs"},
            "input": {"orderId": "o-42"},
            "ctx": {
                "tenantId": "t-1",
                "runId": "run-1",
                "requestId": "call-1",
                "secrets": {"API_KEY": SECRET},
            },
        },
        headers={
            "kindgi-pack-token": "tok",
            "content-type": "application/json",
            "traceparent": f"00-{TRACE_ID}-{PARENT_SPAN}-01",
        },
    )
    assert response.status_code == 200
    return response.json()["output"]


@pytest.mark.anyio
async def test_a_call_one_record_with_its_ids_and_trace_and_ctx_log_beneath(
    service: tuple[httpx.AsyncClient, list[str]],
) -> None:
    http, lines = service
    await invoke(http)
    records = [json.loads(line) for line in lines]
    call = next(r for r in records if r.get("event") == "call")
    assert call["level"] == "info"
    assert call["subsystem"] == "pack"
    assert call["kind"] == "call"
    assert call["outcome"] == "ok"
    assert (call["tenantId"], call["runId"], call["requestId"]) == ("t-1", "run-1", "call-1")
    assert call["traceId"] == TRACE_ID
    assert len(call["spanId"]) == 16 and call["spanId"] != PARENT_SPAN
    assert call["toolId"] == "acme.logs" and call["target"] == "tool"
    assert call["message"].startswith("tool acme.logs ok ")

    authored = next(r for r in records if r["message"] == "looked up order")
    assert authored["subsystem"] == "pack.tool"
    assert authored["orderId"] == "o-42"
    assert (authored["runId"], authored["traceId"]) == ("run-1", TRACE_ID)
    assert "event" not in authored


@pytest.mark.anyio
async def test_the_context_never_shows_its_secrets(
    service: tuple[httpx.AsyncClient, list[str]],
) -> None:
    http, lines = service
    output = await invoke(http)
    assert output == {"repr_has_secret": False, "has_secret": True}
    assert SECRET not in "\n".join(lines)
    assert SECRET not in repr(ToolContext.for_test(secrets={"API_KEY": SECRET}))


def test_the_lifecycle_is_written_at_any_level_with_kind_for_older_supervisors() -> None:
    lines: list[str] = []
    logs, _ = pack_service_logs({"KINDGI_LOG_LEVEL": "error"}, write=lines.append)
    logs.log.info("a call", {"event": "call"})
    logs.event("listening", "Listening on port 1", port=1, packId="acme")
    (record,) = (json.loads(line) for line in lines)
    assert record["event"] == record["kind"] == "listening"
    assert (record["port"], record["subsystem"], record["level"]) == (1, "pack", "info")


def test_json_for_a_supervisor_even_in_dev_mode_and_a_bad_level_refused() -> None:
    lines: list[str] = []
    logs, _ = pack_service_logs({"KINDGI_DEV": "true"}, write=lines.append)
    logs.event("stopped", "Stopped")
    assert json.loads(lines[0])["event"] == "stopped"
    with pytest.raises(LogConfigError, match="KINDGI_LOG_LEVEL"):
        pack_service_logs({"KINDGI_LOG_LEVEL": "loud"}, write=lines.append)


def test_a_level_for_a_subsystem_pack_code_logs_under_is_no_problem() -> None:
    _, problems = pack_service_logs(
        {"KINDGI_LOG_LEVELS": "billing=debug,pack=warn"}, write=lambda _line: None
    )
    assert problems == []


def test_a_test_context_logs_nowhere_unless_given_a_logger() -> None:
    ToolContext.for_test().log.info("nothing written")
    lines: list[str] = []
    ctx = ToolContext.for_test(log=create_logger(write=lines.append))
    ctx.log.info("written")
    assert json.loads(lines[0])["message"] == "written"
