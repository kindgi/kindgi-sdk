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

Boot fails (exit 1, a `boot-failed` JSON line listing every problem) when
the index can't be read, a module it names is missing, or one fails to
import. A name in the index's `env.required` that is unset or empty is
logged once (`{"kind":"missing-env","check":…,"names":[…]}`); under `strict`
`/readyz` and calls answer 503 naming it, under `warn` the service serves.
Once listening it writes `{"kind":"listening","port":…}` on stderr.
SIGTERM drains in-flight calls (`/readyz` and new calls answer 503) for up
to 8 s, then exits 0.
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
    )


def load_service(
    config: ServeConfig, environ: Mapping[str, str] | None = None
) -> PackService | list[str]:
    """Read the index, check every module exists and imports; the service, or the problems.

    `environ` is what `env.required` is checked against (default: `os.environ`).
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
    kwargs: dict[str, Any] = {}
    if config.max_concurrency is not None:
        kwargs["max_concurrency"] = config.max_concurrency
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
        log_json({"kind": "missing-env", "check": config.env_check, "names": service.missing_env})
    failures = service.prewarm()
    if failures:
        return [str(f["message"]) for f in failures]
    return service


class _Server(uvicorn.Server):
    """uvicorn, with SIGTERM meaning: drain the pack service, then stop."""

    def __init__(
        self, config: uvicorn.Config, service: PackService, listening: Mapping[str, Any]
    ) -> None:
        super().__init__(config)
        self._service = service
        self._listening = listening
        self._loop: asyncio.AbstractEventLoop | None = None
        self._draining = False
        self._drain_task: asyncio.Task[None] | None = None

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        self._loop = asyncio.get_running_loop()
        await super().startup(sockets=sockets)
        log_json(self._listening)

    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        # Not recorded as a captured signal, so uvicorn doesn't re-raise it: a drain exits 0.
        if self._draining or self._loop is None:
            self.force_exit = self._draining
            self.should_exit = True
            return
        self._draining = True
        self._loop.call_soon_threadsafe(self._begin_drain)

    def _begin_drain(self) -> None:
        log_json({"kind": "draining"})
        self._service.begin_drain()
        self._drain_task = asyncio.ensure_future(self._drain_then_exit())

    async def _drain_then_exit(self) -> None:
        await self._service.drain(PACK_SERVICE_DRAIN_S)
        self.should_exit = True


def serve(config: ServeConfig, service: PackService) -> None:
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
        "kind": "listening",
        "port": port,
        "packId": service.index.get("packId"),
        "artifactVersion": service.index.get("artifactVersion"),
    }
    server = _Server(uv_config, service, listening)
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
    config = read_config(args, environ)
    if isinstance(config, list):
        log_json({"kind": "config-invalid", "problems": config})
        return 1
    # The token is for the service's callers. The pack's code, loaded
    # next, runs in this process and has no use for it — and a dependency
    # that read it could call the pack's tools around the runtime.
    os.environ.pop("KINDGI_PACK_SERVICE_TOKEN", None)
    service = load_service(config, environ)
    if isinstance(service, list):
        log_json({"kind": "boot-failed", "problems": service})
        return 1
    serve(config, service)
    log_json({"kind": "stopped"})
    return 0
