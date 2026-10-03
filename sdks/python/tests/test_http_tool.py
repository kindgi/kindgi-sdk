# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`http_tool`: a declarative HTTP tool — its spec, checked as `defineTool` checks it, and indexed."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from kindgi import DefinitionError, Tool, http_tool
from kindgi.pack.index import _spec, run_indexer


class Lookup(BaseModel):
    case_id: str
    court: str


class Found(BaseModel):
    title: str


def lookup(**overrides: Any) -> Tool[..., Any]:
    args: dict[str, Any] = {
        "id": "acme.lookup",
        "description": "Looks a case up.",
        "input": Lookup,
        "output": Found,
        "method": "GET",
        "url_template": "https://cases.example.com/{court}/{case_id}",
        **overrides,
    }
    return http_tool(**args)


def test_the_spec_is_the_wire_shape() -> None:
    tool = lookup(
        headers={"Accept": "application/json"},
        authorization={"kind": "bearer", "secretRef": {"envName": "local", "name": "ACME_TOKEN"}},
        timeout_ms=5000,
        success_status=(200, 299),
        version="1.0.0",
        effects=[{"kind": "reads", "resource": "external:cases.example.com"}],
    )
    assert tool.spec == {
        "kind": "http",
        "method": "GET",
        "urlTemplate": "https://cases.example.com/{court}/{case_id}",
        "headers": [{"name": "Accept", "value": "application/json"}],
        "authorization": {
            "kind": "bearer",
            "secretRef": {"envName": "local", "name": "ACME_TOKEN"},
        },
        "timeoutMs": 5000,
        "successStatus": {"min": 200, "max": 299},
    }
    assert tool.input_schema["required"] == ["case_id", "court"]
    assert tool.output_schema["properties"] == {"title": {"type": "string"}}
    assert tool.version == "1.0.0"
    assert tool.module == __name__


def test_only_what_is_given_is_in_the_spec() -> None:
    assert lookup().spec == {
        "kind": "http",
        "method": "GET",
        "urlTemplate": "https://cases.example.com/{court}/{case_id}",
    }
    body = lookup(method="POST", request_body={"kind": "json-input"}, parse_json=False)
    assert body.spec is not None
    assert body.spec["requestBody"] == {"kind": "json-input"}
    assert body.spec["parseJson"] is False


@pytest.mark.parametrize(
    ("overrides", "where"),
    [
        ({"method": "FETCH"}, "/method"),
        ({"url_template": ""}, "/urlTemplate"),
        ({"timeout_ms": 0}, "/timeoutMs"),
        ({"success_status": (99, 299)}, "/successStatus/min"),
        (
            {"authorization": {"kind": "basic", "secretRef": {"envName": "local", "name": "K"}}},
            "/authorization",
        ),
        ({"authorization": {"kind": "bearer", "secretRef": {"name": "K"}}}, "/authorization"),
        ({"request_body": {"kind": "form"}}, "/requestBody"),
    ],
)
def test_a_spec_the_schema_refuses_is_a_definition_error(
    overrides: dict[str, Any], where: str
) -> None:
    with pytest.raises(DefinitionError, match="not a valid HTTP tool spec") as raised:
        lookup(**overrides)
    assert where in str(raised.value)


def test_every_placeholder_is_a_field_of_the_input() -> None:
    with pytest.raises(DefinitionError, match=r"\{docket\}, \{year\} not a field of the input"):
        lookup(url_template="https://cases.example.com/{year}/{docket}")
    with pytest.raises(DefinitionError, match=r"\{judge\} not a field"):
        lookup(
            method="POST", request_body={"kind": "text", "template": "case {case_id} by {judge}"}
        )
    text = lookup(method="POST", request_body={"kind": "text", "template": "case {case_id}"})
    assert text.spec is not None


def test_id_version_and_description_are_checked() -> None:
    with pytest.raises(DefinitionError, match="id must be a non-empty string"):
        lookup(id=" ")
    with pytest.raises(DefinitionError, match="exact semver"):
        lookup(version="^1.0.0")
    with pytest.raises(DefinitionError, match="needs a description"):
        lookup(description="")
    with pytest.raises(DefinitionError, match="input must be an object type"):
        lookup(input=int)


def test_calling_it_in_python_says_where_it_runs() -> None:
    with pytest.raises(RuntimeError, match="the Kindgi runtime makes its request"):
        lookup()(Lookup(case_id="1", court="x"))


HTTP_TOOLS = """
from pydantic import BaseModel
from kindgi import http_tool


class Path(BaseModel):
    path: str


class Answer(BaseModel):
    url: str


fetch = http_tool(
    id="acme.fetch",
    description="Fetches a path from the example API.",
    input=Path,
    output=Answer,
    method="GET",
    url_template="https://api.example.com/{path}",
    authorization={"kind": "bearer", "secretRef": {"envName": "local", "name": "ACME_TOKEN"}},
)
"""

AGENT = """
from kindgi import Agent
from ..tools.fetch import fetch

agent = Agent(
    id="acme.agent", version="1.0.0", name="Agent", instructions="Fetch.",
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[fetch],
)
"""


def test_the_index_carries_the_spec(make_pack: Callable[..., Path]) -> None:
    root = make_pack({"tools/fetch.py": HTTP_TOOLS, "agents/agent.py": AGENT})
    outcome = run_indexer(
        root, artifact_version="20261002.1", published_at="2026-10-02T00:00:00.000Z"
    )
    assert outcome["kind"] == "ok", outcome
    assert outcome["value"]["fileErrors"] == []
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    assert _spec("pack-index").issues(index) == []
    (entry,) = index["tools"]
    assert entry["id"] == "acme.fetch"
    assert entry["modulePath"] == "tools/fetch.py"
    assert entry["spec"] == {
        "kind": "http",
        "method": "GET",
        "urlTemplate": "https://api.example.com/{path}",
        "authorization": {
            "kind": "bearer",
            "secretRef": {"envName": "local", "name": "ACME_TOKEN"},
        },
    }
    assert index["agents"][0]["tools"] == [{"id": "acme.fetch", "version": "1.2.3"}]
