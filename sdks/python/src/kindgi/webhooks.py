# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Verify the webhooks Kindgi sends (`run.finished`, `webhook.test`).

Requests are signed in the Standard Webhooks format
(https://www.standardwebhooks.com), symmetric variant `v1`:

    webhook-id:        the event id (the same on every retry)
    webhook-timestamp: Unix seconds when the request was signed
    webhook-signature: `v1,<base64 HMAC-SHA256>`, space-separated when
                       several secrets sign (secret rotation)

The signed content is `{id}.{timestamp}.{body}`, with `body` the raw request
body exactly as sent. Secrets are `whsec_` + base64 of the key bytes. This
is the Python counterpart of `verifyWebhook` in `@kindgi/crypto`; any
Standard Webhooks library verifies the same requests.

    from kindgi import webhooks

    body = await request.body()  # the raw bytes, never re-serialized JSON
    try:
        delivery = webhooks.verify(secret, request.headers, body)
    except webhooks.WebhookVerificationError:
        return Response(status_code=401)
    event = webhooks.parse_event(body)

Delivery is at least once: deduplicate on `delivery.id`.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import math
import re
import secrets as _secrets
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Annotated, Literal, Protocol, TypeAlias

from pydantic import Field, TypeAdapter

from .client import models

__all__ = [
    "DEFAULT_TOLERANCE_SECONDS",
    "ID_HEADER",
    "SECRET_MIN_BYTES",
    "SECRET_PREFIX",
    "SIGNATURE_HEADER",
    "TIMESTAMP_HEADER",
    "RequestHeaders",
    "VerifiedWebhook",
    "VerifyFailure",
    "WebhookEvent",
    "WebhookVerificationError",
    "generate_secret",
    "is_strong_secret",
    "parse_event",
    "sign",
    "signed_headers",
    "verify",
]

SECRET_PREFIX = "whsec_"
"""Prefix of a webhook signing secret."""

ID_HEADER = "webhook-id"
TIMESTAMP_HEADER = "webhook-timestamp"
SIGNATURE_HEADER = "webhook-signature"

DEFAULT_TOLERANCE_SECONDS = 300
"""How far a request's timestamp may be from the receiver's clock (seconds)."""

SECRET_MIN_BYTES = 24
"""The fewest random bytes a webhook secret may have (Standard Webhooks: 24 to 64)."""

_VERSION = "v1"
_SECRET_BYTES = 32
_TIMESTAMP = re.compile(r"[0-9]{1,15}")
_BASE64 = re.compile(r"[A-Za-z0-9+/]+={0,2}")

VerifyFailure = Literal[
    "missing-headers",
    "invalid-timestamp",
    "timestamp-out-of-tolerance",
    "invalid-secret",
    "no-matching-signature",
]

WebhookEvent: TypeAlias = Annotated[
    models.RunFinishedEvent | models.WebhookTestEvent, Field(discriminator="type")
]
"""The JSON body of a webhook request; `type` says which event it is."""

_EVENTS: TypeAdapter[WebhookEvent] = TypeAdapter(WebhookEvent)


class WebhookVerificationError(Exception):
    """The request isn't a webhook signed with this secret; `reason` says which check failed."""

    def __init__(self, reason: VerifyFailure) -> None:
        super().__init__(reason)
        self.reason: VerifyFailure = reason


class RequestHeaders(Protocol):
    """Request headers: a mapping (Starlette, Django, aiohttp, a `dict`), Werkzeug's `Headers`,
    or `http.server`'s — anything whose `items()` gives name/value pairs."""

    def items(self) -> Iterable[tuple[str, str]]: ...


@dataclass(frozen=True)
class VerifiedWebhook:
    """A request whose signature holds."""

    id: str
    """The event id (`webhook-id`): the same on every retry, so deduplicate on it."""
    timestamp: int
    """Unix seconds when Kindgi signed the request."""


def verify(
    secret: str,
    headers: RequestHeaders,
    body: bytes | str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Callable[[], float] = time.time,
) -> VerifiedWebhook:
    """Verify a received webhook, or raise `WebhookVerificationError`.

    The timestamp must be within `tolerance_seconds` of `now()` (Unix
    seconds) and at least one `v1` signature in the header must match;
    comparison is constant-time. `body` is the raw request body, exactly as
    received (a `str` is taken as its UTF-8 bytes). Header names match
    case-insensitively.
    """
    msg_id = _header(headers, ID_HEADER)
    timestamp_raw = _header(headers, TIMESTAMP_HEADER)
    signature_header = _header(headers, SIGNATURE_HEADER)
    if msg_id is None or timestamp_raw is None or signature_header is None:
        raise WebhookVerificationError("missing-headers")
    if _TIMESTAMP.fullmatch(timestamp_raw) is None:
        raise WebhookVerificationError("invalid-timestamp")
    timestamp = int(timestamp_raw)
    if abs(math.floor(now()) - timestamp) > tolerance_seconds:
        raise WebhookVerificationError("timestamp-out-of-tolerance")
    key = _parse_secret(secret)
    if key is None:
        raise WebhookVerificationError("invalid-secret")

    expected = _hmac(key, _signed_content(msg_id, timestamp_raw, body))
    for part in signature_header.split(" "):
        version, comma, encoded = part.partition(",")
        if not comma or version != _VERSION:
            continue
        provided = _decode_signature(encoded)
        if provided is not None and hmac.compare_digest(provided, expected):
            return VerifiedWebhook(id=msg_id, timestamp=timestamp)
    raise WebhookVerificationError("no-matching-signature")


def parse_event(body: bytes | str) -> WebhookEvent:
    """The typed event in a verified request's body: a `RunFinishedEvent` or a `WebhookTestEvent`.

    Raises `pydantic.ValidationError` for a body that isn't an event this
    version of the SDK knows.
    """
    return _EVENTS.validate_json(body)


def sign(secret: str | Sequence[str], *, id: str, timestamp: int, body: bytes | str) -> str:
    """The `webhook-signature` header value: `v1,<base64>` per secret, space-separated.

    Pass the new and the previous secret during a rotation: a receiver
    holding either one accepts the request. For tests of a receiver, or a
    service of your own that sends webhooks in the same format.
    """
    if type(timestamp) is not int or timestamp < 0:
        raise ValueError("timestamp must be a non-negative integer (Unix seconds)")
    keys: list[bytes] = []
    for one in [secret] if isinstance(secret, str) else secret:
        key = _parse_secret(one)
        if key is None:
            raise ValueError("a webhook secret is `whsec_` + base64 of the key bytes")
        keys.append(key)
    if not keys:
        raise ValueError("at least one secret is required")
    content = _signed_content(id, str(timestamp), body)
    return " ".join(
        f"{_VERSION},{base64.b64encode(_hmac(key, content)).decode('ascii')}" for key in keys
    )


def signed_headers(
    secret: str | Sequence[str], *, id: str, timestamp: int, body: bytes | str
) -> dict[str, str]:
    """The three signed headers for a request, ready to send."""
    return {
        ID_HEADER: id,
        TIMESTAMP_HEADER: str(timestamp),
        SIGNATURE_HEADER: sign(secret, id=id, timestamp=timestamp, body=body),
    }


def generate_secret() -> str:
    """A new random signing secret: `whsec_` + base64 of 32 random bytes."""
    return SECRET_PREFIX + base64.b64encode(_secrets.token_bytes(_SECRET_BYTES)).decode("ascii")


def is_strong_secret(secret: str) -> bool:
    """Whether a secret is `whsec_` + base64 (or the bare base64) of at least 24 bytes."""
    key = _parse_secret(secret)
    return key is not None and len(key) >= SECRET_MIN_BYTES


def _signed_content(msg_id: str, timestamp: str, body: bytes | str) -> bytes:
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    return f"{msg_id}.{timestamp}.".encode() + body_bytes


def _hmac(key: bytes, content: bytes) -> bytes:
    return hmac.new(key, content, hashlib.sha256).digest()


def _parse_secret(secret: str) -> bytes | None:
    """Key bytes of a `whsec_…` (or bare base64) secret; `None` when malformed."""
    encoded = secret.removeprefix(SECRET_PREFIX)
    if _BASE64.fullmatch(encoded) is None:
        return None
    try:
        key = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=True)
    except binascii.Error:
        return None
    return key or None


def _decode_signature(encoded: str) -> bytes | None:
    try:
        return base64.b64decode(encoded, validate=True)
    except binascii.Error:
        return None


def _header(headers: RequestHeaders, name: str) -> str | None:
    """The first header called `name` (any case); `None` when absent or empty."""
    for key, value in headers.items():
        if key.lower() == name:
            return value or None
    return None
