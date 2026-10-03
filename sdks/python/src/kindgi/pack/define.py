# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Declaring a pack's primitives in Python.

    from pydantic import BaseModel
    from kindgi import ToolContext, tool

    class Expense(BaseModel):
        vendor: str
        amount_cents: int

    class Recorded(BaseModel):
        expense_id: str

    @tool(id="acme.ledger.record-expense", effects=[{"kind": "writes", "resource": "db:ledger"}])
    def record_expense(expense: Expense, ctx: ToolContext) -> Recorded:
        "Records an expense in the ledger."
        ...

A tool's input and output schemas come from the handler's annotations (or
`input=` / `output=`: a model class, any type pydantic understands, or a JSON
Schema dict). A guardrail check is `@guardrail(...)` over
`(config, trace) -> CheckResult | bool`. Agents and flows are data:
`Agent(...)` and `Flow(...)` at module level. An HTTP tool is data too:
`http_tool(...)` declares the request, and the Kindgi runtime makes it.

The indexer collects every primitive a discovered module defines at module
level; the pack service runs the tool handlers and checks by id.
"""

from __future__ import annotations

import inspect
import json
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from typing import Any, Generic, Literal, NoReturn, ParamSpec, TypeVar, cast, get_type_hints

from pydantic import TypeAdapter
from pydantic_core import to_jsonable_python

from .._schema import SchemaValidator, wire_schema
from .context import ToolContext
from .trace import CheckResult, RunTrace

__all__ = [
    "Agent",
    "Flow",
    "Guardrail",
    "Primitive",
    "Tool",
    "guardrail",
    "http_tool",
    "tool",
]

P = ParamSpec("P")
R = TypeVar("R")

SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)


class DefinitionError(ValueError):
    """A primitive is declared wrong — raised where it is declared."""


def _defined_in(depth: int) -> str:
    """The module of the code `depth` frames above the caller."""
    return str(sys._getframe(depth + 1).f_globals.get("__name__", "__main__"))


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class Tool(Generic[P, R]):
    """A tool: its manifest fields plus the handler. Calling it calls the handler."""

    id: str
    handler: Callable[P, R]
    description: str
    version: str | None
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    input_type: Any
    output_type: Any
    takes_context: bool
    is_async: bool
    effects: Sequence[Mapping[str, Any]] = ()
    mutating: bool | None = None
    """`False`: read-only — it runs in a dry run, and approval gates don't ask before it by
    default. `None` (the default) means it may change something, as `True` does."""
    needs: Sequence[Mapping[str, Any]] | None = None
    needs_spec: Mapping[str, Any] | None = None
    sandbox: str | None = None
    limits: Mapping[str, Any] | None = None
    network: Mapping[str, Any] | None = None
    spec: Mapping[str, Any] | None = None
    """A declarative tool's spec (`http_tool`): the runtime runs it; `handler` refuses."""
    module: str = ""
    _input_adapter: TypeAdapter[Any] | None = field(default=None, repr=False)
    _output_adapter: TypeAdapter[Any] | None = field(default=None, repr=False)

    def __call__(self, *args: P.args, **kwargs: P.kwargs) -> R:
        return self.handler(*args, **kwargs)

    def parse_input(self, value: Any) -> Any:
        """The handler's argument for a wire input (raises pydantic `ValidationError`)."""
        return value if self._input_adapter is None else self._input_adapter.validate_python(value)

    def dump_output(self, value: Any) -> Any:
        """The wire form of the handler's return value."""
        if self._output_adapter is not None:
            return self._output_adapter.dump_python(value, mode="json", by_alias=True)
        return to_jsonable_python(value, by_alias=True)

    def invoke_args(self, value: Any, ctx: ToolContext) -> tuple[Any, ...]:
        return (value, ctx) if self.takes_context else (value,)


