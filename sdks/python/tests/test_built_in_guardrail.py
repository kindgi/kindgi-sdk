# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`built_in_guardrail`: a guardrail whose check is a built-in — refused as TypeScript refuses it,
indexed as TypeScript indexes it, and left to the runtime by the pack's service."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from importlib import resources
from pathlib import Path
from typing import Any

import httpx
import pytest

from kindgi import DefinitionError, Guardrail, built_in_guardrail
from kindgi.pack.define import _GUARDRAIL_POINTS
from kindgi.pack.index import _spec, run_indexer
from kindgi.pack.service import PackService


def no_guarantees(**overrides: Any) -> Guardrail:
    args: dict[str, Any] = {
        "id": "acme.no-guarantees",
        "check": "forbidden-substring",
        "config": {"patterns": ["guaranteed", "we promise"]},
        "on_violation": "halt",
        **overrides,
    }
    return built_in_guardrail(**args)


def test_it_names_the_built_in_and_its_config() -> None:
    built = no_guarantees()
    assert built.built_in
    assert built.check_id == "forbidden-substring"
    assert built.kind == "zero-llm"
    assert built.action == {"on-violation": "halt"}
    assert built.config == {"patterns": ["guaranteed", "we promise"]}
    assert built.at is None
    assert built.module == __name__


def test_calling_it_in_python_says_where_it_runs() -> None:
    with pytest.raises(RuntimeError, match='built-in check "forbidden-substring": the Kindgi'):
        no_guarantees()({}, {})


def test_a_check_that_isnt_a_built_in_is_refused() -> None:
    with pytest.raises(DefinitionError, match=re.escape('"acme.checks.mine" isn\'t a built-in')):
        no_guarantees(check="acme.checks.mine")


@pytest.mark.parametrize(
    "actions",
    [{"on_violation": None}, {"action": {"on-violation": "halt"}}],
    ids=["neither", "both"],
)
def test_it_takes_exactly_one_action(actions: dict[str, Any]) -> None:
    with pytest.raises(DefinitionError, match="exactly one of on_violation= or action="):
        no_guarantees(**actions)


def test_at_is_a_guardrail_point() -> None:
    assert no_guarantees(at="model-step").at == "model-step"
    with pytest.raises(DefinitionError, match="at= must be one of before-tool, after-tool"):
        no_guarantees(at="before-answer")


@pytest.mark.parametrize(
    "overrides",
    [
        {"on_violation": "escalate", "at": "before-tool"},
        {"on_violation": None, "action": {"on-violation": "compensate"}, "at": "model-step"},
    ],
    ids=["escalate", "compensate"],
)
def test_escalate_and_compensate_are_final_answer_only(overrides: dict[str, Any]) -> None:
    with pytest.raises(DefinitionError, match="is recorded at the final answer only, not at"):
        no_guarantees(**overrides)


def test_escalate_at_the_final_answer_builds() -> None:
    assert no_guarantees(on_violation="escalate", at="final-answer").at == "final-answer"


@pytest.mark.parametrize("at", [None, "model-step", "final-answer"])
def test_scope_tools_is_for_the_tool_points_only(at: str | None) -> None:
    with pytest.raises(DefinitionError, match=re.escape('scope.tools is for "before-tool"')):
        no_guarantees(check="never-call-tool", scope={"tools": ["acme.refund"]}, at=at)


@pytest.mark.parametrize("tools", [[], ["acme.*.refund"], [""], "acme.refund"])
def test_scope_tools_names_tool_ids(tools: Any) -> None:
    with pytest.raises(
        DefinitionError, match=re.escape("scope.tools must name one or more tool ids")
    ):
        no_guarantees(check="never-call-tool", scope={"tools": tools}, at="before-tool")


def test_the_points_are_the_index_schemas() -> None:
    schema = json.loads(
        resources.files("kindgi._specs").joinpath("pack-index.schema.json").read_text()
    )
    assert list(_GUARDRAIL_POINTS) == schema["$defs"]["guardrail"]["properties"]["at"]["enum"]


