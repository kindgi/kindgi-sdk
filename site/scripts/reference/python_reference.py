# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.
"""The Python SDK reference, from the `kindgi` package itself.

Run in the SDK's environment (`generate-reference.mjs` does):

    uv run --project sdks/python --frozen python site/scripts/reference/python_reference.py <docs dir>

Writes `reference/python/`: the authoring API (`kindgi`), `kindgi.webhooks`,
the client (`Kindgi`, `AsyncKindgi`, errors, paging), one page per client
resource (`client.runs`, …), the API models by first letter, and
`python -m kindgi.pack`. Signatures and docstrings come from the code, so
the pages match the release they're built from.
"""

from __future__ import annotations

import dataclasses
import inspect
import json
import re
import shutil
import sys
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import kindgi
import kindgi.client as client_module
import kindgi.webhooks as webhooks_module
from kindgi.client import _models, _resources
from kindgi.pack import index as pack_index
from kindgi.pack import serve as pack_serve

OUT = "reference/python"

# ---- text ---------------------------------------------------------------------

_CODE = re.compile(r"(```.*?```|`[^`\n]*`)", re.S)


def prose(text: str | None) -> str:
    """Docstring text as markdown: `<` and `>` escaped outside code."""
    if not text:
        return ""
    parts = _CODE.split(text)
    return "".join(
        part if i % 2 else part.replace("<", "&lt;").replace(">", "&gt;")
        for i, part in enumerate(parts)
    )


def annotation(value: Any) -> str:
    if value is inspect.Parameter.empty:
        return ""
    text = value if isinstance(value, str) else inspect.formatannotation(value)
    for prefix in ("_models.", "typing.", "pydantic.types.", "pydantic.networks.", "datetime."):
        text = text.replace(prefix, "")
    return text


def signature(
    name: str, obj: Callable[..., Any], *, skip_self: bool = False, returns: bool = True
) -> str:
    try:
        sig = inspect.signature(obj)
    except (TypeError, ValueError):
        return f"{name}(...)"
    params = []
    star_done = False
    for param in sig.parameters.values():
        if skip_self and param.name in ("self", "cls"):
            continue
        if param.kind is inspect.Parameter.POSITIONAL_ONLY:
            continue
        if param.kind is inspect.Parameter.KEYWORD_ONLY and not star_done:
            params.append("*")
            star_done = True
        text = param.name
        if param.kind is inspect.Parameter.VAR_POSITIONAL:
            text, star_done = f"*{param.name}", True
        elif param.kind is inspect.Parameter.VAR_KEYWORD:
            text = f"**{param.name}"
        if param.annotation is not inspect.Parameter.empty:
            text += f": {annotation(param.annotation)}"
        if param.default is not inspect.Parameter.empty:
            text += f" = {param.default!r}"
        params.append(text)
    result = annotation(sig.return_annotation) if returns else ""
    one_line = f"{name}({', '.join(params)})" + (f" -> {result}" if result else "")
    if len(one_line) <= 88:
        return one_line
    body = ",\n".join(f"    {p}" for p in params)
    return f"{name}(\n{body},\n)" + (f" -> {result}" if result else "")


def code(text: str) -> list[str]:
    return ["```python", text, "```", ""]


def frontmatter(title: str, description: str, order: int | None = None, label: str | None = None) -> list[str]:
    # JSON strings are valid YAML double-quoted scalars, whatever they contain.
    lines = ["---", f"title: {json.dumps(title)}", f"description: {json.dumps(description)}"]
    if order is not None or label is not None:
        lines.append("sidebar:")
        if order is not None:
            lines.append(f"  order: {order}")
        if label is not None:
            lines.append(f"  label: {json.dumps(label)}")
    return [*lines, "---", ""]


def own_doc(obj: Any) -> str:
    """The object's own docstring: never one inherited from a base class
    (`inspect.getdoc` would give every model pydantic's `BaseModel` text)."""
    doc = vars(obj).get("__doc__") if inspect.isclass(obj) else getattr(obj, "__doc__", None)
    return inspect.cleandoc(doc) if isinstance(doc, str) else ""


