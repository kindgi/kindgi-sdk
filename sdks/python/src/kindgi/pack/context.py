# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""What a tool handler receives besides its input."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Final, Literal, cast

from ..log import Logger, noop_logger
from .files import FileStore, file_store_from_wire

if TYPE_CHECKING:
    from .define import Tool

__all__ = [
    "MAX_PAUSE_NAME_LENGTH",
    "MAX_PAUSE_TIMEOUT_MS",
    "CallCancelled",
    "CancelReason",
    "Cancellation",
    "ConnectionAccount",
    "ConnectionRejected",
    "PauseAnswer",
    "PauseNotAvailable",
    "ToolConnection",
    "ToolContext",
    "WaitToken",
    "wait_token_from_wire",
]

CancelReason = Literal["deadline-exceeded", "cancelled"]


class CallCancelled(Exception):
    """Raised by `Cancellation.raise_if_cancelled` once the call is over."""

    def __init__(self, reason: CancelReason) -> None:
        super().__init__(reason)
        self.reason: CancelReason = reason


class Cancellation:
    """Fires when the caller gives up on the call: its deadline passed, or it disconnected.

    The Python counterpart of `ToolContext.abortSignal`. An async handler is
    also cancelled the asyncio way (`CancelledError` at its next `await`); a
    sync handler runs in a worker thread and should check `cancelled` (or wait
    on it) between slow steps. Thread-safe.
    """

    def __init__(self) -> None:
        self._fired = threading.Event()
        self._reason: CancelReason | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._async_fired: asyncio.Event | None = None

    @property
    def cancelled(self) -> bool:
        return self._fired.is_set()

    @property
    def reason(self) -> CancelReason | None:
        return self._reason

    def raise_if_cancelled(self) -> None:
        if self._reason is not None:
            raise CallCancelled(self._reason)

    def wait(self, timeout: float | None = None) -> bool:
        """Block until cancelled or `timeout` seconds pass; `True` when cancelled."""
        return self._fired.wait(timeout)

    async def wait_async(self) -> CancelReason:
        """Resolve once cancelled."""
        if self._async_fired is None:
            self._loop = asyncio.get_running_loop()
            self._async_fired = asyncio.Event()
            if self._fired.is_set():
                self._async_fired.set()
        await self._async_fired.wait()
        assert self._reason is not None
        return self._reason

    def cancel(self, reason: CancelReason) -> None:
        """Fire (idempotent; the first reason wins)."""
        if self._fired.is_set():
            return
        self._reason = reason
        self._fired.set()
        if self._loop is not None and self._async_fired is not None:
            self._loop.call_soon_threadsafe(self._async_fired.set)


class ConnectionRejected(Exception):
    """The app refused a connection's token: an HTTP 401 from its API.

    Raise it with the tool's name for the connection (its `needs_spec["connections"]` key), or
    raise your own error `from` it. The call answers `connection-rejected`, and the runtime renews
    that token once and runs the call again; it never removes the connection. Say what the app
    said, never the token.
    """

    def __init__(self, connection: str, message: str | None = None) -> None:
        super().__init__(message or f'the app refused the connection "{connection}"')
        self.connection = connection


@dataclass(frozen=True, slots=True)
class ConnectionAccount:
    """Whose account a connection is at the app."""

    id: str
    """Its stable id at the app."""
    label: str
    """What people see: `ana@acme.example`."""


