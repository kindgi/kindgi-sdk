# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`scripts/gen_client.py`'s model names, on a small OpenAPI document of its own."""

from __future__ import annotations

import ast
import importlib.util
import json
import shutil
import sys
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


def test_each_model_is_written_down_where_it_sits(tmp_path: Path) -> None:
    generate(tmp_path, {**SCHEMAS, "Holder": holder("sku")})
    written = json.loads((tmp_path / "out" / "model_names.json").read_text("utf-8"))
    assert written["Flow"] == ["Flow"]
    assert written["JudgedFlow"] == ["JudgedFlow"]
    assert written["Item"] == ["Holder.items#0"]


def test_a_model_not_generated_from_its_component_fails_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Without the owner's name, the inline `flow` takes `Flow`, as it once did.
    monkeypatch.setattr(gen, "name_owned", lambda doc: None)
    with pytest.raises(SystemExit, match="Flow not generated from the component of that name"):
        generate(tmp_path, SCHEMAS)


def test_a_model_name_that_would_move_fails_generation(tmp_path: Path) -> None:
    generate(tmp_path, {"Holder": holder("sku")})
    names = tmp_path / "pinned.json"
    shutil.copy(tmp_path / "out" / "model_names.json", names)
    # An inline object of the same name, ahead of it, takes `Item`; Holder's would be `Item1`.
    with pytest.raises(SystemExit, match=r"Item: was at Holder\.items#0, now at Earlier\.items#0"):
        generate(tmp_path, {"Earlier": holder("code"), "Holder": holder("sku")}, names)


def test_a_model_name_that_would_vanish_fails_generation(tmp_path: Path) -> None:
    generate(tmp_path, {**SCHEMAS, "Holder": holder("sku")})
    names = tmp_path / "pinned.json"
    shutil.copy(tmp_path / "out" / "model_names.json", names)
    with pytest.raises(SystemExit, match=r"Item: gone, was at Holder\.items#0"):
        generate(tmp_path, SCHEMAS, names)


def test_a_component_name_that_changes_meaning_fails_generation(tmp_path: Path) -> None:
    # As `Flow` was pinned if it had been then: the judged run's inline `flow`.
    names = tmp_path / "pinned.json"
    names.write_text(json.dumps({"Flow": ["Judged.flow#0"]}), "utf-8")
    with pytest.raises(SystemExit, match=r"Flow: was at Judged\.flow#0, now at Flow"):
        generate(tmp_path, SCHEMAS, names)
