# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool's `needs_spec`: the definition-time check (each `env` / `secrets` schema compiles, an
`env` default is a string) and the `ToolContext.for_test(tool=...)` env fill, matching the
TypeScript `@kindgi/tools` and the Java/Scala kindgi-pack."""

from __future__ import annotations

from typing import Any

import pytest

from kindgi import DefinitionError, ToolContext, tool
from kindgi.pack.needs import resolve_env


def env_tool(env: dict[str, Any]) -> Any:
    @tool(id="acme.env", needs_spec={"env": env})
    def handler(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        "Echoes its input."
        return input

    return handler


# --- Definition-time check (needs_spec_problem, via @tool) ----------------------------------


def test_accepts_valid_env_and_secrets() -> None:
    @tool(
        id="acme.sign",
        needs_spec={
            "secrets": {
                "SIGNING_KEY": {"type": "string", "minLength": 32},
                "STAMP_KEY": {"type": ["string", "null"], "minLength": 32},
            },
            "env": {"REGION": {"type": "string", "enum": ["eu", "us"], "default": "eu"}},
        },
    )
    def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        "Signs."
        return input

    assert sign.needs_spec is not None


def test_rejects_a_secret_schema_that_does_not_compile() -> None:
    with pytest.raises(DefinitionError, match=r"needsSpec\.secrets\.SIGNING_KEY doesn't compile"):

        @tool(id="acme.sign", needs_spec={"secrets": {"SIGNING_KEY": {"type": "strng"}}})
        def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
            "Signs."
            return input


def test_rejects_an_env_schema_that_does_not_compile() -> None:
    with pytest.raises(DefinitionError, match=r"needsSpec\.env\.REGION doesn't compile"):

        @tool(id="acme.sign", needs_spec={"env": {"REGION": {"type": "strng"}}})
        def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
            "Signs."
            return input


def test_rejects_an_env_default_that_is_not_a_string() -> None:
    with pytest.raises(
        DefinitionError,
        match=r"needsSpec\.env\.RETRIES's default must be a string: env values are strings\.",
    ):

        @tool(id="acme.sign", needs_spec={"env": {"RETRIES": {"type": "string", "default": 3}}})
        def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
            "Signs."
            return input


def test_rejects_an_env_default_of_none() -> None:
    # The index would carry it as `"default": null`, which the runtime refuses.
    with pytest.raises(
        DefinitionError,
        match=r"needsSpec\.env\.REGION's default must be a string: env values are strings\.",
    ):

        @tool(id="acme.sign", needs_spec={"env": {"REGION": {"type": "string", "default": None}}})
        def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
            "Signs."
            return input


@pytest.mark.parametrize(
    ("slot", "schema", "why"),
    [
        ("env", {"type": "string", "fromat": "uri"}, 'strict mode: unknown keyword: "fromat"'),
        ("secrets", {"type": "string", "patern": "^sk_"}, 'strict mode: unknown keyword: "patern"'),
        (
            "env",
            {"type": "string", "format": "hostnmae"},
            'unknown format "hostnmae" ignored in schema at path "#"',
        ),
        (
            "env",
            {"anyOf": [{"type": "string", "format": "uri"}, {"type": "string", "maxLenght": 3}]},
            'strict mode: unknown keyword: "maxLenght"',
        ),
        (
            "env",
            {"type": "string", "$ref": "#/$defs/regoin", "$defs": {"region": {"type": "string"}}},
            "can't resolve reference #/$defs/regoin from id #",
        ),
        (
            "secrets",
            {"type": "string", "$ref": "https://example.com/key.json"},
            "can't resolve reference https://example.com/key.json from id #",
        ),
    ],
)
def test_rejects_a_keyword_or_format_the_runtime_does_not_know(
    slot: str, schema: dict[str, Any], why: str
) -> None:
    # A schema that is valid Draft 2020-12 but that the runtime's strict compile refuses.
    with pytest.raises(DefinitionError) as raised:

        @tool(id="acme.sign", needs_spec={slot: {"KEY": schema}})
        def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
            "Signs."
            return input

    assert str(raised.value).endswith(f"the schema for needsSpec.{slot}.KEY doesn't compile: {why}")


def test_accepts_the_keywords_and_formats_the_runtime_knows() -> None:
    @tool(
        id="acme.sign",
        needs_spec={
            "env": {
                "BASE_URL": {"type": "string", "format": "uri", "x-kindgi-tunable": True},
                "TIMEOUT": {"type": "string", "format": "duration", "$comment": "ISO 8601"},
                # A ref the runtime resolves through `$id`s.
                "REGION": {
                    "$id": "https://acme.example/region",
                    "$ref": "code",
                    "$defs": {"code": {"$id": "https://acme.example/code", "type": "string"}},
                },
            }
        },
    )
    def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        "Signs."
        return input

    assert sign.needs_spec is not None


def test_checks_secrets_before_env() -> None:
    with pytest.raises(DefinitionError, match=r"needsSpec\.secrets\.KEY"):

        @tool(
            id="acme.sign",
            needs_spec={
                "secrets": {"KEY": {"type": "secrit"}},
                "env": {"REGION": {"type": "strng"}},
            },
        )
        def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
            "Signs."
            return input


def test_leaves_config_capabilities_and_bindings_alone() -> None:
    @tool(
        id="acme.sign",
        needs_spec={
            "config": {"BAD": {"type": "strng"}},
            "capabilities": ["read"],
            "bindings": ["db:ledger"],
        },
    )
    def sign(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        "Signs."
        return input

    assert sign.needs_spec is not None


# --- Test-context env fill (ToolContext.for_test(tool=...)) ---------------------------------


def test_fills_a_string_default() -> None:
    t = env_tool({"REGION": {"type": "string", "default": "eu"}})
    assert dict(ToolContext.for_test(tool=t).env) == {"REGION": "eu"}


def test_a_given_value_wins_over_the_default() -> None:
    t = env_tool({"REGION": {"type": "string", "default": "eu"}})
    assert dict(ToolContext.for_test(tool=t, env={"REGION": "us"}).env) == {"REGION": "us"}


def test_drops_a_name_the_tool_does_not_declare() -> None:
    t = env_tool({"REGION": {"type": "string", "default": "eu"}})
    ctx = ToolContext.for_test(tool=t, env={"REGION": "us", "UNDECLARED": "x"})
    assert dict(ctx.env) == {"REGION": "us"}


def test_an_envless_tool_gets_no_env() -> None:
    @tool(id="acme.plain")
    def plain(input: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        "Plain."
        return input

    assert dict(ToolContext.for_test(tool=plain, env={"X": "1"}).env) == {}


def test_fails_naming_a_missing_value() -> None:
    t = env_tool({"ACCOUNT_ID": {"type": "string"}})
    with pytest.raises(ValueError) as caught:
        ToolContext.for_test(tool=t, env={})
    assert str(caught.value) == (
        'tool "acme.env" needs env value "ACCOUNT_ID": the context\'s `env` doesn\'t set it, '
        "and its schema has no default"
    )


def test_fails_naming_several_missing_values() -> None:
    t = env_tool({"A": {"type": "string"}, "B": {"type": "string"}})
    with pytest.raises(ValueError) as caught:
        ToolContext.for_test(tool=t, env={})
    assert str(caught.value) == (
        'tool "acme.env" needs env values "A", "B": the context\'s `env` doesn\'t set them, '
        "and their schemas have no default"
    )


def test_fails_when_a_value_does_not_match_its_schema() -> None:
    t = env_tool({"BASE_URL": {"type": "string", "pattern": "^https://"}})
    with pytest.raises(ValueError, match=r"doesn't match the schema"):
        ToolContext.for_test(tool=t, env={"BASE_URL": "http://orders.example.com"})


def test_checks_missing_before_invalid() -> None:
    t = env_tool({"A": {"type": "string"}, "B": {"type": "string", "pattern": "^x"}})
    with pytest.raises(ValueError, match=r'needs env value "A"'):
        ToolContext.for_test(tool=t, env={"B": "y"})


def test_passes_secrets_through() -> None:
    t = env_tool({"REGION": {"type": "string", "default": "eu"}})
    ctx = ToolContext.for_test(tool=t, secrets={"API_TOKEN": "t"})
    assert ctx.secrets["API_TOKEN"] == "t"


# --- resolve_env directly: a declared schema that doesn't compile ---------------------------
# (unreachable through @tool, which rejects it at definition time, so checked on resolve_env.)


def test_resolve_env_rejects_a_declared_schema_that_does_not_compile() -> None:
    with pytest.raises(
        ValueError, match=r'declares env value "REGION" with a schema that doesn\'t compile'
    ):
        resolve_env("acme.env", {"env": {"REGION": {"type": "strng"}}}, {"REGION": "eu"})


@pytest.mark.parametrize(
    ("schema", "why"),
    [
        ({"type": "string", "enmu": ["eu"]}, 'strict mode: unknown keyword: "enmu"'),
        (
            {"type": "string", "$ref": "#/$defs/regoin", "$defs": {"region": {"type": "string"}}},
            "can't resolve reference #/$defs/regoin from id #",
        ),
        (
            {"type": "string", "$ref": "https://example.com/region.json"},
            "can't resolve reference https://example.com/region.json from id #",
        ),
    ],
)
def test_resolve_env_rejects_a_schema_the_runtime_does_not_compile(
    schema: dict[str, Any], why: str
) -> None:
    with pytest.raises(ValueError) as raised:
        resolve_env("acme.env", {"env": {"REGION": schema}}, {"REGION": "eu"})
    assert str(raised.value).endswith(
        f'declares env value "REGION" with a schema that doesn\'t compile: {why}'
    )


# --- for_test without a tool still flows env/secrets straight through (backward compatible) --


def test_for_test_without_a_tool_passes_env_and_secrets_through() -> None:
    ctx = ToolContext.for_test(env={"X": "1"}, secrets={"KEY": "k"})
    assert ctx.tenant_id == "tenant-test"
    assert ctx.env["X"] == "1"
    assert ctx.secrets["KEY"] == "k"
