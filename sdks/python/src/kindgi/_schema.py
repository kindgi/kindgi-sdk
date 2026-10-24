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
import warnings
from collections.abc import Callable, Iterable, Iterator, Mapping
from datetime import date, time
from typing import Any, cast
from urllib.parse import quote, unquote

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError as InvalidSchemaError
from jsonschema.exceptions import ValidationError as SchemaError
from pydantic import BaseModel, TypeAdapter
from pydantic import ValidationError as PydanticError
from pydantic.json_schema import GenerateJsonSchema, JsonSchemaMode, JsonSchemaValue
from pydantic_core import core_schema

__all__ = [
    "SchemaValidator",
    "apply_defaults",
    "check_schema",
    "compile_problem",
    "issues_from_pydantic",
    "strict_schema_problem",
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


def compile_problem(schema: Mapping[str, Any]) -> str | None:
    """Why the runtime's compile of an inline schema refuses `schema`: it isn't valid Draft
    2020-12, or its strict mode refuses it (`strict_schema_problem`). `None` when it compiles."""
    try:
        check_schema(schema)
    except InvalidSchemaError as exc:
        return exc.message or str(exc)
    return strict_schema_problem(schema)


# The keywords the runtime's compile of an inline schema knows (Ajv's Draft 2020-12 ones, with
# ajv-formats' format bounds), and the annotation Kindgi reads (`x-kindgi-tunable`). Its strict
# mode refuses any other keyword, and any format but ajv-formats' (`_STRICT_FORMATS`). It knows
# `id` only to refuse it.
_STRICT_KEYWORDS = frozenset(
    {
        "$async", "$comment", "$defs", "$dynamicAnchor", "$dynamicRef", "$id", "$recursiveAnchor",
        "$recursiveRef", "$ref", "$schema", "$vocabulary", "additionalProperties", "allOf", "anyOf",
        "const", "contains", "contentEncoding", "contentMediaType", "contentSchema", "default",
        "definitions", "dependencies", "dependentRequired", "dependentSchemas", "deprecated",
        "description", "else", "enum", "examples", "exclusiveMaximum", "exclusiveMinimum", "format",
        "formatExclusiveMaximum", "formatExclusiveMinimum", "formatMaximum", "formatMinimum", "id",
        "if", "items", "maxContains", "maxItems", "maxLength", "maxProperties", "maximum",
        "minContains", "minItems", "minLength", "minProperties", "minimum", "multipleOf", "not",
        "nullable", "oneOf", "pattern", "patternProperties", "prefixItems", "properties",
        "propertyNames", "readOnly", "required", "then", "title", "type", "unevaluatedItems",
        "unevaluatedProperties", "uniqueItems", "writeOnly", "x-kindgi-tunable",
    }
)  # fmt: skip
_STRICT_FORMATS = frozenset(
    {
        "binary", "byte", "date", "date-time", "double", "duration", "email", "float", "hostname",
        "int32", "int64", "ipv4", "ipv6", "iso-date-time", "iso-time", "json-pointer",
        "json-pointer-uri-fragment", "password", "regex", "relative-json-pointer", "time", "uri",
        "uri-reference", "uri-template", "url", "uuid",
    }
)  # fmt: skip
# What each keyword the runtime compiles as a subschema holds: one, a list or a map of them. `$defs`
# and `contentSchema` aren't among them: a definition is compiled where a `$ref` reaches it, and
# `contentSchema` is an annotation.
_HOLDS = {
    "not": "one", "anyOf": "list", "oneOf": "list", "allOf": "list", "if": "one", "then": "one",
    "else": "one", "prefixItems": "list", "items": "one", "contains": "one",
    "propertyNames": "one", "additionalProperties": "one", "dependencies": "map",
    "properties": "map", "patternProperties": "map", "dependentSchemas": "map",
    "unevaluatedItems": "one", "unevaluatedProperties": "one",
}  # fmt: skip
_FORMAT_BOUNDS = (
    "formatMaximum",
    "formatMinimum",
    "formatExclusiveMaximum",
    "formatExclusiveMinimum",
)
# The keywords that check data of a type, with the types (as the runtime lists them), in the order
# its strict mode checks that the data can be of one where they are (`strictTypes`).
_TYPED_KEYWORDS = (
    ("maximum", "number"), ("minimum", "number"), ("exclusiveMaximum", "number"),
    ("exclusiveMinimum", "number"), ("multipleOf", "number"), ("maxLength", "string"),
    ("minLength", "string"), ("pattern", "string"), ("maxProperties", "object"),
    ("minProperties", "object"), ("required", "object"), ("maxItems", "array"),
    ("minItems", "array"), ("uniqueItems", "array"), ("propertyNames", "object"),
    ("additionalProperties", "object"), ("dependencies", "object"), ("properties", "object"),
    ("patternProperties", "object"), ("prefixItems", "array"), ("items", "array"),
    ("contains", "array"), ("format", "number,string"), ("dependentRequired", "object"),
    ("dependentSchemas", "object"), ("maxContains", "array"), ("minContains", "array"),
    ("unevaluatedProperties", "object"), ("unevaluatedItems", "array"),
    *((bound, "string") for bound in _FORMAT_BOUNDS),
)  # fmt: skip
# The keywords that make a schema one the runtime compiles: a schema without any (annotations
# only, say) passes anything, and nothing in it is compiled.
_RULES = frozenset(
    {
        "$dynamicAnchor", "$dynamicRef", "$recursiveAnchor", "$recursiveRef", "$comment", "id",
        "$ref", "type", "nullable", "const", "enum", "not", "anyOf", "oneOf", "allOf", "if",
        "then", "else", *(keyword for keyword, _ in _TYPED_KEYWORDS),
    }
)  # fmt: skip
# The formats whose values ajv-formats can compare, the ones a format bound works with.
_COMPARED_FORMATS = frozenset({"date", "time", "date-time", "iso-time", "iso-date-time"})
# The keyword that evaluates every property (or item), which makes an unevaluated one moot.
_EVALUATES_ALL = {"unevaluatedProperties": "additionalProperties", "unevaluatedItems": "items"}
# Where a subschema sits: under a keyword the runtime compiles, among the definitions, or under
# `contentSchema`, which the runtime doesn't compile but whose bases it registers.
_SUBSCHEMAS = (
    *_HOLDS.items(),
    ("$defs", "map"),
    ("definitions", "map"),
    ("contentSchema", "one"),
)
# The keywords that name a base or an anchor the runtime knows, which a `$ref` can resolve against.
_BASE_KEYWORDS = ("$id", "$dynamicAnchor")
_INDEX = re.compile(r"0|[1-9][0-9]*")
_NOWHERE = object()
_UNKNOWN = object()
# The meta-schemas the runtime knows, which a `$ref` may name.
_META_SCHEMAS = frozenset(
    {
        "https://json-schema.org/draft/2020-12/schema",
        *(
            f"https://json-schema.org/draft/2020-12/meta/{vocabulary}"
            for vocabulary in (
                "core", "applicator", "unevaluated", "validation", "meta-data",
                "format-annotation", "content",
            )
        ),
    }
)  # fmt: skip
# The names every JavaScript object has: the runtime finds each among any schema's `properties`.
_OBJECT_MEMBERS = frozenset(
    {
        "constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty",
        "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable",
        "toString", "valueOf", "__proto__", "toLocaleString",
    }
)  # fmt: skip
# What Python's `re` may read otherwise than JavaScript's `RegExp` (`_js_matches`): in a pattern,
# `\A`, `\Z`, `\N`, `\U`, `\a` and back references, `{,n}`, a `(?` group but `(?:`, a lookahead or
# a lookbehind, `[]` and `[^]`, and possessive quantifiers; in a name, a line break, a space
# beyond ASCII, or a character beyond the BMP.
_NOT_JS_PATTERN = re.compile(r"\\[AZNUa1-9]|\{,|\(\?(?![:=!]|<[=!])|\[\^?\]|[*+?}]\+")
_NOT_JS_NAME = re.compile(
    "[\n\r\u2028\u2029\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]|[^\u0000-\uffff]"
)


def strict_schema_problem(schema: Mapping[str, Any]) -> str | None:
    """What the runtime's strict compile refuses in a valid Draft 2020-12 `schema`, in the schema or
    a subschema it compiles (one a `$ref` reaches included). Worded as the runtime words it, and of
    two problems the one it names first; `None` when there's none. It refuses:

    - a keyword it doesn't know, `id`, a format it doesn't know, a `$ref` that names nothing, and
      a chain of `$ref`s that only leads back to itself;
    - a keyword for a type the data can't have there, or a `type` the context rules out (Ajv's
      `strictTypes`), and `nullable` without a `type`, or `false` with a `null` one;
    - a `prefixItems` tuple whose length `minItems` with `maxItems` or `items: false` doesn't pin
      (`strictTuples`), and a `required` name not among those the runtime counts as defined so
      far, where a schema it compiles for other data (an item, a property's value) starts the
      count afresh with what that schema defines (`strictRequired`);
    - a keyword that does nothing without another (`then` or `else` without `if`, `if` without
      either, `minContains` or `maxContains` without `contains`, a format bound without a format
      it can compare), `minContains` 0 without `maxContains` or above it, and an empty `enum`;
    - a `properties` name a `patternProperties` pattern of the same schema matches;
    - a `$dynamicRef` or `$recursiveRef` that isn't `#`-something, and a value of the wrong type
      for a keyword Draft 2020-12 doesn't define (`nullable`, a format bound, `$recursiveAnchor`).

    A `$ref` that is empty, `#`, a `#/...` pointer, or a plain anchor (`#name`) one schema's
    `$anchor` names is followed, unless a subschema names a base of its own (`$id`): what it
    reaches then depends on bases this walk doesn't track, so it is neither followed nor refused.
    Another `$ref` is refused, but one naming a meta-schema the runtime knows, unless the schema
    names a base or an anchor (`$id`, `$dynamicAnchor`): then it is left alone too. Nor are the
    refusals of a base or an anchor itself checked (one that two schemas share, say). A pattern is
    tried on a name only where Python's `re` reads both as JavaScript does (`_js_matches`); a
    pattern's syntax isn't checked here, nor a `$recursiveAnchor` or `$recursiveRef` that isn't a
    string, which Ajv's own meta-schema refuses.
    """
    pointers = not any(_names(sub, ("$id",)) for sub in _subschemas(schema))
    others = not _names(schema, _BASE_KEYWORDS)
    root_id = schema.get("$id")
    # The root's base, which the runtime writes before the path of a type or a required problem.
    base = re.sub(r"#/?$", "", root_id) if isinstance(root_id, str) else ""
    compiled: set[int] = {id(schema)}

    def target(ref: str) -> Any:
        # What `ref` reaches: a schema, `_NOWHERE` (the runtime refuses it), or `_UNKNOWN`.
        if ref == "" or ref.startswith("#/") or ref == "#":
            return (schema if ref == "" else _local_ref(schema, ref)) if pointers else _UNKNOWN
        if ref.startswith("#") and pointers:
            # A plain anchor names the schema whose `$anchor` it is. The runtime finds it, then
            # refuses `$anchor` there as a keyword it doesn't know.
            anchored = _anchored(schema, ref[1:])
            if len(anchored) == 1:
                return anchored[0]
        if not others or ref.removesuffix("#") in _META_SCHEMAS:
            return _UNKNOWN
        if any(ref.startswith(f"{meta}#") for meta in _META_SCHEMAS):
            return _UNKNOWN  # a pointer into a meta-schema
        return _NOWHERE

    def problems(
        node: Any, path: str, types: list[str], defined: set[str], compiling: tuple[int, ...]
    ) -> Iterator[str]:
        # `types`: the types the data can have here; `defined`: the property names the runtime
        # counts as defined so far. Both are what the runtime knows of the data.
        if not isinstance(node, Mapping):
            return
        here = cast("Mapping[str, Any]", node)
        yield from _unknown_keywords(here)
        if _passes_anything(here):
            return
        raw = here.get("type")
        declared = list(cast("list[str]", raw)) if isinstance(raw, list) else [raw] if raw else []
        if "null" in declared:
            if here.get("nullable") is False:
                yield "type: null contradicts nullable: false"
        elif "nullable" in here:
            if not declared:
                yield '"nullable" cannot be used without "type"'
            elif here["nullable"] is True:
                declared.append("null")
        if _only_ref(here):
            yield from reach(here["$ref"], compiling)  # the runtime compiles nothing else here
            return
        for name in declared if types else ():
            if not _includes(types, name):
                context = ",".join(types)
                yield (
                    f'strict mode: type "{name}" not allowed by context "{context}" '
                    f'at "{base}{path}" (strictTypes)'
                )
        if declared:
            types = _narrowed(types, declared) if types else declared
        for keyword, needs in _TYPED_KEYWORDS:
            if keyword in here and not any(_fits(types, need) for need in needs.split(",")):
                yield (
                    f'strict mode: missing type "{needs}" for keyword "{keyword}" '
                    f'at "{base}{path}" (strictTypes)'
                )
        # Then its keywords, in the order the runtime compiles them: those for any data, then
        # those for numbers, strings, arrays and objects.
        if "$dynamicAnchor" in here and path != "#":
            # The runtime compiles a schema with a dynamic anchor on its own as well.
            yield from on_its_own(here, compiling)
        for keyword in ("$dynamicRef", "$recursiveAnchor", "$recursiveRef"):
            value = here.get(keyword)
            if not isinstance(value, str):
                continue
            if keyword == "$recursiveAnchor":
                yield '$recursiveAnchor value must be ["boolean"]'
            elif not value.startswith("#"):
                yield f'"{keyword}" only supports hash fragment reference'
        if "id" in here:
            yield 'NOT SUPPORTED: keyword "id", use "$id" for schema ID'
        if "$ref" in here:
            yield from reach(here["$ref"], compiling)
        if "nullable" in here and not isinstance(here["nullable"], bool):
            yield 'nullable value must be ["boolean"]'
        if here.get("enum") == []:
            yield "enum must have non-empty array"
        yield from problems(here.get("not"), f"{path}/not", types, defined, compiling)
        # Before it compiles an `anyOf`, the runtime looks for a member any data passes.
        for member in _list(here.get("anyOf")):
            yield from _unknown_keywords(member)
            if _passes_anything(member):
                break
        for keyword in ("anyOf", "oneOf", "allOf"):
            for i, member in enumerate(_list(here.get(keyword))):
                yield from problems(member, f"{path}/{keyword}/{i}", types, defined, compiling)
        if "if" in here:
            clauses = [clause for clause in ("then", "else") if clause in here]
            if not clauses:
                yield 'strict mode: "if" without "then" and "else" is ignored'
            for clause in clauses:
                yield from _unknown_keywords(here[clause])
            # `if` is compiled only for a clause some data fails.
            failing = [clause for clause in clauses if not _passes_anything(here[clause])]
            if failing:
                for keyword in ("if", *failing):
                    yield from problems(
                        here[keyword], f"{path}/{keyword}", types, defined, compiling
                    )
        else:
            for clause in ("then", "else"):
                if clause in here:
                    yield f'strict mode: "{clause}" without "if" is ignored'
        fmt = here.get("format")
        if isinstance(fmt, str) and fmt not in _STRICT_FORMATS:
            yield f'unknown format "{fmt}" ignored in schema at path "{path}"'
        for bound in _FORMAT_BOUNDS:
            if bound not in here:
                continue
            if fmt is None:
                yield f"parent schema must have dependencies of {bound}: format"
            elif not isinstance(here[bound], str):
                yield f'{bound} value must be ["string"]'
            elif fmt not in _COMPARED_FORMATS:
                yield f'"{bound}": format "{fmt}" does not define "compare" function'
        items = here.get("prefixItems")
        if isinstance(items, list):
            n = len(cast("list[Any]", items))
            pinned = n == here.get("maxItems") or here.get("items") is False
            if not (n == here.get("minItems") and pinned):
                yield (
                    f'strict mode: "prefixItems" is {n}-tuple, but minItems or maxItems/items '
                    f'are not specified or different at path "{path}"'
                )
            for i, item in enumerate(cast("list[Any]", items)):
                # The runtime compiles a schema for other data (an item, a property's value, a
                # name) with the names it counts as defined set afresh, and keeps that set after:
                # what the schema defines counts here from then on, what was defined before
                # doesn't. `false` is compiled too, but not as `additionalProperties`, an
                # `unevaluated...` keyword, or `items` after `prefixItems`.
                if not _passes_anything(item):
                    defined = set()
                yield from problems(item, f"{path}/prefixItems/{i}", [], defined, compiling)
        rest = here.get("items")
        after_tuple = rest is False and isinstance(items, list)
        if "items" in here and not _passes_anything(rest) and not after_tuple:
            defined = set()
        yield from problems(rest, f"{path}/items", [], defined, compiling)
        if "contains" in here:
            least, most = here.get("minContains", 1), here.get("maxContains")
            if most is None and least == 0:
                yield (
                    'strict mode: "minContains" == 0 without "maxContains": '
                    '"contains" keyword ignored'
                )
            elif most is not None and least > most:
                yield 'strict mode: "minContains" > "maxContains" is always invalid'
            if not _passes_anything(here["contains"]):
                defined = set()
            yield from problems(here["contains"], f"{path}/contains", [], defined, compiling)
        else:
            for keyword in ("maxContains", "minContains"):
                if keyword in here:
                    yield f'strict mode: "{keyword}" without "contains" is ignored'
        if "unevaluatedItems" in here and not evaluated(here, "unevaluatedItems", compiling):
            if _compiles_a_schema(here["unevaluatedItems"]):
                defined = set()
            yield from problems(
                here["unevaluatedItems"], f"{path}/unevaluatedItems", [], defined, compiling
            )
        props = here.get("properties")
        for key in _list(here.get("required")):
            # Defined by the schema's own `properties` (a name any JavaScript object has
            # included), or among the names the runtime counts as defined so far.
            own = isinstance(props, Mapping) and (key in props or key in _OBJECT_MEMBERS)
            if not own and key not in defined:
                yield (
                    f'strict mode: required property "{key}" is not defined '
                    f'at "{base}{path}" (strictRequired)'
                )
        if "propertyNames" in here and not _passes_anything(here["propertyNames"]):
            defined = set()
        yield from problems(
            here.get("propertyNames"), f"{path}/propertyNames", ["string"], defined, compiling
        )
        if _compiles_a_schema(here.get("additionalProperties")):
            defined = set()
        yield from problems(
            here.get("additionalProperties"), f"{path}/additionalProperties", [], defined, compiling
        )
        for name, dependency in _entries(here.get("dependencies")):
            if name != "__proto__" and not isinstance(dependency, list):
                yield from problems(
                    dependency, f"{path}/dependencies/{_segment(name)}", types, defined, compiling
                )
        properties = [(n, s) for n, s in _entries(props) if n != "__proto__"]
        defined.update(name for name, _ in properties)
        # Before it compiles any, the runtime looks for those any data passes.
        for _, sub in properties:
            yield from _unknown_keywords(sub)
        for name, sub in properties:
            if not _passes_anything(sub):
                defined = set()
                yield from problems(
                    sub, f"{path}/properties/{_segment(name)}", [], defined, compiling
                )
                defined.add(name)
        patterns = [(p, s) for p, s in _entries(here.get("patternProperties")) if p != "__proto__"]
        for _, sub in patterns:
            yield from _unknown_keywords(sub)
        if all(_passes_anything(sub) for _, sub in patterns) and evaluated(
            here, "unevaluatedProperties", compiling
        ):
            patterns = []  # the runtime checks nothing more of them
        for pattern, sub in patterns:
            for name, _ in _entries(props):
                if _js_matches(pattern, name):
                    yield (
                        f"strict mode: property {name} matches pattern {pattern} "
                        "(use allowMatchingProperties)"
                    )
            if not _passes_anything(sub):
                defined = set()
            yield from problems(
                sub, f"{path}/patternProperties/{_segment(pattern)}", [], defined, compiling
            )
        for name, dependent in _entries(here.get("dependentSchemas")):
            yield from problems(
                dependent, f"{path}/dependentSchemas/{_segment(name)}", types, defined, compiling
            )
        if "unevaluatedProperties" in here and not evaluated(
            here, "unevaluatedProperties", compiling
        ):
            if _compiles_a_schema(here["unevaluatedProperties"]):
                defined = set()
            yield from problems(
                here["unevaluatedProperties"],
                f"{path}/unevaluatedProperties",
                [],
                defined,
                compiling,
            )

    def reach(ref: Any, compiling: tuple[int, ...]) -> Iterator[str]:
        if not isinstance(ref, str):
            return
        reached = target(ref)
        if reached is _NOWHERE:
            yield f"can't resolve reference {ref} from id {base or '#'}"
        elif reached is not _UNKNOWN and loops(reached):
            yield "Maximum call stack size exceeded"
        elif reached is not _UNKNOWN:
            yield from on_its_own(reached, compiling)

    def loops(node: Any) -> bool:
        # The runtime reads through a schema that is only a `#/...` ref to the schema it reaches,
        # and overflows its stack on a loop of them. A `#` or `#/` ref ends the chain: the runtime
        # calls the root for it.
        chain: set[int] = set()
        while _only_ref(node) and node["$ref"].startswith("#/") and node["$ref"] != "#/":
            if id(node) in chain:
                return True
            chain.add(id(node))
            node = _local_ref(schema, node["$ref"])
        return False

    def on_its_own(node: Any, compiling: tuple[int, ...]) -> Iterator[str]:
        # The runtime compiles `node` as a schema of its own, once: its path starts at `#`, and
        # it knows nothing yet of the data.
        if id(node) not in compiled:
            compiled.add(id(node))
            yield from problems(node, "#", [], set(), (*compiling, id(node)))

    def evaluated(node: Mapping[str, Any], unevaluated: str, compiling: tuple[int, ...]) -> bool:
        # Whether the runtime knows, before it compiles `unevaluated`, that every property (or
        # item) is evaluated: by `node`'s own keyword, or by an `allOf` member or what a `$ref`
        # reaches (their `unevaluated` keyword included), unless that is still compiling.
        if _EVALUATES_ALL[unevaluated] in node:
            return True
        contains = node.get("contains", True)
        if unevaluated == "unevaluatedItems" and not _passes_anything(contains):
            return True  # a `contains` that some data fails evaluates every item
        members = node.get("allOf")
        if isinstance(members, list) and any(
            covers(member, unevaluated, compiling) for member in cast("list[Any]", members)
        ):
            return True
        ref = node.get("$ref")
        if not isinstance(ref, str):
            return False
        reached = target(ref)
        if reached is _UNKNOWN:
            return True  # what it reaches is unknown, so `unevaluated` is left unwalked
        return id(reached) not in compiling and covers(
            reached, unevaluated, (*compiling, id(reached))
        )

    def covers(node: Any, unevaluated: str, compiling: tuple[int, ...]) -> bool:
        if not isinstance(node, Mapping):
            return False
        here = cast("Mapping[str, Any]", node)
        return unevaluated in here or evaluated(here, unevaluated, compiling)

    return next(problems(schema, "#", [], set(), (id(schema),)), None)


def _names(node: Any, keywords: tuple[str, ...]) -> bool:
    """Whether `node` or a subschema of it has one of `keywords` (`_BASE_KEYWORDS`, say). Only a
    schema has one: a property named `$id`, or a `default` holding one, doesn't."""
    if not isinstance(node, Mapping):
        return False
    here = cast("Mapping[str, Any]", node)
    return any(keyword in here for keyword in keywords) or any(
        _names(sub, keywords) for sub in _subschemas(here)
    )


def _anchored(node: Any, anchor: str) -> list[Mapping[str, Any]]:
    """The schemas in `node` (itself included) whose `$anchor` is `anchor`."""
    if not isinstance(node, Mapping):
        return []
    here = cast("Mapping[str, Any]", node)
    found = [here] if here.get("$anchor") == anchor else []
    for sub in _subschemas(here):
        found.extend(_anchored(sub, anchor))
    return found


def _subschemas(node: Mapping[str, Any]) -> list[Any]:
    """The subschemas directly in `node`, where `_SUBSCHEMAS` says they sit."""
    inside: list[Any] = []
    for keyword, holds in _SUBSCHEMAS:
        value = node.get(keyword)
        if holds == "one":
            inside.append(value)
        elif holds == "list" and isinstance(value, list):
            inside.extend(cast("list[Any]", value))
        elif holds == "map" and isinstance(value, Mapping):
            inside.extend(cast("Mapping[str, Any]", value).values())
    return inside


def _segment(name: str) -> str:
    """`name` as a path segment, written as the runtime writes it: JSON Pointer escaped, then
    URI encoded."""
    return quote(name.replace("~", "~0").replace("/", "~1"), safe="!*'()")


def _local_ref(root: Mapping[str, Any], ref: str) -> Any:
    """What a `#` or `#/...` ref names in `root`, read as the runtime reads it; `_NOWHERE` for
    another ref, or one naming nothing."""
    if ref in ("#", "#/"):
        return root
    if not ref.startswith("#/"):
        return _NOWHERE
    node: Any = root
    for raw in ref[2:].split("/"):
        part = unquote(raw).replace("~1", "/").replace("~0", "~")
        if isinstance(node, Mapping) and part in node:
            node = cast("Mapping[str, Any]", node)[part]
        elif (
            isinstance(node, list)
            and _INDEX.fullmatch(part)
            and int(part) < len(cast("list[Any]", node))
        ):
            node = cast("list[Any]", node)[int(part)]
        else:
            return _NOWHERE
    return node


def _unknown_keywords(node: Any) -> Iterator[str]:
    """The runtime's refusal of each keyword in `node` it doesn't know, in the order it meets
    them."""
    if isinstance(node, Mapping):
        for keyword in _js_keys(cast("Mapping[str, Any]", node)):
            if keyword not in _STRICT_KEYWORDS:
                yield f'strict mode: unknown keyword: "{keyword}"'


def _only_ref(node: Any) -> bool:
    """Whether `node` is a schema whose only keyword the runtime compiles is a `$ref`."""
    if not isinstance(node, Mapping):
        return False
    here = cast("Mapping[str, Any]", node)
    ref = here.get("$ref")
    return isinstance(ref, str) and ref != "" and not any(k in _RULES for k in here if k != "$ref")


def _compiles_a_schema(node: Any) -> bool:
    """Whether the runtime compiles `node` as a schema where `false` is a check of its own:
    `additionalProperties` and the `unevaluated...` keywords."""
    return isinstance(node, Mapping) and not _passes_anything(node)


def _passes_anything(node: Any) -> bool:
    """Whether the runtime takes `node` for a schema any data passes, so compiles nothing in it."""
    if not isinstance(node, Mapping):
        return node is True
    return not any(keyword in _RULES for keyword in cast("Mapping[str, Any]", node))


def _list(value: Any) -> list[Any]:
    return cast("list[Any]", value) if isinstance(value, list) else []


def _entries(value: Any) -> list[tuple[str, Any]]:
    """A map's entries, in the order the runtime's JavaScript object holds them; none for another
    value."""
    if not isinstance(value, Mapping):
        return []
    mapping = cast("Mapping[str, Any]", value)
    return [(key, mapping[key]) for key in _js_keys(mapping)]


def _js_keys(mapping: Mapping[str, Any]) -> list[str]:
    """`mapping`'s keys in the order a JavaScript object parsed from its JSON holds them: the
    array indices first, ascending, then the rest as written."""
    indices = sorted((k for k in mapping if _INDEX.fullmatch(k) and int(k) < 2**32 - 1), key=int)
    first = set(indices)
    return [*indices, *(key for key in mapping if key not in first)]


def _includes(types: list[str], name: str) -> bool:
    """Whether a context whose data can be `types` lets a schema say the data is `name`: an
    integer is a number."""
    return name in types or (name == "integer" and "number" in types)


def _fits(types: list[str], need: str) -> bool:
    """Whether a keyword that checks data of type `need` applies to data that can be `types`: a
    number keyword applies to an integer."""
    return need in types or (need == "number" and "integer" in types)


def _narrowed(types: list[str], declared: list[str]) -> list[str]:
    """The types the data can have once a schema in a context of `types` declares `declared`."""
    narrowed: list[str] = []
    for name in types:
        if _includes(declared, name):
            narrowed.append(name)
        elif name == "number" and "integer" in declared:
            narrowed.append("integer")
    return narrowed


def _js_matches(pattern: str, name: str) -> bool:
    """Whether JavaScript's `new RegExp(pattern).test(name)` holds, as the runtime tries a
    `patternProperties` pattern on a `properties` name. `False` when Python's `re` may read the
    pattern or the name otherwise (`_NOT_JS_PATTERN`, `_NOT_JS_NAME`), or can't read the pattern:
    then the runtime's answer isn't known here, and the schema isn't refused for it."""
    if _NOT_JS_PATTERN.search(pattern) or _NOT_JS_NAME.search(name):
        return False
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # `re` warns of sets a later Python may read otherwise
        try:
            return re.search(pattern, name, re.ASCII) is not None
        except re.error:
            return False


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
