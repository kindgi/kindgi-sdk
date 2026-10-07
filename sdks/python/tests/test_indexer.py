# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from kindgi._json import stable_dumps
from kindgi.pack.index import _spec, run_indexer

PINS = {"artifact_version": "20261001.3", "published_at": "2026-10-01T00:00:00.000Z"}

TOOLS = """
from typing import Any
from pydantic import BaseModel
from kindgi import tool
from ._shared import shout

class Text(BaseModel):
    text: str

@tool(id="acme.shout")
def shout_tool(input: Text) -> Text:
    "Shouts."
    return Text(text=shout(input.text))

@tool(id="acme.whisper", version="2.0.0")
def whisper(input: Text) -> Text:
    "Whispers."
    return Text(text=input.text.lower())
"""

GUARDRAIL = """
from kindgi import RunTrace, guardrail

@guardrail(id="acme.nonempty", on_violation="halt", severity="error", config={"minLength": 2})
def nonempty(config: dict, trace: RunTrace) -> bool:
    return bool(trace.output)
"""

AGENT = """
from kindgi import Agent
from ..tools.text import shout_tool, whisper
from ..guardrails.nonempty import nonempty

class Answer:
    pass

agent = Agent(
    id="acme.agent", version="1.0.0", name="Agent", instructions="Shout.",
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[shout_tool, whisper, {"id": "other.tool", "version": "^1.0.0"}],
    guardrails=[nonempty, "other.guardrail"],
    output={"type": "object", "properties": {"ok": {"type": "boolean"}}},
    tool_errors={"maxRetries": 2},
)
"""

FLOW = """
from kindgi import Flow
from ..tools.text import shout_tool

flow = Flow(
    id="acme.flow", version="1.0.0",
    nodes=[{"id": "shout", "kind": "tool", "ref": shout_tool}],
    edges=[{"id": "e1", "from": "$start", "to": "shout"}, {"id": "e2", "from": "shout", "to": "$end"}],
)
"""


def full_pack(make_pack: Callable[..., Path], **extra: str) -> Path:
    return make_pack(
        {
            "tools/text.py": TOOLS,
            "tools/_shared.py": "def shout(s: str) -> str:\n    return s.upper()\n",
            "tools/test_text.py": "raise RuntimeError('tests are never imported')\n",
            "guardrails/nonempty.py": GUARDRAIL,
            "agents/agent.py": AGENT,
            "flows/flow.py": FLOW,
            **extra,
        }
    )


