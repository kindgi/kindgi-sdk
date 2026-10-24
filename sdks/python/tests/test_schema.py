# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from kindgi._schema import (
    SchemaValidator,
    issues_from_pydantic,
    strict_schema_problem,
    wire_schema,
)
from kindgi.pack.index import _spec


class Line(BaseModel):
    sku: str


class Order(BaseModel):
    model_config = ConfigDict(extra="forbid")
    customer_id: str = Field(alias="customerId", description="Who ordered")
    lines: list[Line]
    note: str = Field("", title="Note to the courier")


class Tree(BaseModel):
    name: str
    children: list[Tree] = []


def test_wire_schema_uses_aliases_and_drops_generated_titles() -> None:
    schema = wire_schema(Order)
    assert "title" not in schema
    assert set(schema["properties"]) == {"customerId", "lines", "note"}
    assert "title" not in schema["properties"]["customerId"]
    assert schema["properties"]["note"]["title"] == "Note to the courier"
    assert schema["additionalProperties"] is False


def test_wire_schema_inlines_local_refs() -> None:
    schema = wire_schema(Order)
    assert "$defs" not in schema
    assert schema["properties"]["lines"]["items"] == {
        "properties": {"sku": {"type": "string"}},
        "required": ["sku"],
        "type": "object",
    }


def test_a_recursive_type_keeps_its_definition() -> None:
    schema = wire_schema(Tree)
    assert schema["properties"]["children"]["items"] == {"$ref": "#/$defs/Tree"}
    assert "Tree" in schema["$defs"]
    validator = SchemaValidator(schema)
    assert validator.issues({"name": "a", "children": [{"name": "b"}]}) == []
    assert validator.issues({"name": "a", "children": [{"children": []}]}) != []


def test_a_dict_is_already_json_schema() -> None:
    assert wire_schema({"type": "object"}) == {"type": "object"}


def issue_of(schema: dict[str, object], value: object) -> list[dict[str, object]]:
    return SchemaValidator(schema).issues(value)


def test_required_issues_name_each_missing_property() -> None:
    issues = issue_of({"type": "object", "required": ["a", "b"]}, {})
    assert issues == [
        {
            "instancePath": "",
            "schemaPath": "#/required",
            "keyword": "required",
            "params": {"missingProperty": "a"},
            "message": "must have required property 'a'",
        },
        {
            "instancePath": "",
            "schemaPath": "#/required",
            "keyword": "required",
            "params": {"missingProperty": "b"},
            "message": "must have required property 'b'",
        },
    ]


def test_additional_property_issues_name_each_extra() -> None:
    schema = {"type": "object", "properties": {"a": {}}, "additionalProperties": False}
    issues = issue_of(schema, {"a": 1, "x": 2, "y": 3})
    assert [i["params"] for i in issues] == [
        {"additionalProperty": "x"},
        {"additionalProperty": "y"},
    ]
    assert {i["message"] for i in issues} == {"must NOT have additional properties"}


def test_nested_paths_are_json_pointers() -> None:
    schema = {
        "type": "object",
        "properties": {"a/b": {"type": "array", "items": {"type": "string"}}},
    }
    (issue,) = issue_of(schema, {"a/b": ["ok", 7]})
    assert issue["instancePath"] == "/a~1b/1"
    assert issue["schemaPath"] == "#/properties/a~1b/items/type"
    assert issue["params"] == {"type": "string"}
    assert issue["message"] == "must be string"


def test_limits_formats_and_enums_read_like_ajv() -> None:
    assert issue_of({"minimum": 3}, 1)[0]["message"] == "must be >= 3"
    assert issue_of({"maxLength": 2}, "abc")[0]["message"] == "must NOT have more than 2 characters"
    assert issue_of({"enum": ["a"]}, "b")[0]["params"] == {"allowedValues": ["a"]}
    assert issue_of({"pattern": "^a"}, "b")[0]["message"] == 'must match pattern "^a"'
    assert issue_of({"format": "date-time"}, "2026-13-01T00:00:00Z")[0]["params"] == {
        "format": "date-time"
    }
    assert issue_of({"format": "date-time"}, "2026-10-01T12:00:00.5+02:00") == []
    assert issue_of({"format": "uuid"}, "not-a-uuid")[0]["keyword"] == "format"
    assert issue_of({"format": "email"}, "a@b.co") == []


class Ranged(BaseModel):
    low: int
    high: int

    @field_validator("high")
    @classmethod
    def above_low(cls, value: int) -> int:
        if value < 10:
            raise ValueError("high must be at least 10")
        return value


