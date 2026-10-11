# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The pack service: runs a Python pack's tool handlers and guardrail checks over pack protocol v2.

An ASGI application with the routes, statuses and messages of
`@kindgi/handler-runtime`'s pack service (`@kindgi/specs/pack-protocol.schema.json`):

    POST /v1/invoke   (token)  a v2 request → 200 with a v2 response
    GET  /v1/info     (token)  the pack's identity, tools and checks
    GET  /healthz              the process is up
    GET  /readyz               every module loaded, not draining, and (under
                               `KINDGI_PACK_ENV_CHECK=strict`) every name in the
                               index's `env.required` set and non-empty

Modules are imported once (`prewarm`); calls run concurrently up to a cap.
An async handler runs on the event loop; a sync one in a worker thread. When
a call passes its deadline (`kindgi-timeout-ms`) or the caller disconnects,
the answer is `deadline-exceeded` / `cancelled`, the handler's
`ctx.cancellation` fires, and an async handler is cancelled at its next
`await`. What handlers print goes to the process's own stdout/stderr and
never into a response.
"""

from __future__ import annotations

import asyncio
import contextvars
import hmac
import json
import os
import sys
import time
import traceback
from collections.abc import Awaitable, Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal, cast

from pydantic import ValidationError as PydanticError

from .._json import compact_dumps
from .._schema import Issue, SchemaValidator, apply_defaults, issues_from_pydantic
from ..log import Logger, child_span, noop_logger, parse_traceparent
from .context import Cancellation, ToolContext
from .define import Guardrail, Tool, check_result_to_wire
from .loader import import_pack_module, mount_pack, primitives_of
from .protocol import (
    PACK_HEADERS,
    PACK_PROTOCOL_VERSION,
    CheckInvoke,
    ToolInvoke,
    pack_error,
    parse_request,
)

__all__ = [
    "DEFAULT_MAX_BODY_BYTES",
    "DEFAULT_MAX_CONCURRENCY",
    "DEFAULT_TIMEOUT_MS",
    "ENV_CHECKS",
    "EnvCheck",
    "PackService",
    "log_json",
]

DEFAULT_MAX_CONCURRENCY = 32
DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
DEFAULT_TIMEOUT_MS = 120_000

EnvCheck = Literal["strict", "warn"]
"""`KINDGI_PACK_ENV_CHECK`: `strict` holds readiness while a required name is missing;
`warn` only reports it."""
ENV_CHECKS: tuple[EnvCheck, ...] = ("strict", "warn")

Message = dict[str, Any]
Scope = Mapping[str, Any]
Receive = Callable[[], Awaitable[Mapping[str, Any]]]
Send = Callable[[Mapping[str, Any]], Awaitable[None]]
Target = Literal["tool", "check"]


def log_json(event: Mapping[str, Any]) -> None:
    """One JSON line on stderr — the service's log format."""
    sys.stderr.write(json.dumps(event, separators=(",", ":"), default=str) + "\n")
    sys.stderr.flush()


@dataclass(frozen=True)
class _Route:
    name: Literal["invoke", "info", "healthz", "readyz"]
    method: Literal["GET", "POST"]
    auth: bool


_ROUTES: Mapping[str, _Route] = {
    "/v1/invoke": _Route("invoke", "POST", True),
    "/v1/info": _Route("info", "GET", True),
    "/healthz": _Route("healthz", "GET", False),
    "/readyz": _Route("readyz", "GET", False),
}


class _Disconnected(Exception):
    pass