def index_of(root: Path, **kwargs: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    outcome = run_indexer(root, **{**PINS, **kwargs})
    assert outcome["kind"] == "ok", outcome
    report = outcome["value"]
    return report, json.loads(Path(report["outputPath"]).read_text())


def test_a_pack_indexes_to_the_spec(make_pack: Callable[..., Path]) -> None:
    root = full_pack(make_pack)
    report, index = index_of(root)
    assert report["fileErrors"] == []
    assert report["counts"] == {"tools": 2, "guardrails": 1, "agents": 1, "flows": 1}
    assert _spec("pack-index").issues(index) == []
    assert [t["id"] for t in index["tools"]] == ["acme.shout", "acme.whisper"]
    shout, whisper = index["tools"]
    assert shout["version"] == "1.2.3"  # the pack's version
    assert whisper["version"] == "2.0.0"
    assert shout["modulePath"] == "tools/text.py"
    assert index["guardrails"][0]["checkId"] == "acme.nonempty"
    assert index["guardrails"][0]["config"] == {"minLength": 2}  # pack-index 1.1.0
    agent = index["agents"][0]
    assert agent["tools"] == [
        {"id": "acme.shout", "version": "1.2.3"},
        {"id": "acme.whisper", "version": "2.0.0"},
        {"id": "other.tool", "version": "^1.0.0"},
    ]
    assert agent["guardrails"] == ["acme.nonempty", "other.guardrail"]
    assert agent["output"] == {
        "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    }
    assert index["flows"][0]["nodes"] == [{"id": "shout", "kind": "tool", "ref": "acme.shout"}]


def test_the_index_is_canonical_and_deterministic(make_pack: Callable[..., Path]) -> None:
    root = full_pack(make_pack)
    report, index = index_of(root)
    first = Path(report["outputPath"]).read_text()
    assert first == stable_dumps(index) + "\n"
    index_of(root)
    assert Path(report["outputPath"]).read_text() == first


def test_one_bad_file_does_not_stop_the_rest(make_pack: Callable[..., Path]) -> None:
    root = full_pack(
        make_pack,
        **{
            "tools/broken.py": "def oops(:\n",
            "tools/agent_in_tools.py": AGENT.replace("..tools.text", ".text").replace(
                "..guardrails", "..guardrails"
            ),
            "tools/nothing.py": "VALUE = 1\n",
        },
    )
    report, index = index_of(root)
    errors = {e["filePath"]: e["code"] for e in report["fileErrors"]}
    assert errors == {
        "tools/broken.py": "file-import-failed",
        "tools/agent_in_tools.py": "kind-mismatch",
        "tools/nothing.py": "no-primitives",
    }
    assert [t["id"] for t in index["tools"]] == ["acme.shout", "acme.whisper"]


def test_a_duplicate_id_is_a_file_error(make_pack: Callable[..., Path]) -> None:
    root = full_pack(
        make_pack, **{"tools/again.py": TOOLS.replace('"acme.whisper"', '"acme.whisper2"')}
    )
    report, index = index_of(root)
    (error,) = report["fileErrors"]
    assert error["code"] == "manifest-validation-failed"
    assert "duplicate tool 'acme.shout'" in error["message"]
    assert [t["id"] for t in index["tools"]] == ["acme.shout", "acme.whisper", "acme.whisper2"]


def test_several_versions_of_one_tool_sit_side_by_side(make_pack: Callable[..., Path]) -> None:
    newer = (
        "from kindgi import tool\n"
        '@tool(id="acme.whisper", version="3.0.0")\n'
        "def whisper_v3(input: dict) -> dict:\n"
        '    """Whisper, louder."""\n'
        "    return {}\n"
    )
    report, index = index_of(full_pack(make_pack, **{"tools/whisper_v3.py": newer}))
    assert report["fileErrors"] == []
    assert sorted((t["id"], t.get("version")) for t in index["tools"]) == [
        ("acme.shout", "1.2.3"),
        ("acme.whisper", "2.0.0"),
        ("acme.whisper", "3.0.0"),
    ]


def test_the_same_version_twice_is_a_file_error(make_pack: Callable[..., Path]) -> None:
    again = (
        "from kindgi import tool\n"
        '@tool(id="acme.whisper", version="2.0.0")\n'
        "def whisper_again(input: dict) -> dict:\n"
        '    """Whisper again."""\n'
        "    return {}\n"
    )
    report, _ = index_of(full_pack(make_pack, **{"tools/whisper_again.py": again}))
    (error,) = report["fileErrors"]
    assert error["code"] == "manifest-validation-failed"
    assert "duplicate tool 'acme.whisper' version 2.0.0" in error["message"]


def test_a_bare_string_tool_on_an_agent_is_a_file_error(make_pack: Callable[..., Path]) -> None:
    bad_agent = (
        "from kindgi import Agent\n"
        'bad = Agent(id="acme.bad", version="1.0.0", name="Bad", instructions="x",'
        ' tools=["acme.shout"])\n'
    )
    root = full_pack(make_pack, **{"agents/bad.py": bad_agent})
    report, index = index_of(root)
    (error,) = report["fileErrors"]
    assert error["code"] == "manifest-validation-failed"
    assert "each tool is a Tool or an {id, version} ref, got 'acme.shout'" in error["message"]
    assert "acme.bad" not in [a["id"] for a in index["agents"]]


def test_an_agent_can_reference_data_blocks(make_pack: Callable[..., Path]) -> None:
    blocks_agent = (
        "from kindgi import Agent\n"
        'blocks = Agent(id="acme.blocks", version="1.0.0", name="Blocks",'
        ' instructions={"prompt": "acme.intake-prompt", "version": "^1.0.0"},'
        ' settings=[{"id": "acme.weights", "version": "^1.0.0"}],'
        ' model_settings={"id": "acme.model", "version": "^1.0.0"})\n'
    )
    root = full_pack(make_pack, **{"agents/blocks.py": blocks_agent})
    report, index = index_of(root)
    assert report["fileErrors"] == []
    (entry,) = [a for a in index["agents"] if a["id"] == "acme.blocks"]
    assert entry["instructions"] == {"prompt": "acme.intake-prompt", "version": "^1.0.0"}
    assert entry["settings"] == [{"id": "acme.weights", "version": "^1.0.0"}]
    assert entry["modelSettings"] == {"id": "acme.model", "version": "^1.0.0"}


def test_an_invalid_flow_is_a_file_error(make_pack: Callable[..., Path]) -> None:
    root = full_pack(
        make_pack, **{"flows/flow.py": FLOW.replace('"to": "shout"', '"too": "shout"')}
    )
    report, index = index_of(root)
    (error,) = report["fileErrors"]
    assert error["code"] == "manifest-validation-failed"
    assert "flow 'acme.flow' is invalid" in error["message"]
    assert index["flows"] == []


def test_config_errors(make_pack: Callable[..., Path], tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    assert run_indexer(empty)["error"]["code"] == "config-not-found"
    no_table = make_pack({}, pyproject='[project]\nname = "x"\n')
    assert run_indexer(no_table)["error"]["code"] == "config-not-found"
    no_id = make_pack({}, pyproject='[tool.kindgi.pack]\nversion = "1.0.0"\n')
    assert run_indexer(no_id)["error"] == {
        "code": "config-parse-failed",
        "message": f"Config file {no_id / 'pyproject.toml'}: 'pack.id' is missing or not a non-empty string",
        "filePath": str(no_id / "pyproject.toml"),
    }
    assert run_indexer(make_pack({}))["error"]["code"] == "discovery-empty"


def test_a_pack_embedded_in_an_app(make_pack: Callable[..., Path]) -> None:
    root = make_pack(
        {
            "app/__init__.py": "",
            "app/text.py": "def shout(s: str) -> str:\n    return s.upper()\n",
            "app/not_a_primitive.py": "raise RuntimeError('never imported')\n",
            "kindgi/tools/text.py": TOOLS.replace(
                "from ._shared import shout", "from app.text import shout"
            ),
        },
        pyproject="""
        [tool.kindgi.pack]
        id = "acme"
        version = "1.0.0"

        [tool.kindgi.discovery]
        tools = "kindgi/tools/**/*.py"
        """,
    )
    report, index = index_of(root)
    assert report["fileErrors"] == []
    assert [(t["id"], t["modulePath"]) for t in index["tools"]] == [
        ("acme.shout", "kindgi/tools/text.py"),
        ("acme.whisper", "kindgi/tools/text.py"),
    ]


def test_the_artifact_version_counts_up_within_a_day(make_pack: Callable[..., Path]) -> None:
    root = full_pack(make_pack)
    first = run_indexer(root)["value"]["artifactVersion"]
    second = run_indexer(root)["value"]["artifactVersion"]
    day, _, n = first.partition(".")
    assert second == f"{day}.{int(n) + 1}"


NESTED_FLOW = """
from kindgi import Flow
from ..tools.text import shout_tool, whisper

flow = Flow(
    id="acme.nested", version="1.0.0",
    nodes=[
        {
            "id": "every", "kind": "loop", "loopKind": "foreach",
            "iterateOver": {"path": "runInput.items"}, "maxIterations": 10,
            "outputSchema": {"type": "object"},
            "body": {
                "nodes": [{"id": "shout", "kind": "tool", "ref": shout_tool}],
                "edges": [
                    {"id": "b1", "from": "$loop-start", "to": "shout"},
                    {"id": "b2", "from": "shout", "to": "$loop-end"},
                ],
            },
        },
        {
            "id": "both", "kind": "fanout", "convergence": "all-succeed",
            "branches": [
                {"branchId": "loud", "handler": shout_tool, "outputSchema": {"type": "object"}},
                {"branchId": "quiet", "handler": "acme.whisper", "outputSchema": {"type": "object"}},
            ],
        },
    ],
    edges=[
        {"id": "e1", "from": "$start", "to": "every"},
        {"id": "e2", "from": "every", "to": "both"},
        {"id": "e3", "from": "both", "to": "$end"},
    ],
)
"""


def test_a_ref_object_in_a_loop_body_or_a_fanout_branch_becomes_its_id(
    make_pack: Callable[..., Path],
) -> None:
    root = full_pack(make_pack, **{"flows/nested.py": NESTED_FLOW})
    report, index = index_of(root)
    assert report["fileErrors"] == []
    nested = next(f for f in index["flows"] if f["id"] == "acme.nested")
    assert nested["nodes"][0]["body"]["nodes"][0]["ref"] == "acme.shout"
    assert [b["handler"] for b in nested["nodes"][1]["branches"]] == ["acme.shout", "acme.whisper"]


def test_a_broken_flow_says_what_is_wrong_and_where(make_pack: Callable[..., Path]) -> None:
    broken = NESTED_FLOW.replace('"maxIterations": 10,', "").replace(
        '"id": "both", "kind": "fanout"', '"id": "both", "kind": "fan-out"'
    )
    root = full_pack(make_pack, **{"flows/nested.py": broken})
    report, _ = index_of(root)
    assert [e["message"] for e in report["fileErrors"]] == [
        "flows/nested.py: flow 'acme.nested' is invalid at /nodes/0: "
        "must have required property 'maxIterations'"
    ]
    snake = NESTED_FLOW.replace('"maxIterations": 10,', '"maxIterations": 10, "max_parallel": 2,')
    report, _ = index_of(full_pack(make_pack, **{"flows/nested.py": snake}))
    assert [e["message"] for e in report["fileErrors"]] == [
        "flows/nested.py: flow 'acme.nested' is invalid at /nodes/0: "
        "must NOT have additional properties ('max_parallel')"
    ]


MUTATING_TOOLS = """
from pydantic import BaseModel
from kindgi import http_tool, tool


class Q(BaseModel):
    q: str


@tool(id="acme.read", mutating=False)
def read(input: Q) -> Q:
    "Reads."
    return input


@tool(id="acme.write", mutating=True)
def write(input: Q) -> Q:
    "Writes."
    return input


@tool(id="acme.unsaid")
def unsaid(input: Q) -> Q:
    "Says nothing about it."
    return input


lookup = http_tool(
    id="acme.lookup", description="Looks up.", input=Q, output=Q,
    method="GET", url_template="https://api.example.com/{q}", mutating=False,
)
"""


def test_the_index_carries_mutating_as_declared(make_pack: Callable[..., Path]) -> None:
    root = make_pack({"tools/q.py": MUTATING_TOOLS})
    report, index = index_of(root)
    assert report["fileErrors"] == []
    assert _spec("pack-index").issues(index) == []
    by_id = {t["id"]: t for t in index["tools"]}
    assert by_id["acme.read"]["mutating"] is False
    assert by_id["acme.write"]["mutating"] is True
    assert "mutating" not in by_id["acme.unsaid"]  # absent: it may change something
    assert by_id["acme.lookup"]["mutating"] is False
