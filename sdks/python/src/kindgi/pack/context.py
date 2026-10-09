# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""What a tool handler receives besides its input."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Literal, cast

from ..log import Logger, noop_logger

__all__ = ["CallCancelled", "CancelReason", "Cancellation", "ToolContext"]

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
    """This call — e.g. the model's tool-call id. Useful for logs and idempotency."""
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
    Never in the context's `repr`, so printing a context never prints a secret."""
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

    @classmethod
    def for_test(
        cls, tenant_id: str = "tenant-test", run_id: str = "run-test", **kwargs: Any
    ) -> ToolContext:
        """A context for calling a handler directly in a unit test."""
        return cls(tenant_id=tenant_id, run_id=run_id, **kwargs)

    @classmethod
    def from_wire(
        cls, ctx: Mapping[str, Any], cancellation: Cancellation, log: Logger = noop_logger
    ) -> ToolContext:
        """The context for a protocol v2 `ctx` (`tenantId`, `runId`, …)."""

        def mapping(key: str) -> Mapping[str, Any]:
            value = ctx.get(key)
            if not isinstance(value, Mapping):
                return _EMPTY
            return MappingProxyType(dict(cast("Mapping[str, Any]", value)))

        def text(key: str) -> str | None:
            value = ctx.get(key)
            return value if isinstance(value, str) else None

        return cls(
            tenant_id=str(ctx["tenantId"]),
            run_id=str(ctx["runId"]),
            request_id=text("requestId"),
            project_id=text("projectId"),
            org_id=text("orgId"),
            env=mapping("env"),
            secrets=mapping("secrets"),
            config=mapping("config"),
            settings=mapping("settings"),
            cancellation=cancellation,
            log=log,
        )
