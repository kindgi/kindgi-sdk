# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`scripts/gen_client.py`'s model names, on a small OpenAPI document of its own."""

from __future__ import annotations

import ast
import copy
import importlib.util
import json
import re
import shutil
import sys
from functools import reduce
from pathlib import Path
from typing import Any

import pytest

# The generator's tools are dev dependencies; the floor-versions run has none.
pytest.importorskip("datamodel_code_generator")
pytest.importorskip("inflect")

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "gen_client.py"
_spec = importlib.util.spec_from_file_location("gen_client", SCRIPT)
assert _spec is not None and _spec.loader is not None
gen: Any = importlib.util.module_from_spec(_spec)
sys.modules["gen_client"] = gen
_spec.loader.exec_module(gen)

# `Judged` comes first, so codegen would give its inline `flow` the name `Flow`.
SCHEMAS: dict[str, Any] = {
    "Judged": {
        "type": "object",
        "properties": {
            "flow": {
                "type": "object",
                "description": "The calls the judged run made.",
                "properties": {"calls": {"type": "integer"}},
            }
        },
    },
    "Flow": {
        "type": "object",
        "required": ["id", "nodes"],
        "properties": {
            "id": {"type": "string"},
            "nodes": {"type": "array", "items": {"type": "string"}},
        },
    },
    "FlowPage": {
        "type": "object",
        "properties": {"data": {"type": "array", "items": {"$ref": "#/components/schemas/Flow"}}},
    },
    "Scope": {
        "description": "Where a secret is read.",
        "oneOf": [
            {
                "type": "object",
                "required": ["kind", "tenantId"],
                "properties": {
                    "kind": {"type": "string", "const": "tenant"},
                    "tenantId": {"type": "string"},
                },
            },
            {
                "type": "object",
                "required": ["kind", "orgId"],
                "properties": {
                    "kind": {"type": "string", "enum": ["org"]},
                    "orgId": {"type": "string"},
                },
            },
        ],
    },
    "Secret": {
        "type": "object",
        "properties": {"scope": {"$ref": "#/components/schemas/Scope"}},
    },
}


def holder(field: str) -> dict[str, Any]:
    """A component with an inline object in an array: codegen names it `Item`."""
    return {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {"type": "object", "properties": {field: {"type": "string"}}},
            }
        },
    }


def generate(tmp_path: Path, schemas: dict[str, Any], names: Path | None = None) -> Path:
    """Generate from `schemas`; the generated module's path."""
    openapi = tmp_path / "openapi.json"
    openapi.write_text(
        json.dumps(
            {
                "openapi": "3.1.0",
                "info": {"title": "acme", "version": "1.0.0"},
                "paths": {
                    "/v1/flows/{flowId}": {
                        "get": {
                            "operationId": "flows.get",
                            "parameters": [
                                {
                                    "name": "flowId",
                                    "in": "path",
                                    "required": True,
                                    "schema": {"type": "string"},
                                }
                            ],
                            "responses": {
                                "200": {
                                    "description": "The flow.",
                                    "content": {
                                        "application/json": {
                                            "schema": {"$ref": "#/components/schemas/Flow"}
                                        }
                                    },
                                }
                            },
                        }
                    }
                },
                "components": {"schemas": schemas},
            }
        ),
        "utf-8",
    )
    out = tmp_path / "out"
    shutil.rmtree(out, ignore_errors=True)
    files = gen.generate_into(openapi, out, names or tmp_path / "model_names.json")
    return files[gen.OUT_DIR / gen.MODELS]


def fields(models: Path) -> dict[str, set[str]]:
    return {
        name: {wire for wire, _ in rows}
        for name, rows in gen.model_fields(ast.parse(models.read_text("utf-8"))).items()
    }


def docstring(models: Path, name: str) -> str | None:
    tree = ast.parse(models.read_text("utf-8"))
    node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == name)
    return ast.get_docstring(node)


def test_an_inline_object_named_like_a_component_is_named_after_its_owner(tmp_path: Path) -> None:
    models = generate(tmp_path, SCHEMAS)
    found = fields(models)
    assert found["Flow"] == {"id", "nodes"}
    assert found["JudgedFlow"] == {"calls"}
    assert docstring(models, "JudgedFlow") == "The calls the judged run made."
    assert "Flow1" not in found


