# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A pack's data blocks (`kindgi.pack.blocks`): one JSON file each, read into the index with a
prompt's template file inlined, and refused per file. The same cases and messages as the
TypeScript indexer's (`packages/handler-runtime/tests/pack-blocks.test.ts`)."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from kindgi.pack.blocks import read_pack_blocks
from kindgi.pack.index import _spec, run_indexer

BLOCKS = "blocks/**/*.json"
PINS = {"artifact_version": "20261020.1", "published_at": "2026-10-20T21:00:00.000Z"}


def prompt(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "acme.reply-prompt",
        "version": "1.2.0",
        "kind": "prompt",
        "description": "How the support agent replies",
        "content": {"template": "Reply to {{ customer_name }}.", "parameters": []},
        **overrides,
    }


def settings(**overrides: Any) -> dict[str, Any]:
    return {
        "id": "acme.reply-style",
        "version": "1.0.0",
        "kind": "settings",
        "content": {
            "values": {"tone": "warm"},
            "schema": {"type": "object", "properties": {"tone": {"type": "string"}}},
        },
        **overrides,
    }


def write(root: Path, files: dict[str, str | bytes]) -> Path:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding="utf-8")
    return root


def as_json(value: Any) -> str:
    return json.dumps(value, indent=2) + "\n"


def test_reads_each_block_file_sorted_by_id_naming_its_file(tmp_path: Path) -> None:
    write(
        tmp_path,
        {"blocks/style.json": as_json(settings()), "blocks/support/reply.json": as_json(prompt())},
    )
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.errors == []
    assert read.blocks == [
        {**prompt(), "modulePath": "blocks/support/reply.json"},
        {**settings(), "modulePath": "blocks/style.json"},
    ]
    assert read.files == ["blocks/style.json", "blocks/support/reply.json"]


def test_a_prompts_template_file_is_read_in_relative_to_its_block_file(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "blocks/support/reply.json": as_json(
                prompt(content={"templateFile": "reply.liquid", "parameters": []})
            ),
            "blocks/support/reply.liquid": "Reply to {{ customer_name }}.\nKeep it short.\n",
        },
    )
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.errors == []
    assert read.blocks[0]["content"] == {
        "template": "Reply to {{ customer_name }}.\nKeep it short.\n",
        "parameters": [],
    }
    assert read.files == ["blocks/support/reply.json", "blocks/support/reply.liquid"]


def test_a_template_elsewhere_in_the_folder_and_its_byte_order_mark_dropped(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "blocks/support/reply.json": as_json(
                prompt(content={"templateFile": "../templates/reply.liquid"})
            ),
            "blocks/templates/reply.liquid": b"\xef\xbb\xbfHi.",
        },
    )
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.errors == []
    assert read.blocks[0]["content"] == {"template": "Hi."}


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (
            {"template": "x", "templateFile": "reply.liquid"},
            "blocks/reply.json: give `content.template` or `content.templateFile`, not both",
        ),
        (
            {"templateFile": "nope.liquid"},
            'blocks/reply.json: `content.templateFile` "nope.liquid" isn\'t a readable UTF-8 '
            "file (looked for blocks/nope.liquid)",
        ),
        (
            {"templateFile": "../secrets.txt"},
            'blocks/reply.json: `content.templateFile` "../secrets.txt" is outside the blocks '
            "folder (blocks/); keep a block's template next to it",
        ),
        (
            {"templateFile": "/etc/hosts"},
            'blocks/reply.json: `content.templateFile` "/etc/hosts" must be a path relative to '
            "the block file, with forward slashes",
        ),
        (
            {"templateFile": "sub\\reply.liquid"},
            'blocks/reply.json: `content.templateFile` "sub\\reply.liquid" must be a path '
            "relative to the block file, with forward slashes",
        ),
        (
            {"templateFile": ""},
            "blocks/reply.json: `content.templateFile` must be a path relative to the block file",
        ),
        (
            {"parameters": []},
            "blocks/reply.json: a prompt needs `content.template` (a Liquid template) or "
            "`content.templateFile`",
        ),
    ],
    ids=["both", "missing", "outside", "absolute", "backslashes", "empty", "no-template"],
)
def test_refuses_a_bad_template_naming_the_file(
    tmp_path: Path, content: dict[str, Any], message: str
) -> None:
    write(
        tmp_path,
        {
            "secrets.txt": "not for the index",
            "blocks/reply.json": as_json(prompt(content=content)),
            "blocks/other.json": as_json(settings()),
        },
    )
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.errors == [{"message": message, "filePath": "blocks/reply.json"}]
    assert [b["id"] for b in read.blocks] == ["acme.reply-style"]
    assert read.files == ["blocks/other.json"]


