# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool that declares `pauses=True` makes its run wait for another system's answer:
the handler hands `ctx.wait_token.url` on and returns `ctx.pause()`."""

from __future__ import annotations

import json
import sys
from collections.abc import AsyncIterator, Callable, Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from kindgi import DefinitionError, PauseAnswer, PauseNotAvailable, ToolContext, WaitToken, tool
from kindgi.pack.context import MAX_PAUSE_TIMEOUT_MS, Cancellation
from kindgi.pack.index import run_indexer
from kindgi.pack.service import PackService

TOKEN = {"id": "wt_1", "url": "https://kindgi.example/v1/wait-tokens/wt_1/answer?sig=s"}


class Pickup(BaseModel):
    order_id: str


class Confirmed(BaseModel):
    confirmed_at: str


def test_a_pausing_tool_gets_the_calls_wait_token_and_pauses() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t", "runId": "r", "waitToken": TOKEN}, Cancellation(), pauses=True
    )
    assert ctx.wait_token == WaitToken(id="wt_1", url=TOKEN["url"])
    assert ctx.pause(timeout_ms=60_000, name="the pickup") == PauseAnswer(
        timeout_ms=60_000, name="the pickup"
    )
    assert ctx.pause() == PauseAnswer()


def test_a_tool_that_doesnt_pause_never_sees_the_token() -> None:
    ctx = ToolContext.from_wire({"tenantId": "t", "runId": "r", "waitToken": TOKEN}, Cancellation())
    with pytest.raises(PauseNotAvailable):
        ctx.wait_token  # noqa: B018
    with pytest.raises(PauseNotAvailable):
        ctx.pause()


@pytest.mark.parametrize(
    "token",
    [None, {"id": "", "url": "https://x"}, {"id": "wt_1"}, {"id": "wt_1", "url": 3}, "wt_1"],
)
def test_no_token_or_a_malformed_one_is_no_token(token: Any) -> None:
    wire = {"tenantId": "t", "runId": "r", **({} if token is None else {"waitToken": token})}
    ctx = ToolContext.from_wire(wire, Cancellation(), pauses=True)
    with pytest.raises(PauseNotAvailable, match="speaks pack protocol"):
        ctx.wait_token  # noqa: B018


def test_a_unit_test_passes_a_token() -> None:
    token = WaitToken(id="wt_1", url="https://x")
    assert ToolContext.for_test(wait_token=token).wait_token == token
    with pytest.raises(PauseNotAvailable):
        ToolContext.for_test().pause()
    assert "wt_1" not in repr(ToolContext.for_test(wait_token=token))


def test_the_output_schema_is_the_answers_and_the_index_says_it_pauses(
    make_pack: Callable[..., Path],
) -> None:
    @tool(id="acme.carrier.book-pickup", pauses=True)
    def book_pickup(input: Pickup, ctx: ToolContext) -> Confirmed | PauseAnswer:
        "Books a pickup and waits for the carrier's confirmation."
        return ctx.pause()

    assert book_pickup.pauses
    assert book_pickup.output_schema["required"] == ["confirmed_at"]
    assert book_pickup.output_type is Confirmed

    root = make_pack({"tools/pausing.py": PACK})
    entries = {t["id"]: t for t in _index(root)["tools"]}
    assert entries["acme.carrier.book-pickup"]["pauses"] is True
    assert "pauses" not in entries["acme.carrier.quote"]


def test_a_tool_that_returns_a_pause_must_declare_pauses() -> None:
    with pytest.raises(DefinitionError, match="declare it with pauses=True"):

        @tool(id="acme.carrier.book-pickup")
        def book_pickup(input: Pickup, ctx: ToolContext) -> Confirmed | PauseAnswer:
            "Books a pickup."
            return ctx.pause()


def test_a_pausing_tool_names_the_type_of_its_answer() -> None:
    with pytest.raises(DefinitionError, match="name the type of the answer"):

        @tool(id="acme.carrier.book-pickup", pauses=True)
        def book_pickup(input: Pickup, ctx: ToolContext) -> PauseAnswer:
            "Books a pickup."
            return ctx.pause()


PACK = f"""
from typing import Any
from pydantic import BaseModel
from kindgi import PauseAnswer, ToolContext, tool

HANDED_ON: list[str] = []

class Pickup(BaseModel):
    order_id: str
    timeout_ms: Any = None
    name: Any = None
    answer: bool = False

class Confirmed(BaseModel):
    confirmed_at: str

@tool(id="acme.carrier.book-pickup", pauses=True)
def book_pickup(input: Pickup, ctx: ToolContext) -> Confirmed | PauseAnswer:
    "Books a pickup and waits for the carrier's confirmation."
    url = ctx.wait_token.url
    if input.answer:
        return Confirmed(confirmed_at="2026-10-21T15:00:00Z")
    HANDED_ON.append(url)
    return ctx.pause(timeout_ms=input.timeout_ms, name=input.name)

@tool(id="acme.carrier.quote")
def quote(input: Pickup, ctx: ToolContext) -> Any:
    "Quotes a pickup; it doesn't pause."
    if input.answer:
        return PauseAnswer()
    return {{"url": ctx.wait_token.url}}

