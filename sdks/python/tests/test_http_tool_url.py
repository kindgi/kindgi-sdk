# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`http_tool`'s URL: placeholders in its path and query only, as `defineTool` and Java's
`Tool.Builder.http` refuse the rest, with the same messages."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from kindgi import DefinitionError, Tool, http_tool


class Lookup(BaseModel):
    case_id: str
    court: str


class Found(BaseModel):
    title: str


def lookup(url_template: str) -> Tool[..., Any]:
    return http_tool(
        id="acme.lookup",
        description="Looks a case up.",
        input=Lookup,
        output=Found,
        method="GET",
        url_template=url_template,
    )


def refusal(url_template: str) -> str:
    with pytest.raises(DefinitionError) as raised:
        lookup(url_template)
    return str(raised.value)


def test_a_placeholder_in_the_host_or_port_is_refused() -> None:
    expected = (
        'Tool "acme.lookup" spec.urlTemplate fills {placeholders} in its path and query only,'
        " never in its host or port"
    )
    assert refusal("https://{court}.example.com/{case_id}") == expected
    assert refusal("https://cases.example.com:{court}/{case_id}") == expected


def test_a_url_without_a_scheme_is_refused() -> None:
    expected = 'Tool "acme.lookup" spec.urlTemplate must start with http:// or https:// and a host'
    assert refusal("cases.example.com/{court}/{case_id}") == expected
    assert refusal("ftp://cases.example.com/{court}/{case_id}") == expected
    assert refusal("/proxy?to=https://cases.example.com/{court}/{case_id}") == expected


def test_a_url_without_a_host_is_refused() -> None:
    assert refusal("https:///{court}/{case_id}") == (
        'Tool "acme.lookup" spec.urlTemplate must name a host'
    )


def test_the_scheme_is_read_in_any_case_of_ascii_letters_only() -> None:
    tool = lookup("HTTPS://cases.example.com/{court}?case={case_id}")
    assert tool.spec is not None
    assert tool.spec["urlTemplate"] == "HTTPS://cases.example.com/{court}?case={case_id}"
    # U+017F, the long s, is an `s` to Python's case-blind match but not to JavaScript's `i`.
    assert refusal("http" + chr(0x17F) + "://cases.example.com/{court}/{case_id}") == (
        'Tool "acme.lookup" spec.urlTemplate must start with http:// or https:// and a host'
    )
