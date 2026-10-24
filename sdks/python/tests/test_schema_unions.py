# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A pydantic tagged union (`Field(discriminator=...)`) on the wire: a `oneOf` without OpenAPI's
`discriminator`, which the runtime's strict compile refuses, and answering as pydantic does."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from kindgi import tool
from kindgi._schema import (
    SchemaValidator,
    _inline_refs,
    _WireSchema,
    strict_schema_problem,
    wire_schema,
)

MODES = ("validation", "serialization")


class Cat(BaseModel):
    kind: Literal["cat"]
    meows: int


class Dog(BaseModel):
    kind: Literal["dog"]
    barks: bool


class Lizard(BaseModel):
    kind: Literal["lizard", "gecko"]
    scales: int


class Owner(BaseModel):
    pet: Cat | Dog | Lizard = Field(discriminator="kind")


class Household(BaseModel):
    """The union deeper in: in a list, in an optional field, in a model of a model."""

    owners: list[Owner]
    lead: Owner | None = None


class BlackCat(BaseModel):
    pet_type: Literal["cat"] = "cat"
    color: Literal["black"]


class WhiteCat(BaseModel):
    pet_type: Literal["cat"] = "cat"
    color: Literal["white"]


class Puppy(BaseModel):
    pet_type: Literal["dog"]


class Nested(BaseModel):
    pet: Annotated[
        Annotated[BlackCat | WhiteCat, Field(discriminator="color")] | Puppy,
        Field(discriminator="pet_type"),
    ]


class Card(BaseModel):
    kind: Literal["card"] = "card"
    last4: str


class Transfer(BaseModel):
    kind: Literal["transfer"] = "transfer"
    iban: str


class Payment(BaseModel):
    """Each tag has a default, so pydantic's schema doesn't list it in `required`."""

    method: Card | Transfer = Field(discriminator="kind")


def undropped(model: type[BaseModel], mode: Any) -> dict[str, Any]:
    """The wire schema as it was before: pydantic's, `discriminator` and all."""
    schema = model.model_json_schema(by_alias=True, mode=mode, schema_generator=_WireSchema)
    return _inline_refs(schema)


def accepts(model: type[BaseModel], value: Any) -> bool:
    try:
        model.model_validate(value)
    except ValidationError:
        return False
    return True


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("model", [Owner, Household, Nested, Payment])
def test_a_tagged_union_compiles_under_the_runtimes_strict_compile(
    model: type[BaseModel], mode: Any
) -> None:
    assert "discriminator" in json.dumps(undropped(model, mode))
    assert strict_schema_problem(undropped(model, mode)) == (
        'strict mode: unknown keyword: "discriminator"'
    )
    schema = wire_schema(model, mode)
    assert "discriminator" not in json.dumps(schema)
    assert strict_schema_problem(schema) is None


def test_each_member_keeps_its_tag_and_asks_for_it() -> None:
    members = wire_schema(Owner)["properties"]["pet"]["oneOf"]
    assert [m["properties"]["kind"] for m in members] == [
        {"const": "cat", "type": "string"},
        {"const": "dog", "type": "string"},
        {"enum": ["lizard", "gecko"], "type": "string"},
    ]
    assert [m["required"] for m in members] == [
        ["kind", "meows"],
        ["kind", "barks"],
        ["kind", "scales"],
    ]
    # A tag with a default is asked for too: pydantic refuses a member without its tag.
    paid = wire_schema(Payment)["properties"]["method"]["oneOf"]
    assert [m["required"] for m in paid] == [["kind", "last4"], ["kind", "iban"]]
    # A nested union's members are asked for both tags, the outer one with a default too.
    pets = wire_schema(Nested)["properties"]["pet"]["oneOf"]
    assert [m["required"] for m in pets[0]["oneOf"]] == [
        ["pet_type", "color"],
        ["pet_type", "color"],
    ]
    assert pets[1]["required"] == ["pet_type"]


OWNERS: list[Any] = [
    {"pet": {"kind": "cat", "meows": 3}},
    {"pet": {"kind": "gecko", "scales": 9}},
    {"pet": {"kind": "dog", "barks": "maybe"}},
    {"pet": {"kind": "cat", "barks": True}},
    {"pet": {"kind": "cow", "meows": 3}},
    {"pet": {"meows": 3}},
    {"pet": "cat"},
    {},
]