def test_a_template_file_that_is_a_link_is_refused(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "blocks/reply.json": as_json(prompt(content={"templateFile": "linked.liquid"})),
            "blocks/real.liquid": "Hi.",
        },
    )
    os.symlink(tmp_path / "blocks/real.liquid", tmp_path / "blocks/linked.liquid")
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.errors == [
        {
            "message": 'blocks/reply.json: `content.templateFile` "linked.liquid" is a symbolic '
            "link; keep the template itself in the blocks folder",
            "filePath": "blocks/reply.json",
        }
    ]


@pytest.mark.parametrize(
    ("content", "message"),
    [
        ('{ "id": ', r"^blocks/b\.json: not a JSON file \("),
        (b"{\xff}", r"^blocks/b\.json: not a JSON file \("),
        ('{"id": NaN}', r"^blocks/b\.json: not a JSON file \("),
        (as_json([prompt()]), r"^blocks/b\.json: a block file holds one JSON object: the block$"),
        (
            as_json({**prompt(), "projectId": "p"}),
            r'^blocks/b\.json: unknown field "projectId" \(a block has id, version, kind, '
            r"description and content\)$",
        ),
        (as_json(prompt(id="Reply")), r"`id` must be a dotted lowercase id"),
        (as_json(prompt(version="^1.0.0")), r"`version` must be major\.minor\.patch"),
        (as_json(prompt(kind="tool")), r'`kind` must be "prompt" or "settings"'),
        (as_json(prompt(description=3)), r"`description` must be a string"),
        (as_json(prompt(content="Hi")), r"`content` must be an object"),
        (
            as_json(prompt(content={"template": "x", "values": {}})),
            r'unknown field "content\.values" \(a prompt block\'s content has template, '
            r"templateFile, parameters\)",
        ),
        (
            as_json(prompt(content={"template": "x", "parameters": {}})),
            r"`content\.parameters` must be an array",
        ),
        (as_json(settings(content={})), r"settings need `content\.values`, an object"),
        (
            as_json(settings(content={"values": {}, "schema": True})),
            r"`content\.schema` must be a JSON Schema object",
        ),
        (
            as_json(settings(content={"values": {}, "templateFile": "x"})),
            r'unknown field "content\.templateFile" \(a settings block\'s content has values, '
            r"schema\)",
        ),
    ],
    ids=[
        "not-json",
        "not-utf8",
        "nan",
        "array",
        "unknown-field",
        "bad-id",
        "range-version",
        "other-kind",
        "description",
        "content",
        "other-kinds-content",
        "parameters",
        "no-values",
        "schema",
        "settings-template-file",
    ],
)
def test_refuses_a_bad_block(tmp_path: Path, content: str | bytes, message: str) -> None:
    write(tmp_path, {"blocks/b.json": content})
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.blocks == []
    assert len(read.errors) == 1
    assert read.errors[0]["filePath"] == "blocks/b.json"
    assert re.search(message, read.errors[0]["message"]), read.errors[0]["message"]


def test_a_block_id_twice_keeps_the_first_file(tmp_path: Path) -> None:
    write(
        tmp_path,
        {"blocks/a.json": as_json(prompt()), "blocks/b.json": as_json(prompt(version="2.0.0"))},
    )
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert [(b["modulePath"], b["version"]) for b in read.blocks] == [("blocks/a.json", "1.2.0")]
    assert read.errors == [
        {
            "message": "blocks/b.json: duplicate block 'acme.reply-prompt' (also defined in "
            "blocks/a.json); a pack holds one version of each block",
            "filePath": "blocks/b.json",
        }
    ]


def test_skips_dot_folders_node_modules_links_and_other_files(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "blocks/.drafts/a.json": as_json(prompt()),
            "blocks/node_modules/a.json": as_json(prompt()),
            "blocks/notes.md": "# notes",
            "blocks/real/style.json": as_json(settings()),
            "outside/linked.json": as_json(prompt()),
        },
    )
    os.symlink(tmp_path / "outside", tmp_path / "blocks/linked-dir")
    os.symlink(tmp_path / "outside/linked.json", tmp_path / "blocks/linked.json")
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert read.errors == []
    assert read.files == ["blocks/real/style.json"]


