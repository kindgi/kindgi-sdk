# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool's ``needsSpec``: the typed context it declares it needs.

Two checks the SDK makes, matching the TypeScript ``@kindgi/tools`` and Java kindgi-pack:
:func:`needs_spec_problem` is the definition-time check (each ``env`` / ``secrets`` schema must
compile as the runtime compiles it; an ``env`` default must be a string), and :func:`resolve_env`
is the test-context fill that :meth:`kindgi.pack.ToolContext.for_test` runs. Only ``env`` and
``secrets`` carry schemas to check; ``config``, ``capabilities`` and ``bindings`` are carried, not
validated here.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from jsonschema import SchemaError

from .._schema import SchemaValidator, strict_schema_problem


def needs_spec_problem(needs_spec: Mapping[str, Any]) -> str | None:
    """The problem with a tool's ``needsSpec`` at definition time, or ``None``.

    A schema under ``secrets`` or ``env`` that doesn't compile, or an ``env`` default that isn't a
    string (``None`` included: the index would carry it as ``null``). The slots are checked
    ``secrets`` then ``env``, their entries in order, first wins.
    """
    for slot in ("secrets", "env"):
        declared = needs_spec.get(slot)
        if not isinstance(declared, Mapping):
            continue
        for name, entry in cast("Mapping[str, Any]", declared).items():
            if not isinstance(entry, Mapping):
                continue
            schema = cast("Mapping[str, Any]", entry)
            why = _compile_problem(schema)
            if why is not None:
                return f"the schema for needsSpec.{slot}.{name} doesn't compile: {why}"
            if slot == "env" and "default" in schema and not isinstance(schema["default"], str):
                return f"needsSpec.env.{name}'s default must be a string: env values are strings."
    return None


def resolve_env(
    tool_id: str, needs_spec: Mapping[str, Any] | None, given: Mapping[str, str]
) -> dict[str, Any]:
    """The ``env`` a test should pass a handler: every name the tool declares under
    ``needsSpec.env``, from ``given`` or the schema's string default, each checked against its
    schema. A name the tool doesn't declare is dropped; a missing value fails before any check.
    """
    declared_any = needs_spec.get("env") if isinstance(needs_spec, Mapping) else None
    if not isinstance(declared_any, Mapping) or not declared_any:
        return {}
    declared = cast("Mapping[str, Any]", declared_any)
    resolved: dict[str, Any] = {}
    missing: list[str] = []
    for name, entry in declared.items():
        value: Any
        if name in given:
            value = given[name]
        elif isinstance(entry, Mapping):
            default = cast("Mapping[str, Any]", entry).get("default")
            value = default if isinstance(default, str) else None
        else:
            value = None
        if value is None:
            missing.append(name)
        else:
            resolved[name] = value
    if missing:
        raise ValueError(_missing_message(tool_id, missing))
    for name, value in resolved.items():
        entry = declared[name]
        if not isinstance(entry, Mapping):
            continue
        schema = cast("Mapping[str, Any]", entry)
        why = _compile_problem(schema)
        if why is not None:
            raise ValueError(
                f'tool "{tool_id}" declares env value "{name}" '
                f"with a schema that doesn't compile: {why}"
            )
        issues = SchemaValidator(schema).issues(value)
        if issues:
            raise ValueError(
                f'env value "{name}" is "{value}", '
                f'which doesn\'t match the schema tool "{tool_id}" '
                f"declares for it: {_constraints_broken(issues)}"
            )
    return resolved


def _compile_problem(schema: Mapping[str, Any]) -> str | None:
    """Why the runtime's compile refuses ``schema``: not valid Draft 2020-12, or a keyword or a
    format it doesn't know. ``None`` when it compiles."""
    try:
        SchemaValidator(schema)
    except SchemaError as exc:
        return getattr(exc, "message", None) or str(exc)
    return strict_schema_problem(schema)


def _missing_message(tool_id: str, missing: list[str]) -> str:
    one = len(missing) == 1
    which = ("env value " if one else "env values ") + ", ".join(f'"{name}"' for name in missing)
    return (
        f"tool \"{tool_id}\" needs {which}: the context's `env` doesn't set "
        f"{'it' if one else 'them'}, and "
        f"{'its schema has' if one else 'their schemas have'} no default"
    )


def _constraints_broken(issues: list[Any]) -> str:
    messages = [issue["message"] for issue in issues if issue.get("message")]
    return "; ".join(messages) if messages else "it does not validate"