def test_pydantic_errors_become_issues() -> None:
    try:
        Ranged.model_validate({"low": 1, "high": 2})
    except ValidationError as error:
        (issue,) = issues_from_pydantic(error)
    assert issue["instancePath"] == "/high"
    assert "at least 10" in str(issue["message"])


def test_a_literal_is_an_enum() -> None:
    assert wire_schema(Literal["a", "b"]) == {"enum": ["a", "b"], "type": "string"}


def test_defaults_are_filled_like_ajv_use_defaults() -> None:
    from kindgi._schema import apply_defaults

    schema = {
        "type": "object",
        "properties": {
            "greeting": {"type": "string", "default": "Hello"},
            "options": {
                "type": "object",
                "properties": {"loud": {"type": "boolean", "default": False}},
                "default": {},
            },
            "tags": {
                "type": "array",
                "items": {"type": "object", "properties": {"w": {"default": 1}}},
            },
            "either": {"anyOf": [{"type": "object", "properties": {"x": {"default": 1}}}]},
        },
        "allOf": [{"properties": {"extra": {"default": [1]}}}],
    }
    given = {"tags": [{}, {"w": 5}], "either": {}}
    assert apply_defaults(schema, given) == {
        "greeting": "Hello",
        "options": {"loud": False},
        "tags": [{"w": 1}, {"w": 5}],
        "either": {},  # anyOf branches don't fill, as in Ajv
        "extra": [1],
    }
    assert given == {"tags": [{}, {"w": 5}], "either": {}}  # not modified


# --- explain: the one issue that says what's wrong -------------------------

_EDGES = [{"id": "e0", "from": "$start", "to": "n"}, {"id": "e1", "from": "n", "to": "$end"}]
_LOOP = {
    "iterateOver": {"path": "runInput.x"},
    "maxIterations": 3,
    "outputSchema": {"type": "object"},
    "body": {"nodes": [], "edges": []},
}


def _explain_node(node: dict[str, Any]) -> tuple[str, str, dict[str, Any]] | None:
    issue = _spec("flow").explain(
        {"id": "acme.f", "version": "0.1.0", "nodes": [node], "edges": _EDGES}
    )
    return None if issue is None else (issue["instancePath"], issue["message"], issue["params"])


def test_explain_follows_the_alternative_whose_kind_matches() -> None:
    assert _explain_node({"id": "n", "kind": "tool", "ref": "acme.t", "input_mapping": {}}) == (
        "/nodes/0",
        "must NOT have additional properties",
        {"additionalProperty": "input_mapping"},
    )
    assert _explain_node(
        {
            "id": "n",
            "kind": "fanout",
            "branches": [{"branchId": "a", "handler": "acme.t", "outputSchema": {}}],
        }
    ) == (
        "/nodes/0",
        "must have required property 'convergence'",
        {"missingProperty": "convergence"},
    )


def test_explain_goes_through_nested_alternatives() -> None:
    without_max = {k: v for k, v in _LOOP.items() if k != "maxIterations"}
    assert _explain_node({"id": "n", "kind": "loop", "loopKind": "foreach", **without_max}) == (
        "/nodes/0",
        "must have required property 'maxIterations'",
        {"missingProperty": "maxIterations"},
    )
    body = {"nodes": [{"id": "x", "kind": "tool", "ref": "acme.t", "max_retries": 1}], "edges": []}
    found = _explain_node({"id": "n", "kind": "loop", "loopKind": "foreach", **_LOOP, "body": body})
    assert found is not None
    assert found[0] == "/nodes/0/body/nodes/0"
    assert found[2] == {"additionalProperty": "max_retries"}


def test_explain_names_the_allowed_values_when_no_alternative_matches() -> None:
    kinds = ["tool", "agent", "loop", "fanout", "subgraph"]
    assert _explain_node({"id": "n", "kind": "tol", "ref": "acme.t"}) == (
        "/nodes/0/kind",
        "must be one of " + ", ".join(f'"{k}"' for k in kinds),
        {"allowedValues": kinds},
    )
    assert _explain_node({"id": "n", "kind": "loop", "loopKind": "forach", **_LOOP}) == (
        "/nodes/0/loopKind",
        'must be one of "while", "foreach"',
        {"allowedValues": ["while", "foreach"]},
    )


def test_explain_is_none_for_a_valid_value() -> None:
    assert _explain_node({"id": "n", "kind": "agent", "ref": "acme.a"}) is None


# --- strict_schema_problem: what the runtime's strict compile refuses beyond Draft 2020-12 ----
# (each expected answer is the runtime's compileInlineSchema's, word for word.)


