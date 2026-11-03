# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`corrections.export`: the export's body, handed on in chunks as it arrives.

It's the one operation with the streamed-bytes kind (`x-kindgi-streamed`): the
request goes out on the first read, the chunks are yielded as they come, and
stopping early closes the answer. Nothing is retried.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Generator, Iterator

import httpx
import pytest

from kindgi.client import (
    AsyncKindgi,
    AuthError,
    Kindgi,
    NetworkError,
    NotFoundError,
    ServerError,
)

AGENT_ID = "6ccd0eca-40b4-4b86-b8f5-24b0900dddda"
HEADER = b"id,projectId,runId,agentVersion,madeBy\r\n"
ROWS = [b"c-1,p-1,r-1,3,user:u-1\r\n", b"c-2,p-1,r-2,3,user:u-2\r\n"]

Handler = Callable[[httpx.Request], httpx.Response]


class Chunks(httpx.SyncByteStream, httpx.AsyncByteStream):
    """Sends `chunks` one at a time, then drops the connection if `drop`; records how far it got and whether it was closed."""

    def __init__(self, chunks: list[bytes], *, drop: bool = False) -> None:
        self.chunks = chunks
        self.drop = drop
        self.sent = 0
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.chunks:
            self.sent += 1
            yield chunk
        if self.drop:
            raise httpx.ReadError("connection reset")

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.sent += 1
            yield chunk
        if self.drop:
            raise httpx.ReadError("connection reset")

    def close(self) -> None:
        self.closed = True

    async def aclose(self) -> None:
        self.closed = True


def csv_answer(stream: Chunks) -> httpx.Response:
    return httpx.Response(200, stream=stream, headers={"content-type": "text/csv; charset=utf-8"})


def error_answer(status: int, code: str, message: str) -> httpx.Response:
    return httpx.Response(status, json={"error": {"code": code, "message": message}})


def client(answer: httpx.Response) -> tuple[Kindgi, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert not seen, "a second request: the export is never retried"
        seen.append(request)
        return answer

    http = httpx.Client(transport=httpx.MockTransport(handler))
    return Kindgi("http://kindgi.test", token="kgi_bt_test", http_client=http), seen


def async_client(answer: httpx.Response) -> tuple[AsyncKindgi, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert not seen, "a second request: the export is never retried"
        seen.append(request)
        return answer

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return AsyncKindgi("http://kindgi.test", token="kgi_bt_test", http_client=http), seen


def test_export_yields_the_body_in_its_chunks_from_one_request() -> None:
    stream = Chunks([HEADER, *ROWS])
    api, seen = client(csv_answer(stream))
    chunks = api.corrections.export(
        agent_id=AGENT_ID,
        format="csv",
        status=["not-fixed", "fixed"],
        since="2026-10-01T00:00:00Z",
        until="2026-11-01T00:00:00Z",
    )
    assert seen == []  # the request goes out on the first read
    assert list(chunks) == [HEADER, *ROWS]
    assert len(seen) == 1
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/v1/corrections/export"
    assert seen[0].url.params["agentId"] == AGENT_ID
    assert seen[0].url.params["format"] == "csv"
    assert seen[0].url.params.get_list("status") == ["not-fixed", "fixed"]
    assert seen[0].url.params["until"] == "2026-11-01T00:00:00Z"
    assert "limit" not in seen[0].url.params
    assert stream.closed


def test_stopping_early_closes_the_answer_without_reading_on() -> None:
    stream = Chunks([HEADER, *ROWS])
    api, _ = client(csv_answer(stream))
    chunks = api.corrections.export(agent_id=AGENT_ID)
    assert isinstance(chunks, Generator)  # so the caller can close it
    assert next(chunks) == HEADER
    chunks.close()  # what dropping the iterator after a `break` does
    assert stream.closed
    assert stream.sent == 1


def test_an_error_answer_raises_before_any_chunk() -> None:
    api, seen = client(error_answer(403, "permission-denied", 'Not allowed to read project "p-9".'))
    with pytest.raises(AuthError) as raised:
        list(api.corrections.export(agent_id=AGENT_ID, scope_kind="project", scope_id="p-9"))
    assert raised.value.reason == "forbidden"
    assert 'project "p-9"' in str(raised.value)
    assert len(seen) == 1


def test_a_500_is_raised_not_retried() -> None:
    api, seen = client(
        error_answer(
            500, "persistence-error", "The export couldn't be recorded, so nothing was sent."
        )
    )
    with pytest.raises(ServerError, match="couldn't be recorded"):
        list(api.corrections.export(agent_id=AGENT_ID))
    assert len(seen) == 1


def test_a_drop_mid_stream_is_a_network_error_after_the_chunks_that_came() -> None:
    api, seen = client(csv_answer(Chunks([HEADER, ROWS[0]], drop=True)))
    received: list[bytes] = []
    with pytest.raises(NetworkError, match=r"corrections\.export: the stream dropped"):
        for chunk in api.corrections.export(agent_id=AGENT_ID):
            received.append(chunk)
    assert received == [HEADER, ROWS[0]]
    assert len(seen) == 1


def test_the_async_client_yields_the_chunks_too() -> None:
    async def scenario() -> None:
        stream = Chunks([HEADER, *ROWS])
        api, seen = async_client(csv_answer(stream))
        async with api:
            chunks: AsyncIterator[bytes] = api.corrections.export(agent_id=AGENT_ID, format="jsonl")
            assert [c async for c in chunks] == [HEADER, *ROWS]
        assert len(seen) == 1
        assert seen[0].url.params["format"] == "jsonl"
        assert stream.closed

    asyncio.run(scenario())


def test_the_async_client_closes_the_answer_when_the_caller_stops_early() -> None:
    async def scenario() -> None:
        stream = Chunks([HEADER, *ROWS])
        api, _ = async_client(csv_answer(stream))
        async with api:
            chunks = api.corrections.export(agent_id=AGENT_ID)
            assert isinstance(chunks, AsyncGenerator)  # so the caller can close it
            assert await chunks.__anext__() == HEADER
            await chunks.aclose()
            assert stream.closed
            assert stream.sent == 1

    asyncio.run(scenario())


def test_the_async_client_raises_an_error_answer_and_a_drop() -> None:
    async def scenario() -> None:
        api, _ = async_client(error_answer(404, "not-found", "No agent"))
        async with api:
            with pytest.raises(NotFoundError):
                [c async for c in api.corrections.export(agent_id=AGENT_ID)]

        api, _ = async_client(csv_answer(Chunks([HEADER], drop=True)))
        async with api:
            with pytest.raises(NetworkError, match=r"corrections\.export: the stream dropped"):
                [c async for c in api.corrections.export(agent_id=AGENT_ID)]

    asyncio.run(scenario())
