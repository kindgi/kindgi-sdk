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
    """Environment the runtime resolves for the call — none yet (empty): read `os.environ`."""
    secrets: Mapping[str, Any] = field(default_factory=_empty)
    """The secrets the tool declares (`needs_spec["secrets"]`), resolved for this call's tenant."""
    config: Mapping[str, Any] = field(default_factory=_empty)
    """Configuration the runtime resolves for the call — none yet (empty)."""
    cancellation: Cancellation = field(default_factory=Cancellation)
    """Fires when the caller gives up on the call."""

    @classmethod
    def for_test(
        cls, tenant_id: str = "tenant-test", run_id: str = "run-test", **kwargs: Any
    ) -> ToolContext:
        """A context for calling a handler directly in a unit test."""
        return cls(tenant_id=tenant_id, run_id=run_id, **kwargs)

    @classmethod
    def from_wire(cls, ctx: Mapping[str, Any], cancellation: Cancellation) -> ToolContext:
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
            cancellation=cancellation,
        )
