# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The pack service's log: `kindgi.log` records on stderr, subsystem `pack`.

Two streams share the sink, as in the TypeScript pack service:

- `log`: calls, and `ctx.log` beneath them (`pack.tool`). `KINDGI_LOG_LEVEL` and
  `KINDGI_LOG_LEVELS` apply.
- `event`: the lifecycle (`listening`, `boot-failed`, …), written whatever the levels,
  because a supervisor reads it to know the service is up. Its records carry the event's
  name as `event`, and as `kind` too, so a supervisor from before records (which reads bare
  `{"kind": …}` lines) still sees `listening`. `kind` stays through 0.1.x.

The format is `KINDGI_LOG_FORMAT`'s, but `auto` is pretty only on a terminal: a supervisor
pipes stderr, and dev mode (`KINDGI_DEV`) doesn't make it pretty.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from ..log import Logger, create_logger, logger_from_env, resolve_log_format

__all__ = ["PACK_SERVICE_EVENTS", "PackServiceEvent", "PackServiceLogs", "pack_service_logs"]

PackServiceEvent = Literal["listening", "boot-failed", "config-invalid", "draining", "stopped"]
PACK_SERVICE_EVENTS: tuple[PackServiceEvent, ...] = (
    "listening",
    "boot-failed",
    "config-invalid",
    "draining",
    "stopped",
)
"""Lifecycle events: always written, the supervisor's to read."""

_EVENT_LEVEL: Mapping[str, str] = {
    "listening": "info",
    "boot-failed": "error",
    "config-invalid": "error",
    "draining": "info",
    "stopped": "info",
}


@dataclass(frozen=True)
class PackServiceLogs:
    log: Logger
    """Calls, and `ctx.log` beneath them; the levels apply."""
    _always: Logger

    def event(self, kind: PackServiceEvent, message: str, **fields: Any) -> None:
        """A lifecycle event, written whatever the levels."""
        level = _EVENT_LEVEL[kind]
        getattr(self._always, level)(message, {**fields, "event": kind, "kind": kind})


def _stderr(line: str) -> None:
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def pack_service_logs(
    env: Mapping[str, str],
    *,
    write: Callable[[str], None] | None = None,
    is_tty: bool = False,
) -> tuple[PackServiceLogs, list[str]]:
    """The pack service's logs from `KINDGI_LOG_*`, and harmless problems to report.

    Raises `kindgi.log.LogConfigError` for a bad setting, naming it.
    """
    environ = {k: v for k, v in env.items() if k != "KINDGI_DEV"}
    sink = write or _stderr
    root, problems = logger_from_env(environ, write=sink, is_tty=is_tty, subsystems=["pack"])
    fmt = resolve_log_format(environ.get("KINDGI_LOG_FORMAT"), is_tty=is_tty) or "json"
    always = create_logger(
        write=sink,
        level="trace",
        format=fmt,
        color=fmt == "pretty" and is_tty and environ.get("NO_COLOR", "") == "",
        subsystem="pack",
    )
    return PackServiceLogs(log=root.child(subsystem="pack"), _always=always), problems
