# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`Kindgi` and `AsyncKindgi` — the clients."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from typing import Any, Protocol, TypeVar

import httpx

from ._base import DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT, AsyncClientBase, SyncClientBase
from ._resources import AsyncResources, Resources

__all__ = ["AsyncKindgi", "Kindgi", "apaginate", "paginate"]

T = TypeVar("T")


def _settings(base_url: str | None, token: str | None) -> tuple[str, str]:
    url = base_url or os.environ.get("KINDGI_API_URL")
    secret = token or os.environ.get("KINDGI_API_TOKEN")
    if not url:
        raise ValueError("pass base_url= or set KINDGI_API_URL")
    if not secret:
        raise ValueError("pass token= or set KINDGI_API_TOKEN")
    return url, secret


class Kindgi(SyncClientBase, Resources):
    """The Kindgi API, synchronously.

        client = Kindgi("http://127.0.0.1:4000", token="kgi_bt_…")
        client = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN
        run = client.runs.start(agent="acme.bookkeeper", input={"userMessage": "hi"})

    Resources follow the API's operation ids (`client.approvals.reviewers.list()`).
    Use it as a context manager, or `close()` it, to release connections.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        url, secret = _settings(base_url, token)
        SyncClientBase.__init__(
            self,
            url,
            secret,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            http_client=http_client,
        )
        Resources.__init__(self)

    def __enter__(self) -> Kindgi:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class AsyncKindgi(AsyncClientBase, AsyncResources):
    """The Kindgi API, with asyncio.

    async with AsyncKindgi() as client:
        run = await client.runs.start(flow="acme.ledger.record-flow", input={...})
        async for event in client.runs.stream(run.id):
            ...
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        url, secret = _settings(base_url, token)
        AsyncClientBase.__init__(
            self,
            url,
            secret,
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            http_client=http_client,
        )
        AsyncResources.__init__(self)

    async def __aenter__(self) -> AsyncKindgi:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()


class _Page(Protocol[T]):
    @property
    def data(self) -> list[T]: ...
    @property
    def has_more(self) -> bool: ...


def _next_cursor(page: Any) -> str | None:
    cursor = getattr(page, "next_cursor", None)
    return cursor if isinstance(cursor, str) and cursor else None


def paginate(list_method: Callable[..., _Page[T]], /, *args: Any, **kwargs: Any) -> Iterator[T]:
    """Every item of a list operation, page after page: `paginate(client.runs.list, limit=50)`."""
    while True:
        page = list_method(*args, **kwargs)
        yield from page.data
        cursor = _next_cursor(page)
        if not page.has_more or cursor is None:
            return
        kwargs["cursor"] = cursor


async def apaginate(
    list_method: Callable[..., Awaitable[_Page[T]]], /, *args: Any, **kwargs: Any
) -> AsyncIterator[T]:
    """`paginate` for `AsyncKindgi`: `async for run in apaginate(client.runs.list): …`."""
    while True:
        page = await list_method(*args, **kwargs)
        for item in page.data:
            yield item
        cursor = _next_cursor(page)
        if not page.has_more or cursor is None:
            return
        kwargs["cursor"] = cursor
