# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A pack's data blocks: its prompts and settings, one JSON file each.

The Python counterpart of `@kindgi/handler-runtime`'s `pack-blocks.ts`,
with the same checks and messages. The files are the ones the blocks
discovery pattern matches (`blocks/**/*.json` by default). A file holds
the block as `kindgi blocks publish @<file>` takes it (`id`, `version`,
`kind`, `description`, `content`); a prompt may keep its template in a
file of its own (`content.templateFile`, relative to the block's file and
inside the blocks folder), read in here so the index holds the whole
block. Whether the template parses and the values satisfy their schema is
checked by the CLI and again by a deploy.
"""

from __future__ import annotations

import json
import posixpath
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from .config import code_units
from .discovery import glob_static_prefix, glob_to_regex

__all__ = ["PackBlocks", "blocks_folder", "read_pack_blocks"]

_ID = re.compile(r"^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
_BLOCK_FIELDS = ("id", "version", "kind", "description", "content")
_CONTENT_FIELDS = {
    "prompt": ("template", "templateFile", "parameters"),
    "settings": ("values", "schema"),
}
_SKIP_DIRS = frozenset({"node_modules"})


@dataclass(frozen=True)
class PackBlocks:
    blocks: list[dict[str, Any]]
    """The blocks, sorted by id."""
    files: list[str]
    """Every file read, relative to the pack root: block files and template files, sorted."""
    errors: list[dict[str, str]]
    """The files refused (`{"message", "filePath"}`), in discovery order."""


class _Refused(Exception):
    pass


def blocks_folder(pattern: str) -> str:
    """The folder a blocks pattern starts at, `""` for the pack root.

    Template files stay inside it.
    """
    return glob_static_prefix(pattern)


def read_pack_blocks(pack_dir: Path, pattern: str) -> PackBlocks:
    """Read the pack's blocks: each file the pattern matches, checked, its template file read in."""
    root = pack_dir.resolve()
    folder = blocks_folder(pattern)
    regex = glob_to_regex(pattern)
    found = sorted((rel for rel in _walk(root, folder) if regex.match(rel)), key=code_units)
    blocks: list[dict[str, Any]] = []
    files: list[str] = []
    errors: list[dict[str, str]] = []
    owners: dict[str, str] = {}
    for rel_path in found:
        try:
            block, templates = _read_block(root, folder, rel_path)
        except _Refused as refused:
            errors.append({"message": f"{rel_path}: {refused}", "filePath": rel_path})
            continue
        owner = owners.get(block["id"])
        if owner is not None:
            errors.append(
                {
                    "message": f"{rel_path}: duplicate block '{block['id']}' (also defined in "
                    f"{owner}); a pack holds one version of each block",
                    "filePath": rel_path,
                }
            )
            continue
        owners[block["id"]] = rel_path
        blocks.append(block)
        files.extend([rel_path, *templates])
    blocks.sort(key=lambda b: code_units(b["id"]))
    return PackBlocks(blocks=blocks, files=sorted(set(files), key=code_units), errors=errors)


