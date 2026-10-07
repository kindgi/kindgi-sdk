# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The transport under `Kindgi` / `AsyncKindgi`: one request, its retries, its answer.

- `Authorization: Bearer <token>` on every call.
- An operation that takes an `Idempotency-Key` gets one generated when the
  caller passes none, so a retry can never run it twice.
- Retries — a connection error or timeout, or 429 / 502 / 503 / 504 — only
  for a call that is safe to repeat (a GET, or one with an idempotency key),
  with exponential backoff that honours `Retry-After`.
- A 2xx answer is validated into the operation's model; anything else
  raises a typed `KindgiApiError`.
- A stream (`text/event-stream`) reconnects with `Last-Event-Id` after a
  drop (backoff 0.5 s → 30 s, up to 10 attempts) and ends when the server
  closes it.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal, cast
from urllib.parse import quote

import httpx
from pydantic import BaseModel, TypeAdapter
from pydantic import ValidationError as PydanticError

from .._version import __version__
from ._errors import KindgiApiError, NetworkError, from_wire
from ._sse import SseParser

__all__ = ["AsyncClientBase", "Operation", "SyncClientBase", "_body", "_segments"]

DEFAULT_TIMEOUT = 60.0
DEFAULT_MAX_RETRIES = 2
RETRY_STATUSES = frozenset({429, 502, 503, 504})
STREAM_ATTEMPTS = 10
# A run's last event: `_follow` ends after it.
TERMINAL_KINDS = frozenset({"run.completed", "run.failed", "run.cancelled"})
# Before reconnecting after a connection that brought no events, so a server
# that keeps closing at once isn't called in a tight loop.
FOLLOW_PAUSE = 0.5


@dataclass(frozen=True)
class Operation:
    id: str
    method: str
    path: str
    response_kind: Literal["json", "sse", "binary", "empty"]
    idempotency_key: bool


@cache
def _adapter(model: Any) -> TypeAdapter[Any]:
    return TypeAdapter(model)


def _segments(path: Sequence[BaseModel | Mapping[str, Any]] | None) -> list[str] | None:
    """A segment path as its repeated query value: one `key:value` per step, coarse to fine.

    Each step is a `ScopeSegment` or a mapping with `key` and `value`.
    """
    if path is None:
        return None
    steps = [step.model_dump() if isinstance(step, BaseModel) else step for step in path]
    return [f"{step['key']}:{step['value']}" for step in steps]


def _body(model: Any, body: Any, fields: Mapping[str, Any]) -> Any:
    """The wire JSON of a request body given as a model, a mapping, or keyword fields."""
    if body is not None and fields:
        raise TypeError("pass the body, or its fields as keywords — not both")
    value = body if body is not None else dict(fields)
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_unset=True)
    adapter = _adapter(model)
    return adapter.dump_python(
        adapter.validate_python(value), mode="json", by_alias=True, exclude_unset=True
    )


def _query_value(value: Any) -> Any:
    if isinstance(value, bool):
        return "true" if value else "false"
    return value


def _is_terminal(data: Any) -> bool:
    return (
        isinstance(data, Mapping) and cast("Mapping[str, Any]", data).get("kind") in TERMINAL_KINDS
    )


def _stream_backoff(op: Operation, attempt: int, cause: object) -> float:
    """How long to wait before a stream's next attempt, or `NetworkError` when it's out of them."""
    if attempt > STREAM_ATTEMPTS:
        raise NetworkError(f"{op.id}: the stream dropped {attempt - 1} times: {cause}") from (
            cause if isinstance(cause, BaseException) else None
        )
    return min(0.5 * 2 ** (attempt - 1), 30.0)


def _backoff(attempt: int, retry_after: str | None) -> float:
    if retry_after is not None:
        try:
            return min(float(retry_after), 60.0)
        except ValueError:
            pass
    return min(0.5 * 2 ** (attempt - 1), 8.0) * (0.75 + random.random() / 2)


