# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`Kindgi` and `AsyncKindgi` — the clients."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from typing import Any, Protocol, TypeVar

import httpx

from ._base import DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT, AsyncClientBase, SyncClientBase
from ._resources import AsyncResources, Resources
from ._runtime_config import resolve_settings

__all__ = ["AsyncKindgi", "Kindgi", "apaginate", "paginate"]

T = TypeVar("T")


class Kindgi(SyncClientBase, Resources):
    """The Kindgi API, synchronously.

        client = Kindgi("http://127.0.0.1:4000", token="kgi_bt_…")
        client = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN; in development, kindgi dev
        run = client.runs.start(agent="acme.bookkeeper", input={"userMessage": "hi"})

    Resources follow the API's operation ids (`client.approvals.reviewers.list()`).
    Use it as a context manager, or `close()` it, to release connections.

    The URL and token are found when the client is first used (its first request, or
    `base_url` / `token`), not when it's created: a module-scope `Kindgi()` loads in a
    build step that runs without them. If they're still missing then, that use raises
    `ValueError`, naming what to set.
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
        SyncClientBase.__init__(
            self,
            lambda: resolve_settings(base_url, token),
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
        async for event in client.runs.follow(run.id):  # to the run's end
            ...

    Like `Kindgi`, it finds its URL and token on first use, not when it's created.
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
        AsyncClientBase.__init__(
            self,
            lambda: resolve_settings(base_url, token),
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
    def has_more(self) -> bool | None: ...


def _next_cursor(page: Any) -> str | None:
    cursor = getattr(page, "next_cursor", None)
    return cursor if isinstance(cursor, str) and cursor else None


def _has_more(page: _Page[Any], cursor: str | None) -> bool:
    """`has_more`; from an older server without it, whether there's a cursor."""
    return page.has_more if page.has_more is not None else cursor is not None


def paginate(list_method: Callable[..., _Page[T]], /, *args: Any, **kwargs: Any) -> Iterator[T]:
    """Every item of a list operation, page after page: `paginate(client.runs.list, limit=50)`."""
    while True:
        page = list_method(*args, **kwargs)
        yield from page.data
        cursor = _next_cursor(page)
        if not _has_more(page, cursor) or cursor is None:
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
        if not _has_more(page, cursor) or cursor is None:
            return
        kwargs["cursor"] = cursor