# ---- members ------------------------------------------------------------------


def own_methods(cls: type) -> Iterable[tuple[str, Callable[..., Any]]]:
    for name, member in vars(cls).items():
        if name.startswith("_"):
            continue
        if isinstance(member, (staticmethod, classmethod)):
            member = member.__func__
        if inspect.isfunction(member):
            yield name, member


def own_properties(cls: type) -> Iterable[tuple[str, property]]:
    for name, member in vars(cls).items():
        if not name.startswith("_") and isinstance(member, property):
            yield name, member


def fields_block(cls: type) -> list[str]:
    lines: list[str] = []
    if dataclasses.is_dataclass(cls):
        for field in dataclasses.fields(cls):
            if field.name.startswith("_"):
                continue
            default = ""
            if field.default is not dataclasses.MISSING:
                default = f" = {field.default!r}"
            elif field.default_factory is not dataclasses.MISSING:
                default = " = …"
            lines.append(f"- `{field.name}: {annotation(field.type)}{default}`")
    elif hasattr(cls, "model_fields"):
        for name, field in cls.model_fields.items():
            alias = f" (`{field.alias}` on the wire)" if field.alias and field.alias != name else ""
            required = "" if field.is_required() else " (optional)"
            description = f": {prose(field.description)}" if field.description else ""
            lines.append(f"- `{name}: {annotation(field.annotation)}`{alias}{required}{description}")
    return [*lines, ""] if lines else []


def describe(name: str, obj: Any, level: int = 2) -> list[str]:
    heading = "#" * level
    lines = [f"{heading} `{name}`", ""]
    if inspect.isclass(obj):
        lines += code(signature(f"class {name}", obj.__init__, skip_self=True, returns=False))
        lines += [prose(own_doc(obj)), ""]
        # A dataclass's constructor already lists its fields.
        fields = [] if dataclasses.is_dataclass(obj) else fields_block(obj)
        if fields:
            lines += ["Fields:", "", *fields]
        for prop_name, prop in own_properties(obj):
            lines += [f"{heading}# `{name}.{prop_name}`", "", prose(inspect.getdoc(prop)), ""]
        for method_name, method in own_methods(obj):
            if method_name in ("model_post_init",):
                continue
            lines += [f"{heading}# `{name}.{method_name}()`", ""]
            lines += code(signature(method_name, method, skip_self=True))
            lines += [prose(inspect.getdoc(method)), ""]
    elif callable(obj):
        lines += code(signature(name, obj))
        lines += [prose(own_doc(obj)), ""]
    else:
        lines += code(f"{name} = {obj!r}")
    return lines


def module_page(module: Any, names: Iterable[str]) -> list[str]:
    lines = [prose(inspect.getdoc(module)), ""]
    for name in names:
        lines += describe(name, getattr(module, name))
    return lines


# ---- pages --------------------------------------------------------------------


