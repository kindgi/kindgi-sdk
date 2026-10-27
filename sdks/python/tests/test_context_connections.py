# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A tool reads the connections it declares, as the runtime sends them; their tokens never print."""

from __future__ import annotations

from kindgi import ConnectionAccount, ConnectionRejected, ToolConnection, ToolContext
from kindgi.pack.context import Cancellation

TOKEN = "ya29.acme-token"
MAIL = {
    "connectionId": "c-1",
    "app": "google",
    "appName": "Google",
    "accessToken": TOKEN,
    "account": {"id": "g-1", "label": "ana@acme.example"},
    "expiresAt": "2026-10-23T01:00:00.000Z",
}


def test_the_context_reads_connections_by_the_tools_name() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "connections": {"mail": MAIL}}, Cancellation()
    )
    assert ctx.connections["mail"] == ToolConnection(
        connection_id="c-1",
        app="google",
        app_name="Google",
        access_token=TOKEN,
        account=ConnectionAccount(id="g-1", label="ana@acme.example"),
        expires_at="2026-10-23T01:00:00.000Z",
    )


def test_neither_the_context_nor_a_connection_prints_the_token() -> None:
    ctx = ToolContext.from_wire(
        {"tenantId": "t-1", "runId": "r-1", "connections": {"mail": MAIL}}, Cancellation()
    )
    assert TOKEN not in repr(ctx)
    assert TOKEN not in repr(ctx.connections["mail"])
    assert "ana@acme.example" in repr(ctx.connections["mail"])


def test_none_declared_an_older_runtime_and_a_malformed_entry_give_none() -> None:
    older = ToolContext.from_wire({"tenantId": "t-1", "runId": "r-1"}, Cancellation())
    assert dict(older.connections) == {}
    broken = {**MAIL, "account": {"id": "g-1"}}
    odd = ToolContext.from_wire(
        {
            "tenantId": "t-1",
            "runId": "r-1",
            "connections": {"mail": broken, "inbox": {**MAIL, "accessToken": 7}, "repos": MAIL},
        },
        Cancellation(),
    )
    assert list(odd.connections) == ["repos"]


def test_without_an_expiry_it_is_none() -> None:
    plain = {k: v for k, v in MAIL.items() if k != "expiresAt"}
    connection = ToolConnection.from_wire(plain)
    assert connection is not None and connection.expires_at is None


def test_a_rejection_names_the_connection_and_says_why() -> None:
    rejected = ConnectionRejected("mail", "the app answered 401")
    assert rejected.connection == "mail" and str(rejected) == "the app answered 401"
    assert str(ConnectionRejected("mail")) == 'the app refused the connection "mail"'


def test_a_unit_test_passes_its_own() -> None:
    connection = ToolConnection.from_wire(MAIL)
    assert connection is not None
    ctx = ToolContext.for_test(connections={"mail": connection})
    assert ctx.connections["mail"].access_token == TOKEN
