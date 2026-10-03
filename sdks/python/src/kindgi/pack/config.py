# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A Python pack's config: the `[tool.kindgi]` table of its `pyproject.toml`.

Same keys as `kindgi.config.ts` (`pack.id`, `pack.version`, `discovery`,
`dev`, `environments`, …), so one reference covers both languages:

    [tool.kindgi.pack]
    id = "acme.ledger"
    version = "1.0.0"

    [tool.kindgi.discovery]          # optional; these are the defaults
    tools = "tools/**/*.py"
    guardrails = "guardrails/**/*.py"
    agents = "agents/**/*.py"
    flows = "flows/**/*.py"

    [tool.kindgi.env]                # optional; the process env the pack service needs
    required = ["DATABASE_URL"]      # unset or "" → the service isn't ready
    optional = ["SENTRY_DSN"]        # read when set
"""

from __future__ import annotations

import json
import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

__all__ = [
    "DEFAULT_DISCOVERY",
    "ConfigError",
    "PackConfig",
    "PackEnv",
    "PrimitiveKind",
    "load_config",
]

PrimitiveKind = Literal["tool", "guardrail", "agent", "flow"]

CONFIG_FILENAME = "pyproject.toml"

DEFAULT_DISCOVERY: Mapping[str, str] = {
    "tools": "tools/**/*.py",
    "guardrails": "guardrails/**/*.py",
    "agents": "agents/**/*.py",
    "flows": "flows/**/*.py",
}


ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
"""A process environment variable name, matched in full."""

RESERVED_ENV_PREFIX = "KINDGI_"
"""The prefix of the names that configure Kindgi itself; never a pack's."""


@dataclass(frozen=True)
class PackEnv:
    """`[tool.kindgi.env]`: the process env the pack service needs (`required`)
    or reads when set (`optional`), each sorted (code-unit order)."""

    required: tuple[str, ...]
    optional: tuple[str, ...]


@dataclass(frozen=True)
class PackConfig:
    path: Path
    id: str
    version: str
    description: str | None
    discovery: Mapping[str, str]
    raw: Mapping[str, Any] = field(repr=False)
    env: PackEnv | None = None
    """`[tool.kindgi.env]`; `None` when it declares no name."""


class ConfigError(Exception):
    def __init__(
        self,
        code: Literal["config-not-found", "config-parse-failed", "config-invalid"],
        message: str,
        path: Path | None = None,
        *,
        field: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path
        self.field = field
        """The config key at fault, when one is (`env`)."""


def load_config(pack_dir: Path, config_path: Path | None = None) -> PackConfig:
    """Read and minimally check `[tool.kindgi]`. Raises `ConfigError`."""
    path = (config_path or pack_dir / CONFIG_FILENAME).resolve()
    if not path.is_file():
        raise ConfigError("config-not-found", f"No {CONFIG_FILENAME} found at pack root {pack_dir}")
    try:
        document = tomllib.loads(path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as cause:
        raise ConfigError("config-parse-failed", f"Failed to read {path}: {cause}", path) from cause
    tool_table = document.get("tool")
    kindgi = (
        cast("dict[str, Any]", tool_table).get("kindgi") if isinstance(tool_table, dict) else None
    )
    if not isinstance(kindgi, dict):
        raise ConfigError("config-not-found", f"{path} has no [tool.kindgi] table", path)
    raw = cast("dict[str, Any]", kindgi)
    pack = raw.get("pack")
    if not isinstance(pack, dict):
        raise ConfigError(
            "config-parse-failed",
            f"Config file {path}: 'pack' field is missing or not an object",
            path,
        )
    pack_table = cast("dict[str, Any]", pack)
    pack_id = pack_table.get("id")
    if not isinstance(pack_id, str) or pack_id == "":
        raise ConfigError(
            "config-parse-failed",
            f"Config file {path}: 'pack.id' is missing or not a non-empty string",
            path,
        )
    version = pack_table.get("version")
    if not isinstance(version, str) or version == "":
        raise ConfigError(
            "config-parse-failed",
            f"Config file {path}: 'pack.version' is missing or not a non-empty string",
            path,
        )
    discovery = raw.get("discovery", {})
    if not isinstance(discovery, dict) or not all(
        isinstance(v, str) for v in cast("dict[str, Any]", discovery).values()
    ):
        raise ConfigError(
            "config-parse-failed",
            f"Config file {path}: 'discovery' must map kinds to glob strings",
            path,
        )
    description = pack_table.get("description")
    return PackConfig(
        path=path,
        id=pack_id,
        version=version,
        description=description if isinstance(description, str) else None,
        discovery={**DEFAULT_DISCOVERY, **cast("dict[str, str]", discovery)},
        env=_env(raw.get("env"), path),
        raw=raw,
    )


def _env(table: Any, path: Path) -> PackEnv | None:
    """`[tool.kindgi.env]`, checked and sorted. Raises `ConfigError("config-invalid")`.

    The rules and messages of `@kindgi/handler-runtime`'s `resolvePackEnv`.
    """
    if table is None:
        return None

    def invalid(message: str) -> ConfigError:
        return ConfigError("config-invalid", f"Config file {path}: {message}", path, field="env")

    if not isinstance(table, dict):
        raise invalid("`env` must be a table: required = [...], optional = [...]")
    entries = cast("dict[str, Any]", table)
    unknown = [key for key in entries if key not in ("required", "optional")]
    if unknown:
        listed = ", ".join(f"`{key}`" for key in unknown)
        raise invalid(f"`env` takes only `required` and `optional`, not {listed}")
    problems: list[str] = []
    seen: dict[str, str] = {}
    lists: dict[str, list[str]] = {"required": [], "optional": []}
    for key in ("required", "optional"):
        names = entries.get(key)
        if names is None:
            continue
        if not isinstance(names, list) or not all(
            isinstance(n, str) for n in cast("list[Any]", names)
        ):
            problems.append(f"`env.{key}` must be a list of names")
            continue
        for name in cast("list[str]", names):
            if not ENV_NAME.fullmatch(name):
                problems.append(
                    f"{json.dumps(name)} in `env.{key}` isn't an environment variable name"
                )
            elif name.startswith(RESERVED_ENV_PREFIX):
                problems.append(
                    f"{json.dumps(name)} in `env.{key}`: "
                    f"`{RESERVED_ENV_PREFIX}*` names configure Kindgi, not the pack"
                )
            elif name in seen:
                problems.append(
                    f"{json.dumps(name)} is listed twice in `env.{key}`"
                    if seen[name] == key
                    else f"{json.dumps(name)} is in both `env.required` and `env.optional`"
                )
            else:
                seen[name] = key
                lists[key].append(name)
    if problems:
        raise invalid("; ".join(problems))
    if not seen:
        return None
    return PackEnv(
        required=tuple(sorted(lists["required"], key=code_units)),
        optional=tuple(sorted(lists["optional"], key=code_units)),
    )


def code_units(text: str) -> bytes:
    """The sort key of JavaScript's default sort (UTF-16 code units), so both indexers agree."""
    return text.encode("utf-16-be", "surrogatepass")
