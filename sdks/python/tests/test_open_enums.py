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
import json
import types
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated, Any, Literal, Union, get_args, get_origin

import httpx
import pydantic
import pytest
from pydantic import BaseModel, TypeAdapter

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


def walk(roots: list[type[BaseModel]]) -> Iterator[tuple[str, str, Any]]:
    """`(kind, where, type)` for each enum and union the models reach: `open-enum`,
    `open-union`, `closed-enum` or `closed-union`."""
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
            if len(literal_strings(tp)) >= 2 and (owner, wire) not in routed:
                yield ("closed-enum", where, tp)
            return
        if is_union(tp):
            members = [m for m in get_args(tp) if isinstance(m, type) and issubclass(m, BaseModel)]
            if len(members) >= 2 and union_tag(members) is not None:
                yield ("closed-union", where, tp)
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


def test_a_response_reaches_nothing_closed() -> None:
    closed = sorted(f"{where} ({kind})" for kind, where, _ in SITES if kind.startswith("closed"))
    assert closed == []


def test_the_walk_reaches_the_values_older_clients_failed_on() -> None:
    # The values the 0.1.8 client refused (a second factor's sign-in events, a
    # system key's scope), and some unions, so an empty walk can't pass.
    assert "SignInEvent.kind" in OPEN_ENUMS
    assert "SystemKey.scopes" in OPEN_ENUMS or "Datum2.scopes" in OPEN_ENUMS
    assert "Promotion.scope" in OPEN_UNIONS
    assert len(OPEN_ENUMS) > 50 and len(OPEN_UNIONS) > 10


def known_values(tp: Any) -> list[str]:
    inner = get_args(tp)[0]
    return [v for arg in get_args(inner) for v in literal_strings(arg)]


@pytest.mark.parametrize("where", sorted(OPEN_ENUMS))
def test_each_response_enum_reads_any_value_and_sends_only_known_ones(where: str) -> None:
    tp = OPEN_ENUMS[where]
    adapter = TypeAdapter(tp)
    known = known_values(tp)
    assert len(known) >= 2
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
    adapter = TypeAdapter(OPEN_UNIONS["Promotion.scope"])
    with pytest.raises(pydantic.ValidationError) as sent:
        adapter.validate_python({"kind": "galaxy"}, context=open_.SEND)
    closed = Annotated[
        models.LiveScopeTenant
        | models.LiveScopeOrg
        | models.LiveScopeProject
        | models.LiveScopeSegment,
        pydantic.Field(discriminator="kind"),
    ]
    with pytest.raises(pydantic.ValidationError) as refused:
        TypeAdapter(closed).validate_python({"kind": "galaxy"})
    assert sent.value.errors()[0]["msg"] == refused.value.errors()[0]["msg"]


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
PROMOTION = {
    "id": "f531e37d-f29f-463c-81d2-ffad65e4d4e9",
    "agentId": "acme.triage",
    "scope": {"kind": "tenant"},
    "action": "unpin",
    "fromVersion": "1.0.0",
    "toVersion": None,
    "requestedBy": {"kind": "user", "id": "acme-admin"},
    "createdAt": "2026-10-18T00:00:00Z",
}


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
    api, seen = client({**PROMOTION, "scope": galaxy})
    promotion = api.agents.live.unpin("acme.triage", scope={"kind": "tenant"})
    assert isinstance(promotion.scope, models.LiveScopeUnrecognized)
    assert promotion.scope.model_extra == {"galaxyId": "milky-way"}
    assert len(seen) == 1
    # Read from a newer runtime, it can't be sent back: refused before sending.
    for scope in (promotion.scope, galaxy):
        with pytest.raises(pydantic.ValidationError) as refused:
            api.agents.live.unpin("acme.triage", scope=scope)
        assert refused.value.errors()[0]["type"] == "union_tag_invalid"
    with pytest.raises(pydantic.ValidationError):
        api.agents.live.unpin("acme.triage", models.UnpinBody(scope=promotion.scope))
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


def test_a_known_value_is_sent_as_before() -> None:
    api, seen = client(PROMOTION)
    api.agents.live.unpin("acme.triage", scope=models.LiveScopeTenant(kind="tenant"))
    api.agents.live.unpin("acme.triage", {"scope": {"kind": "tenant"}})
    assert [json.loads(r.content) for r in seen] == [{"scope": {"kind": "tenant"}}] * 2


def test_a_stream_event_of_a_kind_this_client_doesnt_know_is_typed() -> None:
    # As the Java client reads it: a kind it doesn't know is still the event, typed.
    # An event that doesn't match its schema stays a dict, as before.
    events = [
        {
            "eventId": "e1",
            "runId": PROMOTION["id"],
            "tenantId": PROMOTION["id"],
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
    first, second = list(api.runs.stream(PROMOTION["id"]))
    assert isinstance(first, models.RunEvent) and first.kind == "run.kindgi-test"
    assert second == {"eventId": "e2", "kind": "run.started"}


def test_a_response_that_doesnt_match_its_schema_still_fails() -> None:
    api, _ = client({"data": [{**SIGN_IN, "kind": 7}], "hasMore": False})
    with pytest.raises(KindgiApiError) as failed:
        api.audit.sign_ins.list()
    assert failed.value.server_code == "invalid-response"