class _Common:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float,
        max_retries: int,
        default_headers: Mapping[str, str] | None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.max_retries = max_retries
        self._headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"kindgi-python/{__version__}",
            **(default_headers or {}),
        }

    def _prepare(
        self,
        op: Operation,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
    ) -> tuple[str, dict[str, Any], dict[str, str], bool]:
        url_path = op.path
        for name, value in path.items():
            url_path = url_path.replace("{" + name + "}", quote(str(value), safe=""))
        params = {k: _query_value(v) for k, v in query.items() if v is not None}
        sent = {**self._headers, **{k: str(v) for k, v in headers.items() if v is not None}}
        if op.idempotency_key and "Idempotency-Key" not in sent:
            sent["Idempotency-Key"] = str(uuid.uuid4())
        safe = op.method == "GET" or "Idempotency-Key" in sent
        return self.base_url + url_path, params, sent, safe

    @staticmethod
    def _answer(op: Operation, response: httpx.Response, model: Any) -> Any:
        if not response.is_success:
            try:
                body: Any = response.json()
            except ValueError:
                body = None
            raise from_wire(
                body, response.status_code, retry_after=response.headers.get("retry-after")
            )
        if op.response_kind == "empty" or response.status_code == 204:
            return None
        if op.response_kind == "binary":
            return response.content
        try:
            data = response.json()
        except ValueError as cause:
            raise NetworkError(
                f"{op.id}: the response body is not JSON", status=response.status_code
            ) from cause
        if model is None:
            return data
        try:
            return _adapter(model).validate_python(data)
        except PydanticError as cause:
            raise KindgiApiError(
                f"{op.id}: the response does not match the API's schema: "
                f"{cause.errors()[0]['msg']}",
                status=response.status_code,
                server_code="invalid-response",
            ) from cause

    @staticmethod
    def _event(model: Any, data: Any) -> Any:
        try:
            return _adapter(model).validate_python(data)
        except PydanticError:
            return data


class SyncClientBase(_Common):
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        super().__init__(
            base_url,
            token,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
        )
        self._owns_http = http_client is None
        self._http = http_client or httpx.Client()

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def _request(
        self,
        op: Operation,
        *,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
        body: Any = None,
        files: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        response: Any = None,
        timeout: float | None = None,
    ) -> Any:
        url, params, sent, safe = self._prepare(op, path, query, headers)
        attempt = 0
        while True:
            attempt += 1
            try:
                answer = self._http.request(
                    op.method,
                    url,
                    params=params,
                    headers=sent,
                    json=body,
                    files=files,
                    data=data,
                    timeout=timeout if timeout is not None else self.timeout,
                )
            except httpx.TransportError as cause:
                if safe and attempt <= self.max_retries:
                    time.sleep(_backoff(attempt, None))
                    continue
                raise NetworkError(f"{op.id}: {type(cause).__name__}: {cause}") from cause
            if answer.status_code in RETRY_STATUSES and safe and attempt <= self.max_retries:
                time.sleep(_backoff(attempt, answer.headers.get("retry-after")))
                continue
            return self._answer(op, answer, response)

    def _stream(
        self,
        op: Operation,
        *,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
        response: Any = None,
        timeout: float | None = None,
    ) -> Iterator[Any]:
        url, params, sent, _ = self._prepare(op, path, query, headers)
        sent["Accept"] = "text/event-stream"
        attempt = 0
        while True:
            try:
                with self._http.stream(
                    "GET",
                    url,
                    params=params,
                    headers=sent,
                    timeout=httpx.Timeout(timeout or self.timeout, read=None),
                ) as answer:
                    if not answer.is_success:
                        answer.read()
                        self._answer(op, answer, None)
                    attempt = 0
                    parser = SseParser()
                    for line in answer.iter_lines():
                        event = parser.feed(line)
                        if event is None:
                            continue
                        if event.id is not None:
                            sent["Last-Event-Id"] = event.id
                        yield self._event(response, event.data)
                    return
            except (httpx.TransportError, httpx.StreamError) as cause:
                attempt += 1
                if attempt > STREAM_ATTEMPTS:
                    raise NetworkError(
                        f"{op.id}: the stream dropped {attempt - 1} times: {cause}"
                    ) from cause
                time.sleep(min(0.5 * 2 ** (attempt - 1), 30.0))

    def _follow(
        self,
        op: Operation,
        *,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
        response: Any = None,
        timeout: float | None = None,
    ) -> Iterator[Any]:
        """A run's stream, through to its terminal event.

        The server ends a run's stream after its terminal event, or after a time
        limit while the run goes on. In the second case this reconnects after
        the last event it saw (`Last-Event-Id`), so each event comes once, and
        pauses first when a connection brought none. A dropped connection, 429
        or 502-504 is retried with backoff, as `_stream` retries a drop; any
        other error answer is raised.
        """
        url, params, sent, _ = self._prepare(op, path, query, headers)
        sent["Accept"] = "text/event-stream"
        attempt = 0
        while True:
            received = 0
            retry: object = None
            try:
                with self._http.stream(
                    "GET",
                    url,
                    params=params,
                    headers=sent,
                    timeout=httpx.Timeout(timeout or self.timeout, read=None),
                ) as answer:
                    if answer.status_code in RETRY_STATUSES:
                        retry = f"HTTP {answer.status_code}"
                    else:
                        if not answer.is_success:
                            answer.read()
                            self._answer(op, answer, None)
                        attempt = 0
                        parser = SseParser()
                        for line in answer.iter_lines():
                            event = parser.feed(line)
                            if event is None:
                                continue
                            if event.id is not None:
                                sent["Last-Event-Id"] = event.id
                            received += 1
                            yield self._event(response, event.data)
                            if _is_terminal(event.data):
                                return
            except (httpx.TransportError, httpx.StreamError) as cause:
                retry = cause
            if retry is not None:
                attempt += 1
                time.sleep(_stream_backoff(op, attempt, retry))
            elif received == 0:
                time.sleep(FOLLOW_PAUSE)


