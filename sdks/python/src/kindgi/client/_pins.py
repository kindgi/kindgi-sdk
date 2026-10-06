# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""An agent version's pins digest, as the runtime computes it."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel

from .._json import canonical_dumps

__all__ = ["pins_digest"]


def pins_digest(pins: Mapping[str, Any] | BaseModel) -> str:
    """`sha256:<hex>` of an agent version's pins, the string in its `pins_digest`.

    `pins` is an agent version's `pins` (a model or a mapping with `tools`,
    `prompts` and `settings`). Two agent versions with the same digest run
    the same blocks. The same string as `pinsDigest` in `@kindgi/agents`.
    """
    raw: Mapping[str, Any] = pins.model_dump(mode="json") if isinstance(pins, BaseModel) else pins
    canonical = canonical_dumps(
        {
            "tools": dict(raw.get("tools") or {}),
            "prompts": dict(raw.get("prompts") or {}),
            "settings": dict(raw.get("settings") or {}),
        }
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
