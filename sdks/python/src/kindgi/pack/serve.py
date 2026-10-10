# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The pack service process.

    python -m kindgi.pack serve [--index <path>] [--module-root <dir>] [--host <address>]

The process contract of `@kindgi/handler-runtime`'s pack service, so the
same supervisor (`kindgi dev`) and the same deployment run either:

  - index:        `--index`, else `KINDGI_PACK_INDEX`, else `/app/index.json`
  - module root:  `--module-root`, else the index's directory
  - token:        `KINDGI_PACK_SERVICE_TOKEN` (required)
  - concurrency:  `KINDGI_PACK_SERVICE_MAX_CONCURRENCY` (default 32)
  - port:         `PORT` (default 8080; `0` picks one)
  - host:         `--host`, else every interface
  - env check:    `KINDGI_PACK_ENV_CHECK`, `strict` (default) or `warn`

Logs are `kindgi.log` records on stderr (subsystem `pack`), at `KINDGI_LOG_LEVEL` /
`KINDGI_LOG_LEVELS`, in `KINDGI_LOG_FORMAT` (`auto`: JSON unless stderr is a terminal): a
record per call, and the lifecycle (`listening`, `boot-failed`, …) whatever the levels
(`records.py`).

Boot fails (exit 1, a `boot-failed` record listing every problem) when the index can't be
read, a module it names is missing, or one fails to import. A name in the index's
`env.required` that is unset or empty is logged once (a `missing-env` warning naming it);
under `strict` `/readyz` and calls answer 503 naming it, under `warn` the service serves.
Once listening it writes a `listening` record with the port. SIGTERM drains in-flight calls
(`/readyz` and new calls answer 503) for up to 8 s, then exits 0.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import socket
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Any, cast

import uvicorn

from ..log import LogConfigError
from .env_filter import ENV_FILTER_VAR, ENV_FILTERS, EnvFilter, undeclared_pack_env
from .records import PackServiceLogs, pack_service_logs
from .service import ENV_CHECKS, EnvCheck, PackService, log_json

__all__ = ["PACK_SERVICE_DRAIN_S", "ServeConfig", "main", "read_config"]

PACK_SERVICE_DRAIN_S = 8.0
"""How long SIGTERM lets in-flight calls finish (Cloud Run allows 10 s from SIGTERM to SIGKILL)."""


@dataclass(frozen=True)
class ServeConfig:
    index_path: Path
    module_root: Path
    token: str
    port: int
    host: str | None
    max_concurrency: int | None
    env_check: EnvCheck = "strict"
    # `on`: before the pack's code loads, drop from this process's environment every
    # name the pack doesn't declare (but `KINDGI_*` and the platform's). `read_config`
    # sets it from KINDGI_PACK_ENV_FILTER (default `on`); a config built in-process
    # leaves it `off`, so its caller's environment is left alone.
    env_filter: EnvFilter = "off"