def test_a_union_components_members_are_named_by_their_discriminator(tmp_path: Path) -> None:
    models = generate(tmp_path, SCHEMAS)
    found = fields(models)
    assert found["ScopeTenant"] == {"kind", "tenantId"}
    assert found["ScopeOrg"] == {"kind", "orgId"}
    assert not {"Scope", "Scope1", "Scope2"} & set(found)
    # As inline members, they took the union's description; they keep it.
    assert docstring(models, "ScopeOrg") == "Where a secret is read."


# An inline union under a field (`config`) and under an array's items (`steps`).
ENDPOINT: dict[str, Any] = {
    "type": "object",
    "properties": {
        "config": {
            "description": "How it connects.",
            "oneOf": [
                {
                    "type": "object",
                    "properties": {"transport": {"const": "stdio"}, "command": {"type": "string"}},
                },
                {
                    "type": "object",
                    "properties": {"transport": {"const": "http-sse"}, "url": {"type": "string"}},
                },
            ],
        },
        "steps": {
            "type": "array",
            "items": {
                "oneOf": [
                    {
                        "type": "object",
                        "properties": {"kind": {"const": "run"}, "tool": {"type": "string"}},
                    },
                    {
                        "type": "object",
                        "properties": {"kind": {"const": "wait"}, "seconds": {"type": "integer"}},
                    },
                ]
            },
        },
    },
}


def test_an_inline_unions_members_are_named_by_owner_field_and_discriminator(
    tmp_path: Path,
) -> None:
    models = generate(tmp_path, {**SCHEMAS, "Endpoint": ENDPOINT})
    found = fields(models)
    assert found["EndpointConfigStdio"] == {"transport", "command"}
    assert found["EndpointConfigHttpSse"] == {"transport", "url"}
    assert found["EndpointStepRun"] == {"kind", "tool"}
    assert found["EndpointStepWait"] == {"kind", "seconds"}
    assert not {"Config", "Config1", "Step", "Step1"} & set(found)
    assert docstring(models, "EndpointConfigHttpSse") == "How it connects."


def test_a_union_member_left_to_codegen_fails_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # As if name_variants' walk missed them: codegen would number both unions' members.
    monkeypatch.setattr(gen, "name_variants", lambda doc: None)
    with pytest.raises(SystemExit) as failed:
        generate(tmp_path, {"Flow": SCHEMAS["Flow"], "Endpoint": ENDPOINT})
    assert "Endpoint/properties/config/oneOf" in str(failed.value)
    assert "Endpoint/properties/steps/items/oneOf" in str(failed.value)


def test_each_model_is_written_down_where_it_sits(tmp_path: Path) -> None:
    generate(tmp_path, {**SCHEMAS, "Holder": holder("sku")})
    written = json.loads((tmp_path / "out" / "model_names.json").read_text("utf-8"))
    assert written["Flow"] == ["Flow"]
    assert written["JudgedFlow"] == ["JudgedFlow"]
    assert written["Item"] == ["Holder.items"]


def test_a_model_not_generated_from_its_component_fails_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Without the owner's name, the inline `flow` takes `Flow`, as it once did.
    monkeypatch.setattr(gen, "name_owned", lambda doc, dropped: None)
    with pytest.raises(SystemExit, match="Flow not generated from the component of that name"):
        generate(tmp_path, SCHEMAS)


def test_a_model_name_that_would_move_fails_generation(tmp_path: Path) -> None:
    generate(tmp_path, {"Holder": holder("sku")})
    names = tmp_path / "pinned.json"
    shutil.copy(tmp_path / "out" / "model_names.json", names)
    # An inline object of the same name, ahead of it, takes `Item`; Holder's would be `Item1`.
    with pytest.raises(SystemExit, match=r"Item: was at Holder\.items, now at Earlier\.items"):
        generate(tmp_path, {"Earlier": holder("code"), "Holder": holder("sku")}, names)


def test_a_model_name_that_would_vanish_fails_generation(tmp_path: Path) -> None:
    generate(tmp_path, {**SCHEMAS, "Holder": holder("sku")})
    names = tmp_path / "pinned.json"
    shutil.copy(tmp_path / "out" / "model_names.json", names)
    with pytest.raises(SystemExit, match=r"Item: gone, was at Holder\.items"):
        generate(tmp_path, SCHEMAS, names)