def test_strict_finds_an_unknown_keyword_in_each_subschema_the_runtime_compiles() -> None:
    typo: dict[str, Any] = {"patern": "x"}
    for schema in [
        {"type": "object", "properties": {"a": typo}},
        {"type": "object", "patternProperties": {"^a": typo}},
        {"type": "object", "additionalProperties": typo},
        {"type": "object", "propertyNames": typo},
        {"type": "object", "dependentSchemas": {"a": typo}},
        {"type": "object", "dependencies": {"a": typo}},
        {"type": "object", "unevaluatedProperties": typo},
        {"type": "array", "items": typo},
        {"type": "array", "prefixItems": [typo], "minItems": 1, "maxItems": 1},
        {"type": "array", "contains": typo},
        {"type": "array", "unevaluatedItems": typo},
        {"anyOf": [{"type": "string"}, typo]},
        {"oneOf": [typo]},
        {"allOf": [typo]},
        {"type": "string", "if": typo, "then": {"type": "string"}},
        {"type": "string", "if": {"type": "string"}, "else": typo},
        {"type": "string", "not": typo},
        {"$defs": {"a": typo}, "$ref": "#/$defs/a"},
        {"$defs": {"a/b": typo}, "$ref": "#/$defs/a~1b"},
    ]:
        assert strict_schema_problem(schema) == 'strict mode: unknown keyword: "patern"', schema


def test_strict_leaves_what_the_runtime_does_not_compile() -> None:
    # A definition nothing refers to, `contentSchema` (an annotation), and values (enum, const).
    assert strict_schema_problem({"type": "string", "$defs": {"a": {"patern": "x"}}}) is None
    assert strict_schema_problem({"type": "string", "contentSchema": {"patern": "x"}}) is None
    assert strict_schema_problem({"enum": [{"patern": "x"}], "const": {"fromat": 1}}) is None
    assert strict_schema_problem({"type": "object", "properties": {"a": True}}) is None


def test_strict_skips_an_unevaluated_keyword_once_every_property_or_item_is_evaluated() -> None:
    typo: dict[str, Any] = {"patern": "x"}
    # Evaluated by the schema's own keyword, an allOf member's, or what a ref reaches.
    for schema in [
        {"type": "object", "additionalProperties": False, "unevaluatedProperties": typo},
        {"type": "array", "items": {}, "unevaluatedItems": typo},
        {"type": "object", "allOf": [{"additionalProperties": {}}], "unevaluatedProperties": typo},
        {"type": "array", "allOf": [{"unevaluatedItems": {}}], "unevaluatedItems": typo},
        {
            "type": "object",
            "$defs": {
                "a": {"$ref": "#/$defs/b"},
                "b": {"type": "object", "additionalProperties": {}},
            },
            "$ref": "#/$defs/a",
            "unevaluatedProperties": typo,
        },
    ]:
        assert strict_schema_problem(schema) is None, schema
    # Not by anyOf, properties or prefixItems, nor by a ref to a schema still compiling.
    for schema in [
        {"type": "object", "anyOf": [{"additionalProperties": {}}], "unevaluatedProperties": typo},
        {"type": "object", "properties": {"a": {}}, "unevaluatedProperties": typo},
        {
            "type": "array",
            "prefixItems": [{}],
            "minItems": 1,
            "maxItems": 1,
            "unevaluatedItems": typo,
        },
        {
            "type": "object",
            "additionalProperties": {},
            "properties": {"c": {"type": "object", "$ref": "#", "unevaluatedProperties": typo}},
        },
    ]:
        assert strict_schema_problem(schema) == 'strict mode: unknown keyword: "patern"', schema


def test_strict_names_where_an_unknown_format_is() -> None:
    def at(name: str) -> str | None:
        schema = {"type": "object", "properties": {name: {"type": "string", "format": "hostnmae"}}}
        return strict_schema_problem(schema)

    # Each name JSON Pointer escaped, then URI encoded, as the runtime writes it.
    for name, segment in [
        ("a~b", "a~0b"),
        ("a/b", "a~1b"),
        ("a b", "a%20b"),
        ("\u00e9", "%C3%A9"),
        ("a#b?c&d%e+f", "a%23b%3Fc%26d%25e%2Bf"),
        ("it's(1)*!-_.", "it's(1)*!-_."),
    ]:
        assert at(name) == (
            f'unknown format "hostnmae" ignored in schema at path "#/properties/{segment}"'
        )
    pattern = {"type": "object", "patternProperties": {"^x": {"type": "string", "format": "x"}}}
    assert strict_schema_problem(pattern) == (
        'unknown format "x" ignored in schema at path "#/patternProperties/%5Ex"'
    )
    # The runtime compiles the schema a ref reaches on its own, so its path is `#`.
    via_ref = {"$defs": {"a": {"type": "string", "format": "hostnmae"}}, "$ref": "#/$defs/a"}
    assert (
        strict_schema_problem(via_ref) == 'unknown format "hostnmae" ignored in schema at path "#"'
    )