def tool(
    *,
    id: str,
    version: str | None = None,
    description: str | None = None,
    input: Any = None,
    output: Any = None,
    effects: Sequence[Mapping[str, Any]] = (),
    mutating: bool | None = None,
    needs: Sequence[Mapping[str, Any]] | None = None,
    needs_spec: Mapping[str, Any] | None = None,
    sandbox: str | None = None,
    limits: Mapping[str, Any] | None = None,
    network: Mapping[str, Any] | None = None,
) -> Callable[[Callable[P, R]], Tool[P, R]]:
    """Declare a tool. The handler is `(input)` or `(input, ctx: ToolContext)`, sync or async.

    `version` defaults to the pack's version; `description` to the docstring.
    `mutating=False` declares it read-only: it runs in a dry run, and an agent's
    approval gates don't ask before it by default.
    """
    annotation_scope = _caller_locals()

    def decorate(handler: Callable[P, R]) -> Tool[P, R]:
        where = f'Tool "{id}"'
        _require_id(id, where)
        _check_version(version, where)
        text = description if description is not None else inspect.getdoc(handler)
        if not text:
            raise DefinitionError(f"{where} needs a description (description= or a docstring)")
        params = _positional_params(handler, where)
        if len(params) not in (1, 2):
            raise DefinitionError(
                f"{where}: the handler takes (input) or (input, ctx), got {len(params)} parameters"
            )
        hints = _hints(handler, annotation_scope)
        input_type = input if input is not None else hints.get(params[0].name)
        output_type = output if output is not None else hints.get("return")
        if input_type is None:
            raise DefinitionError(f"{where}: annotate the handler's input parameter or pass input=")
        if output_type is None:
            raise DefinitionError(f"{where}: annotate the handler's return type or pass output=")
        input_type = _unwrap_awaitable(input_type)
        output_type = _unwrap_awaitable(output_type)
        return Tool(
            id=id,
            handler=handler,
            description=text,
            version=version,
            input_schema=_schema(input_type, "validation", where, "input"),
            output_schema=_schema(output_type, "serialization", where, "output"),
            input_type=input_type,
            output_type=output_type,
            takes_context=len(params) == 2,
            is_async=inspect.iscoroutinefunction(handler),
            effects=tuple(effects),
            mutating=mutating,
            needs=needs,
            needs_spec=needs_spec,
            sandbox=sandbox,
            limits=limits,
            network=network,
            module=handler.__module__,
            _input_adapter=_adapter(input_type),
            _output_adapter=_adapter(output_type),
        )

    return decorate


HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]