def read_config(argv: Sequence[str], env: Mapping[str, str]) -> ServeConfig | list[str]:
    """The configuration, or every problem with it."""

    def arg(name: str) -> str | None:
        return (
            argv[argv.index(name) + 1]
            if name in argv and argv.index(name) + 1 < len(argv)
            else None
        )

    problems: list[str] = []
    index_path = Path(arg("--index") or env.get("KINDGI_PACK_INDEX") or "/app/index.json").resolve()
    module_root = Path(arg("--module-root") or index_path.parent).resolve()
    host = arg("--host")
    if "--host" in argv and not host:
        problems.append("--host needs an address")
    # Read as the server reads it: without surrounding whitespace (it
    # travels in an HTTP header, which never carries any).
    token = env.get("KINDGI_PACK_SERVICE_TOKEN", "").strip()
    if not token:
        problems.append("KINDGI_PACK_SERVICE_TOKEN is required")
    elif not re.fullmatch(r"[\x21-\x7e]+", token):
        problems.append(
            "KINDGI_PACK_SERVICE_TOKEN may hold only printable ASCII without spaces "
            "(it travels in an HTTP header). Use a random value such as `openssl rand -hex 32`."
        )
    raw_port = env.get("PORT", "8080")
    port = int(raw_port) if raw_port.isdigit() else -1
    if not 0 <= port <= 65535:
        problems.append(f"PORT must be a port number, got {json.dumps(raw_port)}")
    raw_concurrency = env.get("KINDGI_PACK_SERVICE_MAX_CONCURRENCY")
    max_concurrency = (
        int(raw_concurrency) if raw_concurrency and raw_concurrency.isdigit() else None
    )
    if raw_concurrency is not None and (max_concurrency is None or max_concurrency < 1):
        problems.append("KINDGI_PACK_SERVICE_MAX_CONCURRENCY must be a positive integer")
    env_check = env.get("KINDGI_PACK_ENV_CHECK") or "strict"
    if env_check not in ENV_CHECKS:
        problems.append(
            f"KINDGI_PACK_ENV_CHECK must be `strict` or `warn`, not {json.dumps(env_check)}"
        )
    env_filter = env.get(ENV_FILTER_VAR) or "on"
    if env_filter not in ENV_FILTERS:
        problems.append(f"{ENV_FILTER_VAR} must be `on` or `off`, not {json.dumps(env_filter)}")
    if problems:
        return problems
    return ServeConfig(
        index_path,
        module_root,
        token,
        port,
        host or None,
        max_concurrency,
        cast("EnvCheck", env_check),
        cast("EnvFilter", env_filter),
    )


def load_service(
    config: ServeConfig,
    environ: Mapping[str, str] | None = None,
    logs: PackServiceLogs | None = None,
) -> PackService | list[str]:
    """Read the index, check every module exists and imports; the service, or the problems.

    `environ` is what `env.required` is checked against (default: `os.environ`). `logs`:
    where the service's records go; without it, its events are bare JSON lines as before.
    """
    try:
        index = cast("dict[str, Any]", json.loads(config.index_path.read_text("utf-8")))
    except (OSError, ValueError) as cause:
        return [f"Cannot read the pack index: {cause}"]
    if index.get("v") != 1:
        return [f"Index envelope v{index.get('v')} is not v1"]
    paths = [str(t["modulePath"]) for t in index.get("tools", [])]
    paths += [str(g["checkModulePath"]) for g in index.get("guardrails", [])]
    missing = [f"Missing module: {p}" for p in paths if not (config.module_root / p).is_file()]
    if missing:
        return missing
    # Before the pack's code loads: keep only the names it declares (and Kindgi's and
    # the platform's). A variable meant for something else, a model key in a
    # self-hosted `--env-file`, never reaches a handler; `os.environ.pop` unsets it,
    # so a process a handler starts doesn't inherit it either.
    if config.env_filter == "on":
        dropped = undeclared_pack_env(index.get("env"), os.environ)
        for name in dropped:
            os.environ.pop(name, None)
        if dropped:
            noun = "a variable" if len(dropped) == 1 else f"{len(dropped)} variables"
            message = (
                f"Dropped {noun} the pack doesn't declare: {', '.join(dropped)} "
                f"(declare them in the pack's env, or set {ENV_FILTER_VAR}=off)"
            )
            if logs is None:
                log_json({"kind": "env-dropped", "names": dropped})
            else:
                logs.log.warn(
                    message, {"event": "env-dropped", "kind": "env-dropped", "names": dropped}
                )
    kwargs: dict[str, Any] = {}
    if config.max_concurrency is not None:
        kwargs["max_concurrency"] = config.max_concurrency
    if logs is not None:
        kwargs["log"] = logs.log.child(
            packId=index.get("packId"), artifactVersion=index.get("artifactVersion")
        )
        kwargs["logger"] = _ignore
    service = PackService(
        index,
        config.module_root,
        config.token,
        env_check=config.env_check,
        environ=environ,
        **kwargs,
    )
    # Before the imports: a missing variable is often why one fails.
    if service.missing_env:
        names = service.missing_env
        if logs is None:
            log_json({"kind": "missing-env", "check": config.env_check, "names": names})
        else:
            noun = "name has" if len(names) == 1 else "names have"
            logs.log.warn(
                f"The pack's env.required {noun} no value: {', '.join(names)}",
                {
                    "event": "missing-env",
                    "kind": "missing-env",
                    "check": config.env_check,
                    "names": names,
                },
            )
    failures = service.prewarm()
    if failures:
        return [str(f["message"]) for f in failures]
    return service