@pytest.mark.parametrize("value", OWNERS)
def test_it_answers_as_the_undropped_schema_and_as_pydantic(value: Any) -> None:
    schema = wire_schema(Owner)
    assert SchemaValidator(schema).issues(value) == SchemaValidator(
        undropped(Owner, "validation")
    ).issues(value)
    assert (SchemaValidator(schema).issues(value) == []) == accepts(Owner, value)


@pytest.mark.parametrize(
    "value",
    [
        {"pet": {"pet_type": "cat", "color": "white"}},
        {"pet": {"pet_type": "dog"}},
        {"pet": {"pet_type": "cat", "color": "brown"}},
        {"pet": {"pet_type": "cat"}},
        {"pet": {"color": "black"}},
    ],
)
def test_a_nested_union_answers_as_pydantic(value: Any) -> None:
    assert (SchemaValidator(wire_schema(Nested)).issues(value) == []) == accepts(Nested, value)


@pytest.mark.parametrize(
    "value",
    [
        {"method": {"kind": "card", "last4": "4242"}},
        {"method": {"kind": "transfer", "iban": "DE00"}},
        {"method": {"last4": "4242"}},
        {"method": {"iban": "DE00"}},
        {"method": {"kind": "cash"}},
    ],
)
def test_a_tag_with_a_default_answers_as_pydantic(value: Any) -> None:
    assert (SchemaValidator(wire_schema(Payment)).issues(value) == []) == accepts(Payment, value)


def test_the_undropped_schema_took_a_member_without_its_tag() -> None:
    # Why the tag goes into `required`: without it, one member matches on its other fields alone.
    value = {"method": {"last4": "4242"}}
    assert SchemaValidator(undropped(Payment, "validation")).issues(value) == []
    assert not accepts(Payment, value)


class Leaf(BaseModel):
    kind: Literal["leaf"]


class Branch(BaseModel):
    kind: Literal["branch"]
    children: list[Annotated[Leaf | Branch, Field(discriminator="kind")]]


def test_a_recursive_union_keeps_its_definition_without_a_discriminator() -> None:
    schema = wire_schema(Branch)
    assert "discriminator" in json.dumps(undropped(Branch, "validation"))
    assert set(schema["$defs"]) == {"Branch"}
    assert "discriminator" not in json.dumps(schema)
    assert strict_schema_problem(schema) is None
    tree = {"kind": "branch", "children": [{"kind": "leaf"}, {"kind": "branch", "children": []}]}
    assert SchemaValidator(schema).issues(tree) == []
    assert accepts(Branch, tree)


def test_a_property_named_discriminator_stays() -> None:
    class Rule(BaseModel):
        discriminator: str
        pet: Cat | Dog = Field(discriminator="kind")

    schema = wire_schema(Rule)
    assert schema["properties"]["discriminator"] == {"type": "string"}
    assert schema["required"] == ["discriminator", "pet"]
    assert "discriminator" not in schema["properties"]["pet"]


def test_a_union_as_the_whole_schema() -> None:
    # The union as a tool's whole output: `wire_schema` of the type, not of a model.
    Pet = Annotated[Cat | Dog, Field(discriminator="kind")]
    schema = wire_schema(Pet, "serialization")
    assert set(schema) == {"oneOf"}
    assert strict_schema_problem(schema) is None


def test_a_discriminator_with_no_one_of_beside_it_stays() -> None:
    # Only pydantic's, beside the `oneOf` it describes, goes: another is the author's own keyword.
    class Odd(BaseModel):
        model_config = ConfigDict(json_schema_extra={"discriminator": {"propertyName": "kind"}})
        kind: str

    assert wire_schema(Odd)["discriminator"] == {"propertyName": "kind"}


def test_a_dict_keeps_its_discriminator() -> None:
    # A dict is the author's JSON Schema, verbatim.
    given = {"oneOf": [{"type": "object"}], "discriminator": {"propertyName": "kind"}}
    assert wire_schema(given) == given


def test_a_tool_with_a_tagged_union_defines_and_says_so_on_the_wire() -> None:
    class Adopted(BaseModel):
        pet: Cat | Dog = Field(discriminator="kind")
        days: int

    @tool(id="acme.adopt")
    def adopt(input: Owner) -> Adopted:
        """Adopts a pet."""
        return Adopted(pet=Cat(kind="cat", meows=1), days=1)

    for schema in (adopt.input_schema, adopt.output_schema):
        assert "discriminator" not in json.dumps(schema)
        assert strict_schema_problem(schema) is None