@tool(id="acme.carrier.direct", pauses=True)
async def direct(input: Pickup) -> Confirmed | PauseAnswer:
    "Pauses without reading its token."
    return PauseAnswer(timeout_ms={MAX_PAUSE_TIMEOUT_MS})
"""


def _index(root: Path) -> dict[str, Any]:
    outcome = run_indexer(root, artifact_version="1.1", published_at="2026-10-01T00:00:00.000Z")
    assert outcome["kind"] == "ok" and outcome["value"]["fileErrors"] == [], outcome
    return json.loads(Path(outcome["value"]["outputPath"]).read_text())


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def client(
    make_pack: Callable[..., Path],
) -> AsyncIterator[tuple[httpx.AsyncClient, list[Mapping[str, Any]]]]:
    root = make_pack({"tools/pausing.py": PACK})
    log: list[Mapping[str, Any]] = []
    service = PackService(_index(root), root, "tok", logger=log.append)
    assert service.prewarm() == []
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        yield http, log
    service.close()


async def call(
    http: httpx.AsyncClient, tool_id: str, input: dict[str, Any], token: Any = TOKEN
) -> dict[str, Any]:
    ctx = {"tenantId": "t", "runId": "r", **({} if token is None else {"waitToken": token})}
    message = {"v": 2, "kind": "invoke", "tool": {"id": tool_id}, "input": input, "ctx": ctx}
    headers = {"kindgi-pack-token": "tok", "content-type": "application/json"}
    response = await http.post("/v1/invoke", json=message, headers=headers)
    assert response.status_code == 200
    return response.json()


@pytest.mark.anyio
async def test_the_service_answers_a_pause(
    client: tuple[httpx.AsyncClient, list[Mapping[str, Any]]],
) -> None:
    http, log = client
    paused = await call(
        http,
        "acme.carrier.book-pickup",
        {"order_id": "o-1", "timeout_ms": 7_200_000, "name": "the carrier's pickup confirmation"},
    )
    assert paused == {
        "v": 2,
        "kind": "pause",
        "timeoutMs": 7_200_000,
        "name": "the carrier's pickup confirmation",
    }
    assert await call(http, "acme.carrier.book-pickup", {"order_id": "o-1"}) == {
        "v": 2,
        "kind": "pause",
    }
    assert await call(http, "acme.carrier.direct", {"order_id": "o-1"}) == {
        "v": 2,
        "kind": "pause",
        "timeoutMs": MAX_PAUSE_TIMEOUT_MS,
    }
    assert [entry["outcome"] for entry in log if entry.get("kind") == "call"] == ["pause"] * 3


@pytest.mark.anyio
async def test_a_pausing_tool_may_answer_at_once(
    client: tuple[httpx.AsyncClient, list[Mapping[str, Any]]],
) -> None:
    http, _ = client
    answered = await call(http, "acme.carrier.book-pickup", {"order_id": "o-1", "answer": True})
    assert answered == {
        "v": 2,
        "kind": "result",
        "output": {"confirmed_at": "2026-10-21T15:00:00Z"},
    }


@pytest.mark.anyio
async def test_without_a_token_the_call_fails_before_it_hands_anything_on(
    client: tuple[httpx.AsyncClient, list[Mapping[str, Any]]],
) -> None:
    http, _ = client
    for tool_id in ("acme.carrier.book-pickup", "acme.carrier.direct"):
        failed = await call(http, tool_id, {"order_id": "o-1"}, token=None)
        assert failed["kind"] == "error" and failed["code"] == "pause-not-available", failed
        assert "sent no wait token" in failed["message"]
        assert failed["toolId"] == tool_id
    assert sys.modules["_kindgi_pack.tools.pausing"].HANDED_ON == []


@pytest.mark.anyio
async def test_a_tool_that_doesnt_declare_pauses_cant_pause(
    client: tuple[httpx.AsyncClient, list[Mapping[str, Any]]],
) -> None:
    http, _ = client
    for answer in (False, True):
        failed = await call(http, "acme.carrier.quote", {"order_id": "o-1", "answer": answer})
        assert failed["code"] == "pause-not-available", failed
        assert "doesn't declare `pauses=True`" in failed["message"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("options", "says"),
    [
        ({"timeout_ms": 0}, "from 1 to"),
        ({"timeout_ms": MAX_PAUSE_TIMEOUT_MS + 1}, "from 1 to"),
        ({"timeout_ms": 1.5}, "whole number"),
        ({"timeout_ms": True}, "whole number"),
        ({"name": ""}, "1 to 200 characters"),
        ({"name": "x" * 201}, "1 to 200 characters"),
    ],
)
async def test_a_pause_out_of_bounds_is_refused(
    client: tuple[httpx.AsyncClient, list[Mapping[str, Any]]], options: dict[str, Any], says: str
) -> None:
    http, _ = client
    failed = await call(http, "acme.carrier.book-pickup", {"order_id": "o-1", **options})
    assert failed["code"] == "handler-shape-invalid", failed
    assert says in failed["message"]