def test_a_pattern_at_the_pack_root_keeps_templates_inside_the_pack(tmp_path: Path) -> None:
    write(
        tmp_path,
        {
            "support/reply.block.json": as_json(
                prompt(content={"templateFile": "../prompts/reply.liquid"})
            ),
            "prompts/reply.liquid": "Hi.",
            "escape.block.json": as_json(
                prompt(id="acme.escape", content={"templateFile": "../outside.liquid"})
            ),
        },
    )
    read = read_pack_blocks(tmp_path, "**/*.block.json")
    assert [(b["id"], b["content"]) for b in read.blocks] == [
        ("acme.reply-prompt", {"template": "Hi."})
    ]
    assert [e["message"] for e in read.errors] == [
        'escape.block.json: `content.templateFile` "../outside.liquid" is outside the pack; '
        "keep a block's template next to it"
    ]


def test_no_blocks_folder_reads_nothing(tmp_path: Path) -> None:
    read = read_pack_blocks(tmp_path, BLOCKS)
    assert (read.blocks, read.files, read.errors) == ([], [], [])


# ----------------------------------------------------------------------------------------------
# In the index
# ----------------------------------------------------------------------------------------------

AGENT = """
from kindgi import Agent

agent = Agent(
    id="acme.support", version="1.0.0", name="Support agent",
    instructions={"prompt": "acme.reply-prompt", "version": "^1.0.0"},
    capabilities=[], tools=[],
)
"""


def index_of(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    outcome = run_indexer(root, **PINS)
    assert outcome["kind"] == "ok", outcome
    report = outcome["value"]
    index = json.loads(Path(report["outputPath"]).read_text())
    assert _spec("pack-index").issues(index) == []
    return report, index


def test_the_index_carries_the_packs_blocks(make_pack: Callable[..., Path]) -> None:
    root = make_pack(
        {
            "agents/support.py": AGENT,
            "blocks/reply.json": as_json(prompt(content={"templateFile": "reply.liquid"})),
            "blocks/reply.liquid": "Reply to {{ customer_name }}.",
            "blocks/style.json": as_json(settings()),
        }
    )
    report, index = index_of(root)
    assert report["fileErrors"] == []
    assert report["counts"] == {"tools": 0, "guardrails": 0, "agents": 1, "flows": 0, "blocks": 2}
    assert index["blocks"] == [
        {
            **prompt(content={"template": "Reply to {{ customer_name }}."}),
            "modulePath": "blocks/reply.json",
        },
        {**settings(), "modulePath": "blocks/style.json"},
    ]


def test_a_pack_without_blocks_has_no_blocks_key(make_pack: Callable[..., Path]) -> None:
    report, index = index_of(make_pack({"agents/support.py": AGENT}))
    assert "blocks" not in index
    assert report["counts"]["blocks"] == 0


def test_a_refused_block_is_a_file_error_and_the_rest_indexes(
    make_pack: Callable[..., Path],
) -> None:
    root = make_pack(
        {
            "agents/support.py": AGENT,
            "blocks/reply.json": as_json(prompt(content={"templateFile": "missing.liquid"})),
            "blocks/style.json": as_json(settings()),
        }
    )
    report, index = index_of(root)
    assert report["fileErrors"] == [
        {
            "code": "manifest-validation-failed",
            "message": 'blocks/reply.json: `content.templateFile` "missing.liquid" isn\'t a '
            "readable UTF-8 file (looked for blocks/missing.liquid)",
            "filePath": "blocks/reply.json",
        }
    ]
    assert [b["id"] for b in index["blocks"]] == ["acme.reply-style"]


def test_a_pack_of_blocks_alone_indexes(make_pack: Callable[..., Path]) -> None:
    _, index = index_of(make_pack({"blocks/style.json": as_json(settings())}))
    assert index["agents"] == []
    assert len(index["blocks"]) == 1


def test_the_discovery_table_moves_where_blocks_are_found(make_pack: Callable[..., Path]) -> None:
    files = {
        "agents/support.py": AGENT,
        "blocks/style.json": as_json(settings()),
        "kindgi/blocks/reply.json": as_json(prompt()),
    }
    _, by_default = index_of(make_pack(files))
    assert [b["id"] for b in by_default["blocks"]] == ["acme.reply-style"]
    _, moved = index_of(
        make_pack(
            files,
            pyproject="""
            [tool.kindgi.pack]
            id = "acme"
            version = "1.2.3"

            [tool.kindgi.discovery]
            blocks = "kindgi/blocks/**/*.json"
            """,
        )
    )
    assert [b["id"] for b in moved["blocks"]] == ["acme.reply-prompt"]