@dataclass(frozen=True, slots=True)
class ToolConnection:
    """A connection resolved for one call: an account at another app, with a short-lived token.

    What a tool reads from `ctx.connections["mail"]`. The token is never in its `repr`.
    """

    connection_id: str
    app: str
    """The app entry's id: `"google"`, `"github"`."""
    app_name: str
    """The app's name as people know it: `"Google"`."""
    access_token: str = field(repr=False)
    """The token to send to the app's API (`Authorization: Bearer …`). Never log or return it."""
    account: ConnectionAccount
    expires_at: str | None = None
    """When the token expires (ISO 8601), when the app says."""

    @classmethod
    def from_wire(cls, value: Any) -> ToolConnection | None:
        """The connection for one protocol v2 `ctx.connections` entry; `None` when it isn't one."""
        if not isinstance(value, Mapping):
            return None
        raw = cast("Mapping[str, Any]", value)
        account = raw.get("account")
        texts = [raw.get(k) for k in ("connectionId", "app", "appName", "accessToken")]
        if not all(isinstance(t, str) for t in texts) or not isinstance(account, Mapping):
            return None
        account_id = cast("Mapping[str, Any]", account).get("id")
        label = cast("Mapping[str, Any]", account).get("label")
        expires_at = raw.get("expiresAt")
        if not isinstance(account_id, str) or not isinstance(label, str):
            return None
        return cls(
            connection_id=cast(str, texts[0]),
            app=cast(str, texts[1]),
            app_name=cast(str, texts[2]),
            access_token=cast(str, texts[3]),
            account=ConnectionAccount(id=account_id, label=label),
            expires_at=expires_at if isinstance(expires_at, str) else None,
        )


MAX_PAUSE_TIMEOUT_MS: Final = 24 * 24 * 60 * 60 * 1000
"""The longest a pause may wait: 24 days, in milliseconds."""
MAX_PAUSE_NAME_LENGTH: Final = 200
"""The longest a pause's `name` may be."""


@dataclass(frozen=True, slots=True)
class WaitToken:
    """A call's wait token: its id, and the link the other system posts its answer to."""

    id: str
    """The same every time this attempt of the call runs (a retry of its step gets a new token)."""
    url: str
    """`POST` the answer here, as a JSON body, with no `Authorization` header: the link is the
    credential. Hand it only to the system that answers. A re-run after a crash gets a new link
    to the same wait, and either link completes it. Hand on the new one only if the old one never
    went out, and dedupe on `idempotency_key`."""


@dataclass(frozen=True, slots=True)
class PauseAnswer:
    """What `ctx.pause()` returns. A pausing tool's handler returns it as its result."""

    timeout_ms: int | None = None
    """How long the run waits for the answer, in milliseconds: from 1 to `MAX_PAUSE_TIMEOUT_MS`
    (24 days). `None`: 24 hours. When it passes, the call fails with `wait-token-timed-out`."""
    name: str | None = None
    """What the run waits for, in a few words (`the carrier's pickup confirmation`): 1 to 200
    characters."""


class PauseNotAvailable(Exception):
    """Raised by `ToolContext.wait_token` and `ToolContext.pause` when the call has no wait token.

    The pack service answers the call with `pause-not-available`.
    """


_EMPTY: Mapping[str, Any] = MappingProxyType({})


def _empty() -> Mapping[str, Any]:
    return _EMPTY


