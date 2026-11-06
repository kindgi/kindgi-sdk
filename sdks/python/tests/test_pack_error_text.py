# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""What a thrown error says in a failed call's answer: the shared error-text vectors
(`packages/log/tests/vectors/error-text.json`, which `@kindgi/log` and the Java pack service
replay too), and the call's values taken out first."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from kindgi.log import describe_causes, scrub_text
from kindgi.pack.context import ConnectionAccount, ToolConnection, ToolContext
from kindgi.pack.error_text import said, serialize_cause, without_values
from kindgi.pack.files import FileStore

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "log"
        / "tests"
        / "vectors"
        / "error-text.json"
    ).read_text()
)

SECRET = "shop-key-0123456789"
OTHER = "acme-pass-9876"
TOKEN = "ya29.acme-token"
KEY = "-----BEGIN KEY-----\nMIIEowIBAAKCAQEA\n-----END KEY-----"


def error_of(spec: dict[str, Any]) -> BaseException:
    """An error as the vectors write it: a class of its name, its message, its code, its cause."""
    error = type(spec["name"], (Exception,), {})(spec["message"])
    if "code" in spec:
        error.code = spec["code"]  # type: ignore[attr-defined]
    if "cause" in spec:
        error.__cause__ = error_of(spec["cause"])
    return error


@pytest.mark.parametrize("case", VECTORS["scrub"], ids=[c["name"] for c in VECTORS["scrub"]])
def test_the_full_mask_masks_as_the_shared_vectors_say(case: dict[str, str]) -> None:
    assert scrub_text(case["text"], full_mask=True) == case["expected"]


@pytest.mark.parametrize("case", VECTORS["causes"], ids=[c["name"] for c in VECTORS["causes"]])
def test_the_causes_are_said_as_the_shared_vectors_say(case: dict[str, Any]) -> None:
    assert describe_causes(error_of(case["error"])) == case["expected"]


def test_an_error_met_a_second_time_ends_the_walk() -> None:
    top = RuntimeError("lookup failed")
    below = ConnectionError("Connection refused")
    top.__cause__ = below
    below.__cause__ = top
    assert describe_causes(top) == "; caused by ConnectionError: Connection refused"


def test_only_an_explicit_cause_is_said() -> None:
    try:
        try:
            raise KeyError("sku")
        except KeyError:
            # An implicit context, on purpose: no `from`.
            raise RuntimeError("lookup failed")  # noqa: B904
    except RuntimeError as error:
        assert error.__context__ is not None
        assert describe_causes(error) == ""


def test_the_message_is_masked_and_says_its_causes() -> None:
    error = RuntimeError("lookup failed for kgi_sk_ABCDEFGHIJKLMNOPQRSTUV")
    error.__cause__ = OSError("GET https://api.acme.example/v1?token=abc123 refused")
    assert said(error) == (
        "RuntimeError: lookup failed for [redacted]; "
        "caused by OSError: GET https://api.acme.example/v1?token=[redacted] refused"
    )


def context(**secrets: Any) -> ToolContext:
    mail = ToolConnection(
        connection_id="c-1",
        app="google",
        app_name="Google",
        access_token=TOKEN,
        account=ConnectionAccount(id="g-1", label="ana@acme.example"),
    )
    return ToolContext(tenant_id="t", run_id="r", secrets=secrets, connections={"mail": mail})


def test_the_calls_token_and_secrets_are_taken_out() -> None:
    without = without_values(context(SHOP_KEY=SECRET))
    assert without(f"sent {TOKEN} and {SECRET} to the store") == (
        "sent [redacted] and [redacted] to the store"
    )


def test_a_secret_too_short_or_not_a_string_is_passed_over() -> None:
    without = without_values(context(PIN="123", LIMIT=12345))
    assert without("PIN 123, limit 12345") == "PIN 123, limit 12345"


def test_the_calls_files_token_is_taken_out() -> None:
    files = FileStore(_url="http://files.acme.example", _token="files-token-0123", reads=True)
    ctx = ToolContext(tenant_id="t", run_id="r", files=files)
    assert (
        without_values(ctx)("read with files-token-0123 refused") == "read with [redacted] refused"
    )


def test_a_secret_as_a_json_string_writes_it_is_taken_out() -> None:
    without = without_values(context(NOTE='line one\n"quoted"'))
    assert without('body {"note":"line one\\n\\"quoted\\""} refused') == (
        'body {"note":"[redacted]"} refused'
    )


def test_a_secrets_first_part_is_taken_out_up_to_where_the_text_stops() -> None:
    without = without_values(context(KEY=KEY))
    assert without("bad key -----BEGIN KEY-----\nMIIEow") == "bad key [redacted]"
    assert without("bad key -----BEGIN KEY-----\nMIIEowIBAAKCAQEA\nnext line") == (
        "bad key [redacted]\nnext line"
    )


def test_secrets_that_touch_become_one_redacted() -> None:
    without = without_values(context(SHOP_KEY=SECRET, OTHER=OTHER))
    assert without(f"sent {SECRET}{OTHER}") == "sent [redacted]"


def test_the_values_go_before_the_one_line_so_a_key_of_several_lines_goes_whole() -> None:
    error = RuntimeError("lookup failed")
    error.__cause__ = OSError(f"bad key {KEY}")
    assert said(error, without_values(context(KEY=KEY))) == (
        "RuntimeError: lookup failed; caused by OSError: bad key [redacted]"
    )


def test_the_values_go_before_the_cut_so_no_part_shows() -> None:
    phrase = "open sesame for the shop"
    # Cut first, the cause would keep "open sesame for", which no match on the whole phrase finds.
    error = RuntimeError("lookup failed")
    error.__cause__ = OSError("x" * 470 + " " + phrase)
    text = said(error, without_values(context(PHRASE=phrase)))
    assert "sesame" not in text
    assert text == "RuntimeError: lookup failed; caused by OSError: " + "x" * 470 + " [redacted]"


def test_the_cause_field_has_the_values_taken_out() -> None:
    without = without_values(context(SHOP_KEY=SECRET))
    try:
        try:
            raise OSError(f"token {TOKEN}")
        except OSError as error:
            raise RuntimeError(f"lookup failed with {SECRET}") from error
    except RuntimeError as error:
        cause = serialize_cause(error, without)
    assert cause["name"] == "RuntimeError"
    assert cause["message"] == "lookup failed with [redacted]"
    assert "OSError: token [redacted]" in cause["stack"]
    assert SECRET not in cause["stack"] and TOKEN not in cause["stack"]