def test_scope_tools_before_a_tool_builds() -> None:
    built = no_guarantees(
        check="never-call-tool",
        config={"tools": ["acme.refund"]},
        scope={"tools": ["acme.*"]},
        at="before-tool",
    )
    assert built.scope == {"tools": ["acme.*"]}


GUARDRAILS = """
from kindgi import built_in_guardrail

no_guarantees = built_in_guardrail(
    id="acme.no-guarantees",
    name="No guarantees",
    check="forbidden-substring",
    config={"patterns": ["guaranteed", "we promise"]},
    on_violation="halt",
)

no_refunds = built_in_guardrail(
    id="acme.no-refunds",
    check="never-call-tool",
    config={"tools": ["acme.refund"]},
    action={"on-violation": "retry", "retry": {"maxAttempts": 2}},
    at="before-tool",
)
"""

AGENT = """
from kindgi import Agent
from ..guardrails.rules import no_guarantees, no_refunds

agent = Agent(
    id="acme.agent", version="1.0.0", name="Agent", instructions="Answer.",
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    guardrails=[no_guarantees, no_refunds],
)
"""


def index_of(make_pack: Callable[..., Path]) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    root = make_pack({"guardrails/rules.py": GUARDRAILS, "agents/agent.py": AGENT})
    outcome = run_indexer(
        root, artifact_version="20261106.1", published_at="2026-11-06T00:00:00.000Z"
    )
    assert outcome["kind"] == "ok", outcome
    index = json.loads(Path(outcome["value"]["outputPath"]).read_text())
    return root, outcome["value"], index


def test_the_index_entry_is_typescripts(make_pack: Callable[..., Path]) -> None:
    _, value, index = index_of(make_pack)
    assert value["fileErrors"] == []
    # A built-in's id has no pack prefix, so no `check-id-unprefixed`.
    assert value["warnings"] == []
    assert _spec("pack-index").issues(index) == []
    assert index["guardrails"] == [
        {
            "id": "acme.no-guarantees",
            "name": "No guarantees",
            "kind": "zero-llm",
            "action": {"on-violation": "halt"},
            "checkModulePath": "guardrails/rules.py",
            "checkId": "forbidden-substring",
            "checkBuiltIn": True,
            "config": {"patterns": ["guaranteed", "we promise"]},
        },
        {
            "id": "acme.no-refunds",
            "kind": "zero-llm",
            "action": {"on-violation": "retry", "retry": {"maxAttempts": 2}},
            "at": "before-tool",
            "checkModulePath": "guardrails/rules.py",
            "checkId": "never-call-tool",
            "checkBuiltIn": True,
            "config": {"tools": ["acme.refund"]},
        },
    ]
    assert index["agents"][0]["guardrails"] == ["acme.no-guarantees", "acme.no-refunds"]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_the_pack_holds_no_check_for_a_built_in(make_pack: Callable[..., Path]) -> None:
    root, _, index = index_of(make_pack)
    service = PackService(index, root, "tok", logger=lambda _: None)
    assert service.prewarm() == []
    headers = {"kindgi-pack-token": "tok", "content-type": "application/json"}
    message = {
        "v": 2,
        "kind": "check-invoke",
        "check": {"id": "forbidden-substring"},
        "config": {"patterns": ["guaranteed"]},
        "trace": {
            "runId": "r",
            "tenantId": "t",
            "output": "guaranteed",
            "toolCalls": [],
            "toolResults": [],
            "modelCalls": [],
            "mode": "runtime",
        },
    }
    transport = httpx.ASGITransport(app=service)
    async with httpx.AsyncClient(transport=transport, base_url="http://pack") as http:
        info = (await http.get("/v1/info", headers=headers)).json()
        answer = (await http.post("/v1/invoke", json=message, headers=headers)).json()
    service.close()
    assert info["checks"] == []
    assert answer["code"] == "check-not-in-pack"
    assert answer["checkId"] == "forbidden-substring"
