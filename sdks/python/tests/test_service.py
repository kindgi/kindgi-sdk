# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The pack service in-process (ASGI) — the Python-specific behaviour.

The protocol itself is covered black-box by `@kindgi/pack-conformance`; these
tests pin what only Python has: sync handlers in threads, asyncio
cancellation, pydantic validators, check-result shapes.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from collections.abc import AsyncIterator, Callable, Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest

from kindgi.pack.index import run_indexer
from kindgi.pack.service import PackService

TOOLS = """
import asyncio
import time
from typing import Any
from pydantic import BaseModel, field_validator
from kindgi import ToolContext, tool

EVENTS: list[str] = []

class Range(BaseModel):
    low: int
    high: int

    @field_validator("high")
    @classmethod
    def above_low(cls, value: int) -> int:
        if value < 10:
            raise ValueError("high must be at least 10")
        return value

@tool(id="t.range")
def range_tool(input: Range) -> dict[str, int]:
    "Spans a range."
    return {"span": input.high - input.low}

@tool(id="t.blocking")
def blocking(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    "Blocks a thread."
    time.sleep(input["seconds"])
    EVENTS.append(f"blocking done, cancelled={ctx.cancellation.cancelled}")
    return {}

@tool(id="t.cooperative")
def cooperative(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    "Waits on its cancellation."
    if ctx.cancellation.wait(5):
        EVENTS.append(f"cooperative stopped: {ctx.cancellation.reason}")
    return {}

@tool(id="t.async")
async def async_tool(input: dict[str, Any]) -> dict[str, Any]:
    "Awaits."
    try:
        await asyncio.sleep(5)
    except asyncio.CancelledError:
        EVENTS.append("async cancelled")
        raise
    return {}

@tool(id="t.not-json")
def not_json(input: dict[str, Any]) -> Any:
    "Returns something JSON can't hold."
    return {"value": object()}

@tool(id="t.raw", input={"type": "object", "properties": {"n": {"type": "integer"}}}, output={"type": "object"})
def raw(input: dict[str, Any]) -> dict[str, Any]:
    "Takes the raw input."
    return {"type": type(input).__name__, "n": input.get("n")}
"""

CHECKS = """
from typing import Any
from pydantic import BaseModel
from kindgi import RunTrace, guardrail

class Config(BaseModel):
    word: str

@guardrail(id="g.bool", on_violation="halt")
def as_bool(config: Config, trace: RunTrace) -> bool:
    return config.word in (trace.output or "")

@guardrail(id="g.dict", on_violation="halt")
async def as_dict(config: dict[str, Any], trace: dict[str, Any]) -> dict[str, Any]:
    return {"passed": False, "reason": f"saw {trace['output']}", "attributes": {"n": 1}}

@guardrail(id="g.wrong", on_violation="halt")
def wrong(config: dict[str, Any], trace: RunTrace) -> str:
    return "yes"
"""


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client(
    make_pack: Callable[..., Path],
) -> AsyncIterator[tuple[httpx.AsyncClient, list[Mapping[str, Any]]]]:
    root = make_pack({"tools/tools.py": TOOLS, "guardrails/checks.py": CHECKS})
    outcome = run_indexer(root, artifact_version="1.1", published_at="2026-10-01T00:00:00.000Z")
    assert outcome["kind"] == "ok" and outcome["value"]["fileErrors"] == [], outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    log: list[Mapping[str, Any]] = []
    service = PackService(index, root, "tok", logger=log.append)
    assert service.prewarm() == []
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        yield http, log
    service.close()


def events() -> list[str]:
    return sys.modules["_kindgi_pack.tools.tools"].EVENTS


async def call(
    http: httpx.AsyncClient, message: dict[str, Any], timeout_ms: int | None = None
) -> dict[str, Any]:
    headers = {"kindgi-pack-token": "tok", "content-type": "application/json"}
    if timeout_ms is not None:
        headers["kindgi-timeout-ms"] = str(timeout_ms)
    response = await http.post("/v1/invoke", json=message, headers=headers)
    assert response.status_code == 200
    return response.json()


def tool_call(tool_id: str, input: Any) -> dict[str, Any]:
    return {
        "v": 2,
        "kind": "invoke",
        "tool": {"id": tool_id},
        "input": input,
        "ctx": {"tenantId": "t", "runId": "r"},
    }


def check_call(check_id: str, config: dict[str, Any], output: str) -> dict[str, Any]:
    trace = {
        "runId": "r",
        "tenantId": "t",
        "output": output,
        "toolCalls": [],
        "toolResults": [],
        "modelCalls": [],
        "mode": "runtime",
    }
    return {
        "v": 2,
        "kind": "check-invoke",
        "check": {"id": check_id},
        "config": config,
        "trace": trace,
    }


@pytest.mark.anyio
async def test_a_model_validator_is_part_of_input_validation(client: Any) -> None:
    http, _ = client
    answer = await call(http, tool_call("t.range", {"low": 1, "high": 2}))
    assert answer["code"] == "input-validation-failed"
    (issue,) = answer["issues"]
    assert issue["instancePath"] == "/high" and "at least 10" in issue["message"]
    assert (await call(http, tool_call("t.range", {"low": 1, "high": 11})))["output"] == {
        "span": 10
    }