class PackService:
    """The ASGI application. `prewarm()` before serving; `drain()` on shutdown."""

    def __init__(
        self,
        index: Mapping[str, Any],
        module_root: Path,
        token: str,
        *,
        max_concurrency: int = DEFAULT_MAX_CONCURRENCY,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        default_timeout_ms: int = DEFAULT_TIMEOUT_MS,
        env_check: EnvCheck = "strict",
        environ: Mapping[str, str] | None = None,
        logger: Callable[[Mapping[str, Any]], None] = log_json,
        log: Logger | None = None,
    ) -> None:
        self._index = index
        self._module_root = module_root.resolve()
        self._token = token.encode()
        self._max_concurrency = max_concurrency
        self._max_body_bytes = max_body_bytes
        self._default_timeout_ms = default_timeout_ms
        self._log = logger
        # Records (`kindgi.log`, subsystem `pack`): a call's record, and `ctx.log` beneath it.
        self._records = log or noop_logger
        # Every version of a tool the pack holds, side by side: one agent
        # version may pin tool@1 while another pins tool@2.
        self._tools: dict[str, list[Mapping[str, Any]]] = {}
        for t in cast("list[Mapping[str, Any]]", index.get("tools", [])):
            self._tools.setdefault(str(t["id"]), []).append(t)
        self._checks: dict[str, Mapping[str, Any]] = {
            str(g.get("checkId") or g["id"]): g
            for g in cast("list[Mapping[str, Any]]", index.get("guardrails", []))
        }
        self._validators: dict[int, SchemaValidator | Exception] = {}
        self._executor = ThreadPoolExecutor(
            max_workers=max_concurrency, thread_name_prefix="kindgi-pack"
        )
        self._in_flight = 0
        self._ready = False
        self._draining = False
        # Checked once, at startup: a revision's env doesn't change while it runs.
        source = os.environ if environ is None else environ
        required = cast("Mapping[str, Any]", index.get("env") or {}).get("required", [])
        self._env_check: EnvCheck = env_check
        # `required` is sorted in the index, so this is too.
        self._missing_env = [
            str(name) for name in cast("list[Any]", required) if source.get(str(name), "") == ""
        ]

    # -- lifecycle ---------------------------------------------------------

    def prewarm(self) -> list[Message]:
        """Import every tool and check module; the failures (`handler-import-failed`)."""
        mount_pack(self._module_root)
        failures: list[Message] = []
        targets = [
            (tool_id, t["modulePath"], "toolId")
            for tool_id, versions in self._tools.items()
            for t in versions
        ]
        targets += [
            (check_id, g["checkModulePath"], "checkId") for check_id, g in self._checks.items()
        ]
        for target_id, module_path, id_key in targets:
            try:
                import_pack_module(self._relative(str(module_path)))
            except BaseException as cause:
                if isinstance(cause, KeyboardInterrupt):
                    raise
                failures.append(
                    pack_error(
                        "handler-import-failed",
                        f"{target_id}: {_describe(cause)}",
                        **{id_key: target_id},
                    )
                )
        self._ready = not failures
        return failures

    def begin_drain(self) -> None:
        self._draining = True

    async def drain(self, grace_s: float) -> None:
        """Stop taking calls (`/readyz` → 503) and wait for in-flight ones, up to `grace_s`."""
        self._draining = True
        deadline = time.monotonic() + grace_s
        while self._in_flight > 0 and time.monotonic() < deadline:
            await asyncio.sleep(0.025)

    @property
    def index(self) -> Mapping[str, Any]:
        return self._index

    @property
    def in_flight(self) -> int:
        return self._in_flight

    @property
    def ready(self) -> bool:
        return self._unready() is None

    @property
    def missing_env(self) -> list[str]:
        """The index's `env.required` names unset or empty at startup (sorted)."""
        return list(self._missing_env)

    def _unready(self) -> Message | None:
        """Why `/readyz` and new calls answer 503, or `None` when ready."""
        if self._draining:
            return {"error": "draining"}
        if self._env_check == "strict" and self._missing_env:
            return {"error": "missing env", "missingEnv": list(self._missing_env)}
        if not self._ready:
            return {"error": "not ready"}
        return None

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # -- ASGI --------------------------------------------------------------

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        path = str(scope["path"])
        route = _ROUTES.get(path)
        if route is None:
            await _reply(send, 404, {"error": f"No route {path}"})
            return
        if scope["method"] != route.method:
            await _reply(send, 405, {"error": f"Use {route.method}"})
            return
        if route.auth and not self._authorized(scope):
            await _reply(send, 401, {"error": "Bad pack token"})
            return
        if route.name == "healthz":
            await _reply(send, 200, {"status": "ok"})
        elif route.name == "readyz":
            unready = self._unready()
            if unready is None:
                await _reply(send, 200, {"status": "ready"})
            else:
                await _unavailable(send, unready)
        elif route.name == "info":
            await _reply(send, 200, self._info())
        else:
            await self._invoke(scope, receive, send)

    def _authorized(self, scope: Scope) -> bool:
        got = _header(scope, PACK_HEADERS.token)
        return got is not None and hmac.compare_digest(got.encode(), self._token)

    def _info(self) -> Message:
        return {
            "protocol": PACK_PROTOCOL_VERSION,
            "packId": self._index.get("packId"),
            "packVersion": self._index.get("packVersion"),
            "artifactVersion": self._index.get("artifactVersion"),
            "tools": [
                {"id": tool_id, **({"version": t["version"]} if t.get("version") else {})}
                for tool_id, versions in self._tools.items()
                for t in versions
            ],
            "checks": list(self._checks),
            "missingEnv": list(self._missing_env),
        }

    async def _invoke(self, scope: Scope, receive: Receive, send: Send) -> None:
        unready = self._unready()
        if unready is not None:
            await _unavailable(send, unready)
            return
        if self._in_flight >= self._max_concurrency:
            await _unavailable(send, {"error": "overloaded"})
            return
        if "application/json" not in (_header(scope, "content-type") or ""):
            await _reply(send, 415, {"error": "Content-Type must be application/json"})
            return
        self._in_flight += 1
        started = time.monotonic()
        try:
            try:
                body = await self._read_body(receive)
            except _Disconnected:
                return
            if body is None:
                await _reply(send, 413, {"error": "Request body too large"})
                return
            response = await self._dispatch(scope, receive, body)
            await _reply(
                send,
                200,
                response,
                {
                    PACK_HEADERS.duration_ms: str(int((time.monotonic() - started) * 1000)),
                    PACK_HEADERS.artifact_version: str(self._index.get("artifactVersion", "")),
                },
            )
        finally:
            self._in_flight -= 1

    async def _read_body(self, receive: Receive) -> bytes | None:
        chunks: list[bytes] = []
        size = 0
        too_large = False
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                raise _Disconnected
            chunk = cast("bytes", message.get("body", b""))
            size += len(chunk)
            too_large = too_large or size > self._max_body_bytes
            if not too_large:
                chunks.append(chunk)
            if not message.get("more_body", False):
                return None if too_large else b"".join(chunks)

    async def _dispatch(self, scope: Scope, receive: Receive, body: bytes) -> Message:
        try:
            value = json.loads(body.decode("utf-8"), parse_constant=_reject_constant)
        except (UnicodeDecodeError, ValueError):
            return pack_error("malformed-message", "Request body is not valid JSON")
        message = parse_request(value)
        if isinstance(message, dict):
            return message
        target: Target = "tool" if isinstance(message, ToolInvoke) else "check"
        call_id = message.tool_id if isinstance(message, ToolInvoke) else message.check_id
        ids = {"toolId": call_id} if target == "tool" else {"checkId": call_id}

        # The call's ids and trace, on its record and on the handler's `ctx.log`.
        call_log = self._records.child(
            {
                **_call_ids(message.ctx if isinstance(message, ToolInvoke) else None),
                **_call_trace(_header(scope, PACK_HEADERS.traceparent)),
                "target": target,
                **ids,
            }
        )
        cancellation = Cancellation()
        timeout_ms = (
            _parse_timeout(_header(scope, PACK_HEADERS.timeout_ms)) or self._default_timeout_ms
        )
        started = time.monotonic()
        work = asyncio.ensure_future(
            self._run_tool(message, cancellation, call_log)
            if isinstance(message, ToolInvoke)
            else self._run_check(message)
        )
        disconnect = asyncio.ensure_future(_wait_disconnect(receive))
        done, _ = await asyncio.wait(
            {work, disconnect}, timeout=timeout_ms / 1000, return_when=asyncio.FIRST_COMPLETED
        )
        if work in done:
            disconnect.cancel()
            outcome = work.result()
        else:
            reason: Literal["deadline-exceeded", "cancelled"] = (
                "cancelled" if disconnect in done else "deadline-exceeded"
            )
            disconnect.cancel()
            cancellation.cancel(reason)
            text = (
                f"{call_id} passed its deadline"
                if reason == "deadline-exceeded"
                else f"{call_id} was cancelled"
            )
            outcome = pack_error(reason, text, **ids)
            work.add_done_callback(
                lambda task: self._finished_late(task, target, call_id, started, call_log)
            )
            work.cancel()
        duration_ms = int((time.monotonic() - started) * 1000)
        result = outcome["code"] if outcome.get("kind") == "error" else "ok"
        self._log(
            {
                "kind": "call",
                "target": target,
                "id": call_id,
                "durationMs": duration_ms,
                "outcome": result,
            }
        )
        (call_log.info if result == "ok" else call_log.warn)(
            f"{target} {call_id} {result} {duration_ms}ms",
            {
                "event": "call",
                "kind": "call",
                "id": call_id,
                "outcome": result,
                "durationMs": duration_ms,
            },
            in_message=("target", "id", "outcome", "durationMs"),
        )
        return outcome

    def _finished_late(
        self,
        task: asyncio.Future[Message],
        target: Target,
        call_id: str,
        started: float,
        call_log: Logger = noop_logger,
    ) -> None:
        if not task.cancelled():
            self._late(target, call_id, started, call_log)

    def _late(
        self, target: Target, call_id: str, started: float, call_log: Logger = noop_logger
    ) -> None:
        after_ms = int((time.monotonic() - started) * 1000)
        self._log(
            {"kind": "handler-finished-late", "target": target, "id": call_id, "afterMs": after_ms}
        )
        call_log.warn(
            f"{target} {call_id} finished {after_ms} ms after its call ended",
            {
                "event": "handler-finished-late",
                "kind": "handler-finished-late",
                "afterMs": after_ms,
            },
        )

    # -- running pack code --------------------------------------------------

    async def _run_tool(
        self, message: ToolInvoke, cancellation: Cancellation, call_log: Logger = noop_logger
    ) -> Message:
        tool_id = message.tool_id
        versions = self._tools.get(tool_id, [])
        if not versions:
            return pack_error(
                "tool-not-in-pack", f'This pack has no tool "{tool_id}"', toolId=tool_id
            )
        # The version the call asks for, or, when it names none, the only one.
        if message.tool_version is None:
            entry = versions[0] if len(versions) == 1 else None
        else:
            entry = next((t for t in versions if t.get("version") == message.tool_version), None)
        if entry is None:
            have = ", ".join(str(t.get("version") or "unversioned") for t in versions)
            asked = (
                "named none"
                if message.tool_version is None
                else f"asked for {message.tool_version}"
            )
            return pack_error(
                "tool-version-mismatch",
                f'Tool "{tool_id}" is {have} in this pack; the caller {asked}',
                toolId=tool_id,
            )
        module_path = str(entry["modulePath"])
        found = self._resolve(module_path, Tool, tool_id, "handler")
        if isinstance(found, dict):
            return {**found, "toolId": tool_id}
        tool = cast("Tool[..., Any]", found)

        validator = self._validator(entry["input"])
        if isinstance(validator, Exception):
            return pack_error(
                "input-validation-failed",
                f'Tool "{tool_id}" input schema failed to compile: {_describe(validator)}',
                toolId=tool_id,
            )
        # As the Node worker's Ajv `useDefaults`: the schema's defaults, filled into a copy.
        candidate = apply_defaults(entry["input"], message.input)
        issues = validator.issues(candidate)
        if issues:
            return pack_error(
                "input-validation-failed",
                f'Tool "{tool_id}" input failed validation',
                toolId=tool_id,
                issues=issues,
            )
        try:
            argument = tool.parse_input(candidate)
        except PydanticError as error:
            return pack_error(
                "input-validation-failed",
                f'Tool "{tool_id}" input failed validation',
                toolId=tool_id,
                issues=issues_from_pydantic(error),
            )

        # The handler's records are its own (`pack.tool`), shown, never acted on.
        ctx = ToolContext.from_wire(
            message.ctx, cancellation, call_log.child(subsystem="pack.tool")
        )
        try:
            result = await self._call(
                tool.handler,
                tool.is_async,
                *tool.invoke_args(argument, ctx),
                late=("tool", tool_id),
                late_log=call_log,
            )
        except asyncio.CancelledError:
            raise
        except BaseException as cause:
            if isinstance(cause, KeyboardInterrupt):
                raise
            return pack_error(
                "handler-throw",
                f'Handler for tool "{tool_id}" threw: {_describe_named(cause)}',
                toolId=tool_id,
                cause=_serialize_cause(cause),
            )

        try:
            output = tool.dump_output(result)
            compact_dumps(output)
        except Exception as cause:
            return pack_error(
                "output-validation-failed",
                f'Tool "{tool_id}" handler produced output that is not JSON: {_describe(cause)}',
                toolId=tool_id,
            )
        output_validator = self._validator(entry["output"])
        if isinstance(output_validator, Exception):
            return pack_error(
                "output-validation-failed",
                f'Tool "{tool_id}" output schema failed to compile: {_describe(output_validator)}',
                toolId=tool_id,
            )
        output_issues = output_validator.issues(output)
        if output_issues:
            return pack_error(
                "output-validation-failed",
                f'Tool "{tool_id}" handler produced output that failed validation',
                toolId=tool_id,
                issues=output_issues,
            )
        return {"v": PACK_PROTOCOL_VERSION, "kind": "result", "output": output}

    async def _run_check(self, message: CheckInvoke) -> Message:
        check_id = message.check_id
        entry = self._checks.get(check_id)
        if entry is None:
            return pack_error(
                "check-not-in-pack", f'This pack has no check "{check_id}"', checkId=check_id
            )
        found = self._resolve(str(entry["checkModulePath"]), Guardrail, check_id, "check")
        if isinstance(found, dict):
            return {**found, "checkId": check_id}
        guardrail = cast("Guardrail", found)

        # Checked as sent (no defaults filled in), as the indexer checks a declared
        # config; a schema that doesn't compile is refused, as a tool's input schema is.
        schema = entry.get("configSchema")
        if isinstance(schema, Mapping):
            validator = self._validator(cast("Mapping[str, Any]", schema))
            if isinstance(validator, Exception):
                return pack_error(
                    "input-validation-failed",
                    f'Check "{check_id}" config schema failed to compile: {_describe(validator)}',
                    checkId=check_id,
                )
            issues = validator.issues(dict(message.config))
            if issues:
                return pack_error(
                    "input-validation-failed",
                    f'Check "{check_id}" config failed validation{_first_issue(issues)}',
                    checkId=check_id,
                    issues=issues,
                )
        try:
            config = guardrail.parse_config(message.config)
        except PydanticError as error:
            issues = issues_from_pydantic(error)
            return pack_error(
                "input-validation-failed",
                f'Check "{check_id}" config failed validation{_first_issue(issues)}',
                checkId=check_id,
                issues=issues,
            )
        try:
            trace = guardrail.parse_trace(message.trace)
        except PydanticError as error:
            return pack_error(
                "input-validation-failed",
                f'Check "{check_id}" trace failed validation',
                checkId=check_id,
                issues=issues_from_pydantic(error),
            )
        try:
            result = await self._call(
                guardrail.check, guardrail.is_async, config, trace, late=("check", check_id)
            )
        except asyncio.CancelledError:
            raise
        except BaseException as cause:
            if isinstance(cause, KeyboardInterrupt):
                raise
            return pack_error(
                "handler-throw",
                f'Check "{check_id}" evaluate() threw: {_describe_named(cause)}',
                checkId=check_id,
                cause=_serialize_cause(cause),
            )
        wire = check_result_to_wire(result)
        if wire is None:
            return pack_error(
                "output-validation-failed",
                f'Check "{check_id}" returned {type(result).__name__}; a check returns '
                "a CheckResult, a dict with a boolean `passed`, or a bool",
                checkId=check_id,
            )
        return {"v": PACK_PROTOCOL_VERSION, "kind": "check-result", "result": wire}

    async def _call(
        self,
        fn: Callable[..., Any],
        is_async: bool,
        *args: Any,
        late: tuple[Target, str],
        late_log: Logger = noop_logger,
    ) -> Any:
        if is_async:
            return await fn(*args)
        context = contextvars.copy_context()
        future: Future[Any] = self._executor.submit(context.run, fn, *args)
        started = time.monotonic()
        try:
            return await asyncio.wrap_future(future)
        except asyncio.CancelledError:
            # The thread can't be stopped; note when it finishes.
            if not future.done():
                loop = asyncio.get_running_loop()
                future.add_done_callback(
                    lambda f: (
                        None
                        if f.cancelled()
                        else loop.call_soon_threadsafe(self._late, *late, started, late_log)
                    )
                )
            raise

    def _resolve(self, module_path: str, kind: type, target_id: str, what: str) -> Any:
        try:
            module = import_pack_module(self._relative(module_path))
        except BaseException as cause:
            if isinstance(cause, KeyboardInterrupt):
                raise
            return pack_error(
                "handler-import-failed",
                f"Failed to import {what} module '{module_path}': {_describe_named(cause)}",
                cause=_serialize_cause(cause),
            )
        for primitive in primitives_of(module):
            if isinstance(primitive, kind):
                if isinstance(primitive, Tool) and primitive.id == target_id:
                    return primitive
                if isinstance(primitive, Guardrail) and target_id in (
                    primitive.check_id,
                    primitive.id,
                ):
                    return primitive
        code = "handler-shape-invalid" if kind is Tool else "check-shape-invalid"
        return pack_error(code, f"Module '{module_path}' does not define {what} \"{target_id}\"")

    def _relative(self, module_path: str) -> str:
        path = PurePosixPath(module_path)
        if path.is_absolute():
            return Path(module_path).resolve().relative_to(self._module_root).as_posix()
        return module_path

    def _validator(self, schema: Mapping[str, Any]) -> SchemaValidator | Exception:
        key = id(schema)
        cached = self._validators.get(key)
        if cached is None:
            try:
                cached = SchemaValidator(schema)
            except Exception as cause:
                cached = cause
            self._validators[key] = cached
        return cached


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _header(scope: Scope, name: str) -> str | None:
    wanted = name.encode()
    for key, value in cast("list[tuple[bytes, bytes]]", scope.get("headers", [])):
        if key.lower() == wanted:
            return value.decode("latin-1")
    return None


