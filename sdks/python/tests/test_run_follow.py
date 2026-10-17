# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`runs.follow` and `runs.follow_progress`: a run's stream through to its end (T328).

The server ends a run's stream after its terminal event, or after 5 minutes
while the run goes on. `follow` reconnects with `Last-Event-Id` in the second
case; `stream` stays the plain operation and ends when the server closes.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any

import httpx
import pytest

from kindgi.client import AsyncKindgi, Kindgi, NetworkError, NotFoundError, models

RUN_ID = "6ccd0eca-40b4-4b86-b8f5-24b0900dddda"
TENANT_ID = "f531e37d-f29f-463c-81d2-ffad65e4d4e9"


def event(seq: int, kind: str = "run.step-completed") -> dict[str, Any]:
    return {
        "eventId": f"{RUN_ID}:{seq}",
        "runId": RUN_ID,
        "tenantId": TENANT_ID,
        "timestamp": "2026-10-01T14:07:42.379Z",
        "kind": kind,
        "sequence": seq,
    }


def sse(*events: dict[str, Any]) -> bytes:
    return "".join(
        f"id: {e['eventId']}\nevent: run\ndata: {json.dumps(e)}\n\n" for e in events
    ).encode()


def answer(*events: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, content=sse(*events), headers={"content-type": "text/event-stream"})


class ThenFail(httpx.SyncByteStream):
    """Delivers `body`, then fails the test if anything reads on: the server keeps it open."""

    def __init__(self, body: bytes) -> None:
        self.body = body

    def __iter__(self) -> Iterator[bytes]:
        yield self.body
        raise AssertionError("read past the terminal event")


Handler = Callable[[httpx.Request], httpx.Response]


def serve(*responses: httpx.Response) -> Handler:
    """Answer each connection with the next response; one more connection fails the test."""
    queue = list(responses)

    def handler(_: httpx.Request) -> httpx.Response:
        assert queue, "a connection after the last expected one"
        return queue.pop(0)

    return handler


def client(handler: Handler) -> tuple[Kindgi, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    http = httpx.Client(transport=httpx.MockTransport(record))
    return Kindgi("http://kindgi.test", token="kgi_bt_test", http_client=http), seen


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr("kindgi.client._base.time.sleep", slept.append)
    return slept


def test_follow_reconnects_after_the_last_event_until_the_run_ends(sleeps: list[float]) -> None:
    api, seen = client(
        serve(
            answer(event(1, "run.started"), event(2)),  # the server's time limit
            answer(event(3)),  # again
            answer(event(4), event(5, "run.completed")),
        )
    )
    received = list(api.runs.follow(RUN_ID))
    assert [e.sequence for e in received] == [1, 2, 3, 4, 5]
    assert all(isinstance(e, models.RunEvent) for e in received)
    assert [r.headers.get("last-event-id") for r in seen] == [None, f"{RUN_ID}:2", f"{RUN_ID}:3"]
    assert all(r.url.path == f"/v1/runs/{RUN_ID}/stream" for r in seen)
    assert sleeps == []  # every connection brought events: no pause


def test_stream_stays_the_plain_operation_and_ends_when_the_server_closes() -> None:
    api, seen = client(serve(answer(event(1, "run.started"), event(2))))
    assert [e.sequence for e in api.runs.stream(RUN_ID)] == [1, 2]
    assert len(seen) == 1


@pytest.mark.parametrize("terminal", ["run.completed", "run.failed", "run.cancelled"])
def test_follow_ends_after_the_terminal_event_even_if_the_server_keeps_the_stream_open(
    terminal: str,
) -> None:
    body = sse(event(1, "run.started"), event(2, terminal))
    api, seen = client(serve(httpx.Response(200, stream=ThenFail(body))))
    assert [e.kind for e in api.runs.follow(RUN_ID)] == ["run.started", terminal]
    assert len(seen) == 1


def test_follow_starts_after_a_given_last_event_id() -> None:
    api, seen = client(serve(answer(event(8, "run.completed"))))
    assert [e.sequence for e in api.runs.follow(RUN_ID, last_event_id=f"{RUN_ID}:7")] == [8]
    assert seen[0].headers["last-event-id"] == f"{RUN_ID}:7"


def test_a_connection_with_no_events_pauses_before_reconnecting(sleeps: list[float]) -> None:
    api, seen = client(serve(answer(event(1)), answer(), answer(event(2, "run.completed"))))
    assert [e.sequence for e in api.runs.follow(RUN_ID)] == [1, 2]
    assert sleeps == [0.5]
    assert seen[2].headers["last-event-id"] == f"{RUN_ID}:1"


class Dropping(httpx.SyncByteStream):
    """Delivers `body`, then the connection drops."""

    def __init__(self, body: bytes) -> None:
        self.body = body

    def __iter__(self) -> Iterator[bytes]:
        yield self.body
        raise httpx.ReadError("connection reset")


def test_a_drop_or_a_503_is_retried_with_backoff(sleeps: list[float]) -> None:
    api, seen = client(
        serve(
            httpx.Response(200, stream=Dropping(sse(event(1)))),
            httpx.Response(503, json={"error": {"code": "unavailable", "message": "busy"}}),
            answer(event(2, "run.completed")),
        )
    )
    assert [e.sequence for e in api.runs.follow(RUN_ID)] == [1, 2]
    assert sleeps == [0.5, 1.0]
    assert [r.headers.get("last-event-id") for r in seen] == [None, f"{RUN_ID}:1", f"{RUN_ID}:1"]


def test_a_4xx_on_reconnect_is_raised_not_retried(sleeps: list[float]) -> None:
    api, seen = client(
        serve(
            answer(event(1)),
            httpx.Response(404, json={"error": {"code": "not-found", "message": "No run"}}),
        )
    )
    received: list[int] = []
    with pytest.raises(NotFoundError):
        for e in api.runs.follow(RUN_ID):
            received.append(e.sequence)
    assert received == [1]
    assert len(seen) == 2


def test_after_ten_failed_attempts_in_a_row_a_network_error(sleeps: list[float]) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    api, seen = client(refuse)
    with pytest.raises(NetworkError, match=r"runs\.follow: the stream dropped 10 times"):
        list(api.runs.follow(RUN_ID))
    assert len(seen) == 11
    assert sleeps == [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0, 30.0]


def test_follow_progress_follows_the_progress_stream(sleeps: list[float]) -> None:
    progress = [{k: v for k, v in event(n).items() if k != "tenantId"} for n in (1, 2)]
    progress[1]["kind"] = "run.completed"
    api, seen = client(serve(answer(progress[0]), answer(progress[1])))
    received = list(api.runs.follow_progress(RUN_ID))
    assert [e.kind for e in received] == ["run.step-completed", "run.completed"]
    assert all(isinstance(e, models.RunProgressEvent) for e in received)
    assert all(r.url.path == f"/v1/runs/{RUN_ID}/progress/stream" for r in seen)


def test_the_async_client_follows_too(monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_sleep(_: float) -> None:
        return None

    monkeypatch.setattr("kindgi.client._base.asyncio.sleep", no_sleep)

    async def scenario() -> None:
        respond = serve(answer(event(1)), answer(), answer(event(2, "run.failed")))
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return respond(request)

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        async with AsyncKindgi("http://kindgi.test", token="t", http_client=http) as api:
            events: AsyncIterator[models.RunEvent] = api.runs.follow(RUN_ID)
            assert [e.sequence async for e in events] == [1, 2]
        assert seen[2].headers["last-event-id"] == f"{RUN_ID}:1"

    asyncio.run(scenario())