def http_tool(
    *,
    id: str,
    description: str,
    input: Any,
    output: Any,
    method: HttpMethod,
    url_template: str,
    headers: Mapping[str, str] | None = None,
    authorization: Mapping[str, Any] | None = None,
    request_body: Mapping[str, Any] | None = None,
    timeout_ms: int | None = None,
    parse_json: bool | None = None,
    success_status: tuple[int, int] | None = None,
    version: str | None = None,
    effects: Sequence[Mapping[str, Any]] = (),
    mutating: bool | None = None,
) -> Tool[..., Any]:
    """Declare a tool that is one HTTP request — no handler: the Kindgi runtime makes the call.

    The Python counterpart of `defineTool({ spec: { kind: 'http', ... } })`;
    the pack's index carries the spec. `{name}` placeholders in `url_template`
    (and in a `text` request body's `template`) are filled from the input's
    fields, URL-encoded. `authorization` and `request_body` take the spec's
    JSON shape:

        authorization={"kind": "bearer", "secretRef": {"envName": "local", "name": "ACME_TOKEN"}}
        request_body={"kind": "json-input"}

    The runtime resolves the secret on every call (`local`: the pack's `.env`
    under `kindgi dev`). A GET that changes nothing is `mutating=False`. Calling
    the tool in Python raises: it runs in Kindgi.
    """
    where = f'Tool "{id}"'
    _require_id(id, where)
    _check_version(version, where)
    if description.strip() == "":
        raise DefinitionError(f"{where} needs a description")
    input_schema = _schema(input, "validation", where, "input")
    spec = _compact(
        {
            "kind": "http",
            "method": method,
            "urlTemplate": url_template,
            "headers": None
            if headers is None
            else [{"name": name, "value": value} for name, value in headers.items()],
            "authorization": None if authorization is None else dict(authorization),
            "requestBody": None if request_body is None else dict(request_body),
            "timeoutMs": timeout_ms,
            "parseJson": parse_json,
            "successStatus": None
            if success_status is None
            else {"min": success_status[0], "max": success_status[1]},
        }
    )
    issues = _http_spec_validator().issues(spec)
    if issues:
        found = "; ".join(f"{i['instancePath'] or '/'} {i['message']}" for i in issues)
        raise DefinitionError(f"{where}: not a valid HTTP tool spec: {found}")
    templates = [url_template]
    if request_body is not None and request_body.get("kind") == "text":
        templates.append(str(request_body.get("template", "")))
    fields = set(cast("Mapping[str, Any]", input_schema.get("properties", {})))
    unknown = sorted({n for text in templates for n in _PLACEHOLDER.findall(text)} - fields)
    if unknown:
        named = ", ".join(f"{{{n}}}" for n in unknown)
        raise DefinitionError(
            f"{where}: {named} not a field of the input, which fills placeholders"
        )

    def runs_in_kindgi(*_args: Any, **_kwargs: Any) -> NoReturn:
        raise RuntimeError(
            f"{where} is an HTTP tool: the Kindgi runtime makes its request, not Python."
            " Call it through Kindgi (an agent, a flow, `kindgi dev`)."
        )

    return Tool(
        id=id,
        handler=runs_in_kindgi,
        description=description,
        version=version,
        input_schema=input_schema,
        output_schema=_schema(output, "serialization", where, "output"),
        input_type=input,
        output_type=output,
        takes_context=False,
        is_async=False,
        effects=tuple(effects),
        mutating=mutating,
        spec=spec,
        module=_defined_in(1),
        _input_adapter=_adapter(input),
        _output_adapter=_adapter(output),
    )


_PLACEHOLDER = re.compile(r"\{(\w+)\}")
"""A `{name}` placeholder, as the runtime's HTTP tool fills it."""


@cache
def _http_spec_validator() -> SchemaValidator:
    """`HttpToolSpec` in the vendored `tool.schema.json`, as `defineTool` checks it."""
    text = resources.files("kindgi._specs").joinpath("tool.schema.json").read_text("utf-8")
    defs = json.loads(text)["$defs"]
    return SchemaValidator({"$defs": defs, "$ref": "#/$defs/HttpToolSpec"})


