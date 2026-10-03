# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The Kindgi API client.

    from kindgi.client import Kindgi

    client = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN
    run = client.runs.start(flow="acme.ledger.record-flow", input={"vendor": "Acme"})
    print(run.status, run.output)

Every operation of the API (`@kindgi/api/openapi.json`) is a method: the
operation id `approvals.reviewers.list` is `client.approvals.reviewers.list()`.
Request bodies are a model from `kindgi.client.models`, a mapping, or their
fields as keywords; answers are models. Errors are typed (`NotFoundError`,
`GuardrailViolationError`, …). `AsyncKindgi` is the same with asyncio.
"""

from __future__ import annotations

from . import _models as models
from ._client import AsyncKindgi, Kindgi, apaginate, paginate
from ._errors import (
    AuthError,
    ConflictError,
    GuardrailViolationError,
    InvalidRequestError,
    KindgiApiError,
    NetworkError,
    NotFoundError,
    RateLimitedError,
    ServerError,
)

__all__ = [
    "AsyncKindgi",
    "AuthError",
    "ConflictError",
    "GuardrailViolationError",
    "InvalidRequestError",
    "Kindgi",
    "KindgiApiError",
    "NetworkError",
    "NotFoundError",
    "RateLimitedError",
    "ServerError",
    "apaginate",
    "models",
    "paginate",
]
