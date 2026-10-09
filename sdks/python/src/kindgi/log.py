# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Kindgi's structured logs, for Python: the same records as `@kindgi/log` (TypeScript).

A record is one JSON object per line: `time` (RFC 3339), `level`, `severity` (Cloud
Logging's name for the level), `subsystem` and `message`, then the correlation ids
(`traceId`, `runId`, …) when known, then the event's own fields; an error is `err`. The
runtime, its pack services in both languages and `kindgi dev` write and read this one
schema. It needs no dependency beyond the standard library.

    from kindgi.log import get_logger
    log = get_logger("billing", tenantId=tenant_id)
    log.info("charged", {"amountCents": 1200})

Levels, per subsystem with dotted inheritance (`pack=debug` covers `pack.tool`), and the
format come from `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT`
(`configure`). Every record is redacted before it's written: fields whose key looks secret
become `[redacted]`, and known secret shapes in any string (Kindgi tokens, `Bearer …`, a
URL's password) are masked. Pass a secret's name, never its value.

`JsonFormatter` and `PrettyFormatter` put an app's own `logging` records in the same
schema.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import re
import secrets as _secrets
import sys
import traceback
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TextIO, cast

__all__ = [
    "LOG_LEVELS",
    "REDACTED",
    "SEVERITY",
    "TRACE",
    "JsonFormatter",
    "LogConfigError",
    "Logger",
    "PrettyFormatter",
    "TraceContext",
    "child_span",
    "configure",
    "create_logger",
    "format_json",
    "format_pretty",
    "get_logger",
    "is_secret_key",
    "level_for",
    "logger_from_env",
    "noop_logger",
    "parse_log_level",
    "parse_log_levels",
    "parse_traceparent",
    "redact_value",
    "resolve_log_format",
    "scrub_text",
]

LogLevel = Literal["error", "warn", "info", "debug", "trace"]
LogFormat = Literal["json", "pretty"]

LOG_LEVELS: tuple[LogLevel, ...] = ("error", "warn", "info", "debug", "trace")
"""Most severe first."""

_RANK: Mapping[str, int] = {"error": 50, "warn": 40, "info": 30, "debug": 20, "trace": 10}

SEVERITY: Mapping[str, str] = {
    "error": "ERROR",
    "warn": "WARNING",
    "info": "INFO",
    "debug": "DEBUG",
    "trace": "DEBUG",
}
"""Cloud Logging's severity names: Cloud Run and GKE show levels with no agent setup."""

TRACE = 5
"""The `logging` level number for `trace`, below `DEBUG`."""
logging.addLevelName(TRACE, "TRACE")

_CORRELATION: tuple[str, ...] = (
    "traceId",
    "spanId",
    "runTraceId",
    "requestId",
    "tenantId",
    "projectId",
    "orgId",
    "runId",
    "parentRunId",
    "agentId",
    "agentVersion",
    "flowId",
    "flowVersion",
    "toolId",
    "conversationId",
    "approvalId",
)
"""Correlation fields, in the order a record carries them, after the fixed five."""

_FIXED = frozenset({"time", "level", "severity", "subsystem", "message"})


# -- levels -------------------------------------------------------------------------------


def level_enabled(level: str, threshold: str) -> bool:
    """Whether a record at `level` is written by a logger at `threshold`."""
    return _RANK[level] >= _RANK[threshold]


def parse_log_level(raw: str) -> LogLevel | None:
    """A level's name, case and spaces aside; `None` when it isn't one."""
    value = raw.strip().lower()
    return value if value in LOG_LEVELS else None  # type: ignore[return-value]


def parse_log_levels(raw: str) -> dict[str, LogLevel]:
    """`KINDGI_LOG_LEVELS`'s form: `subsystem=level,…`. Raises `ValueError` quoting a bad entry."""
    levels: dict[str, LogLevel] = {}
    for entry in raw.split(","):
        trimmed = entry.strip()
        if trimmed == "":
            continue
        name, eq, rest = trimmed.partition("=")
        subsystem = name.strip() if eq else ""
        level = parse_log_level(rest) if eq else None
        if subsystem == "" or level is None:
            raise ValueError(
                f'"{trimmed}" isn\'t subsystem=level (levels: {", ".join(LOG_LEVELS)})'
            )
        levels[subsystem] = level
    return levels


def level_for(subsystem: str, levels: Mapping[str, str], fallback: str) -> str:
    """The level for `subsystem`: its own entry, its nearest dotted parent's, else `fallback`."""
    name = subsystem
    while True:
        own = levels.get(name)
        if own is not None:
            return own
        dot = name.rfind(".")
        if dot == -1:
            return fallback
        name = name[:dot]


# -- redaction ----------------------------------------------------------------------------

REDACTED = "[redacted]"

_SECRET_KEY_ENDINGS: tuple[str, ...] = (
    "authorization",
    "cookie",
    "token",
    "password",
    "passwd",
    "secret",
    "secrets",
    "apikey",
    "privatekey",
    "passphrase",
    "credential",
    "credentials",
)


def _normalize(key: str) -> str:
    return key.lower().replace("-", "").replace("_", "")


def is_secret_key(key: str, extra: Sequence[str] = ()) -> bool:
    """Whether a field's key looks secret: lowercased without `-`/`_`, it ends in a secret word."""
    k = _normalize(key)
    return any(k.endswith(end) for end in (*_SECRET_KEY_ENDINGS, *(_normalize(e) for e in extra)))


_KINDGI_TOKEN = re.compile(r"\bkgi_([a-z]{2})_([A-Za-z0-9._~+/=-]+)", re.ASCII)
_BEARER = re.compile(r"\b(Bearer)\s+[^\s\"',;]+", re.ASCII | re.IGNORECASE)
_URL_PASSWORD = re.compile(r"\b([a-z][a-z0-9+.-]*://[^\s:/@]+):[^\s@/]+@", re.ASCII | re.IGNORECASE)


def _mask_token(m: re.Match[str]) -> str:
    kind, body = m.group(1), m.group(2)
    tail = body[-4:] if len(body) >= 16 else ""
    return f"kgi_{kind}_…{tail}"


def scrub_text(text: str) -> str:
    """A string with known secret shapes masked: Kindgi tokens, `Bearer …`, a URL's password."""
    text = _KINDGI_TOKEN.sub(_mask_token, text)
    text = _BEARER.sub(r"\1 [redacted]", text)
    return _URL_PASSWORD.sub(r"\1:***@", text)


_MAX_DEPTH = 8


def redact_value(
    value: Any, extra: Sequence[str] = (), _depth: int = 0, _seen: set[int] | None = None
) -> Any:
    """A value with secret keys redacted and strings scrubbed, recursively (a copy)."""
    if isinstance(value, str):
        return scrub_text(value)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, _dt.datetime):
        return _iso(value)
    seen: set[int] = _seen if _seen is not None else set()
    marker = id(value)
    if marker in seen:
        return "[circular]"
    if _depth >= _MAX_DEPTH:
        return "[too deep]"
    seen.add(marker)
    try:
        if isinstance(value, Mapping):
            items = cast("Mapping[Any, Any]", value).items()
            return {
                str(k): REDACTED
                if is_secret_key(str(k), extra)
                else redact_value(v, extra, _depth + 1, seen)
                for k, v in items
            }
        if isinstance(value, (list, tuple)):
            elements = cast("Sequence[Any]", value)
            return [redact_value(v, extra, _depth + 1, seen) for v in elements]
        return scrub_text(str(value))
    finally:
        seen.discard(marker)


# -- records ------------------------------------------------------------------------------


def _iso(when: _dt.datetime) -> str:
    when = when.astimezone(_dt.UTC) if when.tzinfo else when.replace(tzinfo=_dt.UTC)
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _serialize_error(err: BaseException | Any, with_stack: bool, depth: int = 0) -> Any:
    if not isinstance(err, BaseException):
        return scrub_text(str(err))
    out: dict[str, Any] = {"name": type(err).__name__, "message": scrub_text(str(err))}
    code = getattr(err, "code", None)
    if isinstance(code, (str, int)) and not isinstance(code, bool):
        out["code"] = str(code)
    if with_stack:
        out["stack"] = scrub_text(
            "".join(traceback.format_exception(type(err), err, err.__traceback__))
        )
    cause = err.__cause__
    if cause is not None and depth < 3:
        out["cause"] = _serialize_error(cause, with_stack, depth + 1)
    return out


def _build_record(
    *,
    time: _dt.datetime,
    level: str,
    subsystem: str,
    message: str,
    merged: Mapping[str, Any],
    threshold: str,
    extra: Sequence[str],
) -> dict[str, Any]:
    """The record, built exactly as `@kindgi/log` builds it (the shared vectors check it)."""
    out: dict[str, Any] = {
        "time": _iso(time),
        "level": level,
        "severity": SEVERITY[level],
        "subsystem": subsystem,
        "message": scrub_text(message),
    }
    for key in _CORRELATION:
        if key in merged:
            out[key] = redact_value(merged[key], extra)
    reserved: dict[str, Any] = {}
    for key, value in merged.items():
        if key in ("subsystem", "err") or key in _CORRELATION:
            continue
        if key in _FIXED:
            reserved[key] = value
        else:
            out[key] = (
                _serialize_error(value, level == "error")
                if isinstance(value, BaseException)
                else value
            )
    redacted: dict[str, Any] = redact_value(out, extra)
    for key in _FIXED:
        redacted[key] = out[key]
    if reserved:
        redacted["fields"] = redact_value(reserved, extra)
    if "err" in merged:
        with_stack = level == "error" or level_enabled("debug", threshold)
        redacted["err"] = _serialize_error(merged["err"], with_stack)
    return redacted


def format_json(record: Mapping[str, Any]) -> str:
    """The JSON format: one record per line."""
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"), default=str)


_LEVEL_LABEL: Mapping[str, str] = {
    "error": "ERROR",
    "warn": "WARN ",
    "info": "INFO ",
    "debug": "DEBUG",
    "trace": "TRACE",
}
_COLOR: Mapping[str, str] = {
    "error": "\x1b[31m",
    "warn": "\x1b[33m",
    "info": "\x1b[36m",
    "debug": "\x1b[90m",
    "trace": "\x1b[90m",
}
_RESET = "\x1b[0m"
_DIM = "\x1b[2m"
_PRETTY_FIXED = frozenset({*_FIXED, "err"})


def _pretty(value: Any) -> str:
    if isinstance(value, str):
        return (
            json.dumps(value, ensure_ascii=False)
            if value == "" or re.search(r'[\s"=]', value)
            else value
        )
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _error_lines(err: Mapping[str, Any]) -> list[str]:
    code = f" ({err['code']})" if err.get("code") is not None else ""
    lines = [f"{err.get('name')}: {err.get('message')}{code}"]
    stack = err.get("stack")
    if isinstance(stack, str):
        lines.extend(
            f"    {line.strip()}" for line in stack.splitlines() if line.strip().startswith("File ")
        )
    cause = err.get("cause")
    if isinstance(cause, str):
        lines.append(f"  caused by: {cause}")
    elif isinstance(cause, Mapping):
        lines.append("  caused by: " + "\n  ".join(_error_lines(cast("Mapping[str, Any]", cause))))
    return lines


def format_pretty(
    record: Mapping[str, Any], *, color: bool = False, omit: Sequence[str] = ()
) -> str:
    """`HH:MM:SS.mmm LEVEL [subsystem] message key=value …`, for a person at a terminal."""
    time = str(record["time"])[11:23]
    level = str(record["level"])
    label = _LEVEL_LABEL[level]
    fields = [
        f"{key}={_pretty(value)}"
        for key, value in record.items()
        if key not in _PRETTY_FIXED and key not in omit
    ]
    head = " ".join(
        [
            f"{_DIM}{time}{_RESET}" if color else time,
            f"{_COLOR[level]}{label}{_RESET}" if color else label,
            f"[{record['subsystem']}]",
            str(record["message"]),
            *fields,
        ]
    )
    err = record.get("err")
    if not isinstance(err, Mapping):
        return head
    first, *rest = _error_lines(cast("Mapping[str, Any]", err))
    return "\n".join([f"{head} err={_pretty(first)}", *rest])


# -- the logger ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Shared:
    threshold: str
    levels: Mapping[str, str]
    format: LogFormat
    color: bool
    write: Callable[[str], None]
    redact: Sequence[str]
    subsystem: str
    now: Callable[[], _dt.datetime]


class Logger:
    """A logger: records at or above its level are redacted and written as JSON or pretty lines.

    `log.info("message", {"field": value})` (or `**fields`); pass an error as `err=exc`.
    `log.child(subsystem="pack.tool", runId=run_id)` binds fields to every record. Logging
    never raises.
    """

    __slots__ = ("_bindings", "_shared", "_subsystem", "_threshold")

    def __init__(self, shared: _Shared, bindings: Mapping[str, Any]) -> None:
        self._shared = shared
        self._bindings = dict(bindings)
        sub = bindings.get("subsystem")
        self._subsystem = sub if isinstance(sub, str) and sub != "" else shared.subsystem
        self._threshold = level_for(self._subsystem, shared.levels, shared.threshold)

    def __repr__(self) -> str:
        return f"Logger(subsystem={self._subsystem!r}, level={self._threshold!r})"

    def _write(
        self,
        level: str,
        message: str,
        fields: Mapping[str, Any] | None,
        in_message: Sequence[str] | None,
        kwargs: Mapping[str, Any],
    ) -> None:
        if not level_enabled(level, self._threshold):
            return
        try:
            merged = {**self._bindings, **(fields or {}), **kwargs}
            record = _build_record(
                time=self._shared.now(),
                level=level,
                subsystem=self._subsystem,
                message=message,
                merged=merged,
                threshold=self._threshold,
                extra=self._shared.redact,
            )
            line = (
                format_pretty(record, color=self._shared.color, omit=in_message or ())
                if self._shared.format == "pretty"
                else format_json(record)
            )
            self._shared.write(line)
        except Exception:
            return

    def error(
        self,
        message: str,
        fields: Mapping[str, Any] | None = None,
        /,
        *,
        in_message: Sequence[str] | None = None,
        **kw: Any,
    ) -> None:
        self._write("error", message, fields, in_message, kw)

    def warn(
        self,
        message: str,
        fields: Mapping[str, Any] | None = None,
        /,
        *,
        in_message: Sequence[str] | None = None,
        **kw: Any,
    ) -> None:
        self._write("warn", message, fields, in_message, kw)

    def info(
        self,
        message: str,
        fields: Mapping[str, Any] | None = None,
        /,
        *,
        in_message: Sequence[str] | None = None,
        **kw: Any,
    ) -> None:
        self._write("info", message, fields, in_message, kw)

    def debug(
        self,
        message: str,
        fields: Mapping[str, Any] | None = None,
        /,
        *,
        in_message: Sequence[str] | None = None,
        **kw: Any,
    ) -> None:
        self._write("debug", message, fields, in_message, kw)

    def trace(
        self,
        message: str,
        fields: Mapping[str, Any] | None = None,
        /,
        *,
        in_message: Sequence[str] | None = None,
        **kw: Any,
    ) -> None:
        self._write("trace", message, fields, in_message, kw)

    def child(self, bindings: Mapping[str, Any] | None = None, /, **kw: Any) -> Logger:
        """A logger whose records also carry `bindings`; `subsystem` replaces the parent's."""
        return Logger(self._shared, {**self._bindings, **(bindings or {}), **kw})

    def is_level_enabled(self, level: str) -> bool:
        """Whether a record at `level` would be written: skip costly fields when it wouldn't."""
        return level_enabled(level, self._threshold)


def create_logger(
    *,
    write: Callable[[str], None],
    level: str = "info",
    levels: Mapping[str, str] | None = None,
    format: LogFormat = "json",
    color: bool = False,
    redact: Sequence[str] = (),
    subsystem: str = "root",
    now: Callable[[], _dt.datetime] | None = None,
) -> Logger:
    """A logger writing one line per record to `write` (no trailing newline)."""
    return Logger(
        _Shared(
            threshold=level,
            levels=dict(levels or {}),
            format=format,
            color=color,
            write=write,
            redact=tuple(redact),
            subsystem=subsystem,
            now=now or (lambda: _dt.datetime.now(_dt.UTC)),
        ),
        {},
    )


class _NoopLogger(Logger):
    __slots__ = ()

    def _write(
        self,
        level: str,
        message: str,
        fields: Mapping[str, Any] | None,
        in_message: Sequence[str] | None,
        kwargs: Mapping[str, Any],
    ) -> None:
        return None

    def child(self, bindings: Mapping[str, Any] | None = None, /, **kw: Any) -> Logger:
        return self

    def is_level_enabled(self, level: str) -> bool:
        return False


noop_logger: Logger = _NoopLogger(
    _Shared(
        threshold="error",
        levels={},
        format="json",
        color=False,
        write=lambda _line: None,
        redact=(),
        subsystem="root",
        now=lambda: _dt.datetime.now(_dt.UTC),
    ),
    {},
)
"""Writes nothing: a default where no logger is given."""


# -- settings -----------------------------------------------------------------------------


class LogConfigError(ValueError):
    """A `KINDGI_LOG_*` setting that can't be honoured; the message names it."""


def resolve_log_format(raw: str | None, *, is_tty: bool, dev: bool = False) -> LogFormat | None:
    """`KINDGI_LOG_FORMAT`: `json`, `pretty`, or `auto` (pretty on a terminal or in dev mode)."""
    value = (raw or "").strip().lower()
    if value in ("", "auto"):
        return "pretty" if is_tty or dev else "json"
    if value in ("json", "pretty"):
        return value  # type: ignore[return-value]
    return None


def logger_from_env(
    env: Mapping[str, str] | None = None,
    *,
    write: Callable[[str], None] | None = None,
    is_tty: bool = False,
    subsystems: Sequence[str] | None = None,
    redact: Sequence[str] = (),
) -> tuple[Logger, list[str]]:
    """The root logger from `KINDGI_LOG_*`, and the harmless problems to report.

    Raises `LogConfigError` for an unknown level or format, or a malformed
    `KINDGI_LOG_LEVELS`. A subsystem in `KINDGI_LOG_LEVELS` that's not in `subsystems`
    (when given) is a problem, not an error. Default sink: stdout.
    """
    environ = os.environ if env is None else env
    raw_level = environ.get("KINDGI_LOG_LEVEL")
    if raw_level is None or raw_level.strip() == "":
        level: str = "info"
    else:
        parsed = parse_log_level(raw_level)
        if parsed is None:
            raise LogConfigError(
                f'KINDGI_LOG_LEVEL must be one of {", ".join(LOG_LEVELS)}, got "{raw_level}".'
            )
        level = parsed
    try:
        levels = parse_log_levels(environ.get("KINDGI_LOG_LEVELS", ""))
    except ValueError as err:
        raise LogConfigError(f"KINDGI_LOG_LEVELS: {err}.") from None
    dev = (environ.get("KINDGI_DEV", "") or "").strip().lower() in ("true", "1")
    fmt = resolve_log_format(environ.get("KINDGI_LOG_FORMAT"), is_tty=is_tty, dev=dev)
    if fmt is None:
        got = environ.get("KINDGI_LOG_FORMAT")
        raise LogConfigError(f'KINDGI_LOG_FORMAT must be auto, json or pretty, got "{got}".')
    problems: list[str] = []
    if subsystems is not None:
        known = set(subsystems)
        problems = [
            f'KINDGI_LOG_LEVELS names "{name}", which no subsystem logs under; it has no effect.'
            for name in levels
            if name not in known and name.split(".")[0] not in known
        ]

    def stdout(line: str) -> None:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    logger = create_logger(
        write=write or stdout,
        level=level,
        levels=levels,
        format=fmt,
        color=fmt == "pretty" and is_tty and environ.get("NO_COLOR", "") == "",
        redact=redact,
    )
    return logger, problems


_root: Logger | None = None


def configure(
    env: Mapping[str, str] | None = None,
    *,
    stream: TextIO | None = None,
    is_tty: bool | None = None,
) -> list[str]:
    """Set the module's root logger from `KINDGI_LOG_*`, writing to `stream` (default stderr).

    Returns the harmless problems to report; raises `LogConfigError` for a bad setting.
    """
    global _root
    out = stream or sys.stderr

    def write(line: str) -> None:
        out.write(line + "\n")
        out.flush()

    tty = is_tty if is_tty is not None else bool(getattr(out, "isatty", lambda: False)())
    logger, problems = logger_from_env(env, write=write, is_tty=tty)
    _root = logger
    return problems


def get_logger(subsystem: str = "root", /, **bindings: Any) -> Logger:
    """A logger for `subsystem` under the root `configure` set (JSON on stderr at `info` before)."""
    global _root
    if _root is None:
        configure({})
    assert _root is not None
    return _root.child(subsystem=subsystem, **bindings)


# -- the standard library's `logging` -------------------------------------------------------


def _level_of(levelno: int) -> LogLevel:
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warn"
    if levelno >= logging.INFO:
        return "info"
    if levelno >= logging.DEBUG:
        return "debug"
    return "trace"


class JsonFormatter(logging.Formatter):
    """A `logging.Formatter` that writes an app's own `logging` records in Kindgi's schema.

    The logger's name is the subsystem; `extra={"fields": {...}}` adds fields; an exception
    (`log.exception(...)`) becomes `err`.
    """

    pretty = False

    def __init__(self, *, redact: Sequence[str] = (), color: bool = False) -> None:
        super().__init__()
        self._redact = tuple(redact)
        self._color = color

    def format(self, record: logging.LogRecord) -> str:
        level = _level_of(record.levelno)
        fields = getattr(record, "fields", None)
        merged: dict[str, Any] = (
            dict(cast("Mapping[str, Any]", fields)) if isinstance(fields, Mapping) else {}
        )
        if record.exc_info and record.exc_info[1] is not None:
            merged["err"] = record.exc_info[1]
        built = _build_record(
            time=_dt.datetime.fromtimestamp(record.created, _dt.UTC),
            level=level,
            subsystem=record.name,
            message=record.getMessage(),
            merged=merged,
            threshold=level,
            extra=self._redact,
        )
        return format_pretty(built, color=self._color) if self.pretty else format_json(built)


class PrettyFormatter(JsonFormatter):
    """`JsonFormatter`'s records, in the pretty format, for a terminal."""

    pretty = True


# -- trace context ------------------------------------------------------------------------


@dataclass(frozen=True)
class TraceContext:
    """A W3C trace context: the trace, this span, its parent's, and the flags."""

    trace_id: str
    span_id: str
    flags: str = "01"
    parent_span_id: str | None = None


_TRACEPARENT = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$")


def parse_traceparent(header: str | None) -> TraceContext | None:
    """An incoming `traceparent`, as the parent of a span to come; `None` if absent or bad."""
    if not isinstance(header, str):
        return None
    value = header.strip()
    m = _TRACEPARENT.match(value)
    if m is None:
        return None
    version, trace_id, parent, flags = m.groups()
    if version == "ff" or (version == "00" and len(value) != 55):
        return None
    if set(trace_id) == {"0"} or set(parent) == {"0"}:
        return None
    return TraceContext(trace_id=trace_id, span_id=parent, flags=flags)


def _random_hex(n: int) -> str:
    while True:
        value = _secrets.token_hex(n)
        if set(value) != {"0"}:
            return value


def child_span(parent: TraceContext) -> TraceContext:
    """A new span in the same trace, whose parent is `parent`'s span."""
    return TraceContext(
        trace_id=parent.trace_id,
        span_id=_random_hex(8),
        flags=parent.flags,
        parent_span_id=parent.span_id,
    )
