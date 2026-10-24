# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Response enums and tagged unions: read open, sent closed.

A newer runtime may answer with an enum value, or a union member, that this
client doesn't know yet: an additive change to the API. Read as a closed
`Literal`, it would fail the whole response. So `scripts/gen_client.py`
types every enum a response reaches, one of a single value too, as
`Annotated[Literal[...] | str, OPEN]` (the known values, or any other
text), and gives every tagged union a response reaches a fallback member,
`<Union>Unrecognized`, chosen for any tag it doesn't know (`OpenUnion`), its
fields kept as they came. A `const` stays closed, and so does the tag a
union picks its member by.

A request body this client sends (`_base._body`) is validated with `SEND`
as its context, and there both stay closed: a value outside the known ones,
or an unrecognized member, is refused before sending, with the error a
closed `Literal` or tagged union gives. So a value read from a newer
runtime can't be sent back by this client.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Annotated, Any, Literal, Union, cast, get_args, get_origin

from pydantic import BaseModel, Discriminator, GetCoreSchemaHandler, Tag
from pydantic.fields import FieldInfo
from pydantic_core import PydanticCustomError, core_schema

__all__ = ["OPEN", "SEND", "OpenEnum", "OpenUnion"]

SEND: Mapping[str, Any] = {"kindgi.send": True}
"""The validation context of a request body the client sends."""


def _sending(info: core_schema.ValidationInfo) -> bool:
    context = info.context
    if not isinstance(context, Mapping):
        return False
    return cast("Mapping[str, Any]", context).get("kindgi.send") is True


def _literal_values(annotation: Any) -> list[str]:
    """The strings a `Literal[...]` allows, found in a union too (`Literal[...] | str`)."""
    if get_origin(annotation) is Literal:
        return [value for value in get_args(annotation) if isinstance(value, str)]
    if get_origin(annotation) is Annotated:
        return _literal_values(get_args(annotation)[0])
    return [value for arg in get_args(annotation) for value in _literal_values(arg)]


def _either(values: Sequence[str]) -> str:
    """As pydantic lists a `Literal`'s values: `'a', 'b' or 'c'`."""
    quoted = [repr(value) for value in values]
    return quoted[0] if len(quoted) == 1 else f"{', '.join(quoted[:-1])} or {quoted[-1]}"


class OpenEnum:
    """On `Literal[...] | str`: any text read, only the `Literal`'s values sent."""

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        known = _literal_values(source)
        if not known or str not in get_args(source):
            raise TypeError(f"OpenEnum is for `Literal[...] | str`, not {source!r}")
        expected = _either(known)

        def check(value: Any, info: core_schema.ValidationInfo) -> Any:
            if _sending(info) and value not in known:
                raise PydanticCustomError(
                    "literal_error", "Input should be {expected}", {"expected": expected}
                )
            return value

        return core_schema.with_info_after_validator_function(check, handler(source))


OPEN = OpenEnum()
"""The metadata of every response enum (`Annotated[Literal[...] | str, OPEN]`)."""


def _field(model: type[BaseModel], wire: str) -> tuple[str, FieldInfo]:
    """A model's field by its wire name: its Python name and its info."""
    for name, info in model.model_fields.items():
        if (info.alias or name) == wire:
            return name, info
    raise TypeError(f"{model.__name__} has no field {wire!r}")


class OpenUnion:
    """On a union of models told apart by `tag`: a tag this client doesn't know, read, is
    `fallback` (`<Union>Unrecognized`, its fields kept as they came); sent, it's refused.

    A known tag picks its member, as a discriminated union does, so a known member
    with a body that doesn't match is still refused, never read as the fallback.
    """

    def __init__(self, tag: str, fallback: type[BaseModel]) -> None:
        self.tag = tag
        self.fallback = fallback

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        members: list[type[BaseModel]] = list(get_args(source))
        if self.fallback not in members:
            raise TypeError(f"OpenUnion: {self.fallback.__name__} isn't a member of {source!r}")
        routes: dict[str, str] = {}
        for member in members:
            if member is not self.fallback:
                _, info = _field(member, self.tag)
                for value in _literal_values(info.annotation):
                    routes[value] = member.__name__
        attribute, _ = _field(self.fallback, self.tag)
        fallback = self.fallback.__name__

        def route(value: Any) -> str:
            if isinstance(value, BaseModel):
                tag = getattr(value, attribute, None)
                return routes.get(tag, fallback) if isinstance(tag, str) else type(value).__name__
            if isinstance(value, Mapping):
                body = cast("Mapping[str, Any]", value)
                found = body.get(self.tag, body.get(attribute))
                return routes.get(found, fallback) if isinstance(found, str) else fallback
            return fallback

        tagged = tuple(Annotated[member, Tag(member.__name__)] for member in members)
        union: Any = Annotated[Union[tagged], Discriminator(route)]  # noqa: UP007
        expected = ", ".join(repr(value) for value in routes)

        def check(value: Any, info: core_schema.ValidationInfo) -> Any:
            if _sending(info) and isinstance(value, self.fallback):
                raise PydanticCustomError(
                    "union_tag_invalid",
                    "Input tag {tag} found using {discriminator} does not match any of the"
                    " expected tags: {expected_tags}",
                    {
                        "tag": repr(getattr(value, attribute)),
                        "discriminator": repr(self.tag),
                        "expected_tags": expected,
                    },
                )
            return value

        return core_schema.with_info_after_validator_function(check, handler.generate_schema(union))