def test_strict_refuses_id_as_the_runtime_does() -> None:
    assert strict_schema_problem({"type": "string", "id": "x"}) == (
        'NOT SUPPORTED: keyword "id", use "$id" for schema ID'
    )


def test_strict_names_the_problem_the_runtime_names_first() -> None:
    def bad(name: str) -> dict[str, Any]:
        return {"type": "string", "format": name}

    # A node's unknown keywords come first, then `id`.
    assert strict_schema_problem({"type": "string", "format": "hostnmae", "fromat": "x"}) == (
        'strict mode: unknown keyword: "fromat"'
    )
    assert strict_schema_problem({"type": "object", "properties": {"a": bad("x")}, "zzz": 1}) == (
        'strict mode: unknown keyword: "zzz"'
    )
    assert strict_schema_problem({"type": "string", "id": "x", "zzz": 1}) == (
        'strict mode: unknown keyword: "zzz"'
    )
    assert strict_schema_problem({**bad("x"), "id": "x"}) == (
        'NOT SUPPORTED: keyword "id", use "$id" for schema ID'
    )
    # Then its keywords in the runtime's order, whatever the schema's key order: `$ref` and the
    # applicators before `format`, `additionalProperties` before `properties`, unevaluated last.
    assert strict_schema_problem({**bad("x"), "$ref": "#/$defs/nope"}) == (
        "can't resolve reference #/$defs/nope from id #"
    )
    assert strict_schema_problem({**bad("bad1"), "allOf": [bad("bad2")]}) == (
        'unknown format "bad2" ignored in schema at path "#/allOf/0"'
    )
    two = {"type": "object", "properties": {"b": bad("bad2")}, "additionalProperties": bad("bad1")}
    assert strict_schema_problem(two) == (
        'unknown format "bad1" ignored in schema at path "#/additionalProperties"'
    )
    both = {
        "type": ["object", "array"],
        "unevaluatedProperties": bad("p"),
        "unevaluatedItems": bad("i"),
    }
    assert strict_schema_problem(both) == (
        'unknown format "i" ignored in schema at path "#/unevaluatedItems"'
    )


def test_strict_refuses_a_ref_that_names_nothing() -> None:
    for ref, schema in [
        ("#/$defs/nope", {}),
        ("#/$defs/a/", {"$defs": {"a": {"type": "string"}}}),
        ("#/allOf/01", {"allOf": [{"type": "string"}, {"type": "string"}]}),
        ("#A", {}),
        ("other.json", {}),
        ("https://example.com/x.json", {}),
    ]:
        assert strict_schema_problem({**schema, "type": "string", "$ref": ref}) == (
            f"can't resolve reference {ref} from id #"
        )
    nested = {"type": "object", "properties": {"p": {"type": "string", "$ref": "#/$defs/nope"}}}
    assert strict_schema_problem(nested) == "can't resolve reference #/$defs/nope from id #"


def test_strict_follows_a_ref_to_the_root_once() -> None:
    tree = {"type": "object", "properties": {"child": {"$ref": "#"}}}
    assert strict_schema_problem(tree) is None
    assert strict_schema_problem({"type": "string", "allOf": [{"$ref": "#/"}]}) is None


def test_strict_leaves_a_ref_alone_in_a_schema_with_a_base() -> None:
    # What a ref reaches there depends on bases the walk doesn't track: the runtime resolves this
    # `b` through its `$id`, and this `#/$defs/q` in `p`'s own `$defs`, not the root's.
    by_id = {
        "$id": "https://x.example/a",
        "$ref": "b",
        "$defs": {"b": {"$id": "https://x.example/b", "type": "string"}},
    }
    assert strict_schema_problem(by_id) is None
    nested_base = {
        "type": "object",
        "properties": {
            "p": {
                "$id": "https://x.example/p",
                "type": "string",
                "$ref": "#/$defs/q",
                "$defs": {"q": {"type": "string"}},
            }
        },
        "$defs": {"q": {"type": "string", "format": "hostnmae"}},
    }
    assert strict_schema_problem(nested_base) is None
    anchored = {"$ref": "#A", "$defs": {"a": {"$dynamicAnchor": "A", "type": "string"}}}
    assert strict_schema_problem(anchored) is None
