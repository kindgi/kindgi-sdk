# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""JSON Schema on the wire: derive it from Python types, validate against it.

`wire_schema` turns a pydantic model (or any type pydantic understands) into
the JSON Schema a pack index carries — Draft 2020-12, field names as they
travel (aliases), no generated titles, local `$ref`s inlined unless a type is
recursive. A dict is taken as JSON Schema already.

`SchemaValidator` checks a value against a schema and reports issues shaped
like Ajv's (`instancePath`, `schemaPath`, `keyword`, `params`, `message`) —
the shape pack protocol v2 carries, whichever language runs the pack.
"""

from __future__ import annotations

import copy
import ipaddress
import json
import re
from collections.abc import Callable, Iterable, Mapping
from datetime import date, time
from typing import Any, cast

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError as SchemaError
from pydantic import BaseModel, TypeAdapter
from pydantic import ValidationError as PydanticError
from pydantic.json_schema import GenerateJsonSchema, JsonSchemaMode, JsonSchemaValue
from pydantic_core import core_schema

__all__ = [
    "SchemaValidator",
    "apply_defaults",
    "check_schema",
    "issues_from_pydantic",
    "wire_schema",
]

JsonObject = dict[str, Any]
Issue = dict[str, Any]


class _WireSchema(GenerateJsonSchema):
    """Pydantic's generator, minus the titles it invents."""

    def field_title_should_be_set(self, schema: Any) -> bool:
        return False

    def model_schema(self, schema: core_schema.ModelSchema) -> JsonSchemaValue:
        out = super().model_schema(schema)
        # The core config's title defaults to the class name; the model's own config says
        # whether the author chose one.
        explicit = schema["cls"].model_config.get("title")
        if explicit is None and isinstance(out.get("title"), str):
            out.pop("title")
        return out


def wire_schema(source: Any, mode: JsonSchemaMode = "validation") -> JsonObject:
    """The wire JSON Schema for `source`: a dict (verbatim), a model class, or a type."""
    if isinstance(source, Mapping):
        return dict(cast("Mapping[str, Any]", source))
    if isinstance(source, type) and issubclass(source, BaseModel):
        schema = source.model_json_schema(by_alias=True, mode=mode, schema_generator=_WireSchema)
    else:
        adapter: TypeAdapter[Any] = TypeAdapter(cast(Any, source))
        schema = adapter.json_schema(by_alias=True, mode=mode, schema_generator=_WireSchema)
    return _inline_refs(schema)


def _inline_refs(schema: JsonObject) -> JsonObject:
    """Replace `#/$defs/X` references with the definition, except for recursive types."""
    defs: dict[str, Any] = dict(schema.pop("$defs", {}))
    kept: set[str] = set()

    def walk(node: Any, stack: tuple[str, ...]) -> Any:
        if isinstance(node, list):
            return [walk(item, stack) for item in cast("list[Any]", node)]
        if not isinstance(node, dict):
            return node
        obj = cast("dict[str, Any]", node)
        ref = obj.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            name = ref[len("#/$defs/") :]
            if name in stack or name not in defs:
                kept.add(name)
                return {key: walk(value, stack) for key, value in obj.items()}
            inlined = walk(defs[name], (*stack, name))
            siblings = {key: walk(value, stack) for key, value in obj.items() if key != "$ref"}
            return {**inlined, **siblings}
        return {key: walk(value, stack) for key, value in obj.items()}

    out = walk(schema, ())
    # A recursive definition stays in `$defs`; its body may reference others.
    pending = list(kept)
    done: dict[str, Any] = {}
    while pending:
        name = pending.pop()
        if name in done or name not in defs:
            continue
        before = set(kept)
        done[name] = walk(defs[name], (name,))
        pending.extend(kept - before)
    if done:
        out["$defs"] = done
    return out


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _formats() -> FormatChecker:
    """Formats checked as Ajv's `ajv-formats` checks them (stdlib only)."""
    checker = FormatChecker(formats=())

    def register(name: str, check: Callable[[str], bool]) -> None:
        def accepts(value: object) -> bool:
            return not isinstance(value, str) or check(value)

        checker.checks(name)(accepts)

    register("date-time", _is_date_time)
    register("date", _is_date)
    register("time", _is_time)
    register("uuid", lambda v: _UUID.match(v) is not None)
    register("email", lambda v: _EMAIL.match(v) is not None)
    register("hostname", lambda v: _HOSTNAME.match(v) is not None)
    register("ipv4", lambda v: _is_ip(v, 4))
    register("ipv6", lambda v: _is_ip(v, 6))
    register("uri", lambda v: _URI.match(v) is not None)
    register("uri-reference", lambda v: _NO_SPACE.match(v) is not None)
    register("regex", _is_regex)
    return checker


