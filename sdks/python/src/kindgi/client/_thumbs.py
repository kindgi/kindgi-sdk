# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`client.corrections.thumbs`: an end user's thumbs up or down on a run's answer.

A mixin of the generated corrections resource (`gen_client.py`'s `MIXINS`),
calling only its generated `create`.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol
from uuid import UUID

from . import _models

__all__ = ["AsyncThumbs", "Thumbs"]


class _Creates(Protocol):
    def create(
        self,
        body: Mapping[str, Any] | None = None,
        /,
        *,
        idempotency_key: str | None = None,
        timeout: float | None = None,
        **fields: Any,
    ) -> _models.Correction: ...


class _AsyncCreates(Protocol):
    async def create(
        self,
        body: Mapping[str, Any] | None = None,
        /,
        *,
        idempotency_key: str | None = None,
        timeout: float | None = None,
        **fields: Any,
    ) -> _models.Correction: ...


def _fields(run_id: str | UUID, participant_id: str, up: bool, why: str | None) -> dict[str, Any]:
    return {
        "run_id": str(run_id),
        "participant_id": participant_id,
        "answer": "right" if up else "wrong",
        **({"why": why} if why is not None else {}),
    }


class Thumbs:
    def thumbs(
        self: _Creates,
        *,
        run_id: str | UUID,
        participant_id: str,
        up: bool,
        why: str | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
    ) -> _models.Correction:
        """An end user's thumbs up or down on a run's answer, from your app's server.

        A correction with `answer` `right` (up) or `wrong` (down), made for the end
        user (`participant_id`, your opaque id for them), with their words as `why`.
        A thumbs down needs `why`: a bare "wrong" can't be checked, and the API
        refuses it with a 400. Your page posts the thumbs to your server, which
        calls this; a Kindgi token never goes to a browser. `POST /v1/corrections`
        """
        return self.create(
            idempotency_key=idempotency_key,
            timeout=timeout,
            **_fields(run_id, participant_id, up, why),
        )


class AsyncThumbs:
    async def thumbs(
        self: _AsyncCreates,
        *,
        run_id: str | UUID,
        participant_id: str,
        up: bool,
        why: str | None = None,
        idempotency_key: str | None = None,
        timeout: float | None = None,
    ) -> _models.Correction:
        """An end user's thumbs up or down on a run's answer, from your app's server.

        A correction with `answer` `right` (up) or `wrong` (down), made for the end
        user (`participant_id`, your opaque id for them), with their words as `why`.
        A thumbs down needs `why`: a bare "wrong" can't be checked, and the API
        refuses it with a 400. Your page posts the thumbs to your server, which
        calls this; a Kindgi token never goes to a browser. `POST /v1/corrections`
        """
        return await self.create(
            idempotency_key=idempotency_key,
            timeout=timeout,
            **_fields(run_id, participant_id, up, why),
        )