class AsyncClientBase(_Common):
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            base_url,
            token,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
        )
        self._owns_http = http_client is None
        self._http = http_client or httpx.AsyncClient()

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def _request(
        self,
        op: Operation,
        *,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
        body: Any = None,
        files: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        response: Any = None,
        timeout: float | None = None,
    ) -> Any:
        url, params, sent, safe = self._prepare(op, path, query, headers)
        attempt = 0
        while True:
            attempt += 1
            try:
                answer = await self._http.request(
                    op.method,
                    url,
                    params=params,
                    headers=sent,
                    json=body,
                    files=files,
                    data=data,
                    timeout=timeout if timeout is not None else self.timeout,
                )
            except httpx.TransportError as cause:
                if safe and attempt <= self.max_retries:
                    await asyncio.sleep(_backoff(attempt, None))
                    continue
                raise NetworkError(f"{op.id}: {type(cause).__name__}: {cause}") from cause
            if answer.status_code in RETRY_STATUSES and safe and attempt <= self.max_retries:
                await asyncio.sleep(_backoff(attempt, answer.headers.get("retry-after")))
                continue
            return self._answer(op, answer, response)

    async def _stream(
        self,
        op: Operation,
        *,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
        response: Any = None,
        timeout: float | None = None,
    ) -> AsyncIterator[Any]:
        url, params, sent, _ = self._prepare(op, path, query, headers)
        sent["Accept"] = "text/event-stream"
        attempt = 0
        while True:
            try:
                async with self._http.stream(
                    "GET",
                    url,
                    params=params,
                    headers=sent,
                    timeout=httpx.Timeout(timeout or self.timeout, read=None),
                ) as answer:
                    if not answer.is_success:
                        await answer.aread()
                        self._answer(op, answer, None)
                    attempt = 0
                    parser = SseParser()
                    async for line in answer.aiter_lines():
                        event = parser.feed(line)
                        if event is None:
                            continue
                        if event.id is not None:
                            sent["Last-Event-Id"] = event.id
                        yield self._event(response, event.data)
                    return
            except (httpx.TransportError, httpx.StreamError) as cause:
                attempt += 1
                if attempt > STREAM_ATTEMPTS:
                    raise NetworkError(
                        f"{op.id}: the stream dropped {attempt - 1} times: {cause}"
                    ) from cause
                await asyncio.sleep(min(0.5 * 2 ** (attempt - 1), 30.0))

    async def _follow(
        self,
        op: Operation,
        *,
        path: Mapping[str, Any],
        query: Mapping[str, Any],
        headers: Mapping[str, Any],
        response: Any = None,
        timeout: float | None = None,
    ) -> AsyncIterator[Any]:
        """`SyncClientBase._follow`, with asyncio."""
        url, params, sent, _ = self._prepare(op, path, query, headers)
        sent["Accept"] = "text/event-stream"
        attempt = 0
        while True:
            received = 0
            retry: object = None
            try:
                async with self._http.stream(
                    "GET",
                    url,
                    params=params,
                    headers=sent,
                    timeout=httpx.Timeout(timeout or self.timeout, read=None),
                ) as answer:
                    if answer.status_code in RETRY_STATUSES:
                        retry = f"HTTP {answer.status_code}"
                    else:
                        if not answer.is_success:
                            await answer.aread()
                            self._answer(op, answer, None)
                        attempt = 0
                        parser = SseParser()
                        async for line in answer.aiter_lines():
                            event = parser.feed(line)
                            if event is None:
                                continue
                            if event.id is not None:
                                sent["Last-Event-Id"] = event.id
                            received += 1
                            yield self._event(response, event.data)
                            if _is_terminal(event.data):
                                return
            except (httpx.TransportError, httpx.StreamError) as cause:
                retry = cause
            if retry is not None:
                attempt += 1
                await asyncio.sleep(_stream_backoff(op, attempt, retry))
            elif received == 0:
                await asyncio.sleep(FOLLOW_PAUSE)