def test_a_dropped_name_names_no_model_again(tmp_path: Path) -> None:
    # `Item1` was dropped; a second inline `items` object would be numbered into it.
    names = tmp_path / "pinned.json"
    names.write_text(json.dumps({"Item1": []}), "utf-8")
    with pytest.raises(SystemExit, match=r"Item1: dropped, now at Second\.items"):
        generate(tmp_path, {**SCHEMAS, "First": holder("code"), "Second": holder("sku")}, names)


def test_a_component_that_takes_a_dropped_name_fails_generation_saying_how_out(
    tmp_path: Path,
) -> None:
    # Naming an object in the API doesn't help here: the component is the object.
    names = tmp_path / "pinned.json"
    names.write_text(json.dumps({"Flow": []}), "utf-8")
    with pytest.raises(SystemExit) as failed:
        generate(tmp_path, SCHEMAS, names)
    assert "Flow: dropped, now at Flow\n" in str(failed.value)
    assert "Where a component takes it, rename the component" in str(failed.value)


def test_an_inline_object_a_dropped_name_would_name_is_named_after_its_owner(
    tmp_path: Path,
) -> None:
    names = tmp_path / "pinned.json"
    names.write_text(json.dumps({"Item": []}), "utf-8")
    generate(tmp_path, {**SCHEMAS, "Holder": holder("sku")}, names)
    written = json.loads((tmp_path / "out" / "pinned.json").read_text("utf-8"))
    assert written["HolderItem"] == ["HolderItem"]
    # It stays dropped: its line is written back, at no place.
    assert written["Item"] == []


def test_a_component_name_that_changes_meaning_fails_generation(tmp_path: Path) -> None:
    # As `Flow` was pinned if it had been then: the judged run's inline `flow`.
    names = tmp_path / "pinned.json"
    names.write_text(json.dumps({"Flow": ["Judged.flow"]}), "utf-8")
    with pytest.raises(SystemExit, match=r"Flow: was at Judged\.flow, now at Flow"):
        generate(tmp_path, SCHEMAS, names)


def test_two_members_nothing_tells_apart_fail_generation_naming_the_field(tmp_path: Path) -> None:
    either = {
        "type": "object",
        "properties": {
            "pick": {
                "oneOf": [
                    {"type": "object", "properties": {"sku": {"type": "string"}}},
                    {"type": "object", "properties": {"sku": {"type": "integer"}}},
                ]
            }
        },
    }
    with pytest.raises(SystemExit, match=r"Holder\.pick: Pick, Pick1 have the same properties"):
        generate(tmp_path, {**SCHEMAS, "Holder": either})


def test_members_alike_that_are_components_generate_each_at_its_own_name(tmp_path: Path) -> None:
    # A component sits at its own name, so nothing in the union need tell it apart: not
    # from another of the same properties, nor from an inline member of them.
    def ref(name: str) -> dict[str, str]:
        return {"$ref": f"#/components/schemas/{name}"}

    def sku(kind: str) -> dict[str, Any]:
        return {"type": "object", "properties": {"sku": {"type": kind}}}

    either = {
        "type": "object",
        "properties": {"pick": {"oneOf": [ref("SkuText"), ref("SkuNumber"), sku("boolean")]}},
    }
    generate(
        tmp_path,
        {**SCHEMAS, "SkuText": sku("string"), "SkuNumber": sku("integer"), "Holder": either},
    )
    written = json.loads((tmp_path / "out" / "model_names.json").read_text("utf-8"))
    assert written["SkuText"] == ["SkuText"]
    assert written["SkuNumber"] == ["SkuNumber"]
    assert written["Pick"] == ["Holder.pick{sku}"]


# The API's own document, and the names generated from it.
API: dict[str, Any] = json.loads(gen.DEFAULT_OPENAPI.read_text("utf-8"))
PINNED: dict[str, list[str]] = json.loads(gen.MODEL_NAMES.read_text("utf-8"))

# An inline object no member of these unions has, put first in one.
QUEUED = {"type": "object", "properties": {"queued": {"type": "boolean"}}}

