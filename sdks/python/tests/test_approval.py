# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool's ``approval``: how an approval of a call to it reads, checked where it's declared.

The same rules as ``defineTool``: each ``{field}`` names a required top-level field of the input
whose schema is a string, a number, an integer or a boolean (or an enum of those).
"""

from __future__ import annotations

import re
from typing import Any, Literal

import pytest
from pydantic import BaseModel, Field

from kindgi import DefinitionError, http_tool, tool


class Refund(BaseModel):
    order_id: int
    amount: float
    reason: str
    notify: bool
    channel: Literal["mail", "phone"]
    lines: list[str]
    note: str | None = None


class Done(BaseModel):
    ok: bool


class Resize(BaseModel):
    size: str = Field(alias="gr\u00f6\u00dfe")


def _refund_tool(approval: Any) -> Any:
    @tool(id="acme.refund", mutating=True, approval=approval)
    def refund(input: Refund) -> Done:
        "Refunds an order."
        return Done(ok=True)

    return refund


def test_placeholders_naming_required_scalar_fields_are_kept() -> None:
    approval = {
        "title": "Refund {amount} on order #{order_id}",
        "summary": "{reason} (notify: {notify}, by {channel})",
        "about": {"kind": "acme.order", "id": "{order_id}"},
    }
    assert _refund_tool(approval).approval == approval


def test_a_tool_without_one_has_none() -> None:
    assert _refund_tool(None).approval is None


@pytest.mark.parametrize(
    ("approval", "message"),
    [
        (
            {"title": "Refund {total}"},
            "approval.title names {total}, which isn't a field of the input",
        ),
        (
            {"title": "Refund {amount}", "summary": "{note}"},
            "approval.summary names {note}, an optional field of the input:"
            " a call may leave it out",
        ),
        (
            {"title": "Refund {lines}"},
            "approval.title names {lines}, a field of the input that isn't a string, a number,"
            " an integer or a boolean",
        ),
        (
            {"title": "Refund {{amount}}"},
            "approval.title has a brace that isn't part of a {field} placeholder",
        ),
        (
            {"title": "Refund {amount}", "about": {"kind": "acme.order", "id": "latest"}},
            "approval.about.id must hold at least one {field} placeholder",
        ),
    ],
)
def test_an_approval_a_call_could_not_fill_is_refused_where_declared(
    approval: dict[str, Any], message: str
) -> None:
    with pytest.raises(DefinitionError, match=re.escape(f'Tool "acme.refund": {message}')):
        _refund_tool(approval)


@pytest.mark.parametrize(
    "approval",
    [
        {"summary": "{reason}"},
        {"title": "Refund {amount}\non order #{order_id}"},
        {"title": ""},
        {"title": "Refund {amount}", "body": "{reason}"},
        {"title": "Refund", "about": {"kind": "Order", "id": "{order_id}"}},
    ],
)
def test_an_approval_its_schema_refuses_is_refused_where_declared(approval: dict[str, Any]) -> None:
    refused = re.escape('Tool "acme.refund": not a valid approval:')
    with pytest.raises(DefinitionError, match=refused):
        _refund_tool(approval)


def _resize_tool(approval: Any) -> Any:
    @tool(id="acme.resize", approval=approval)
    def resize(input: Resize) -> Done:
        "Resizes a picture."
        return Done(ok=True)

    return resize


def test_a_placeholder_names_its_field_in_ascii_as_typescript_reads_it() -> None:
    # The field's name (its alias) isn't ASCII: not a placeholder in TypeScript, so not here.
    refused = "approval.title has a brace that isn't part of a {field} placeholder"
    with pytest.raises(DefinitionError, match=re.escape(f'Tool "acme.resize": {refused}')):
        _resize_tool({"title": "Resize to {gr\u00f6\u00dfe}"})


def test_an_http_tools_approval_is_checked_the_same_way() -> None:
    def charge(approval: dict[str, Any]) -> Any:
        return http_tool(
            id="acme.charge", description="Charges.", input=Refund, output=Done,
            method="POST", url_template="https://api.example.com/orders/{order_id}",
            approval=approval,
        )

    kept = {"title": "Charge order #{order_id}"}
    assert charge(kept).approval == kept
    with pytest.raises(DefinitionError, match=re.escape("approval.title names {total}")):
        charge({"title": "Charge {total}"})