@dataclass(frozen=True, slots=True)
class ToolContext:
    """Per-call context: who the call is for, its resolved env/secrets/config, its cancellation."""

    tenant_id: str
    """Tenant the call runs for — key per-tenant state by it."""
    run_id: str
    """The kernel run this call belongs to (an agent turn or a flow step)."""
    request_id: str | None = None
    """This call — e.g. the model's tool-call id. Useful for logs; to dedupe a side effect, use
    `idempotency_key` (a model's call id is only unique within one of its answers)."""
    project_id: str | None = None
    """The run's project. The runtime sets it from the run, never from the run's input or a
    model's arguments, so a tool can check an id in its input against it."""
    org_id: str | None = None
    """The project's org, when it belongs to one: set by the runtime from the project, never
    from input. `None` when the project has no org."""
    env: Mapping[str, Any] = field(default_factory=_empty)
    """The env values the tool declares (`needs_spec["env"]`), by name, resolved for this call:
    the project's value, else its org's, else the tenant's (a schema `default` when no scope sets
    one). Strings. Empty when the tool declares none, and from an older runtime (protocol 2.5.0).
    The pack service's own environment stays in `os.environ`."""
    secrets: Mapping[str, Any] = field(default_factory=_empty, repr=False)
    """The secrets the tool declares (`needs_spec["secrets"]`), resolved for this call's tenant.
    An optional one (its schema names null: `{"type": ["string", "null"]}`) is absent when the
    env doesn't have it, or has it empty: read it with `.get` (runtime 0.1.6 or later; an older
    runtime requires it). Never in the context's `repr`, so printing a context never prints a
    secret."""
    config: Mapping[str, Any] = field(default_factory=_empty)
    """Reserved: no runtime sends it yet (empty)."""
    settings: Mapping[str, Mapping[str, Any]] = field(default_factory=_empty)
    """The settings blocks the calling agent version pins, by block id:
    `ctx.settings["acme.weights"]["recency"]`. Empty when it pins none, and from an older
    runtime (protocol 2.4.0)."""
    cancellation: Cancellation = field(default_factory=Cancellation)
    """Fires when the caller gives up on the call."""
    log: Logger = field(default=noop_logger, repr=False, compare=False)
    """A logger bound to this call: its records carry the run's ids and the caller's trace id
    (`ctx.log.info("looked up order", order_id=…)`). The pack service sets it; in a test it
    writes nothing unless you pass one. Never put a secret's value in a field."""
    idempotency_key: str | None = None
    """A key for this call's side effects: the same every time this call runs (its step resumed
    after a wait, retried after a failure, or run again after a crash), different for every other
    call. A step can run more than once, so a tool that changes something passes it to the system
    it writes to (an `Idempotency-Key` header, a client reference, a unique column), or looks for
    it there first. A UUID. `None` from a runtime that can't name its steps (before protocol
    2.6.0): the call can't be deduped on it then."""
    connections: Mapping[str, ToolConnection] = field(default_factory=_empty, repr=False)
    """The connections the tool declares (`needs_spec["connections"]`), by the tool's name for
    each: an account at another app and a short-lived token for it
    (`ctx.connections["mail"].access_token`). Empty when the tool declares none, and from a
    runtime before protocol 2.9.0. Never in the context's `repr`. When the app refuses a token
    (a 401), raise `ConnectionRejected("mail")`."""
    files: FileStore | None = field(default=None, repr=False)
    """The call's files, for a tool that declares `stores_files=True` or `reads_files=True`.
    `ctx.files.store(name=…, content_type=…, data=…)` (`store_async` from an async handler)
    stores a file the tool fetched as a file the call's run owns, and answers its value, to
    return in the result's top-level `files`, or why nothing was stored; a call has it when its
    tool stores files and it has an idempotency key (`ctx.files.stores`).
    `ctx.files.read(artifact_id)` (`read_async`) answers the bytes of a file the call's run may
    be shown, or why there are none; a call has it when its tool reads files
    (`ctx.files.reads`). `None` for a tool that declares neither, and from a runtime before
    pack protocol 2.10.0: return a file's `notShown` as `store` then."""
    _wait_token: WaitToken | None = field(default=None, repr=False)

    @property
    def wait_token(self) -> WaitToken:
        """The call's wait token, for a tool that declares `pauses=True`: hand its `url` to the
        system that will answer, then return `ctx.pause()`. The run waits until that system posts
        its answer to the link, or until the pause's time passes; the answer, valid against the
        tool's output schema, becomes the call's result. A re-run after a crash gets a new link to
        the same wait, and either link completes it: hand on the new one only if the old one never
        went out, and dedupe on `idempotency_key`.

        Raises `PauseNotAvailable` when the call has none: the tool doesn't declare
        `pauses=True`, or the runtime that called it can't pause (before pack protocol 2.8.0).
        Read it before handing anything on, so the tool fails first."""
        if self._wait_token is None:
            raise _no_wait_token()
        return self._wait_token

    def pause(self, timeout_ms: int | None = None, name: str | None = None) -> PauseAnswer:
        """The answer that makes the run wait for the system the tool handed `wait_token` to.

        `timeout_ms`: how long the run waits, from 1 to `MAX_PAUSE_TIMEOUT_MS` (24 days);
        24 hours when `None`. `name`: what it waits for, in a few words. Raises
        `PauseNotAvailable` as `wait_token` does."""
        if self._wait_token is None:
            raise _no_wait_token()
        return PauseAnswer(timeout_ms=timeout_ms, name=name)

    @classmethod
    def for_test(
        cls,
        tenant_id: str = "tenant-test",
        run_id: str = "run-test",
        *,
        wait_token: WaitToken | None = None,
        tool: Tool[Any, Any] | None = None,
        **kwargs: Any,
    ) -> ToolContext:
        """A context for calling a handler directly in a unit test. Pass `wait_token` to test a
        pausing tool.

        Pass `tool=` to fill `env` from the tool's `needs_spec["env"]` the way the runtime
        does: every env name the tool declares, from the `env=` the test offers or the
        schema's string default, each checked against its schema. A name the tool doesn't
        declare is dropped. `secrets=` pass through unchecked (the runtime resolves them).
        """
        if tool is not None:
            from .needs import resolve_env

            kwargs["env"] = resolve_env(
                tool.id, tool.needs_spec, dict(kwargs.pop("env", None) or {})
            )
        return cls(tenant_id=tenant_id, run_id=run_id, _wait_token=wait_token, **kwargs)

    @classmethod
    def from_wire(
        cls,
        ctx: Mapping[str, Any],
        cancellation: Cancellation,
        log: Logger = noop_logger,
        *,
        pauses: bool = False,
        stores_files: bool = False,
        reads_files: bool = False,
    ) -> ToolContext:
        """The context for a protocol v2 `ctx` (`tenantId`, `runId`, …). Its `waitToken` is kept
        only for a tool that `pauses`, and its `toolFiles`, as `files`, only for a tool that
        `stores_files` (on a call with an `idempotencyKey`) or `reads_files`, with what it
        declares."""

        def mapping(key: str) -> Mapping[str, Any]:
            value = ctx.get(key)
            if not isinstance(value, Mapping):
                return _EMPTY
            return MappingProxyType(dict(cast("Mapping[str, Any]", value)))

        def text(key: str) -> str | None:
            value = ctx.get(key)
            return value if isinstance(value, str) else None

        idempotency_key = text("idempotencyKey")
        return cls(
            tenant_id=str(ctx["tenantId"]),
            run_id=str(ctx["runId"]),
            request_id=text("requestId"),
            idempotency_key=idempotency_key,
            project_id=text("projectId"),
            org_id=text("orgId"),
            env=mapping("env"),
            secrets=mapping("secrets"),
            config=mapping("config"),
            settings=mapping("settings"),
            cancellation=cancellation,
            log=log,
            connections=_connections(ctx.get("connections")),
            files=file_store_from_wire(
                ctx, stores=stores_files and idempotency_key is not None, reads=reads_files
            ),
            _wait_token=wait_token_from_wire(ctx) if pauses else None,
        )


def _connections(value: Any) -> Mapping[str, ToolConnection]:
    if not isinstance(value, Mapping):
        return _EMPTY
    out: dict[str, ToolConnection] = {}
    for name, raw in cast("Mapping[str, Any]", value).items():
        connection = ToolConnection.from_wire(raw)
        if connection is not None:
            out[str(name)] = connection
    return MappingProxyType(out)


def wait_token_from_wire(ctx: Mapping[str, Any]) -> WaitToken | None:
    """A protocol v2 `ctx`'s `waitToken` (protocol 2.8.0), if it carries a well-formed one."""
    value = ctx.get("waitToken")
    if not isinstance(value, Mapping):
        return None
    token = cast("Mapping[str, Any]", value)
    token_id, url = token.get("id"), token.get("url")
    if not isinstance(token_id, str) or token_id == "" or not isinstance(url, str) or url == "":
        return None
    return WaitToken(id=token_id, url=url)


def _no_wait_token() -> PauseNotAvailable:
    return PauseNotAvailable(
        "This call has no wait token: a tool pauses only when it declares `pauses=True` and the"
        " runtime that calls it speaks pack protocol 2.8.0 or later."
    )
