# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Errors: a code the client doesn't list is read by its HTTP status."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from kindgi.client import (
    AuthError,
    ConflictError,
    GuardrailViolationError,
    InvalidRequestError,
    NotFoundError,
    RateLimitedError,
    ServerError,
)
from kindgi.client._errors import from_wire

OPENAPI = Path(__file__).resolve().parents[3] / "packages" / "api" / "openapi.json"


def body(code: str, **details: Any) -> dict[str, Any]:
    return {"error": {"code": code, "message": "m", "details": details, "requestId": "r"}}


@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (404, NotFoundError),
        (410, NotFoundError),
        (400, InvalidRequestError),
        (413, InvalidRequestError),
        (409, ConflictError),
        # 422 stays a server error: the docs match its codes there.
        (422, ServerError),
        (401, AuthError),
        (403, AuthError),
        (429, RateLimitedError),
        (500, ServerError),
        (503, ServerError),
    ],
)
def test_an_unlisted_code_is_read_by_its_status(status: int, kind: type) -> None:
    error = from_wire(body("org-not-found", id="o-1"), status)
    assert type(error) is kind
    assert error.server_code == "org-not-found"


def test_an_unlisted_not_found_names_its_resource() -> None:
    error = from_wire(body("org-not-found", id="o-1"), 404)
    assert isinstance(error, NotFoundError)
    assert (error.kind, error.id) == ("org", "o-1")


def test_an_unlisted_403_is_forbidden_and_401_unauthenticated() -> None:
    forbidden = from_wire(body("tenant-locked"), 403)
    unauthenticated = from_wire(body("session-gone"), 401)
    assert isinstance(forbidden, AuthError) and forbidden.reason == "forbidden"
    assert isinstance(unauthenticated, AuthError) and unauthenticated.reason == "unauthenticated"


@pytest.mark.parametrize(
    "code",
    [
        "eval-suite-already-registered",
        "policy-already-registered",
        "version-already-exists",
        "gate-policy-already-registered",
        "gate-policy-needs-pin",
        "gate-policy-descendant-unpinned",
        "promotion-superseded",
    ],
)
def test_an_already_registered_code_is_a_conflict(code: str) -> None:
    assert type(from_wire(body(code), 409)) is ConflictError


def test_a_refused_provider_registration_is_an_invalid_request_with_its_issues() -> None:
    issues = [{"path": "/adapter_config/api", "message": "adapter_config.api must be one of …"}]
    error = from_wire(body("provider-config-invalid", issues=issues), 422)
    assert type(error) is InvalidRequestError
    assert error.issues == issues
    assert error.server_code == "provider-config-invalid"


def test_a_listed_code_keeps_its_class_whatever_the_status() -> None:
    assert type(from_wire(body("slug-conflict"), 500)) is ConflictError


@pytest.mark.parametrize(
    "code", ["budget-exceeded", "agent-turn-aborted", "output-schema-violation"]
)
def test_a_documented_422_is_still_a_server_error(code: str) -> None:
    error = from_wire(body(code), 422)
    assert type(error) is ServerError
    assert error.server_code == code


# The family a documented code belongs in: its HTTP status's (`x-error-codes` in
# openapi.json), except where this client classifies a code on purpose.
_EXCEPTIONS: dict[str, type] = {
    # Its own class, with the violations.
    "guardrail-violation": GuardrailViolationError,
    # A provider registration the adapter refuses: an invalid request, with its issues.
    "provider-config-invalid": InvalidRequestError,
}
_BY_STATUS: dict[int, type] = {
    400: InvalidRequestError,
    413: InvalidRequestError,
    401: AuthError,
    403: AuthError,
    404: NotFoundError,
    410: NotFoundError,
    409: ConflictError,
    429: RateLimitedError,
}


def expected_class(code: str, status: int) -> type:
    """422 and 5xx are server errors: the docs match their codes by `server_code`."""
    return _EXCEPTIONS.get(code) or _BY_STATUS.get(status, ServerError)


def test_every_documented_code_is_in_its_status_family_and_keeps_its_code() -> None:
    spec = json.loads(OPENAPI.read_text())
    codes: dict[str, int] = spec["components"]["schemas"]["WireError"]["x-error-codes"]
    assert len(codes) > 100
    wrong = [
        f"{code} ({status}): {type(error).__name__}, not {expected_class(code, status).__name__}"
        for code, status in codes.items()
        if type(error := from_wire(body(code), status)) is not expected_class(code, status)
    ]
    assert wrong == []
    assert [c for c, s in codes.items() if from_wire(body(c), s).server_code != c] == []
