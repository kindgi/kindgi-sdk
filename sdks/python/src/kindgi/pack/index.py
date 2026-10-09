# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The indexer — a Python pack's `index.json`.

    python -m kindgi.pack index --pack-dir . [--output dist/index.json]
                                [--artifact-version 20261001.1] [--published-at <iso>] [--json]

The Python counterpart of `kindgi-index`: reads `[tool.kindgi]`, discovers
the files under `tools/`, `guardrails/`, `agents/`, `flows/` (or the
configured globs), imports each one, collects the primitives it defines,
and writes the index (`@kindgi/specs/pack-index.schema.json`) atomically.
Byte-deterministic: same source and pinned `--artifact-version` /
`--published-at`, same bytes.

Fails loud, but per file: a module that fails to import, defines a
primitive of the wrong kind for its folder, or defines nothing is a file
error, and the rest of the pack still indexes. A helper module inside a
discovery folder starts with `_` (`tools/_db.py`) and is skipped.
"""

from __future__ import annotations

import json
import os
import traceback
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any, cast

from .._json import stable_dumps
from .._schema import SchemaValidator, wire_schema
from .config import ConfigError, PackConfig, PrimitiveKind, code_units, load_config
from .define import Agent, Flow, Guardrail, Primitive, Tool
from .discovery import discover
from .loader import import_pack_module, mount_pack, primitives_of

__all__ = ["INDEX_ENVELOPE_VERSION", "KERNEL_PAYLOAD_VERSION", "run_indexer"]

INDEX_ENVELOPE_VERSION = 1
KERNEL_PAYLOAD_VERSION = 1

_FOLDERS: Mapping[str, PrimitiveKind] = {
    "tools": "tool",
    "guardrails": "guardrail",
    "agents": "agent",
    "flows": "flow",
}

Outcome = dict[str, Any]


def _spec(name: str) -> SchemaValidator:
    text = resources.files("kindgi._specs").joinpath(f"{name}.schema.json").read_text("utf-8")
    return SchemaValidator(json.loads(text))


def run_indexer(
    pack_dir: Path,
    *,
    config_path: Path | None = None,
    output_path: Path | None = None,
    artifact_version: str | None = None,
    published_at: str | None = None,
) -> Outcome:
    """Index the pack. Never raises.

    `{"kind": "ok", "value": report}` or `{"kind": "err", "error": {code, message, …}}`.
    """
    pack_dir = pack_dir.resolve()
    try:
        config = load_config(pack_dir, config_path)
    except ConfigError as error:
        return _err(
            error.code,
            error.message,
            file_path=str(error.path) if error.path else None,
            field=error.field,
        )

    discovered = _discover(pack_dir, config)
    if not discovered:
        return _err(
            "discovery-empty",
            f"Indexer discovered zero files under {pack_dir}. "
            "Check the [tool.kindgi.discovery] patterns.",
        )

    mount_pack(pack_dir)
    entries: dict[PrimitiveKind, list[dict[str, Any]]] = {
        "tool": [],
        "guardrail": [],
        "agent": [],
        "flow": [],
    }
    # Per (kind, id), the versions defined so far and their files.
    owners: dict[tuple[PrimitiveKind, str], dict[str | None, str]] = {}
    file_errors: list[dict[str, Any]] = []
    flow_spec = _spec("flow")

    for rel_path, expected in discovered:
        try:
            module = import_pack_module(rel_path)
        except BaseException as cause:  # an import may raise anything, SystemExit included
            if isinstance(cause, KeyboardInterrupt):
                raise
            file_errors.append(
                _file_error(
                    "file-import-failed",
                    f"Failed to import {rel_path}: {type(cause).__name__}: {cause}",
                    rel_path,
                    cause=_serialize_cause(cause),
                )
            )
            continue
        primitives = primitives_of(module)
        if not primitives:
            if Path(rel_path).name.startswith("_"):
                continue
            file_errors.append(
                _file_error(
                    "no-primitives",
                    f"File {rel_path} defines no tool, guardrail, agent or flow at module level "
                    "(a helper module's name starts with `_`)",
                    rel_path,
                )
            )
            continue
        for primitive in primitives:
            kind = _kind_of(primitive)
            if expected is not None and kind != expected:
                file_errors.append(
                    _file_error(
                        "kind-mismatch",
                        f"File {rel_path} is under the default folder for kind '{expected}' "
                        f"but defines a '{kind}' ({primitive.id})",
                        rel_path,
                    )
                )
                continue
            built = _build(primitive, kind, rel_path, config, flow_spec)
            if "error" in built:
                file_errors.append(built["error"])
                continue
            # Several versions of one primitive may sit side by side (an agent
            # version pins the one it uses), keyed by the version the index
            # records (a tool without its own takes the pack's). The same
            # version twice is an error, and so is an entry with no version
            # next to any other of its id: nothing would tell them apart.
            version = built["entry"].get("version")
            defined = owners.setdefault((kind, primitive.id), {})
            owner = (
                next(iter(defined.values()), None)
                if version is None or None in defined
                else defined.get(version)
            )
            if owner is not None:
                what = f"{kind} '{primitive.id}'" + (f" version {version}" if version else "")
                file_errors.append(
                    _manifest_error(rel_path, f"duplicate {what} (also defined in {owner})")
                )
                continue
            defined[version] = rel_path
            entries[kind].append(built["entry"])

    output = (output_path or pack_dir / "index.json").resolve()
    version = artifact_version or _auto_artifact_version(output)
    when = published_at or datetime.now(UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )
    index: dict[str, Any] = {
        "v": INDEX_ENVELOPE_VERSION,
        "packId": config.id,
        "packVersion": config.version,
        "artifactVersion": version,
        "publishedAt": when,
        "tools": _sorted(entries["tool"]),
        "guardrails": _sorted(entries["guardrail"]),
        "agents": _sorted(entries["agent"]),
        "flows": _sorted(entries["flow"]),
    }
    if config.env is not None:
        index["env"] = {
            "optional": list(config.env.optional),
            "required": list(config.env.required),
        }
    issues = _spec("pack-index").issues(index)
    if issues:
        first = issues[0]
        return _err(
            "manifest-validation-failed",
            "The index does not match pack-index.schema.json at "
            f"{first['instancePath'] or '/'}: {first['message']}",
        )
    try:
        _atomic_write(output, stable_dumps(index) + "\n")
    except OSError as cause:
        return _err(
            "output-write-failed", f"Failed to write {output}: {cause}", file_path=str(output)
        )
    return {
        "kind": "ok",
        "value": {
            "packId": config.id,
            "packVersion": config.version,
            "artifactVersion": version,
            "publishedAt": when,
            "counts": {kind_plural: len(entries[kind]) for kind_plural, kind in _FOLDERS.items()},
            "outputPath": str(output),
            "fileErrors": file_errors,
        },
    }


def _discover(pack_dir: Path, config: PackConfig) -> list[tuple[str, PrimitiveKind | None]]:
    seen: dict[str, PrimitiveKind | None] = {}
    for folder, kind in _FOLDERS.items():
        pattern = config.discovery.get(folder, "")
        for rel in discover(pack_dir, pattern):
            if rel in seen:
                continue
            seen[rel] = kind if rel.split("/")[0] == folder else None
    return sorted(seen.items())


def _kind_of(primitive: Primitive) -> PrimitiveKind:
    if isinstance(primitive, Tool):
        return "tool"
    if isinstance(primitive, Guardrail):
        return "guardrail"
    if isinstance(primitive, Agent):
        return "agent"
    return "flow"


def _build(
    primitive: Primitive,
    kind: PrimitiveKind,
    rel_path: str,
    config: PackConfig,
    flow_spec: SchemaValidator,
) -> dict[str, Any]:
    if isinstance(primitive, Tool):
        return {"entry": _tool_entry(primitive, rel_path, config)}
    if isinstance(primitive, Guardrail):
        return {"entry": _guardrail_entry(primitive, rel_path)}
    if isinstance(primitive, Agent):
        try:
            return {"entry": _agent_entry(primitive, rel_path, config)}
        except ValueError as cause:
            return {"error": _manifest_error(rel_path, str(cause))}
    return _flow_entry(primitive, rel_path, flow_spec)


def _tool_entry(tool: Tool[..., Any], rel_path: str, config: PackConfig) -> dict[str, Any]:
    return _compact(
        {
            "id": tool.id,
            "description": tool.description,
            "version": tool.version or config.version,
            "input": tool.input_schema,
            "output": tool.output_schema,
            "effects": [dict(e) for e in tool.effects],
            "mutating": tool.mutating,
            "needs": None if tool.needs is None else [dict(n) for n in tool.needs],
            "needsSpec": _dict(tool.needs_spec),
            "sandbox": tool.sandbox,
            "limits": _dict(tool.limits),
            "network": _dict(tool.network),
            "spec": _dict(tool.spec),
            "modulePath": rel_path,
        }
    )


def _guardrail_entry(guardrail: Guardrail, rel_path: str) -> dict[str, Any]:
    return _compact(
        {
            "id": guardrail.id,
            "name": guardrail.name,
            "kind": guardrail.kind,
            "action": dict(guardrail.action),
            "severity": guardrail.severity,
            "scope": _dict(guardrail.scope),
            "checkModulePath": rel_path,
            "checkId": guardrail.check_id,
            "config": _dict(guardrail.config),
            "configSchema": guardrail.config_schema,
            "sandbox": guardrail.sandbox,
            "limits": _dict(guardrail.limits),
            "network": _dict(guardrail.network),
        }
    )


def _agent_entry(agent: Agent, rel_path: str, config: PackConfig) -> dict[str, Any]:
    tools: list[dict[str, Any]] = []
    # Typed `Tool | Mapping`, but a pack can pass anything (a bare id string).
    for ref in cast("Sequence[object]", agent.tools):
        if isinstance(ref, Tool):
            pinned = cast("Tool[..., Any]", ref)
            tools.append({"id": pinned.id, "version": pinned.version or config.version})
            continue
        mapping = cast("Mapping[str, Any]", ref) if isinstance(ref, Mapping) else None
        if (
            mapping is None
            or not isinstance(mapping.get("id"), str)
            or not isinstance(mapping.get("version"), str)
        ):
            raise ValueError(
                f"agent '{agent.id}': each tool is a Tool or an {{id, version}} ref, got {ref!r}"
            )
        tools.append({"id": mapping["id"], "version": mapping["version"]})
    guardrails = [g.id if isinstance(g, Guardrail) else g for g in agent.guardrails]
    output = agent.output
    if output is not None and not (isinstance(output, Mapping) and "schema" in output):
        output = {"schema": wire_schema(output, "validation")}
    elif isinstance(output, Mapping):
        out_map = cast("Mapping[str, Any]", output)
        output = {**out_map, "schema": wire_schema(out_map["schema"], "validation")}
    return _compact(
        {
            "id": agent.id,
            "version": agent.version,
            "name": agent.name,
            "instructions": (
                agent.instructions
                if isinstance(agent.instructions, str)
                else dict(agent.instructions)
            ),
            "capabilities": [dict(c) for c in agent.capabilities],
            "tools": tools,
            "retrieval": [dict(r) for r in agent.retrieval],
            "guardrails": guardrails,
            "parameters": [dict(p) for p in agent.parameters],
            "budget": _dict(agent.budget),
            "preferredProvider": agent.preferred_provider,
            "preferredModel": agent.preferred_model,
            "description": agent.description,
            "tags": None if agent.tags is None else list(agent.tags),
            "conversationPolicy": _dict(agent.conversation_policy),
            "output": output,
            "toolErrors": _dict(agent.tool_errors),
            "memory": _dict(agent.memory),
            "settings": [dict(s) for s in agent.settings],
            "modelSettings": _dict(agent.model_settings),
            "modulePath": rel_path,
        }
    )


def _flow_entry(flow: Flow, rel_path: str, flow_spec: SchemaValidator) -> dict[str, Any]:
    declared = _compact(
        {
            "id": flow.id,
            "version": flow.version,
            "name": flow.name,
            "description": flow.description,
            "nodes": [_node(n) for n in flow.nodes],
            "edges": [dict(e) for e in flow.edges],
            "maxParallelism": flow.max_parallelism,
            "metadata": _dict(flow.metadata),
            "output": _dict(flow.output),
        }
    )
    issue = flow_spec.explain(declared)
    if issue is not None:
        where = issue["instancePath"] or "/"
        unexpected = issue["params"].get("additionalProperty")
        detail = f" ('{unexpected}')" if unexpected is not None else ""
        return {
            "error": _manifest_error(
                rel_path, f"flow '{flow.id}' is invalid at {where}: {issue['message']}{detail}"
            )
        }
    return {
        "entry": {
            **declared,
            "kernelPayloadVersion": KERNEL_PAYLOAD_VERSION,
            "modulePath": rel_path,
        }
    }


def _node(node: Mapping[str, Any]) -> dict[str, Any]:
    """The node as data: a `Tool` / `Agent` / `Flow` ref becomes its id, in loop bodies and
    fanout branches too."""
    out = dict(node)
    if "ref" in out:
        out["ref"] = _ref_id(out["ref"])
    body = out.get("body")
    if isinstance(body, Mapping):
        body_map = cast("Mapping[str, Any]", body)
        nodes = cast("Sequence[Mapping[str, Any]]", body_map.get("nodes", []))
        out["body"] = {**body_map, "nodes": [_node(n) for n in nodes]}
    branches = out.get("branches")
    if isinstance(branches, list):
        out["branches"] = [
            {**b, "handler": _ref_id(b.get("handler"))} if "handler" in b else dict(b)
            for b in cast("list[Mapping[str, Any]]", branches)
        ]
    return out


def _ref_id(ref: Any) -> Any:
    return ref.id if isinstance(ref, (Tool, Agent, Flow)) else ref


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compact(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in entry.items() if value is not None}


def _dict(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    return None if value is None else dict(value)


def _sorted(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(entries, key=lambda e: code_units(str(e["id"])))


def _err(
    code: str, message: str, *, file_path: str | None = None, field: str | None = None
) -> Outcome:
    return {
        "kind": "err",
        "error": _compact(
            {"code": code, "message": message, "filePath": file_path, "field": field}
        ),
    }


def _file_error(code: str, message: str, rel_path: str, **extra: Any) -> dict[str, Any]:
    return _compact({"code": code, "message": message, "filePath": rel_path, **extra})


def _manifest_error(rel_path: str, message: str) -> dict[str, Any]:
    return _file_error("manifest-validation-failed", f"{rel_path}: {message}", rel_path)


def _serialize_cause(cause: BaseException) -> dict[str, Any]:
    return {
        "name": type(cause).__name__,
        "message": str(cause),
        "stack": "".join(traceback.format_exception(cause)),
    }


def _auto_artifact_version(output: Path) -> str:
    today = datetime.now(UTC).strftime("%Y%m%d")
    n = 1
    try:
        previous = json.loads(output.read_text("utf-8")).get("artifactVersion")
        day, _, count = str(previous).partition(".")
        if day == today and count.isdigit():
            n = int(count) + 1
    except (OSError, ValueError, AttributeError):
        pass
    return f"{today}.{n}"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        f"{path.name}.tmp-{os.getpid()}-{int(datetime.now(UTC).timestamp() * 1000)}"
    )
    try:
        tmp.write_text(text, "utf-8")
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise
