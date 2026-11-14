# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A `properties`, `patternProperties`, `dependentSchemas` or `dependencies` name holding a lone
surrogate. The runtime writes the name, URI encoded, into the path of the subschema under it when
it compiles that subschema, and a lone surrogate can't be encoded, so it refuses the schema with
JavaScript's "URI malformed". Under a subschema any data passes, it compiles nothing, and the name
changes nothing. The strict-schema test vectors hold the runtime's own answers, which
test_schema.py replays. These tests check each case on all four keywords, and that a tool's
schema with such a name fails where the tool is defined."""

from __future__ import annotations

from typing import Any

import pytest

from kindgi import DefinitionError, tool
from kindgi._schema import compile_problem, pattern_problem, strict_schema_problem

HIGH = chr(0xD835)
LOW = chr(0xDC00)
KEYWORDS = ("properties", "patternProperties", "dependentSchemas", "dependencies")


def under(keyword: str, name: str, sub: Any) -> dict[str, Any]:
    return {"type": "object", keyword: {name: sub}}


# Subschemas the runtime compiles: `false` is a check of its own, and `$comment` counts as one.
COMPILED = [False, {"minProperties": 1}, {"$comment": "x"}]


@pytest.mark.parametrize("keyword", KEYWORDS)
@pytest.mark.parametrize("sub", COMPILED)
@pytest.mark.parametrize("name", [HIGH, LOW, f"a{HIGH}", f"{LOW}{HIGH}"])
def test_a_name_with_a_lone_surrogate_is_refused_where_its_subschema_compiles(
    keyword: str, sub: Any, name: str
) -> None:
    assert strict_schema_problem(under(keyword, name, sub)) == "URI malformed"


# Subschemas any data passes: the runtime compiles none of them, but it still refuses a keyword
# it doesn't know in one.
PASSING = [True, {}, {"description": "x"}, {"minLenght": 1}]


@pytest.mark.parametrize("keyword", KEYWORDS)
@pytest.mark.parametrize("sub", PASSING)
def test_under_a_subschema_any_data_passes_the_name_changes_nothing(keyword: str, sub: Any) -> None:
    assert strict_schema_problem(under(keyword, HIGH, sub)) == strict_schema_problem(
        under(keyword, "a", sub)
    )
    assert compile_problem(under(keyword, HIGH, sub)) == compile_problem(under(keyword, "a", sub))


@pytest.mark.parametrize("sub", [{"type": "string"}, {"type": "string", "minimum": 1}])
def test_a_surrogate_pair_is_one_character(sub: Any) -> None:
    # As JSON gives it, or as two halves in a Python string, which the pack's JSON sends as one
    # character.
    astral = chr(0x1D400)
    expected = strict_schema_problem(under("properties", f"a{astral}", sub))
    assert strict_schema_problem(under("properties", f"a{HIGH}{LOW}", sub)) == expected
    assert strict_schema_problem(under("properties", f"a{astral}", sub)) != "URI malformed"
    assert strict_schema_problem(under("properties", f"{HIGH}{astral}", sub)) == "URI malformed"


def test_a_guardrail_configs_pattern_check_reads_past_the_name() -> None:
    # Only a pattern the runtime refuses fails a guardrail config's derived schema.
    assert pattern_problem(under("properties", HIGH, {"type": "string"})) is None


def test_a_tools_schema_with_such_a_name_fails_where_the_tool_is_defined() -> None:
    with pytest.raises(DefinitionError) as raised:

        @tool(
            id="acme.x",
            description="x",
            input={"type": "object"},
            output=under("properties", HIGH, {"type": "string"}),
        )
        def handler(input: dict[str, Any]) -> dict[str, Any]: ...

    assert str(raised.value) == (
        'Tool "acme.x": the output JSON Schema doesn\'t compile: URI malformed'
    )
