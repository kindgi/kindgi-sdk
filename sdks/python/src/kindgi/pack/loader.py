# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Importing a pack's modules.

A pack's files are imported as submodules of one synthetic package,
`_kindgi_pack`, whose path is the pack root: `tools/ledger.py` is
`_kindgi_pack.tools.ledger`. So relative imports work inside the pack
(`from ._shared import pool`), and a pack folder named like an installed
distribution (`agents/`, `tools/`) never shadows it or is shadowed by it.
The pack root also goes on `sys.path`, so the pack's own top-level packages
import by their names.
"""

from __future__ import annotations

import importlib
import importlib.machinery
import sys
import types
from pathlib import Path, PurePosixPath
from typing import cast

from .define import Agent, Flow, Guardrail, Primitive, Tool

__all__ = ["PACK_PACKAGE", "import_pack_module", "module_name", "mount_pack", "primitives_of"]

PACK_PACKAGE = "_kindgi_pack"


def mount_pack(root: Path) -> None:
    """Make `root` the pack package's path. A process holds one pack: mounting
    another root first drops every module of the previous one."""
    root_str = str(root.resolve())
    existing = sys.modules.get(PACK_PACKAGE)
    if existing is not None:
        previous = list(getattr(existing, "__path__", []))
        if previous == [root_str]:
            return
        for name in [
            n for n in sys.modules if n == PACK_PACKAGE or n.startswith(PACK_PACKAGE + ".")
        ]:
            del sys.modules[name]
        for path in previous:
            if path in sys.path:
                sys.path.remove(path)
        importlib.invalidate_caches()
    spec = importlib.machinery.ModuleSpec(PACK_PACKAGE, None, is_package=True)
    spec.submodule_search_locations = [root_str]
    package = types.ModuleType(PACK_PACKAGE)
    package.__spec__ = spec
    package.__path__ = [root_str]
    package.__package__ = PACK_PACKAGE
    sys.modules[PACK_PACKAGE] = package
    if root_str not in sys.path:
        sys.path.insert(0, root_str)


def module_name(rel_path: str) -> str:
    """`tools/ledger.py` → `_kindgi_pack.tools.ledger`.

    A package's `__init__.py` names the package itself.
    """
    path = PurePosixPath(rel_path)
    if path.suffix != ".py" or path.is_absolute() or ".." in path.parts:
        raise ValueError(f"not a pack-relative Python module path: {rel_path}")
    parts = list(path.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join([PACK_PACKAGE, *parts])


def import_pack_module(rel_path: str) -> types.ModuleType:
    return importlib.import_module(module_name(rel_path))


def primitives_of(module: types.ModuleType) -> list[Primitive]:
    """The primitives `module` defines at module level, in definition order (imports skipped)."""
    found: list[Primitive] = []
    seen: set[int] = set()
    for value in cast("dict[str, object]", vars(module)).values():
        if not isinstance(value, (Tool, Guardrail, Agent, Flow)):
            continue
        primitive = cast("Primitive", value)
        if primitive.module == module.__name__ and id(primitive) not in seen:
            seen.add(id(primitive))
            found.append(primitive)
    return found