def pages() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}

    out["index"] = [
        *frontmatter("Python SDK", "The kindgi package: authoring, the API client, webhooks.", 0, "Overview"),
        "The `kindgi` Python package, generated from its own code:",
        "",
        "- [`kindgi`](authoring/): tools, guardrails, agents and flows for a pack.",
        "- [`kindgi.client`](client/): `Kindgi` and `AsyncKindgi`, the API client, its errors and paging.",
        "- [Client resources](resources/): every `client.<resource>` and its methods.",
        "- [Models](models/): the request and response types of the API.",
        "- [`kindgi.webhooks`](webhooks/): verifying the webhooks Kindgi sends.",
        "- [`python -m kindgi.pack`](pack/): indexing and serving a pack's code.",
        "",
    ]

    authoring = [n for n in kindgi.__all__ if n != "__version__"]
    out["authoring"] = [
        *frontmatter("kindgi", "Tools, guardrails, agents and flows for a Python pack.", 1),
        *module_page(kindgi, authoring),
    ]
    out["webhooks"] = [
        *frontmatter("kindgi.webhooks", "Verifying the webhooks Kindgi sends.", 4),
        *module_page(webhooks_module, webhooks_module.__all__),
    ]
    client_names = [n for n in client_module.__all__ if n != "models"]
    out["client"] = [
        *frontmatter("kindgi.client", "Kindgi and AsyncKindgi: the API client, its errors and paging.", 2),
        *module_page(client_module, client_names),
    ]

    # Resources: `client.runs` and so on, the sync classes (each async one
    # is the same with `await`).
    resource_classes = [
        (name, cls)
        for name, cls in vars(_resources).items()
        if inspect.isclass(cls) and name.endswith("Resource") and not name.startswith("Async")
    ]
    entries = []
    for name, cls in resource_classes:
        doc = own_doc(cls) or ""
        match = re.search(r"`(client(?:\.[a-z_]+)+)`", doc)
        path = match.group(1) if match else f"client.{name.removesuffix('Resource').lower()}"
        slug = path.removeprefix("client.").replace(".", "-").replace("_", "-")
        entries.append((path, slug))
        lines = [*frontmatter(path, prose(doc.splitlines()[0] if doc else path).replace("`", ""))]
        lines += [prose(doc), "", "On `AsyncKindgi` every method is the same, awaited.", ""]
        for method_name, method in own_methods(cls):
            lines += [f"## `{path}.{method_name}()`", ""]
            lines += code(signature(method_name, method, skip_self=True))
            lines += [prose(inspect.getdoc(method)), ""]
        out[f"resources/{slug}"] = lines
    out["resources/index"] = [
        *frontmatter("Client resources", "Every client.<resource> and its methods.", 0, "Overview"),
        "Each resource is an attribute of the client (`client.runs.start(...)`), on",
        "`Kindgi` and, awaited, on `AsyncKindgi`.",
        "",
        *[f"- [`{path}`]({slug}/)" for path, slug in sorted(entries)],
        "",
    ]

    # Models by first letter.
    models = sorted(
        (name, cls)
        for name, cls in vars(_models).items()
        if inspect.isclass(cls) and getattr(cls, "__module__", "") == _models.__name__ and not name.startswith("_")
    )
    letters: dict[str, list[tuple[str, type]]] = {}
    for name, cls in models:
        letters.setdefault(name[0].upper(), []).append((name, cls))
    for letter, items in letters.items():
        lines = [*frontmatter(f"Models: {letter}", f"API models starting with {letter}.")]
        for name, cls in items:
            lines += [f"## `{name}`", "", prose(own_doc(cls)), "", *fields_block(cls)]
        out[f"models/{letter.lower()}"] = lines
    out["models/index"] = [
        *frontmatter("Models", "The request and response types of the Kindgi API.", 0, "Overview"),
        "The types `kindgi.client` sends and returns, from `kindgi.client.models`, one",
        "per API schema. Fields are snake_case in Python; the wire name follows when",
        "it differs.",
        "",
        " · ".join(f"[{letter}]({letter.lower()}/)" for letter in letters),
        "",
    ]

    out["pack"] = [
        *frontmatter("python -m kindgi.pack", "Indexing and serving a Python pack's code.", 5),
        "`kindgi dev` runs both for you; a pack image runs `serve`.",
        "",
        "## `python -m kindgi.pack index`",
        "",
        prose(inspect.getdoc(pack_index)),
        "",
        "## `python -m kindgi.pack serve`",
        "",
        prose(inspect.getdoc(pack_serve)),
        "",
    ]
    return out


def main() -> int:
    docs = Path(sys.argv[1])
    root = docs / OUT
    shutil.rmtree(root, ignore_errors=True)
    written = pages()
    for slug, lines in written.items():
        path = root / f"{slug}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print(f"python reference: {len(written)} pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