_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_TIME = re.compile(r"^(\d{2}):(\d{2}):(\d{2})(\.\d+)?([zZ]|[+-]\d{2}:\d{2})$")
_UUID = re.compile(r"^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", re.IGNORECASE)
_EMAIL = re.compile(
    r"^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$",
    re.IGNORECASE,
)
_HOSTNAME = re.compile(
    r"^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$",
    re.IGNORECASE,
)
_URI = re.compile(r"^[a-z][a-z0-9+\-.]*:[^\s]*$", re.IGNORECASE)
_NO_SPACE = re.compile(r"^[^\s]*$")


def _is_date(value: str) -> bool:
    m = _DATE.match(value)
    if m is None:
        return False
    try:
        date(int(m[1]), int(m[2]), int(m[3]))
    except ValueError:
        return False
    return True


def _is_time(value: str) -> bool:
    m = _TIME.match(value)
    if m is None:
        return False
    hour, minute, second = int(m[1]), int(m[2]), int(m[3])
    try:
        time(hour, minute, min(second, 59))  # a leap second (60) is allowed
    except ValueError:
        return False
    return second <= 60


def _is_date_time(value: str) -> bool:
    parts = re.split(r"[tT\s]", value, maxsplit=1)
    return len(parts) == 2 and _is_date(parts[0]) and _is_time(parts[1])


def _is_ip(value: str, version: int) -> bool:
    try:
        return ipaddress.ip_address(value).version == version
    except ValueError:
        return False


def _is_regex(value: str) -> bool:
    try:
        re.compile(value)
    except re.error:
        return False
    return True


_FORMAT_CHECKER = _formats()


def check_schema(schema: Mapping[str, Any]) -> None:
    """Raise `jsonschema.SchemaError` when `schema` is not a valid Draft 2020-12 schema."""
    Draft202012Validator.check_schema(schema)


class SchemaValidator:
    """A compiled Draft 2020-12 schema that reports Ajv-shaped issues."""

    def __init__(self, schema: Mapping[str, Any]) -> None:
        check_schema(schema)
        self._schema = schema
        self._validator = Draft202012Validator(schema, format_checker=_FORMAT_CHECKER)

    def issues(self, instance: Any) -> list[Issue]:
        out: list[Issue] = []
        seen: set[tuple[str, str, str]] = set()
        errors: Iterable[SchemaError] = self._validator.iter_errors(instance)  # pyright: ignore[reportUnknownMemberType]
        for error in errors:
            for issue in _issues_for(error):
                key = (issue["instancePath"], issue["schemaPath"], _param_key(issue))
                if key not in seen:
                    seen.add(key)
                    out.append(issue)
        return out

    def explain(self, instance: Any) -> Issue | None:
        """The issue that best says what's wrong with `instance`, or `None` when it's valid.

        Through a `oneOf` / `anyOf` it follows the one alternative whose
        discriminator (a `const` or `enum` property such as `kind`) the value
        matches, so a tool node reports its own problem, not "matches none of the
        node kinds"; when none matches, it names the discriminator's allowed values.
        """
        errors: list[SchemaError] = list(self._validator.iter_errors(instance))  # pyright: ignore[reportUnknownMemberType, reportUnknownArgumentType]
        if not errors:
            return None
        return _explain(errors[0])


def _explain(error: SchemaError) -> Issue:
    while error.validator in ("oneOf", "anyOf") and error.context:
        depth = len(error.absolute_path)
        branches = _branches(error)
        matching = [errs for errs in branches if not _misses(errs, depth)]
        if len(matching) == 1:
            error = matching[0][0]
            continue
        if matching:
            break
        # Every alternative misses. The property they discriminate on (`kind`) is the
        # one most of them check directly; an alternative that misses only on another
        # one (`loopKind`, under a `kind` that matched) is where the value belongs.
        props = [_prop(e) for errs in branches for e in errs if _is_discriminator(e, depth)]
        if not props:
            break
        prop = max(set(props), key=props.count)
        elsewhere = [errs for errs in branches if prop not in _missed_props(errs, depth)]
        if len(elsewhere) == 1:
            error = next(
                (e for e in elsewhere[0] if e.validator in ("oneOf", "anyOf")), elsewhere[0][0]
            )
            continue
        values = _allowed(branches, depth, prop)
        return {
            "instancePath": _pointer([*error.absolute_path, prop]),
            "schemaPath": "#" + _pointer(error.absolute_schema_path),
            "keyword": "enum",
            "params": {"allowedValues": values},
            "message": "must be one of " + ", ".join(json.dumps(v) for v in values),
        }
    issues = _issues_for(error)
    if issues:
        return issues[0]
    return {
        "instancePath": _pointer(error.absolute_path),
        "schemaPath": "#" + _pointer(error.absolute_schema_path),
        "keyword": str(error.validator),
        "params": {},
        "message": error.message,
    }