@pytest.mark.anyio
async def test_a_blocking_sync_handler_answers_at_the_deadline_and_is_logged_when_it_ends(
    client: Any,
) -> None:
    http, log = client
    started = time.monotonic()
    answer = await call(http, tool_call("t.blocking", {"seconds": 0.4}), timeout_ms=100)
    assert answer["code"] == "deadline-exceeded"
    assert time.monotonic() - started < 0.35
    for _ in range(100):
        if any(e["kind"] == "handler-finished-late" for e in log):
            break
        await asyncio.sleep(0.02)
    late = [e for e in log if e["kind"] == "handler-finished-late"]
    assert late and late[0]["id"] == "t.blocking" and late[0]["target"] == "tool"
    assert "blocking done, cancelled=True" in events()


@pytest.mark.anyio
async def test_a_sync_handler_sees_its_cancellation(client: Any) -> None:
    http, _ = client
    answer = await call(http, tool_call("t.cooperative", {}), timeout_ms=100)
    assert answer["code"] == "deadline-exceeded"
    for _ in range(100):
        if "cooperative stopped: deadline-exceeded" in events():
            break
        await asyncio.sleep(0.02)
    assert "cooperative stopped: deadline-exceeded" in events()


@pytest.mark.anyio
async def test_an_async_handler_is_cancelled(client: Any) -> None:
    http, log = client
    answer = await call(http, tool_call("t.async", {}), timeout_ms=100)
    assert answer["code"] == "deadline-exceeded"
    await asyncio.sleep(0.05)
    assert "async cancelled" in events()
    assert not any(e["kind"] == "handler-finished-late" and e["id"] == "t.async" for e in log)


@pytest.mark.anyio
async def test_output_json_cannot_hold(client: Any) -> None:
    http, _ = client
    answer = await call(http, tool_call("t.not-json", {}))
    assert answer["code"] == "output-validation-failed"
    assert "not JSON" in answer["message"]


@pytest.mark.anyio
async def test_a_json_schema_tool_gets_the_raw_input(client: Any) -> None:
    http, _ = client
    assert (await call(http, tool_call("t.raw", {"n": 3})))["output"] == {"type": "dict", "n": 3}


@pytest.mark.anyio
async def test_checks_return_a_bool_a_dict_or_a_check_result(client: Any) -> None:
    http, _ = client
    assert (await call(http, check_call("g.bool", {"word": "hi"}, "hi there")))["result"] == {
        "passed": True
    }
    assert (await call(http, check_call("g.dict", {}, "x")))["result"] == {
        "passed": False,
        "reason": "saw x",
        "attributes": {"n": 1},
    }
    wrong = await call(http, check_call("g.wrong", {}, "x"))
    assert wrong["code"] == "output-validation-failed" and wrong["checkId"] == "g.wrong"


@pytest.mark.anyio
async def test_check_config_is_validated(client: Any) -> None:
    http, _ = client
    answer = await call(http, check_call("g.bool", {}, "x"))
    assert answer["code"] == "input-validation-failed"
    assert answer["issues"][0]["params"] == {"missingProperty": "word"}
    assert answer["message"] == (
        "Check \"g.bool\" config failed validation: must have required property 'word'"
    )


@pytest.mark.anyio
async def test_a_check_config_schema_that_does_not_compile_is_refused(
    make_pack: Callable[..., Path],
) -> None:
    root = make_pack({"guardrails/checks.py": CHECKS})
    outcome = run_indexer(root, artifact_version="1.1", published_at="2026-10-01T00:00:00.000Z")
    assert outcome["kind"] == "ok", outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    for entry in index["guardrails"]:
        if entry["id"] == "g.bool":
            entry["configSchema"] = {"type": "no-such-type"}
    service = PackService(index, root, "tok", logger=lambda _: None)
    assert service.prewarm() == []
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        answer = await call(http, check_call("g.bool", {"word": "x"}, "x"))
    service.close()
    assert answer["code"] == "input-validation-failed"
    assert answer["checkId"] == "g.bool"
    assert answer["message"].startswith('Check "g.bool" config schema failed to compile: ')


@pytest.mark.anyio
async def test_several_versions_of_one_tool_run_side_by_side(
    make_pack: Callable[..., Path],
) -> None:
    def version_module(version: str) -> str:
        return (
            "from kindgi import tool\n"
            f'@tool(id="acme.versioned", version="{version}")\n'
            f"def versioned_{version.replace('.', '_')}(input: dict) -> dict:\n"
            '    """Answers with its own version."""\n'
            f'    return {{"version": "{version}"}}\n'
        )

    root = make_pack(
        {"tools/v1.py": version_module("1.0.0"), "tools/v2.py": version_module("2.0.0")}
    )
    outcome = run_indexer(root, artifact_version="1.1", published_at="2026-10-01T00:00:00.000Z")
    assert outcome["kind"] == "ok" and outcome["value"]["fileErrors"] == [], outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    service = PackService(index, root, "tok")
    assert service.prewarm() == []
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        for version in ("1.0.0", "2.0.0"):
            message = {
                **tool_call("acme.versioned", {}),
                "tool": {"id": "acme.versioned", "version": version},
            }
            assert (await call(http, message)) == {
                "v": 2,
                "kind": "result",
                "output": {"version": version},
            }
        unnamed = await call(http, tool_call("acme.versioned", {}))
        assert unnamed["code"] == "tool-version-mismatch"
        assert "1.0.0, 2.0.0" in unnamed["message"] and "named none" in unnamed["message"]
        info = (await http.get("/v1/info", headers={"kindgi-pack-token": "tok"})).json()
        assert {"id": "acme.versioned", "version": "1.0.0"} in info["tools"]
        assert {"id": "acme.versioned", "version": "2.0.0"} in info["tools"]
    service.close()