async def _reply(
    send: Send, status: int, body: Any, headers: Mapping[str, str] | None = None
) -> None:
    payload = compact_dumps(body).encode()
    raw_headers = [
        (b"content-type", b"application/json; charset=utf-8"),
        (b"content-length", str(len(payload)).encode()),
        *((key.encode(), value.encode()) for key, value in (headers or {}).items()),
    ]
    try:
        await send({"type": "http.response.start", "status": status, "headers": raw_headers})
        await send({"type": "http.response.body", "body": payload})
    except Exception:  # the caller went away; nothing to answer
        pass


async def _unavailable(send: Send, body: Message) -> None:
    await _reply(send, 503, body, {"retry-after": "1"})


async def _wait_disconnect(receive: Receive) -> None:
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return


def _parse_timeout(raw: str | None) -> int | None:
    if raw is None or not raw.strip().isdigit():
        return None
    ms = int(raw)
    return ms if ms > 0 else None


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _first_issue(issues: list[Issue]) -> str:
    """Where the first issue is and what it says (` at /maxChars: must be >= 0`).

    For a message read without its issues: a runtime reports a check's error by
    its code and message alone.
    """
    if not issues:
        return ""
    first = issues[0]
    at = f" at {first['instancePath']}" if first.get("instancePath") else ""
    return f"{at}: {first.get('message') or 'invalid'}"


def _describe(cause: BaseException) -> str:
    return str(cause) or type(cause).__name__


def _describe_named(cause: BaseException) -> str:
    return f"{type(cause).__name__}: {cause}"


def _serialize_cause(cause: BaseException) -> Message:
    return {
        "name": type(cause).__name__,
        "message": str(cause),
        "stack": "".join(traceback.format_exception(cause)),
    }


def _call_ids(ctx: Mapping[str, Any] | None) -> dict[str, str]:
    """The ids a call's records carry, from its context."""
    if ctx is None:
        return {}
    return {
        key: value
        for key in ("tenantId", "projectId", "orgId", "runId", "requestId")
        if isinstance(value := ctx.get(key), str) and value != ""
    }


def _call_trace(header: str | None) -> dict[str, str]:
    """The caller's trace id and a span of this call's own, parented to the caller's; none
    without a `traceparent` (an older runtime): a fresh trace would join nothing."""
    parent = parse_traceparent(header)
    if parent is None:
        return {}
    span = child_span(parent)
    return {"traceId": span.trace_id, "spanId": span.span_id}