def _read_block(root: Path, folder: str, rel_path: str) -> tuple[dict[str, Any], list[str]]:
    try:
        parsed = json.loads(
            (root / rel_path).read_bytes().decode("utf-8-sig"), parse_constant=_no_constant
        )
    except (UnicodeDecodeError, ValueError, OSError) as cause:
        raise _Refused(f"not a JSON file ({cause})") from None
    if not isinstance(parsed, dict):
        raise _Refused("a block file holds one JSON object: the block")
    parsed = cast("dict[str, Any]", parsed)
    unknown = [k for k in parsed if k not in _BLOCK_FIELDS]
    if unknown:
        raise _Refused(
            f'unknown field "{unknown[0]}" (a block has id, version, kind, description and content)'
        )
    block_id = parsed.get("id")
    version = parsed.get("version")
    kind = parsed.get("kind")
    description = parsed.get("description")
    content = parsed.get("content")
    if not isinstance(block_id, str) or not _ID.match(block_id):
        raise _Refused('`id` must be a dotted lowercase id, e.g. "acme.reply-prompt"')
    if not isinstance(version, str) or not _VERSION.match(version):
        raise _Refused('`version` must be major.minor.patch, e.g. "1.0.0"')
    if kind not in ("prompt", "settings"):
        raise _Refused('`kind` must be "prompt" or "settings"')
    if "description" in parsed and not isinstance(description, str):
        raise _Refused("`description` must be a string")
    if not isinstance(content, dict):
        raise _Refused("`content` must be an object")
    content = cast("dict[str, Any]", content)
    allowed = _CONTENT_FIELDS[kind]
    unknown_content = [k for k in content if k not in allowed]
    if unknown_content:
        raise _Refused(
            f'unknown field "content.{unknown_content[0]}" (a {kind} block\'s content has '
            f"{', '.join(allowed)})"
        )

    templates: list[str] = []
    shown: dict[str, Any] = dict(content)
    if kind == "prompt":
        if "templateFile" in shown:
            template_file = shown.pop("templateFile")
            if "template" in shown:
                raise _Refused("give `content.template` or `content.templateFile`, not both")
            text, template_path = _read_template(root, folder, rel_path, template_file)
            templates.append(template_path)
            shown["template"] = text
        if not isinstance(shown.get("template"), str):
            raise _Refused(
                "a prompt needs `content.template` (a Liquid template) or `content.templateFile`"
            )
        if "parameters" in shown and not isinstance(shown["parameters"], list):
            raise _Refused("`content.parameters` must be an array")
    else:
        if not isinstance(content.get("values"), dict):
            raise _Refused("settings need `content.values`, an object")
        if "schema" in content and not isinstance(content["schema"], dict):
            raise _Refused("`content.schema` must be a JSON Schema object")

    block: dict[str, Any] = {"id": block_id, "version": version, "kind": kind}
    if "description" in parsed:
        block["description"] = description
    block["content"] = shown
    block["modulePath"] = rel_path
    return block, templates


def _read_template(root: Path, folder: str, block_path: str, template_file: Any) -> tuple[str, str]:
    """A prompt's template file: relative to its block's file, inside the blocks folder, UTF-8."""
    if not isinstance(template_file, str) or template_file == "":
        raise _Refused("`content.templateFile` must be a path relative to the block file")
    if template_file.startswith("/") or "\\" in template_file:
        raise _Refused(
            f'`content.templateFile` "{template_file}" must be a path relative to the block '
            "file, with forward slashes"
        )
    rel_path = posixpath.normpath(posixpath.join(posixpath.dirname(block_path), template_file))
    inside = (
        rel_path != ".." and not rel_path.startswith("../")
        if folder == ""
        else rel_path.startswith(f"{folder}/")
    )
    if not inside:
        where = "the pack" if folder == "" else f"the blocks folder ({folder}/)"
        raise _Refused(
            f'`content.templateFile` "{template_file}" is outside {where}; '
            "keep a block's template next to it"
        )
    path = root / rel_path
    # Lexically inside isn't inside through a link: a link could put any file of the
    # machine's into the index, and so into a deploy.
    if path.is_symlink():
        raise _Refused(
            f'`content.templateFile` "{template_file}" is a symbolic link; '
            "keep the template itself in the blocks folder"
        )
    try:
        # A leading byte order mark isn't the template's, as the TypeScript and Java
        # indexers read it.
        return path.read_bytes().decode("utf-8-sig"), rel_path
    except (OSError, UnicodeDecodeError):
        raise _Refused(
            f'`content.templateFile` "{template_file}" isn\'t a readable UTF-8 file '
            f"(looked for {rel_path})"
        ) from None


def _no_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def _walk(root: Path, rel: str) -> Iterator[str]:
    """Files under `rel`, `/`-separated from the pack root.

    `node_modules` and dot folders are skipped.
    """
    start = root / rel if rel else root
    if not start.is_dir():
        return
    for entry in sorted(start.iterdir(), key=lambda p: p.name):
        # A link is never followed, as the TypeScript indexer's walk doesn't.
        if entry.name in _SKIP_DIRS or entry.name.startswith(".") or entry.is_symlink():
            continue
        child = entry.name if rel == "" else f"{rel}/{entry.name}"
        if entry.is_dir():
            yield from _walk(root, child)
        elif entry.is_file():
            yield child
