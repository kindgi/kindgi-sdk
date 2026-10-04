# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The Kindgi API client.

    from kindgi.client import Kindgi

    client = Kindgi()  # KINDGI_API_URL, KINDGI_API_TOKEN; in development, the running kindgi dev
    run = client.runs.start(flow="acme.ledger.record-flow", input={"vendor": "Acme"})
    print(run.status, run.output)

Every operation of the API (`@kindgi/api/openapi.json`) is a method: the
operation id `approvals.reviewers.list` is `client.approvals.reviewers.list()`.
Request bodies are a model from `kindgi.client.models`, a mapping, or their
fields as keywords; answers are models. Errors are typed (`NotFoundError`,
`GuardrailViolationError`, …). `AsyncKindgi` is the same with asyncio.

Without arguments, a client takes `KINDGI_API_URL` and `KINDGI_API_TOKEN`
from the environment. In development, when they're unset, it uses the running
`kindgi dev` (the nearest `.kindgirc.json`), and warns once
(`KindgiConfigWarning`) to put them in your env file (`.env` / `.env.local`).
Production (`KINDGI_ENV` or `NODE_ENV` set to `production`) never reads
`.kindgirc.json`.
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
from ._runtime_config import KindgiConfigWarning

__all__ = [
    "AsyncKindgi",
    "AuthError",
    "ConflictError",
    "GuardrailViolationError",
    "InvalidRequestError",
    "Kindgi",
    "KindgiApiError",
    "KindgiConfigWarning",
    "NetworkError",
    "NotFoundError",
    "RateLimitedError",
    "ServerError",
    "apaginate",
    "models",
    "paginate",
]