def _compact(value: Mapping[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in value.items() if v is not None}


# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------


CheckFn = Callable[..., Any]


@dataclass(frozen=True, eq=False)
class Guardrail:
    """A guardrail whose check is this module's function. Calling it calls the check."""

    id: str
    check: CheckFn
    check_id: str
    kind: str
    action: Mapping[str, Any]
    name: str | None = None
    severity: str | None = None
    scope: Mapping[str, Any] | None = None
    config: Mapping[str, Any] | None = None
    """What the check is configured with (wire keys); the runtime passes it to the check."""
    config_schema: dict[str, Any] | None = None
    config_type: Any = None
    trace_is_model: bool = True
    is_async: bool = False
    sandbox: str | None = None
    limits: Mapping[str, Any] | None = None
    network: Mapping[str, Any] | None = None
    module: str = ""
    _config_adapter: TypeAdapter[Any] | None = field(default=None, repr=False)

    def __call__(self, config: Any, trace: Any) -> Any:
        return self.check(config, trace)

    def parse_config(self, value: Mapping[str, Any]) -> Any:
        return (
            dict(value)
            if self._config_adapter is None
            else self._config_adapter.validate_python(value)
        )

    def parse_trace(self, value: Any) -> Any:
        return RunTrace.model_validate(value) if self.trace_is_model else value


def guardrail(
    *,
    id: str,
    kind: str = "zero-llm",
    on_violation: str | None = None,
    action: Mapping[str, Any] | None = None,
    name: str | None = None,
    severity: str | None = None,
    scope: Mapping[str, Any] | None = None,
    check_id: str | None = None,
    config: Mapping[str, Any] | None = None,
    config_type: Any = None,
    sandbox: str | None = None,
    limits: Mapping[str, Any] | None = None,
    network: Mapping[str, Any] | None = None,
) -> Callable[[CheckFn], Guardrail]:
    """Declare a guardrail and its check: `(config, trace) -> CheckResult | dict | bool`.

    `on_violation` is the action's name (`"halt"`, `"retry"`, `"escalate"`, …);
    pass `action=` for the full object (`{"on-violation": "retry", "retry": {"maxAttempts": 2}}`).
    `config=` is what the check is configured with, keyed as on the wire (a
    model's aliases); it is checked against the config type here. Without it
    the check gets `{}` — its defaults. The config type comes from the check's
    first annotation or `config_type=`.
    """
    annotation_scope = _caller_locals()

    def decorate(check: CheckFn) -> Guardrail:
        where = f'Guardrail "{id}"'
        _require_id(id, where)
        if (on_violation is None) == (action is None):
            raise DefinitionError(f"{where}: pass exactly one of on_violation= or action=")
        resolved_action: Mapping[str, Any] = (
            action if action is not None else {"on-violation": on_violation}
        )
        if not isinstance(resolved_action.get("on-violation"), str):
            raise DefinitionError(f'{where}: action needs a string "on-violation"')
        params = _positional_params(check, where)
        if len(params) != 2:
            raise DefinitionError(
                f"{where}: the check takes (config, trace), got {len(params)} parameters"
            )
        hints = _hints(check, annotation_scope)
        resolved_type = config_type if config_type is not None else hints.get(params[0].name)
        if resolved_type in (dict, Mapping, Any):
            resolved_type = None
        adapter = _adapter(resolved_type)
        if config is not None and adapter is not None:
            try:
                adapter.validate_python(dict(config))
            except Exception as cause:
                raise DefinitionError(f"{where}: config does not fit its type: {cause}") from cause
        trace_hint = hints.get(params[1].name)
        return Guardrail(
            id=id,
            check=check,
            check_id=check_id or id,
            kind=kind,
            action=dict(resolved_action),
            name=name,
            severity=severity,
            scope=scope,
            config=None if config is None else dict(config),
            config_schema=None
            if resolved_type is None
            else _schema(resolved_type, "validation", where, "config"),
            config_type=resolved_type,
            trace_is_model=trace_hint is None or trace_hint is RunTrace,
            is_async=inspect.iscoroutinefunction(check),
            sandbox=sandbox,
            limits=limits,
            network=network,
            module=check.__module__,
            _config_adapter=adapter,
        )

    return decorate


def check_result_to_wire(result: Any) -> dict[str, Any] | None:
    """The wire `CheckResult` for what a check returned, or `None` if it isn't one."""
    if isinstance(result, bool):
        return {"passed": result}
    if isinstance(result, CheckResult):
        return result.to_wire()
    if isinstance(result, Mapping):
        wire = cast("dict[str, Any]", to_jsonable_python(dict(cast("Mapping[str, Any]", result))))
        return wire if isinstance(wire.get("passed"), bool) else None
    return None


# ---------------------------------------------------------------------------
# Agents and flows — data
# ---------------------------------------------------------------------------


@dataclass(eq=False)
class Agent:
    """An agent: instructions, capabilities, the tools it may call. Pure data.

    `tools` takes `Tool` objects (pinned to their version) or `{"id", "version"}`
    refs (`version` a semver range); `guardrails` takes `Guardrail` objects or
    ids; `output` a model class / type / JSON Schema for typed output, or the
    full `{"schema", "name", "maxRepairs"}` object.
    """

    id: str
    version: str
    name: str
    instructions: str
    capabilities: Sequence[Mapping[str, Any]] = ()
    tools: Sequence[Tool[..., Any] | Mapping[str, Any]] = ()
    retrieval: Sequence[Mapping[str, Any]] = ()
    guardrails: Sequence[Guardrail | str] = ()
    parameters: Sequence[Mapping[str, Any]] = ()
    budget: Mapping[str, Any] | None = None
    preferred_provider: str | None = None
    preferred_model: str | None = None
    description: str | None = None
    tags: Sequence[str] | None = None
    conversation_policy: Mapping[str, Any] | None = None
    output: Any = None
    tool_errors: Mapping[str, Any] | None = None
    """How turns retry failed tool calls: `{"maxRetries": 2, "retryOn": [...]}`."""
    module: str = field(default="", repr=False)

    def __post_init__(self) -> None:
        if not self.module:
            self.module = _defined_in(2)
        where = f'Agent "{self.id}"'
        _require_id(self.id, where)
        if not SEMVER.match(self.version):
            raise DefinitionError(f"{where}: version must be an exact semver, got {self.version!r}")


@dataclass(eq=False)
class Flow:
    """A flow: nodes and edges as data (`flow.schema.json`). A node's `ref` may be a `Tool`."""

    id: str
    version: str
    nodes: Sequence[Mapping[str, Any]]
    edges: Sequence[Mapping[str, Any]]
    name: str | None = None
    description: str | None = None
    max_parallelism: int | None = None
    metadata: Mapping[str, Any] | None = None
    output: Mapping[str, Any] | None = None
    module: str = field(default="", repr=False)

    def __post_init__(self) -> None:
        if not self.module:
            self.module = _defined_in(2)
        _require_id(self.id, f'Flow "{self.id}"')


Primitive = Tool[..., Any] | Guardrail | Agent | Flow


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _check_version(version: str | None, where: str) -> None:
    if version is not None and not SEMVER.match(version):
        raise DefinitionError(
            f"{where}: version must be an exact semver (e.g. 1.2.3), got {version!r}"
        )


def _require_id(value: Any, where: str) -> None:
    if not isinstance(value, str) or value.strip() == "":
        raise DefinitionError(f"{where}: id must be a non-empty string")


def _positional_params(fn: Callable[..., Any], where: str) -> list[inspect.Parameter]:
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError) as cause:
        raise DefinitionError(f"{where}: cannot read the function's signature") from cause
    return [
        p
        for p in signature.parameters.values()
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]