class _Server(uvicorn.Server):
    """uvicorn, with SIGTERM meaning: drain the pack service, then stop."""

    def __init__(
        self,
        config: uvicorn.Config,
        service: PackService,
        listening: Mapping[str, Any],
        logs: PackServiceLogs | None = None,
    ) -> None:
        super().__init__(config)
        self._service = service
        self._listening = listening
        self._logs = logs
        self._loop: asyncio.AbstractEventLoop | None = None
        self._draining = False
        self._drain_task: asyncio.Task[None] | None = None

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        self._loop = asyncio.get_running_loop()
        await super().startup(sockets=sockets)
        if self._logs is None:
            log_json({"kind": "listening", **self._listening})
        else:
            port = self._listening["port"]
            self._logs.event("listening", f"Listening on port {port}", **self._listening)

    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        # Not recorded as a captured signal, so uvicorn doesn't re-raise it: a drain exits 0.
        if self._draining or self._loop is None:
            self.force_exit = self._draining
            self.should_exit = True
            return
        self._draining = True
        self._loop.call_soon_threadsafe(self._begin_drain)

    def _begin_drain(self) -> None:
        if self._logs is None:
            log_json({"kind": "draining"})
        else:
            self._logs.event("draining", "Draining: finishing the calls in flight")
        self._service.begin_drain()
        self._drain_task = asyncio.ensure_future(self._drain_then_exit())

    async def _drain_then_exit(self) -> None:
        await self._service.drain(PACK_SERVICE_DRAIN_S)
        self.should_exit = True


def serve(config: ServeConfig, service: PackService, logs: PackServiceLogs | None = None) -> None:
    family = socket.AF_INET6 if config.host and ":" in config.host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((config.host or "0.0.0.0", config.port))
    sock.listen(1024)
    sock.setblocking(False)
    port = int(sock.getsockname()[1])
    uv_config = uvicorn.Config(
        app=service,
        interface="asgi3",
        lifespan="off",
        http="h11",
        ws="none",
        log_config=None,
        access_log=False,
        server_header=False,
        date_header=False,
        timeout_graceful_shutdown=2,
    )
    listening = {
        "port": port,
        "packId": service.index.get("packId"),
        "artifactVersion": service.index.get("artifactVersion"),
    }
    server = _Server(uv_config, service, listening, logs)
    try:
        asyncio.run(server.serve(sockets=[sock]))
    finally:
        service.close()


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    environ = dict(os.environ if env is None else env)
    # What handlers print reaches the supervisor line by line.
    stdout: object = sys.stdout
    if isinstance(stdout, io.TextIOWrapper):
        stdout.reconfigure(line_buffering=True)
    try:
        logs, problems = pack_service_logs(environ, is_tty=sys.stderr.isatty())
    except LogConfigError as err:
        defaults, _ = pack_service_logs({})
        defaults.event("config-invalid", str(err), problems=[str(err)])
        return 1
    for problem in problems:
        logs.log.warn(problem)
    config = read_config(args, environ)
    if isinstance(config, list):
        logs.event("config-invalid", "The pack service configuration is invalid", problems=config)
        return 1
    # The token is for the service's callers. The pack's code, loaded
    # next, runs in this process and has no use for it — and a dependency
    # that read it could call the pack's tools around the runtime.
    os.environ.pop("KINDGI_PACK_SERVICE_TOKEN", None)
    service = load_service(config, environ, logs)
    if isinstance(service, list):
        logs.event("boot-failed", "The pack service failed to boot", problems=service)
        return 1
    serve(config, service, logs)
    logs.event("stopped", "Stopped")
    return 0


def _ignore(_event: Mapping[str, Any]) -> None:
    """The service's events, when its records carry them instead."""
