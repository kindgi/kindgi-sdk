# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`kindgi.log`: the same records as `@kindgi/log`, replayed from the shared vectors."""

from __future__ import annotations

import datetime as dt
import io
import json
import logging
from collections.abc import Mapping
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
    format_pretty,
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
    getattr(log, case["level"])(case["message"], fields, in_message=case.get("inMessage"))
    if case["expected"] is None:
        assert lines == []
        return
    assert len(lines) == 1
    got = json.loads(lines[0])
    assert got == case["expected"]
    assert list(got) == list(case["expected"])  # keys in the same order


def test_stated_fields_are_left_out_of_a_pretty_line_and_named_in_json() -> None:
    fields = {"method": "POST", "route": "/v1/runs", "status": 201, "durationMs": 12}
    stated = ["method", "route", "status", "durationMs"]
    pretty: list[str] = []
    create_logger(write=pretty.append, format="pretty", now=lambda: NOW).child(
        subsystem="http"
    ).info("POST /v1/runs 201 12ms", {**fields, "tenantId": "t-1"}, in_message=stated)
    assert pretty == ["12:00:00.000 INFO  [http] POST /v1/runs 201 12ms tenantId=t-1"]
    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).child(subsystem="http").info(
        "POST /v1/runs 201 12ms", {**fields, "tenantId": "t-1"}, in_message=stated
    )
    record = json.loads(lines[0])
    assert record["inMessage"] == stated
    # Read back from JSON, the record renders as it did at the source.
    assert format_pretty(record) == pretty[0]


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


def test_an_error_in_a_field_is_logged_like_err_without_stack_or_other_fields() -> None:
    # A database error's own attributes carry the values the query was bound to.
    class DbError(Exception):
        pass

    unique = DbError("duplicate key value violates unique constraint")
    unique.code = "23505"  # type: ignore[attr-defined]
    unique.detail = "Key (email)=(owner@acme.test) already exists."  # type: ignore[attr-defined]
    outer = TypeError("outer")
    outer.__cause__ = unique

    lines: list[str] = []
    create_logger(write=lines.append, level="debug", now=lambda: NOW).error(
        "import failed", {"batch": {"failures": [unique], "last": outer}}
    )
    record = json.loads(lines[0])
    serialized = {
        "name": "DbError",
        "message": "duplicate key value violates unique constraint",
        "code": "23505",
    }
    assert record["batch"] == {
        "failures": [serialized],
        "last": {"name": "TypeError", "message": "outer", "cause": serialized},
    }
    assert "owner@acme.test" not in lines[0]


def test_an_error_that_resists_being_read_never_makes_a_log_call_throw() -> None:
    class Unstringable(Exception):
        def __str__(self) -> str:
            raise RuntimeError("nope")

    class CodeRaises(Exception):
        @property
        def code(self) -> str:
            raise RuntimeError("nope")

    lines: list[str] = []
    log = create_logger(write=lines.append, now=lambda: NOW)
    log.error("as err", err=Unstringable("x"))
    log.error("as a top-level field", {"failure": CodeRaises("boom")})
    log.error("nested", {"batch": {"failure": Unstringable("x")}})
    assert len(lines) == 3
    # A message that can't be read is empty; the name is still the class's. (The stack,
    # which format_exception keeps with a placeholder for the message, carries no secret.)
    as_err = json.loads(lines[0])["err"]
    assert as_err["name"] == "Unstringable"
    assert as_err["message"] == ""
    # The attribute that raises is left out; the rest of the error is written.
    as_field = json.loads(lines[1])["failure"]
    assert as_field["name"] == "CodeRaises"
    assert "code" not in as_field
    # Deeper in a field there's no stack at any level, so the shape is exact.
    assert json.loads(lines[2])["batch"] == {"failure": {"name": "Unstringable", "message": ""}}


def test_a_value_that_raises_when_read_is_unreadable_and_siblings_are_kept() -> None:
    class Unreadable:
        def __str__(self) -> str:
            raise RuntimeError("nope")

        __repr__ = __str__

    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).info(
        "values", {"ok": 1, "bad": Unreadable(), "nested": [Unreadable(), 2]}
    )
    record = json.loads(lines[0])
    assert record["ok"] == 1
    assert record["bad"] == "[unreadable]"
    assert record["nested"] == ["[unreadable]", 2]


def test_a_field_mapping_that_cannot_be_read_is_unreadable() -> None:
    class HostileMapping(Mapping[str, Any]):
        def __getitem__(self, key: str) -> Any:
            raise RuntimeError("nope")

        def __iter__(self) -> Any:
            raise RuntimeError("nope")

        def __len__(self) -> int:
            return 1

    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).info(
        "values", {"ok": 1, "broken": HostileMapping()}
    )
    record = json.loads(lines[0])
    assert record["ok"] == 1
    assert record["broken"] == "[unreadable]"


class _Unlistable(Mapping[str, Any]):
    """A mapping whose keys can't be listed."""

    def __getitem__(self, key: str) -> Any:
        raise RuntimeError("nope")

    def __iter__(self) -> Any:
        raise RuntimeError("nope")

    def __len__(self) -> int:
        raise RuntimeError("nope")


def test_fields_whose_keys_cannot_be_listed_still_write_a_record() -> None:
    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).child(runId="r-1").info(
        "fields", _Unlistable()
    )
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["message"] == "fields"
    assert record["runId"] == "r-1"


def test_child_bindings_whose_keys_cannot_be_listed_still_write_a_record() -> None:
    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).child(_Unlistable()).info("bindings")
    assert len(lines) == 1
    assert json.loads(lines[0])["message"] == "bindings"


def test_a_field_whose_value_cannot_be_read_is_unreadable() -> None:
    class ValueRaises(Mapping[str, Any]):
        def __iter__(self) -> Any:
            return iter(["bad"])

        def __len__(self) -> int:
            return 1

        def __getitem__(self, key: str) -> Any:
            raise RuntimeError("nope")

    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).info("x", ValueRaises(), ok=1)
    record = json.loads(lines[0])
    assert record["bad"] == "[unreadable]"
    assert record["ok"] == 1


def test_a_nested_mapping_keeps_its_readable_keys_when_one_value_raises() -> None:
    class PartlyReadable(Mapping[str, Any]):
        def __iter__(self) -> Any:
            return iter(["ok", "bad"])

        def __len__(self) -> int:
            return 2

        def __getitem__(self, key: str) -> Any:
            if key == "bad":
                raise RuntimeError("nope")
            return 1

    lines: list[str] = []
    create_logger(write=lines.append, now=lambda: NOW).info("values", {"outer": PartlyReadable()})
    record = json.loads(lines[0])
    # One value that raises is `[unreadable]`; the whole mapping isn't lost.
    assert record["outer"] == {"ok": 1, "bad": "[unreadable]"}


def test_the_formatter_writes_a_record_even_when_its_fields_cannot_be_read() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    std = logging.getLogger("acme.hostile")
    std.addHandler(handler)
    std.setLevel(logging.INFO)
    std.propagate = False
    try:
        std.info("looked up %s", "o-1", extra={"fields": _Unlistable()})
    finally:
        std.removeHandler(handler)
    # A hostile `fields` doesn't make `format` raise, so logging doesn't drop the record.
    out = stream.getvalue()
    assert out != ""
    record = json.loads(out)
    assert record["subsystem"] == "acme.hostile"
    assert record["message"] == "looked up o-1"
