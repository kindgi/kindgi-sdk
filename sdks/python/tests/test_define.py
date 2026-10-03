# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import BaseModel, Field

from kindgi import CheckResult, DefinitionError, RunTrace, ToolContext, guardrail, tool


class In(BaseModel):
    text: str


class Out(BaseModel):
    length: int


def test_a_tool_reads_its_schemas_and_description_from_the_handler() -> None:
    @tool(id="acme.length")
    def length(input: In) -> Out:
        """Counts characters."""
        return Out(length=len(input.text))

    assert length.description == "Counts characters."
    assert length.input_schema["required"] == ["text"]
    assert length.output_schema["properties"] == {"length": {"type": "integer"}}
    assert not length.takes_context and not length.is_async
    assert length(In(text="abc")) == Out(length=3)  # still callable for unit tests


def test_an_async_tool_with_a_context() -> None:
    @tool(id="acme.whoami", description="Says which tenant.")
    async def whoami(input: dict[str, Any], ctx: ToolContext) -> dict[str, str]:
        return {"tenant": ctx.tenant_id}

    assert whoami.is_async and whoami.takes_context
    assert asyncio.run(whoami({}, ToolContext.for_test(tenant_id="t-9"))) == {"tenant": "t-9"}


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"id": ""}, "id must be a non-empty string"),
        ({"id": "acme.x", "version": "1.0"}, "exact semver"),
    ],
)
def test_bad_tool_declarations_fail_where_declared(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(DefinitionError, match=message):

        @tool(**kwargs, description="x")
        def handler(input: In) -> Out: ...


def test_a_tool_needs_a_description() -> None:
    with pytest.raises(DefinitionError, match="needs a description"):

        @tool(id="acme.x")
        def handler(input: In) -> Out: ...


def test_a_tool_needs_types() -> None:
    with pytest.raises(DefinitionError, match="annotate the handler's input"):

        @tool(id="acme.x", description="x")
        def handler(input) -> Out: ...  # type: ignore[no-untyped-def]

    with pytest.raises(DefinitionError, match="annotate the handler's return type"):

        @tool(id="acme.x", description="x")
        def handler2(input: In): ...  # type: ignore[no-untyped-def]


def test_a_tool_input_is_an_object() -> None:
    with pytest.raises(DefinitionError, match="input must be an object type"):

        @tool(id="acme.x", description="x")
        def handler(input: str) -> Out: ...


def test_a_handler_takes_one_or_two_parameters() -> None:
    with pytest.raises(DefinitionError, match="takes \\(input\\) or \\(input, ctx\\)"):

        @tool(id="acme.x", description="x")
        def handler(input: In, ctx: ToolContext, extra: int) -> Out: ...


def test_a_guardrail_takes_one_action() -> None:
    with pytest.raises(DefinitionError, match="exactly one of"):

        @guardrail(id="acme.g")
        def check(config: dict[str, Any], trace: RunTrace) -> bool: ...

    with pytest.raises(DefinitionError, match="exactly one of"):

        @guardrail(id="acme.g", on_violation="halt", action={"on-violation": "halt"})
        def check2(config: dict[str, Any], trace: RunTrace) -> bool: ...


def test_a_guardrails_configured_values_are_checked_where_declared() -> None:
    class Config(BaseModel):
        min_length: int = Field(1, alias="minLength", ge=0)

    @guardrail(id="acme.long", on_violation="halt", config={"minLength": 500})
    def long_enough(config: Config, trace: RunTrace) -> bool:
        return len(trace.output or "") >= config.min_length

    assert long_enough.config == {"minLength": 500}
    assert long_enough.parse_config(long_enough.config).min_length == 500

    with pytest.raises(DefinitionError, match="config does not fit its type"):

        @guardrail(id="acme.bad", on_violation="halt", config={"minLength": -1})
        def bad(config: Config, trace: RunTrace) -> bool: ...

    # Without config= the check runs with {} — its defaults.
    @guardrail(id="acme.default", on_violation="halt", config_type=Config)
    def default(config: Any, trace: RunTrace) -> bool: ...

    assert default.config is None
    assert default.parse_config({}).min_length == 1


def test_a_guardrail_check_and_its_config() -> None:
    class Config(BaseModel):
        word: str

    @guardrail(id="acme.says", on_violation="retry", check_id="acme.checks.says")
    def says(config: Config, trace: RunTrace) -> CheckResult:
        return CheckResult(passed=config.word in (trace.output or ""))

    assert says.check_id == "acme.checks.says"
    assert says.action == {"on-violation": "retry"}
    assert says.config_schema == {
        "properties": {"word": {"type": "string"}},
        "required": ["word"],
        "type": "object",
    }
    trace = RunTrace(run_id="r", tenant_id="t", output="hello world")
    assert says(Config(word="world"), trace).passed
