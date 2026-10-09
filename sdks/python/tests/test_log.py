# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`kindgi.log`: the same records as `@kindgi/log`, replayed from the shared vectors."""

from __future__ import annotations

import datetime as dt
import io
import json
import logging
from pathlib import Path
from typing import Any

import pytest

from kindgi.log import (
    JsonFormatter,
    LogConfigError,
    PrettyFormatter,
    child_span,
    configure,
    create_logger,
    get_logger,
    logger_from_env,
    noop_logger,
    parse_traceparent,
)

VECTORS = (
    Path(__file__).resolve().parents[3] / "packages" / "log" / "tests" / "vectors" / "records.json"
)
SPEC = json.loads(VECTORS.read_text(encoding="utf-8"))
NOW = dt.datetime.fromisoformat(SPEC["now"].replace("Z", "+00:00"))


@pytest.mark.parametrize("case", SPEC["cases"], ids=[c["name"] for c in SPEC["cases"]])
def test_the_shared_vectors(case: dict[str, Any]) -> None:
    lines: list[str] = []
    log = create_logger(
        write=lines.append,
        level=case["logger"]["level"],
        levels=case["logger"].get("levels"),
        now=lambda: NOW,
    )
    for bindings in case["bindings"]:
        log = log.child(bindings)
    fields = dict(case["fields"])
    if "error" in case:
        spec = case["error"]
        err = type(spec["name"], (Exception,), {})(spec["message"])
        if "code" in spec:
            err.code = spec["code"]  # type: ignore[attr-defined]
        fields["err"] = err
    getattr(log, case["level"])(case["message"], fields)
    if case["expected"] is None:
        assert lines == []
        return
    assert len(lines) == 1
    got = json.loads(lines[0])
    assert got == case["expected"]
    assert list(got) == list(case["expected"])  # keys in the same order


def test_a_bad_setting_is_refused_naming_it() -> None:
    with pytest.raises(LogConfigError, match="KINDGI_LOG_LEVEL"):
        logger_from_env({"KINDGI_LOG_LEVEL": "loud"}, write=lambda _: None)
    with pytest.raises(LogConfigError, match="KINDGI_LOG_LEVELS"):
        logger_from_env({"KINDGI_LOG_LEVELS": "pack"}, write=lambda _: None)
    with pytest.raises(LogConfigError, match="KINDGI_LOG_FORMAT"):
        logger_from_env({"KINDGI_LOG_FORMAT": "xml"}, write=lambda _: None)
    _, problems = logger_from_env(
        {"KINDGI_LOG_LEVELS": "nobody=debug"}, write=lambda _: None, subsystems=["pack"]
    )
    assert problems == [
        'KINDGI_LOG_LEVELS names "nobody", which no subsystem logs under; it has no effect.'
    ]


def test_auto_is_pretty_on_a_terminal_or_in_dev_mode_and_json_otherwise() -> None:
    for env, tty, pretty in (
        ({}, False, False),
        ({}, True, True),
        ({"KINDGI_DEV": "true"}, False, True),
    ):
        lines: list[str] = []
        log, _ = logger_from_env(env, write=lines.append, is_tty=tty)
        log.info("hello")
        assert ("[root] hello" in lines[0]) is pretty
        if not pretty:
            assert json.loads(lines[0])["message"] == "hello"


def test_keyword_fields_and_child_bindings() -> None:
    lines: list[str] = []
    log = create_logger(write=lines.append, now=lambda: NOW).child(subsystem="billing", runId="r-1")
    log.info("charged", amountCents=1200)
    assert json.loads(lines[0]) == {
        "time": "2026-10-08T12:00:00.000Z",
        "level": "info",
        "severity": "INFO",
        "subsystem": "billing",
        "message": "charged",
        "runId": "r-1",
        "amountCents": 1200,
    }


def test_an_error_at_error_level_carries_its_stack_scrubbed() -> None:
    lines: list[str] = []
    log = create_logger(write=lines.append)
    try:
        raise RuntimeError("token kgi_bt_0123456789abcdefWXYZ leaked")
    except RuntimeError as err:
        log.error("failed", err=err)
    record = json.loads(lines[0])
    assert record["err"]["name"] == "RuntimeError"
    assert "kgi_bt_…WXYZ" in record["err"]["message"]
    assert "0123456789abcdef" not in lines[0]
    assert "Traceback" in record["err"]["stack"]


def test_logging_never_raises_even_when_the_sink_does() -> None:
    def broken(_line: str) -> None:
        raise OSError("disk full")

    create_logger(write=broken).info("still fine")


def test_the_noop_logger_writes_nothing() -> None:
    noop_logger.error("x")
    assert noop_logger.is_level_enabled("error") is False
    assert noop_logger.child(subsystem="a") is noop_logger


def test_configure_and_get_logger() -> None:
    stream = io.StringIO()
    assert configure({"KINDGI_LOG_LEVEL": "debug"}, stream=stream, is_tty=False) == []
    get_logger("billing", tenantId="t-1").debug("detail")
    record = json.loads(stream.getvalue())
    assert record["subsystem"] == "billing"
    assert record["tenantId"] == "t-1"
    assert record["level"] == "debug"


def test_the_formatters_put_an_apps_logging_records_in_the_schema() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    std = logging.getLogger("acme.orders")
    std.addHandler(handler)
    std.setLevel(logging.INFO)
    std.propagate = False
    try:
        std.info("looked up %s", "o-1", extra={"fields": {"orderId": "o-1", "apiKey": "nope"}})
        handler.setFormatter(PrettyFormatter())
        std.warning("slow")
    finally:
        std.removeHandler(handler)
    first, second = stream.getvalue().splitlines()
    record = json.loads(first)
    assert record["subsystem"] == "acme.orders"
    assert record["message"] == "looked up o-1"
    assert record["orderId"] == "o-1"
    assert record["apiKey"] == "[redacted]"
    assert "WARN  [acme.orders] slow" in second


def test_traceparent_parsing_and_child_spans() -> None:
    header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    parent = parse_traceparent(header)
    assert parent is not None
    assert parent.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
    span = child_span(parent)
    assert span.trace_id == parent.trace_id
    assert span.parent_span_id == "00f067aa0ba902b7"
    assert len(span.span_id) == 16
    assert span.span_id != parent.span_id
    for bad in (
        None,
        "",
        "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",
        "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
    ):
        assert parse_traceparent(bad) is None
