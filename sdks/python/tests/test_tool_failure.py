# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`ToolFailure`: a tool fails a call on purpose, with its own code and words for a person.

The class's rules, and the pack service's answer: `tool-failed`, with the tool's code as
`reason`, its message as written and its details, and no `cause`.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from kindgi import ToolFailure
from kindgi.pack.index import run_indexer
from kindgi.pack.service import PackService

TOOLS = """
from typing import Any
from kindgi import ToolFailure, tool

@tool(id="acme.get-order")
def get_order(input: dict[str, Any]) -> dict[str, Any]:
    "Looks an order up."
    if input.get("bad"):
        raise ToolFailure("Order Not Found", "No order Z-9")
    if input.get("bare"):
        raise ToolFailure("order-not-found", "No order Z-9")
    raise ToolFailure("order-not-found", "No order Z-9", details={"orderId": "Z-9"})
"""


def test_keeps_its_code_its_message_as_written_and_a_json_copy_of_its_details() -> None:
    given = {"orderId": "Z-9", "lines": (1, 2)}
    failure = ToolFailure("order-not-found", "No order Z-9", details=given)
    assert isinstance(failure, Exception)
    assert failure.code == "order-not-found"
    assert failure.message == "No order Z-9"
    assert str(failure) == "No order Z-9"
    assert failure.details == {"orderId": "Z-9", "lines": [1, 2]}
    assert failure.details is not given


def test_has_no_details_when_it_was_given_none() -> None:
    assert ToolFailure("order-not-found", "No order Z-9").details is None


def test_cuts_its_message_at_1000_characters() -> None:
    assert len(ToolFailure("too-long", "x" * 1500).message) == 1000
    assert ToolFailure("too-long", "x" * 999 + "😀😀").message == "x" * 999 + "😀"


@pytest.mark.parametrize(
    "code", ["Order-Not-Found", "9-orders", "order_not_found", "", "a" + "b" * 64]
)
def test_refuses_a_code_that_isnt_kebab_case(code: str) -> None:
    with pytest.raises(ValueError, match="kebab case"):
        ToolFailure(code, "No order Z-9")


def test_takes_a_code_of_exactly_64_characters() -> None:
    assert len(ToolFailure("a" + "b" * 63, "No order Z-9").code) == 64


@pytest.mark.parametrize("message", ["", "   "])
def test_refuses_an_empty_message(message: str) -> None:
    with pytest.raises(ValueError, match='ToolFailure "order-not-found" needs a message'):
        ToolFailure("order-not-found", message)


@pytest.mark.parametrize(
    ("details", "why"),
    [
        (["Z-9"], "must be a JSON object"),
        ("Z-9", "must be a JSON object"),
        ({"at": object()}, "aren't JSON"),
        ({"ratio": float("nan")}, "aren't JSON"),
    ],
)
def test_refuses_details_that_arent_a_json_object(details: Any, why: str) -> None:
    with pytest.raises(ValueError, match=why):
        ToolFailure("order-not-found", "No order Z-9", details=details)


def test_refuses_details_of_more_than_4_kib_as_json_and_takes_4_kib_exactly() -> None:
    # {"note":"…"} is 11 bytes around the note.
    def at(size: int) -> dict[str, str]:
        return {"note": "x" * (size - 11)}

    assert ToolFailure("too-big", "No order Z-9", details=at(4096)).details == at(4096)
    with pytest.raises(ValueError, match="take 4097 bytes as JSON, more than 4096"):
        ToolFailure("too-big", "No order Z-9", details=at(4097))


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def http(make_pack: Callable[..., Path]) -> AsyncIterator[httpx.AsyncClient]:
    root = make_pack({"tools/tools.py": TOOLS})
    outcome = run_indexer(root, artifact_version="1.1", published_at="2026-10-01T00:00:00.000Z")
    assert outcome["kind"] == "ok" and outcome["value"]["fileErrors"] == [], outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    service = PackService(index, root, "tok", logger=lambda _record: None)
    assert service.prewarm() == []
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as client:
        yield client
    service.close()


async def call(http: httpx.AsyncClient, input: dict[str, Any]) -> dict[str, Any]:
    message = {
        "v": 2,
        "kind": "invoke",
        "tool": {"id": "acme.get-order"},
        "input": input,
        "ctx": {"tenantId": "t", "runId": "r"},
    }
    headers = {"kindgi-pack-token": "tok", "content-type": "application/json"}
    response = await http.post("/v1/invoke", json=message, headers=headers)
    assert response.status_code == 200
    answer: dict[str, Any] = response.json()
    return answer


@pytest.mark.anyio
async def test_the_service_answers_tool_failed_with_the_tools_code_words_and_details(
    http: httpx.AsyncClient,
) -> None:
    assert await call(http, {}) == {
        "v": 2,
        "kind": "error",
        "code": "tool-failed",
        "message": "No order Z-9",
        "toolId": "acme.get-order",
        "reason": "order-not-found",
        "details": {"orderId": "Z-9"},
    }


@pytest.mark.anyio
async def test_the_answer_has_no_details_when_the_tool_gave_none(http: httpx.AsyncClient) -> None:
    assert await call(http, {"bare": True}) == {
        "v": 2,
        "kind": "error",
        "code": "tool-failed",
        "message": "No order Z-9",
        "toolId": "acme.get-order",
        "reason": "order-not-found",
    }


@pytest.mark.anyio
async def test_a_tool_failure_the_class_refuses_is_a_handler_throw_that_says_why(
    http: httpx.AsyncClient,
) -> None:
    answer = await call(http, {"bad": True})
    assert answer["code"] == "handler-throw"
    assert "ToolFailure's code must be kebab case" in answer["message"]