# The API's inline unions with a discriminator, and their members' names.
NAMED: dict[str, tuple[tuple[str, ...], list[str]]] = {
    "CompleteApprovalResult.resume": (
        ("CompleteApprovalResult", "properties", "resume"),
        ["CompleteApprovalResultResumeOk", "CompleteApprovalResultResumeFailed"],
    ),
    "JudgedComparisonSummary.baseline": (
        ("JudgedComparisonSummary", "properties", "baseline"),
        ["JudgedComparisonSummaryBaselineRecorded", "JudgedComparisonSummaryBaselineVersion"],
    ),
    "MCPEndpoint.config": (
        ("MCPEndpoint", "properties", "config"),
        ["MCPEndpointConfigStdio", "MCPEndpointConfigHttpSse", "MCPEndpointConfigStreamableHttp"],
    ),
    "MCPPromptMessage.content": (
        ("MCPPromptMessage", "properties", "content"),
        ["MCPPromptMessageContentText", "MCPPromptMessageContentImage"],
    ),
    "RegisterMCPEndpointBody.config": (
        ("RegisterMCPEndpointBody", "properties", "config"),
        [
            "RegisterMCPEndpointBodyConfigStdio",
            "RegisterMCPEndpointBodyConfigHttpSse",
            "RegisterMCPEndpointBodyConfigStreamableHttp",
        ],
    ),
}

# The API's unions without one, whose members are numbered names, and those names in order.
UNIONS: dict[str, tuple[tuple[str, ...], list[str]]] = {
    "EvalBaseline": (("EvalBaseline",), ["EvalBaseline1", "EvalBaseline2"]),
    "IdentityProviderSignIn": (
        ("IdentityProviderSignIn",),
        ["IdentityProviderSignIn1", "IdentityProviderSignIn2"],
    ),
    "NetworkPolicy": (("NetworkPolicy",), ["NetworkPolicy1", "NetworkPolicy2"]),
    "Secrets": (
        ("DeploymentSecretsSyncRequest", "properties", "secrets", "items"),
        ["Secrets", "Secrets1"],
    ),
    "StartRunBody": (("StartRunBody",), ["StartRunBody1", "StartRunBody2"]),
}


def generate_api(tmp_path: Path, doc: dict[str, Any]) -> dict[str, list[str]]:
    """Generate from `doc`, checked against the committed names; the names it writes."""
    openapi = tmp_path / "openapi.json"
    openapi.write_text(json.dumps(doc), "utf-8")
    gen.generate_into(openapi, tmp_path / "out", gen.MODEL_NAMES)
    return json.loads((tmp_path / "out" / "model_names.json").read_text("utf-8"))


def first_in(path: tuple[str, ...], member: dict[str, Any] = QUEUED) -> dict[str, Any]:
    """The API's document, `member` put first in the union at `path`."""
    doc = copy.deepcopy(API)
    reduce(lambda node, key: node[key], path, doc["components"]["schemas"])["oneOf"].insert(
        0, member
    )
    return doc


def test_the_api_as_it_is_generates_with_the_committed_names(tmp_path: Path) -> None:
    assert generate_api(tmp_path, API) == PINNED


@pytest.mark.parametrize("union", list(NAMED))
def test_a_member_with_no_discriminator_put_first_fails_generation_naming_the_members_gone(
    tmp_path: Path, union: str
) -> None:
    # The union has no discriminator left, so codegen numbers its members.
    path, names = NAMED[union]
    assert all(PINNED[name] == [name] for name in names)
    with pytest.raises(SystemExit) as failed:
        generate_api(tmp_path, first_in(path))
    lines = str(failed.value).splitlines()
    for name in names:
        assert f"  {name}: gone, was at {name}" in lines


def test_a_member_with_the_discriminator_put_first_takes_its_own_name_and_moves_none(
    tmp_path: Path,
) -> None:
    # The likeliest new member: another transport.
    unix = {
        "type": "object",
        "additionalProperties": False,
        "required": ["transport", "path"],
        "properties": {"transport": {"const": "unix"}, "path": {"type": "string"}},
    }
    names = generate_api(tmp_path, first_in(NAMED["MCPEndpoint.config"][0], unix))
    assert names.pop("MCPEndpointConfigUnix") == ["MCPEndpointConfigUnix"]
    assert names == PINNED


@pytest.mark.parametrize("union", list(UNIONS))
def test_a_member_put_first_in_any_numbered_union_fails_generation_naming_its_names(
    tmp_path: Path, union: str
) -> None:
    path, names = UNIONS[union]
    assert all(name in PINNED for name in names)
    with pytest.raises(SystemExit) as failed:
        generate_api(tmp_path, first_in(path))
    for name in names:
        assert re.search(rf"^  {name}: was at ", str(failed.value), re.M), name