def _branches(error: SchemaError) -> list[list[SchemaError]]:
    """A `oneOf` / `anyOf` error's sub-errors, grouped by alternative."""
    grouped: dict[Any, list[SchemaError]] = {}
    for sub in error.context or ():
        grouped.setdefault(sub.relative_schema_path[0], []).append(sub)
    return list(grouped.values())


def _is_discriminator(error: SchemaError, depth: int) -> bool:
    """A `const` / `enum` failure on a property of the object at `depth`."""
    return error.validator in ("const", "enum") and len(error.absolute_path) == depth + 1


def _prop(error: SchemaError) -> str:
    return str(error.absolute_path[-1])


def _missed_props(errors: Iterable[SchemaError], depth: int) -> set[str]:
    """The discriminating properties an alternative fails on: directly, or in every
    alternative of a nested `oneOf` / `anyOf` on the same object."""
    missed: set[str] = set()
    for error in errors:
        if _is_discriminator(error, depth):
            missed.add(_prop(error))
        elif error.validator in ("oneOf", "anyOf") and len(error.absolute_path) == depth:
            nested = [_missed_props(errs, depth) for errs in _branches(error)]
            if nested and all(nested):
                common = nested[0].intersection(*nested[1:])
                missed |= common or nested[0].union(*nested[1:])
    return missed


def _misses(errors: Iterable[SchemaError], depth: int) -> bool:
    return bool(_missed_props(errors, depth))


def _allowed(branches: list[list[SchemaError]], depth: int, prop: str) -> list[Any]:
    """The values the alternatives allow for `prop`, in schema order."""
    values: list[Any] = []

    def collect(errors: Iterable[SchemaError]) -> None:
        for error in errors:
            if _is_discriminator(error, depth) and _prop(error) == prop:
                allowed = error.validator_value
                found = allowed if error.validator == "enum" else [allowed]
                values.extend(v for v in cast("list[Any]", found) if v not in values)
            elif error.validator in ("oneOf", "anyOf") and error.context:
                collect(error.context)

    for errs in branches:
        collect(errs)
    return values


def _param_key(issue: Issue) -> str:
    params: Any = issue.get("params", {})
    if not isinstance(params, dict):
        return ""
    return repr(sorted(cast("dict[str, Any]", params).items()))


def _pointer(parts: Iterable[Any]) -> str:
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _issues_for(error: SchemaError) -> list[Issue]:
    keyword = str(error.validator)
    value: Any = error.validator_value
    instance_path = _pointer(error.absolute_path)
    schema_path = "#" + _pointer(error.absolute_schema_path)

    def issue(params: JsonObject, message: str) -> Issue:
        return {
            "instancePath": instance_path,
            "schemaPath": schema_path,
            "keyword": keyword,
            "params": params,
            "message": message,
        }

    instance: Any = error.instance
    if keyword == "required" and isinstance(instance, dict):
        present = cast("dict[str, Any]", instance)
        missing = [name for name in cast("list[str]", value) if name not in present]
        return [
            issue({"missingProperty": name}, f"must have required property '{name}'")
            for name in missing
        ]
    if keyword == "additionalProperties" and value is False and isinstance(instance, dict):
        schema = cast("dict[str, Any]", error.schema)
        declared = set(cast("dict[str, Any]", schema.get("properties", {})))
        patterns = [
            re.compile(p) for p in cast("dict[str, Any]", schema.get("patternProperties", {}))
        ]
        extras = [
            name
            for name in cast("dict[str, Any]", instance)
            if name not in declared and not any(p.search(name) for p in patterns)
        ]
        return [
            issue({"additionalProperty": name}, "must NOT have additional properties")
            for name in extras
        ]
    return [issue(*_params_and_message(keyword, value, error))]