def _caller_locals() -> dict[str, Any]:
    """The locals where the decorator is applied — so a model defined in a function resolves."""
    return dict(sys._getframe(2).f_locals)


def _hints(fn: Callable[..., Any], scope: Mapping[str, Any]) -> dict[str, Any]:
    try:
        return get_type_hints(fn, localns=dict(scope), include_extras=True)
    except Exception:  # an annotation that can't resolve yet: fall back to the raw ones
        return dict(getattr(fn, "__annotations__", {}))


def _unwrap_awaitable(annotation: Any) -> Any:
    origin = getattr(annotation, "__origin__", None)
    if origin is not None and getattr(origin, "__name__", "") in ("Awaitable", "Coroutine"):
        args = getattr(annotation, "__args__", ())
        return args[-1] if args else Any
    return annotation


def _adapter(annotation: Any) -> TypeAdapter[Any] | None:
    if annotation is None or isinstance(annotation, Mapping):
        return None
    return TypeAdapter(annotation)


def _schema(source: Any, mode: Any, where: str, what: str) -> dict[str, Any]:
    try:
        schema = wire_schema(source, mode)
    except Exception as cause:
        raise DefinitionError(f"{where}: cannot derive the {what} JSON Schema: {cause}") from cause
    if what == "input" and schema.get("type") != "object":
        # A model calls a tool with an object of arguments.
        raise DefinitionError(
            f"{where}: the input must be an object type (a model, TypedDict, or object schema)"
        )
    return schema
