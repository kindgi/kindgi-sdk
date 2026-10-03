# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from kindgi._schema import SchemaValidator, issues_from_pydantic, wire_schema
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
