# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""What a response reaches is read open and sent closed (`kindgi.client._open`).

A newer runtime may answer with an enum value or a tagged union's member this
client doesn't know yet. Every model an operation answers with is walked
here, to every enum and tagged union it reaches. Each enum takes a value it
doesn't know and keeps it, and each union reads an unknown tag as its
`<Union>Unrecognized` fallback, its fields kept. Nothing a response reaches
is left closed. Sent in a request body, both refuse what a closed `Literal`
or tagged union refuses.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import re
import sys
import types
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated, Any, Literal, Union, get_args, get_origin

import httpx
import pydantic
import pytest
from pydantic import BaseModel, TypeAdapter
from pydantic.fields import FieldInfo

from kindgi.client import Kindgi, KindgiApiError, models
from kindgi.client import _open as open_
from kindgi.client import _resources as resources

UNKNOWN = "kindgi-test-unknown"


# --- every response's models, walked ------------------------------------------


def response_models() -> list[type[BaseModel]]:
    """Each model an operation answers with (its method's return type)."""
    tree = ast.parse(Path(resources.__file__).read_text("utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.returns is not None:
            for sub in ast.walk(node.returns):
                if isinstance(sub, ast.Attribute) and ast.unparse(sub.value) == "_models":
                    names.add(sub.attr)
    found = [getattr(models, name) for name in sorted(names)]
    return [m for m in found if isinstance(m, type) and issubclass(m, BaseModel)]


def is_union(tp: Any) -> bool:
    return get_origin(tp) in (Union, types.UnionType)


def literal_strings(tp: Any) -> list[str]:
    return [v for v in get_args(tp) if isinstance(v, str)] if get_origin(tp) is Literal else []


def tag_values(model: type[BaseModel], wire: str) -> list[str] | None:
    for name, info in model.model_fields.items():
        if (info.alias or name) == wire:
            annotation = info.annotation
            if get_origin(annotation) is Annotated:
                annotation = get_args(annotation)[0]
            return literal_strings(annotation) or None
    return None


def union_tag(members: list[type[BaseModel]]) -> str | None:
    """The wire field each member holds to values of its own, if one does."""
    wires = [{info.alias or name for name, info in m.model_fields.items()} for m in members]
    for wire in sorted(set.intersection(*wires)):
        values = [tag_values(m, wire) for m in members]
        flat = [v for vs in values if vs for v in vs]
        if all(values) and len(set(flat)) == len(flat):
            return wire
    return None


def open_mark(tp: Any) -> bool:
    return get_origin(tp) is Annotated and any(m is open_.OPEN for m in get_args(tp)[1:])


def walk(roots: list[type[BaseModel]]) -> Iterator[tuple[str, str, Any]]:
    """`(kind, where, type)` for each enum and union the models reach: `open-enum`,
    `open-union`, `closed-enum` or `closed-union`, and `text-or-model` for a union of an
    open enum and models."""
    seen: set[type[BaseModel]] = set()
    routed: set[tuple[type[BaseModel], str]] = set()

    def visit(tp: Any, where: str, owner: type[BaseModel] | None, wire: str) -> Iterator[Any]:
        metadata: list[Any] = []
        while get_origin(tp) is Annotated:
            tp, *more = get_args(tp)
            metadata += more
        if any(m is open_.OPEN for m in metadata):
            yield ("open-enum", where, Annotated[tp, open_.OPEN])
            return
        unions = [m for m in metadata if isinstance(m, open_.OpenUnion)]
        if unions:
            yield ("open-union", where, Annotated[tp, unions[0]])
            for member in get_args(tp):
                routed.add((member, unions[0].tag))
                yield from model(member)
            return
        if get_origin(tp) is Literal:
            # One value may be a `const`, closed on purpose: the OpenAPI walk below tells.
            if len(literal_strings(tp)) >= 2 and (owner, wire) not in routed:
                yield ("closed-enum", where, tp)
            return
        if is_union(tp):
            members = [m for m in get_args(tp) if isinstance(m, type) and issubclass(m, BaseModel)]
            if len(members) >= 2 and union_tag(members) is not None:
                yield ("closed-union", where, tp)
            if members and any(open_mark(arg) for arg in get_args(tp)):
                yield ("text-or-model", where, tp)
        for arg in get_args(tp):
            yield from visit(arg, where, owner, wire)
        if isinstance(tp, type) and issubclass(tp, BaseModel):
            yield from model(tp)

    def model(m: type[BaseModel]) -> Iterator[Any]:
        if m in seen:
            return
        seen.add(m)
        for name, info in m.model_fields.items():
            annotation = (
                Annotated[info.annotation, *info.metadata] if info.metadata else info.annotation
            )
            yield from visit(
                annotation, f"{m.__name__}.{info.alias or name}", m, info.alias or name
            )

    for root in roots:
        yield from model(root)


SITES = list(walk(response_models()))
OPEN_ENUMS = {where: tp for kind, where, tp in SITES if kind == "open-enum"}
OPEN_UNIONS = {where: tp for kind, where, tp in SITES if kind == "open-union"}
TEXT_OR_MODEL = {where: tp for kind, where, tp in SITES if kind == "text-or-model"}


def test_a_response_reaches_nothing_closed() -> None:
    closed = sorted(f"{where} ({kind})" for kind, where, _ in SITES if kind.startswith("closed"))
    assert closed == []


def test_the_walk_reaches_the_values_older_clients_failed_on() -> None:
    # The values the 0.1.8 client refused (a second factor's sign-in events, a
    # system key's scope), and some unions, so an empty walk can't pass.
    assert "SignInEvent.kind" in OPEN_ENUMS
    assert "SystemKey.scopes" in OPEN_ENUMS or "Datum2.scopes" in OPEN_ENUMS
    # An enum of one value: it may gain one.
    assert "TrustedSigningKey.algorithm" in OPEN_ENUMS
    assert "Pin.scope" in OPEN_UNIONS
    assert len(OPEN_ENUMS) > 50 and len(OPEN_UNIONS) > 10


def known_values(tp: Any) -> list[str]:
    inner = get_args(tp)[0]
    return [v for arg in get_args(inner) for v in literal_strings(arg)]


@pytest.mark.parametrize("where", sorted(OPEN_ENUMS))
def test_each_response_enum_reads_any_value_and_sends_only_known_ones(where: str) -> None:
    tp = OPEN_ENUMS[where]
    adapter = TypeAdapter(tp)
    known = known_values(tp)
    assert known
    assert adapter.validate_python(UNKNOWN) == UNKNOWN
    for value in known:
        assert adapter.validate_python(value) == value
        assert adapter.validate_python(value, context=open_.SEND) == value
    with pytest.raises(pydantic.ValidationError) as sent:
        adapter.validate_python(UNKNOWN, context=open_.SEND)
    # The error a closed `Literal` of those values gives.
    with pytest.raises(pydantic.ValidationError) as closed:
        TypeAdapter(Literal[tuple(known)]).validate_python(UNKNOWN)  # type: ignore[valid-type]
    assert sent.value.errors()[0]["type"] == closed.value.errors()[0]["type"] == "literal_error"
    assert sent.value.errors()[0]["msg"] == closed.value.errors()[0]["msg"]


@pytest.mark.parametrize("where", sorted(OPEN_UNIONS))
def test_each_response_union_reads_an_unknown_tag_as_its_fallback(where: str) -> None:
    tp = OPEN_UNIONS[where]
    union, mark = get_args(tp)
    adapter = TypeAdapter(tp)
    read = adapter.validate_python({mark.tag: UNKNOWN, "kindgiTestField": 1})
    assert type(read) is mark.fallback
    assert getattr(read, mark.tag) == UNKNOWN
    assert read.model_extra == {"kindgiTestField": 1}
    with pytest.raises(pydantic.ValidationError) as sent:
        adapter.validate_python({mark.tag: UNKNOWN}, context=open_.SEND)
    assert sent.value.errors()[0]["type"] == "union_tag_invalid"
    # A known tag picks its member: a body that doesn't match it is refused, never
    # read as the fallback.
    for member in get_args(union):
        if member is mark.fallback:
            continue
        tag = tag_values(member, mark.tag)
        assert tag
        required = [
            n
            for n, info in member.model_fields.items()
            if info.is_required() and (info.alias or n) != mark.tag
        ]
        if required:
            with pytest.raises(pydantic.ValidationError):
                adapter.validate_python({mark.tag: tag[0]})


def test_an_unknown_tag_is_refused_as_pydantic_refuses_it_in_a_closed_union() -> None:
    adapter = TypeAdapter(OPEN_UNIONS["Pin.scope"])
    with pytest.raises(pydantic.ValidationError) as sent:
        adapter.validate_python({"kind": "galaxy"}, context=open_.SEND)
    closed = Annotated[
        models.PinScopeTenant
        | models.PinScopeOrg
        | models.PinScopeProject
        | models.PinScopeSegment,
        pydantic.Field(discriminator="kind"),
    ]
    with pytest.raises(pydantic.ValidationError) as refused:
        TypeAdapter(closed).validate_python({"kind": "galaxy"})
    assert sent.value.errors()[0]["msg"] == refused.value.errors()[0]["msg"]


# --- every response enum in the API, from the OpenAPI document ----------------


def gen_client() -> Any:
    """`scripts/gen_client.py`, for the OpenAPI document as codegen reads it. Its tools are
    dev dependencies; the floor-versions run has none."""
    pytest.importorskip("inflect")
    if "gen_client" not in sys.modules:
        script = Path(__file__).resolve().parents[1] / "scripts" / "gen_client.py"
        spec = importlib.util.spec_from_file_location("gen_client", script)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules["gen_client"] = module
        spec.loader.exec_module(module)
    return sys.modules["gen_client"]


def field_type(info: FieldInfo) -> Any:
    return Annotated[info.annotation, *info.metadata] if info.metadata else info.annotation


def bare(tp: Any) -> Any:
    """`tp` without `| None` or `Annotated` metadata, but an open enum's."""
    while get_origin(tp) is Annotated and not open_mark(tp):
        tp = get_args(tp)[0]
    if is_union(tp):
        args = [a for a in get_args(tp) if a is not type(None)]
        if len(args) == 1:
            return bare(args[0])
    return tp


def is_model(tp: Any) -> bool:
    return isinstance(tp, type) and issubclass(tp, BaseModel)


def literals_in(tp: Any) -> list[tuple[list[str], bool]]:
    """Each `Literal` in a type, not inside its models, and whether it's open."""
    if open_mark(tp):
        return [(known_values(tp), True)]
    if get_origin(tp) is Literal:
        return [(literal_strings(tp), False)]
    if get_origin(tp) is Annotated:
        return literals_in(get_args(tp)[0])
    return [found for arg in get_args(tp) for found in literals_in(arg)]


def held_apart_by(members: list[type[BaseModel]]) -> str | None:
    """The wire field each member holds to values of its own, open or not."""
    fields = [
        {info.alias or n: field_type(info) for n, info in m.model_fields.items()} for m in members
    ]
    for wire in sorted(set.intersection(*map(set, fields))):
        held = [literals_in(bare(f[wire])) for f in fields]
        flat = [v for h in held for values, _ in h for v in values]
        if all(len(h) == 1 for h in held) and len(set(flat)) == len(flat):
            return wire
    return None


def tagged_fields() -> set[tuple[type[BaseModel], str]]:
    """Each model's field a union picks it by: an `OpenUnion`'s tag, a discriminator, or the
    field the members hold to values of their own. Those stay closed."""
    found: set[tuple[type[BaseModel], str]] = set()

    def unions(tp: Any, tag: str | None) -> None:
        while get_origin(tp) is Annotated:
            tp, *metadata = get_args(tp)
            for mark in metadata:
                if isinstance(mark, open_.OpenUnion):
                    tag = mark.tag
                elif isinstance(mark, FieldInfo) and isinstance(mark.discriminator, str):
                    tag = mark.discriminator
        members = [a for a in get_args(tp) if is_model(a)]
        if is_union(tp) and len(members) >= 2:
            prop = tag or held_apart_by(members)
            found.update((m, prop) for m in members if prop)
        for arg in get_args(tp):
            if not is_model(arg):
                unions(arg, None)

    for model in vars(models).values():
        if is_model(model):
            for info in model.model_fields.values():
                named = info.discriminator if isinstance(info.discriminator, str) else None
                unions(field_type(info), named)
    # A method's answer by status: `secrets.rotate` returns the sync or the async model,
    # told apart by `kind`.
    tree = ast.parse(Path(resources.__file__).read_text("utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.returns is not None:
            names = [
                sub.attr
                for sub in ast.walk(node.returns)
                if isinstance(sub, ast.Attribute) and ast.unparse(sub.value) == "_models"
            ]
            answers = [getattr(models, n) for n in names]
            if len(answers) >= 2 and (prop := held_apart_by(answers)):
                found.update((m, prop) for m in answers)
    return found


def properties(doc: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """A schema's properties, its `allOf`'s merged in."""
    schema = gen_client().deref(doc, schema)
    merged: dict[str, Any] = {}
    for member in schema.get("allOf") or []:
        merged |= properties(doc, member)
    return merged | (schema.get("properties") or {})


def stands_for(doc: dict[str, Any], model: type[BaseModel], schema: dict[str, Any]) -> bool:
    """Whether `model` was generated from the object `schema`: its fields, its values."""
    props = properties(doc, schema)
    fields = {i.alias or n: field_type(i) for n, i in model.model_fields.items()}
    if set(fields) != set(props):
        return False
    for wire, prop in props.items():
        prop = gen_client().deref(doc, prop)
        values = [prop["const"]] if "const" in prop else prop.get("enum")
        strings = sorted(v for v in values or [] if isinstance(v, str))
        if strings and strings not in [sorted(s) for s, _ in literals_in(bare(fields[wire]))]:
            return False
    return True


def follow(
    doc: dict[str, Any],
    tp: Any,
    schema: dict[str, Any],
    path: tuple[Any, ...],
    at: tuple[type[BaseModel], str] | None,
) -> tuple[Any, tuple[type[BaseModel], str] | None]:
    """The Python type standing for the schema at `path` under `schema`, which `tp` stands
    for, and the field it's in."""
    schema = gen_client().deref(doc, schema)
    if is_model(bare(tp)) and issubclass(bare(tp), pydantic.RootModel):
        tp = field_type(bare(tp).model_fields["root"])
    if not path:
        return tp, at
    key, rest = path[0], path[1:]
    if key == "properties":
        model = bare(tp)
        assert is_model(model), f"{path}: {tp!r} isn't a model"
        [info] = [i for n, i in model.model_fields.items() if (i.alias or n) == rest[0]]
        return follow(
            doc, field_type(info), schema["properties"][rest[0]], rest[1:], (model, rest[0])
        )
    if key in ("items", "additionalProperties"):
        return follow(doc, get_args(bare(tp))[-1], schema[key], rest, at)
    if key == "allOf":
        return follow(doc, tp, schema["allOf"][rest[0]], rest[1:], at)
    if key in ("oneOf", "anyOf"):
        member = schema[key][rest[0]]
        if not rest[1:]:
            return tp, at
        [model] = [a for a in get_args(bare(tp)) if is_model(a) and stands_for(doc, a, member)]
        return follow(doc, model, member, rest[1:], at)
    raise AssertionError(f"can't follow {key!r} in {path}")


def test_every_response_enum_in_the_api_is_read_open() -> None:
    # From the OpenAPI document, so a one-value `enum` (it may gain values) is told from a
    # `const` (it never does), which both generate as `Literal['x']`.
    gen = gen_client()
    doc, ops = gen.operations(json.loads(gen.DEFAULT_OPENAPI.read_text("utf-8")))
    pinned = json.loads(gen.MODEL_NAMES.read_text("utf-8"))
    gen.name_variants(doc)
    gen.name_owned(doc, frozenset(name for name, at in pinned.items() if not at))
    components = doc["components"]["schemas"]
    reached = gen.response_components(doc, ops)
    used: dict[str, list[tuple[str, tuple[Any, ...]]]] = {}
    for user in reached:
        for at, node in gen.schemas_in(components[user]):
            if isinstance(node.get("$ref"), str):
                used.setdefault(node["$ref"].split("/")[-1], []).append((user, at))

    def places(owner: str, path: tuple[Any, ...], seen: frozenset[str]) -> list[Any]:
        model = getattr(models, owner, None)
        if is_model(model):
            return [follow(doc, model, components[owner], path, None)]
        # Without a model of its own (an enum, a union, a list): wherever a response uses it.
        return [
            place
            for user, at in used.get(owner, [])
            if user not in seen
            for place in places(user, (*at, *path), seen | {owner})
        ]

    tags = tagged_fields()
    opened: set[str] = set()
    kept: set[str] = set()
    closed: list[str] = []
    for owner in sorted(reached):
        for path, node in gen.schemas_in(components[owner]):
            values = node.get("enum")
            if not isinstance(values, list) or not any(isinstance(v, str) for v in values):
                continue
            known = sorted(v for v in values if isinstance(v, str))
            found = places(owner, path, frozenset())
            assert found, gen.site(owner, path)
            for tp, at in found:
                held = [is_open for strings, is_open in literals_in(tp) if sorted(strings) == known]
                where = f"{at[0].__name__}.{at[1]}" if at else owner
                assert held, f"{gen.site(owner, path)} at {where}: no Literal of {known}"
                if all(held):
                    opened.add(where)
                elif at in tags:
                    kept.add(where)
                else:
                    closed.append(f"{gen.site(owner, path)} at {where}")
    assert closed == []
    # The enums of one value: each open, but where a union picks its member by it.
    assert {
        "ApprovalCollectionPage.decidedBy",
        "BuildCorrectedTestSetResult.kind",
        "ConversationCollectionPage.openedBy",
        "TestRunComparison.baseline",
        "Fact.review",
        "TrustedSigningKey.algorithm",
        "Warning1.code",
    } <= opened
    assert {"SecretRotateResponseAsync.kind", "SecretRotateResponseSync.kind"} <= kept

    # Both walks reach the same open fields: a model's own or one it inherits (`allOf`).
    def named(where: str) -> set[str]:
        owner, wire = where.split(".", 1)
        return {f"{m.__name__}.{wire}" for m in getattr(models, owner).__mro__ if is_model(m)}

    assert sorted(w for w in OPEN_ENUMS if not named(w) & opened) == []
    assert sorted(w for w in opened if not any(w in named(o) for o in OPEN_ENUMS)) == []


# --- an enum beside models ---------------------------------------------------


def test_the_unions_of_text_and_models_are_the_ones_known() -> None:
    # Opened beside models, an enum takes any text: text must never be read as a model.
    assert sorted(TEXT_OR_MODEL) == ["TestRunComparison.baseline"]


@pytest.mark.parametrize(
    "model", [models.TestRunComparison, models.StartTestRunBody], ids=lambda m: m.__name__
)
def test_a_baseline_reads_each_member_it_knows_as_before_and_other_text_as_text(
    model: type[BaseModel],
) -> None:
    opened = TypeAdapter(field_type(model.model_fields["baseline"]))
    before = TypeAdapter(Literal["recorded"] | models.TestRunBaseline1 | models.TestRunBaseline2)
    for body in ("recorded", {"agentId": "acme.triage", "version": "1.0.0"}, {"pinned": {}}):
        assert type(opened.validate_python(body)) is type(before.validate_python(body))
    assert type(opened.validate_python({"pinned": {}})) is models.TestRunBaseline2
    read = opened.validate_python(UNKNOWN)
    assert type(read) is str and read == UNKNOWN
    # Sent, it's refused as the closed union refuses it.
    with pytest.raises(pydantic.ValidationError) as sent:
        opened.validate_python(UNKNOWN, context=open_.SEND)
    with pytest.raises(pydantic.ValidationError) as closed:
        before.validate_python(UNKNOWN)
    assert [(e["type"], e["msg"]) for e in sent.value.errors()] == [
        (e["type"], e["msg"]) for e in closed.value.errors()
    ]


# --- through the client --------------------------------------------------------


def client(answer: Any, status: int = 200) -> tuple[Kindgi, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=answer)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    return Kindgi("http://kindgi.test/", token="kgi_bt_test", http_client=http, max_retries=0), seen


KEY = {
    "id": "6ccd0eca-40b4-4b86-b8f5-24b0900dddda",
    "label": "acme",
    "scopes": ["system:tenants"],
    "createdAt": "2026-10-18T00:00:00Z",
    "mintedBy": "acme-operator",
}
SIGN_IN = {"id": "ev_1", "timestamp": "2026-10-18T00:00:00Z", "kind": "signed-in", "outcome": "ok"}
PIN_CHANGE = {
    "id": "f531e37d-f29f-463c-81d2-ffad65e4d4e9",
    "agentId": "acme.triage",
    "scope": {"kind": "tenant"},
    "action": "unpin",
    "fromVersion": "1.0.0",
    "toVersion": None,
    "requestedBy": {"kind": "user", "id": "acme-admin"},
    "createdAt": "2026-10-18T00:00:00Z",
}
ROTATION = {"rotationId": PIN_CHANGE["id"], "statusUrl": "/s", "eventsUrl": "/e"}


def test_system_keys_with_a_scope_this_client_doesnt_know() -> None:
    # 0.1.8 failed these with `invalid-response`, the revoke after the key was revoked.
    api, _ = client({"data": [{**KEY, "scopes": ["system:tenants", "system:kindgi-test"]}]})
    [key] = api.system_keys.list().data
    assert key.scopes == ["system:tenants", "system:kindgi-test"]
    api, _ = client({**KEY, "scopes": ["system:kindgi-test"], "alsoRevoked": []})
    assert api.system_keys.revoke(KEY["id"]).scopes == ["system:kindgi-test"]


def test_sign_ins_with_a_kind_this_client_doesnt_know() -> None:
    api, _ = client({"data": [SIGN_IN, {**SIGN_IN, "kind": "kindgi-test-kind"}], "hasMore": False})
    assert [e.kind for e in api.audit.sign_ins.list().data] == ["signed-in", "kindgi-test-kind"]


def test_a_union_member_this_client_doesnt_know_and_cant_send_back() -> None:
    galaxy = {"kind": "galaxy", "galaxyId": "milky-way"}
    api, seen = client({**PIN_CHANGE, "scope": galaxy})
    pin = api.agents.pinned.unpin("acme.triage", scope={"kind": "tenant"})
    assert isinstance(pin.scope, models.AgentPinScopeUnrecognized)
    assert pin.scope.model_extra == {"galaxyId": "milky-way"}
    assert len(seen) == 1
    # Read from a newer runtime, it can't be sent back: refused before sending.
    for scope in (pin.scope, galaxy):
        with pytest.raises(pydantic.ValidationError) as refused:
            api.agents.pinned.unpin("acme.triage", scope=scope)
        assert refused.value.errors()[0]["type"] == "union_tag_invalid"
    with pytest.raises(pydantic.ValidationError):
        api.agents.pinned.unpin("acme.triage", models.AgentUnpinBody(scope=pin.scope))
    assert len(seen) == 1


def test_an_enum_value_this_client_doesnt_know_isnt_sent() -> None:
    api, seen = client({})
    body = {"url": "https://acme.test/hook", "secretRef": {"envName": "prod", "name": "HOOK"}}
    for events in (["kindgi-test-event"], ["run.finished", "kindgi-test-event"]):
        with pytest.raises(pydantic.ValidationError) as refused:
            api.webhook_endpoints.create({**body, "events": events})
        assert refused.value.errors()[0]["type"] == "literal_error"
        built = models.CreateWebhookEndpointBody.model_validate({**body, "events": events})
        with pytest.raises(pydantic.ValidationError):
            api.webhook_endpoints.create(built)
    assert seen == []


def test_a_baseline_this_client_doesnt_know_isnt_sent() -> None:
    # `TestRunBaseline` is in a request and a response: read open, sent closed.
    api, seen = client({"testRunId": PIN_CHANGE["id"]})
    body = {"projectId": PIN_CHANGE["id"], "agentRef": {"agentId": "acme.triage"}}
    with pytest.raises(pydantic.ValidationError) as refused:
        api.test_runs.start(PIN_CHANGE["id"], {**body, "baseline": UNKNOWN})
    assert refused.value.errors()[0]["msg"] == "Input should be 'recorded'"
    assert seen == []
    api.test_runs.start(PIN_CHANGE["id"], {**body, "baseline": "recorded"})
    assert json.loads(seen[0].content)["baseline"] == "recorded"


@pytest.mark.parametrize(
    ("status", "answer", "model"),
    [
        (201, {"kind": "sync", "newVersionId": 2, "oldVersionId": 1}, "SecretRotateResponseSync"),
        (202, {"kind": "async", **ROTATION}, "SecretRotateResponseAsync"),
    ],
)
def test_a_rotation_is_read_by_its_status(status: int, answer: dict[str, Any], model: str) -> None:
    api, _ = client(answer, status)
    rotated = api.secrets.rotate("HOOK", scope_kind="tenant")
    assert type(rotated) is getattr(models, model)
    assert rotated.kind == answer["kind"]


def test_a_rotations_kind_stays_closed_as_it_tells_the_two_answers_apart() -> None:
    # `answer.kind == "async"` narrows the method's answer (tests/typing/client_rotate.py):
    # the tag of a union, so closed, as every union's tag is.
    api, _ = client({"kind": UNKNOWN, **ROTATION}, 202)
    with pytest.raises(KindgiApiError) as failed:
        api.secrets.rotate("HOOK", scope_kind="tenant")
    assert failed.value.server_code == "invalid-response"


_OPEN_VALUES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages/specs/test-vectors/open-values/cases.json"
    ).read_text()
)


def test_the_shared_cases_are_there() -> None:
    assert len(_OPEN_VALUES) >= 5


@pytest.mark.parametrize("case", _OPEN_VALUES, ids=lambda c: c["name"])
def test_each_shared_case_is_refused_before_sending(case: dict[str, Any]) -> None:
    # packages/specs/test-vectors/open-values: the Java client replays the same cases.
    api, seen = client({})
    method: Any = api
    for part in case["operation"].split("."):
        method = getattr(method, re.sub(r"(?<!^)(?=[A-Z])", "_", part).lower())
    with pytest.raises(pydantic.ValidationError) as refused:
        method(*case["args"], case["body"])
    first = refused.value.errors()[0]
    assert first["loc"][: len(case["at"])] == tuple(case["at"])
    assert f"'{case['names']}'" in first["msg"]
    if "tag" in case:
        assert first["type"] == "union_tag_invalid"
        assert f"'{case['tag']}'" in first["msg"]
    assert seen == []


def test_a_known_value_is_sent_as_before() -> None:
    api, seen = client(PIN_CHANGE)
    api.agents.pinned.unpin("acme.triage", scope=models.PinScopeTenant(kind="tenant"))
    api.agents.pinned.unpin("acme.triage", {"scope": {"kind": "tenant"}})
    assert [json.loads(r.content) for r in seen] == [{"scope": {"kind": "tenant"}}] * 2


def test_a_stream_event_of_a_kind_this_client_doesnt_know_is_typed() -> None:
    # As the Java client reads it: a kind it doesn't know is still the event, typed.
    # An event that doesn't match its schema stays a dict, as before.
    events = [
        {
            "eventId": "e1",
            "runId": PIN_CHANGE["id"],
            "tenantId": PIN_CHANGE["id"],
            "timestamp": "2026-10-18T00:00:00Z",
            "kind": "run.kindgi-test",
            "sequence": 1,
        },
        {"eventId": "e2", "kind": "run.started"},
    ]
    content = "".join(f"id: {e['eventId']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
    http = httpx.Client(
        transport=httpx.MockTransport(
            lambda _: httpx.Response(
                200, content=content, headers={"content-type": "text/event-stream"}
            )
        )
    )
    api = Kindgi("http://kindgi.test/", token="kgi_bt_test", http_client=http, max_retries=0)
    first, second = list(api.runs.stream(PIN_CHANGE["id"]))
    assert isinstance(first, models.RunEvent) and first.kind == "run.kindgi-test"
    assert second == {"eventId": "e2", "kind": "run.started"}


def test_a_response_that_doesnt_match_its_schema_still_fails() -> None:
    api, _ = client({"data": [{**SIGN_IN, "kind": 7}], "hasMore": False})
    with pytest.raises(KindgiApiError) as failed:
        api.audit.sign_ins.list()
    assert failed.value.server_code == "invalid-response"
