# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Typed API errors — the Python side of `KindgiError` in `@kindgi/client`.

Every failure is a `KindgiApiError` subclass named after its category; the
server's own code stays on `.server_code`. The categories and the wire codes
that map to them are the TypeScript client's (`errors.ts` `fromWire`).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, ClassVar, Literal, cast

__all__ = [
    "AuthError",
    "ConflictError",
    "GuardrailViolationError",
    "InvalidRequestError",
    "KindgiApiError",
    "NetworkError",
    "NotFoundError",
    "RateLimitedError",
    "ServerError",
    "from_wire",
]


class KindgiApiError(Exception):
    """A Kindgi API call failed."""

    code: ClassVar[str] = "server"

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        server_code: str | None = None,
        details: Mapping[str, Any] | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.server_code = server_code
        self.details: Mapping[str, Any] = details or {}
        self.request_id = request_id

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}({self.message!r}, status={self.status}, "
            f"server_code={self.server_code!r})"
        )


class NetworkError(KindgiApiError):
    """The request didn't get an answer (connection, timeout, a body that isn't JSON)."""

    code = "network"


class AuthError(KindgiApiError):
    code = "auth"

    def __init__(
        self,
        message: str,
        *,
        reason: Literal["unauthenticated", "forbidden", "token-expired"],
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.reason = reason


class RateLimitedError(KindgiApiError):
    code = "rate-limited"

    def __init__(
        self, message: str, *, retry_after_seconds: float | None = None, **kw: Any
    ) -> None:
        super().__init__(message, **kw)
        self.retry_after_seconds = retry_after_seconds


class NotFoundError(KindgiApiError):
    code = "not-found"

    def __init__(self, message: str, *, kind: str, id: str, **kw: Any) -> None:
        super().__init__(message, **kw)
        self.kind = kind
        self.id = id


class ConflictError(KindgiApiError):
    code = "conflict"


class InvalidRequestError(KindgiApiError):
    code = "invalid-request"

    def __init__(self, message: str, *, issues: list[Mapping[str, Any]], **kw: Any) -> None:
        super().__init__(message, **kw)
        self.issues = issues


class GuardrailViolationError(KindgiApiError):
    code = "guardrail-violation"

    def __init__(
        self,
        message: str,
        *,
        violations: list[Mapping[str, Any]],
        evaluation_errors: list[Mapping[str, Any]],
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.violations = violations
        self.evaluation_errors = evaluation_errors


class ServerError(KindgiApiError):
    code = "server"


_NOT_FOUND = {
    "not-found", "run-not-found", "agent-not-found", "tool-not-found", "guardrail-not-found",
    "flow-not-found", "conversation-not-found", "approval-not-found", "reviewer-not-found",
    "proposal-not-found", "provenance-not-found", "observation-not-found", "blob-not-found",
    "audit-bundle-not-found", "signing-not-configured", "signing-key-not-found",
    "adapter-not-found", "fact-not-found", "identity-user-not-found", "provider-not-found",
    "capability-not-found", "token-not-found",
}  # fmt: skip
_CONFLICT = {
    "conflict", "already-terminal", "run-already-terminal", "idempotency-key-body-mismatch",
    "hitl-required", "agent-already-registered", "tool-already-registered",
    "guardrail-already-registered", "flow-already-registered", "conversation-closed",
    "provider-already-registered", "proposal-invalid-state-transition", "approval-not-decided",
    "slug-conflict", "project-default-already-exists", "registry-read-only",
    "policy-already-registered", "policy-scope-taken", "policy-scope-changed",
}  # fmt: skip
_INVALID = {
    "invalid-request", "validation-failed", "unknown-field", "bad-input", "unresolved-tool",
    "unresolved-guardrail", "schema-validation-failed", "invalid-agent", "invalid-tool-definition",
    "invalid-schema", "unknown-effect", "invalid-guardrail", "invalid-provider",
    "supervisor-header-missing",
}  # fmt: skip
_AUTH: Mapping[str, Literal["unauthenticated", "forbidden", "token-expired"]] = {
    "auth-missing": "unauthenticated",
    "auth-expired": "token-expired",
    "auth-revoked": "unauthenticated",
    "permission-denied": "forbidden",
}
_ID_FIELDS = (
    "agentId", "toolId", "runId", "adapterId", "userId", "providerId", "capabilityId", "tokenId",
    "factId", "guardrailId", "id",
)  # fmt: skip


def from_wire(body: Any, status: int, *, retry_after: str | None = None) -> KindgiApiError:
    """The error for a non-2xx answer (`{"error": {code, message, details, …}}`)."""
    inner = cast("dict[str, Any]", body).get("error") if isinstance(body, dict) else None
    if not isinstance(inner, dict):
        return ServerError(
            f"HTTP {status} without a recognizable error body", status=status, server_code="unknown"
        )
    error = cast("dict[str, Any]", inner)
    code = _text(error.get("code")) or "unknown"
    message = _text(error.get("message")) or f"Server error: {code}"
    raw_details = error.get("details")
    details = cast("dict[str, Any]", raw_details) if isinstance(raw_details, dict) else {}
    request_id = _text(error.get("requestId"))
    common: dict[str, Any] = {
        "status": status,
        "server_code": code,
        "details": details,
        "request_id": request_id,
    }

    if code == "auth":
        reason = error.get("reason")
        valid = reason in ("unauthenticated", "forbidden", "token-expired")
        return AuthError(message, reason=reason if valid else "unauthenticated", **common)
    if code in _AUTH:
        return AuthError(message, reason=_AUTH[code], **common)
    if code in ("rate-limited", "rate-limit-exceeded"):
        seconds = error.get("retryAfterSeconds")
        if (
            not isinstance(seconds, (int, float))
            and retry_after is not None
            and retry_after.isdigit()
        ):
            seconds = int(retry_after)
        return RateLimitedError(
            message,
            retry_after_seconds=float(seconds) if isinstance(seconds, (int, float)) else None,
            **common,
        )
    if code in _NOT_FOUND:
        kind = code.removesuffix("-not-found") or "unknown"
        found = next((v for k in _ID_FIELDS if (v := _text(details.get(k))) is not None), "unknown")
        return NotFoundError(message, kind=kind, id=found, **common)
    if code in _CONFLICT:
        return ConflictError(message, **common)
    if code in _INVALID:
        issues = _list(error.get("issues", details.get("issues")))
        return InvalidRequestError(message, issues=issues, **common)
    if code == "guardrail-violation":
        return GuardrailViolationError(
            message,
            violations=_list(details.get("violations")),
            evaluation_errors=_list(details.get("evaluationErrors")),
            **common,
        )
    return ServerError(message, **common)


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _list(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        cast("Mapping[str, Any]", v) for v in cast("list[Any]", value) if isinstance(v, Mapping)
    ]
