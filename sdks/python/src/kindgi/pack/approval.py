# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool's ``approval``: how an approval of a call to it reads, checked where it's declared.

The same rules ``defineTool`` applies: each ``{field}`` placeholder names a required top-level
field of the tool's input whose schema is a string, a number, an integer or a boolean (or an
enum of those); a brace that isn't part of a placeholder is refused; ``about.id`` holds at least
one placeholder. The runtime fills the placeholders from each call's arguments.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from functools import cache
from importlib import resources
from typing import Any, cast

from .._schema import SchemaValidator

__all__ = ["approval_problem", "approval_wire"]

_PLACEHOLDER = re.compile(r"\{(\w+)\}")
"""A ``{field}`` placeholder, as an HTTP tool's ``url_template`` names one."""

_SCALAR_TYPES = frozenset({"string", "number", "integer", "boolean"})


@cache
def _approval_validator() -> SchemaValidator:
    """``approval`` in the vendored ``tool.schema.json``, as ``defineTool`` checks it."""
    text = resources.files("kindgi._specs").joinpath("tool.schema.json").read_text("utf-8")
    return SchemaValidator(json.loads(text)["properties"]["approval"])


def approval_wire(approval: Mapping[str, Any]) -> dict[str, Any]:
    """The approval as the pack's index carries it: plain dicts, ``about`` too."""
    wire = dict(approval)
    about = wire.get("about")
    if isinstance(about, Mapping):
        wire["about"] = dict(cast("Mapping[str, Any]", about))
    return wire


def _is_scalar_value(value: Any) -> bool:
    return isinstance(value, (str, int, float, bool))


def _is_scalar_schema(schema: Any) -> bool:
    if not isinstance(schema, Mapping):
        return False
    node = cast("Mapping[str, Any]", schema)
    enum = node.get("enum")
    if isinstance(enum, list):
        values = cast("list[Any]", enum)
        return len(values) > 0 and all(_is_scalar_value(v) for v in values)
    if "const" in node:
        return _is_scalar_value(node["const"])
    declared = node.get("type")
    types = cast("list[Any]", declared) if isinstance(declared, list) else [declared]
    return len(types) > 0 and all(t in _SCALAR_TYPES for t in types)


def _field_problem(name: str, properties: Mapping[str, Any], required: set[Any]) -> str | None:
    if name not in properties:
        return f"names {{{name}}}, which isn't a field of the input"
    if name not in required:
        return f"names {{{name}}}, an optional field of the input: a call may leave it out"
    if not _is_scalar_schema(properties[name]):
        return (
            f"names {{{name}}}, a field of the input that isn't a string, a number, "
            "an integer or a boolean"
        )
    return None


def _text_problem(
    path: str, text: str, properties: Mapping[str, Any], required: set[Any]
) -> str | None:
    if re.search(r"[{}]", _PLACEHOLDER.sub("", text)):
        return "has a brace that isn't part of a {field} placeholder"
    names = _PLACEHOLDER.findall(text)
    if path == "approval.about.id" and not names:
        return "must hold at least one {field} placeholder"
    for name in names:
        problem = _field_problem(name, properties, required)
        if problem is not None:
            return problem
    return None


def approval_problem(approval: Mapping[str, Any], input_schema: Mapping[str, Any]) -> str | None:
    """The problem with a tool's ``approval`` at definition time, or ``None``.

    Its shape first (``tool.schema.json``), then each text in turn (``title``, ``summary``,
    ``about.id``), first wins, each named by its path.
    """
    issues = _approval_validator().issues(approval_wire(approval))
    if issues:
        found = "; ".join(f"{i['instancePath'] or '/'} {i['message']}" for i in issues)
        return f"not a valid approval: {found}"
    declared = input_schema.get("properties")
    properties = cast("Mapping[str, Any]", declared) if isinstance(declared, Mapping) else {}
    listed = input_schema.get("required")
    required = set(cast("list[Any]", listed)) if isinstance(listed, list) else set()
    texts: list[tuple[str, str]] = [("approval.title", str(approval["title"]))]
    if "summary" in approval:
        texts.append(("approval.summary", str(approval["summary"])))
    about = approval.get("about")
    if isinstance(about, Mapping):
        texts.append(("approval.about.id", str(cast("Mapping[str, Any]", about)["id"])))
    for path, text in texts:
        problem = _text_problem(path, text, properties, required)
        if problem is not None:
            return f"{path} {problem}"
    return None