def _params_and_message(keyword: str, value: Any, error: SchemaError) -> tuple[JsonObject, str]:
    if keyword == "type":
        types = ",".join(cast("list[str]", value)) if isinstance(value, list) else str(value)
        return {"type": types}, f"must be {types}"
    if keyword == "enum":
        return {"allowedValues": value}, "must be equal to one of the allowed values"
    if keyword == "const":
        return {"allowedValue": value}, "must be equal to constant"
    limits = {
        "minLength": ("fewer", "characters"),
        "maxLength": ("more", "characters"),
        "minItems": ("fewer", "items"),
        "maxItems": ("more", "items"),
        "minProperties": ("fewer", "properties"),
        "maxProperties": ("more", "properties"),
    }
    if keyword in limits:
        word, unit = limits[keyword]
        return {"limit": value}, f"must NOT have {word} than {value} {unit}"
    comparisons = {
        "minimum": ">=",
        "maximum": "<=",
        "exclusiveMinimum": ">",
        "exclusiveMaximum": "<",
    }
    if keyword in comparisons:
        op = comparisons[keyword]
        return {"comparison": op, "limit": value}, f"must be {op} {value}"
    if keyword == "pattern":
        return {"pattern": value}, f'must match pattern "{value}"'
    if keyword == "format":
        return {"format": value}, f'must match format "{value}"'
    if keyword == "multipleOf":
        return {"multipleOf": value}, f"must be multiple of {value}"
    if keyword == "uniqueItems":
        return {}, "must NOT have duplicate items"
    if keyword == "anyOf":
        return {}, "must match a schema in anyOf"
    if keyword == "oneOf":
        return {"passingSchemas": None}, "must match exactly one schema in oneOf"
    if keyword == "not":
        return {}, "must NOT be valid"
    return {}, error.message


def issues_from_pydantic(error: PydanticError) -> list[Issue]:
    """Ajv-shaped issues for a pydantic validation error (a model's own validators)."""
    return [
        {
            "instancePath": _pointer(detail["loc"]),
            "schemaPath": "#",
            "keyword": detail["type"],
            "params": {},
            "message": detail["msg"],
        }
        for detail in error.errors(include_url=False)
    ]


def apply_defaults(schema: Mapping[str, Any], instance: Any) -> Any:
    """`instance` with its schema's `default`s filled in, as Ajv's `useDefaults` fills them.

    A property missing from an object gets its `properties` entry's `default`
    (a copy), then nested objects and array items are filled the same way;
    `allOf` branches and local `$ref`s count, `anyOf` / `oneOf` / `not` don't.
    Returns a new value; `instance` is not modified.
    """
    root = schema

    def resolve(node: Mapping[str, Any]) -> Mapping[str, Any]:
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            target: Mapping[str, Any] = root
            for part in ref[2:].split("/"):
                step: object = target.get(part.replace("~1", "/").replace("~0", "~"))
                target = cast("Mapping[str, Any]", step) if isinstance(step, Mapping) else {}
            return target
        return node

    def fill(node: Any, value: Any) -> Any:
        if not isinstance(node, Mapping):
            return value
        sub = resolve(cast("Mapping[str, Any]", node))
        for branch in cast("list[Any]", sub.get("allOf", [])):
            value = fill(branch, value)
        if isinstance(value, dict):
            obj = dict(cast("dict[str, Any]", value))
            properties = sub.get("properties")
            if isinstance(properties, Mapping):
                for name, prop in cast("Mapping[str, Any]", properties).items():
                    if not isinstance(prop, Mapping):
                        continue
                    prop_schema = resolve(cast("Mapping[str, Any]", prop))
                    if name not in obj and "default" in prop_schema:
                        obj[name] = copy.deepcopy(prop_schema["default"])
                    if name in obj:
                        obj[name] = fill(prop_schema, obj[name])
            return obj
        if isinstance(value, list):
            items_list = list(cast("list[Any]", value))
            prefix = sub.get("prefixItems")
            prefix_list = cast("list[Any]", prefix) if isinstance(prefix, list) else []
            for i, item_schema in enumerate(prefix_list):
                if i < len(items_list):
                    items_list[i] = fill(item_schema, items_list[i])
            items = sub.get("items")
            if isinstance(items, Mapping):
                for i in range(len(prefix_list), len(items_list)):
                    items_list[i] = fill(items, items_list[i])
            return items_list
        return value

    return fill(schema, copy.deepcopy(instance))
