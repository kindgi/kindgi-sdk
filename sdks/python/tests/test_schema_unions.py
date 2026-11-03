# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A pydantic tagged union (`Field(discriminator=...)`) on the wire: a `oneOf` without OpenAPI's
`discriminator`, which the runtime's strict compile refuses, and answering as pydantic does."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal

import pytest
from pydantic import BaseModel, ConfigDict, Discriminator, Field, Tag, ValidationError

from kindgi import tool
from kindgi._schema import (
    SchemaValidator,
    _inline_refs,
    _WireSchema,
    strict_schema_problem,
    wire_schema,
)
from kindgi.pack.index import run_indexer

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


class Twig(BaseModel):
    kind: Literal["twig"] = "twig"
    value: int


class Bough(BaseModel):
    """A recursive union whose tags have defaults: its `$ref` member is asked for the tag."""

    kind: Literal["bough"] = "bough"
    children: list[Annotated[Bough | Twig, Field(discriminator="kind")]]


@pytest.mark.parametrize(
    "value",
    [
        {"kind": "bough", "children": [{"children": []}]},
        {"kind": "bough", "children": [{"value": 1}]},
        {"kind": "bough", "children": [{"kind": "bough", "children": [{"value": 1}]}]},
        {"kind": "bough", "children": [{"kind": "bough", "children": []}]},
        {"children": [{"kind": "twig", "value": 1}]},
    ],
)
def test_a_recursive_member_is_asked_for_its_tag_when_it_has_a_default(value: Any) -> None:
    schema = wire_schema(Bough)
    assert strict_schema_problem(schema) is None
    assert (SchemaValidator(schema).issues(value) == []) == accepts(Bough, value)


def test_a_recursive_member_asks_for_its_tag_beside_its_ref() -> None:
    schema = wire_schema(Bough)
    # The definition stays as it is: outside the union, as the whole value, the tag is not asked for.
    for where in (schema, schema["$defs"]["Bough"]):
        assert where["required"] == ["children"]
        member = where["properties"]["children"]["items"]["oneOf"][0]
        assert member == {
            "$ref": "#/$defs/Bough",
            "type": "object",
            "properties": {"kind": True},
            "required": ["kind"],
        }


class CallableCat(BaseModel):
    meows: int


class CallableDog(BaseModel):
    barks: bool = False


def _which_pet(value: Any) -> str:
    if isinstance(value, CallableCat):
        return "cat"
    return "cat" if isinstance(value, dict) and "meows" in value else "dog"


class Shelter(BaseModel):
    """A callable picks the member: pydantic writes no `discriminator`, and the members overlap."""

    pet: Annotated[
        Annotated[CallableCat, Tag("cat")] | Annotated[CallableDog, Tag("dog")],
        Discriminator(_which_pet),
    ]


SHELTERED: list[Any] = [
    {"pet": {"meows": 2}},
    {"pet": {"meows": 2, "barks": True}},
    {"pet": {"barks": True}},
    {"pet": {}},
]


@pytest.mark.parametrize("mode", MODES)
def test_a_union_a_callable_picks_is_an_any_of(mode: Any) -> None:
    schema = wire_schema(Shelter, mode)
    assert set(schema["properties"]["pet"]) == {"anyOf"}
    assert strict_schema_problem(schema) is None


@pytest.mark.parametrize("value", SHELTERED)
def test_a_union_a_callable_picks_takes_what_pydantic_takes(value: Any) -> None:
    assert accepts(Shelter, value)
    assert SchemaValidator(wire_schema(Shelter)).issues(value) == []


@pytest.mark.parametrize("value", SHELTERED)
def test_a_union_a_callable_picks_takes_its_own_output(value: Any) -> None:
    dumped = Shelter.model_validate(value).model_dump(mode="json", by_alias=True)
    assert SchemaValidator(wire_schema(Shelter, "serialization")).issues(dumped) == []


def test_a_one_of_refused_a_value_that_fits_both_members() -> None:
    # Why an `anyOf`: a cat's `{"meows": 2}` fits the dog too, whose fields all have defaults.
    value = {"pet": {"meows": 2}}
    for mode in MODES:
        schema = wire_schema(Shelter, mode)
        before = json.loads(json.dumps(schema).replace('"anyOf"', '"oneOf"'))
        assert SchemaValidator(before).issues(value) != []
        assert SchemaValidator(schema).issues(value) == []


class Tabby(BaseModel):
    kind: Literal["cat"] = "cat"
    stripes: int


class Calico(BaseModel):
    kind: Literal["cat"] = "cat"
    patches: int = 3


class Hound(BaseModel):
    kind: Literal["dog"] = "dog"


def _which_cat(value: Any) -> str:
    if isinstance(value, Tabby):
        return "tabby"
    return "tabby" if isinstance(value, dict) and "stripes" in value else "calico"


class Cattery(BaseModel):
    """A union a callable picks, as a member of a tagged union whose tags have defaults."""

    pet: Annotated[
        Annotated[
            Annotated[Tabby, Tag("tabby")] | Annotated[Calico, Tag("calico")],
            Discriminator(_which_cat),
        ]
        | Hound,
        Field(discriminator="kind"),
    ]


@pytest.mark.parametrize(
    "value",
    [
        {"pet": {"stripes": 2}},
        {"pet": {}},
        {"pet": {"kind": "cat", "stripes": 2}},
        {"pet": {"kind": "cat"}},
        {"pet": {"kind": "dog"}},
    ],
)
def test_a_union_a_callable_picks_in_a_tagged_union_answers_as_pydantic(value: Any) -> None:
    schema = wire_schema(Cattery)
    assert strict_schema_problem(schema) is None
    assert (SchemaValidator(schema).issues(value) == []) == accepts(Cattery, value)


def test_a_union_a_callable_picks_in_a_tagged_union_asks_for_the_tag() -> None:
    cats = wire_schema(Cattery)["properties"]["pet"]["oneOf"][0]["anyOf"]
    assert [m["required"] for m in cats] == [["kind", "stripes"], ["kind"]]


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


def test_an_agents_typed_answer_with_a_tagged_union_indexes_without_it(
    make_pack: Callable[..., Path],
) -> None:
    root = make_pack(
        {
            "agents/adopter.py": """
                from typing import Literal
                from pydantic import BaseModel, Field
                from kindgi import Agent

                class Cat(BaseModel):
                    kind: Literal["cat"]

                class Dog(BaseModel):
                    kind: Literal["dog"]

                class Answer(BaseModel):
                    pet: Cat | Dog = Field(discriminator="kind")

                agent = Agent(
                    id="acme.adopter", version="1.0.0", name="Adopter",
                    instructions="Picks a pet.", output=Answer,
                )
            """,
        }
    )
    outcome = run_indexer(
        root, artifact_version="20261001.3", published_at="2026-10-01T00:00:00.000Z"
    )
    assert outcome["kind"] == "ok", outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    schema = index["agents"][0]["output"]["schema"]
    assert "discriminator" not in json.dumps(schema)
    assert [m["required"] for m in schema["properties"]["pet"]["oneOf"]] == [["kind"], ["kind"]]
    assert strict_schema_problem(schema) is None
