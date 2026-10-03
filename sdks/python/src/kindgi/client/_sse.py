# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Server-sent events: an incremental parser over text lines."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

__all__ = ["SseEvent", "SseParser"]


@dataclass(frozen=True)
class SseEvent:
    event: str
    data: Any
    id: str | None


class SseParser:
    """Feed it lines (no line terminators); it returns an event at each blank line.

    A `data:` payload that isn't JSON is dropped — one bad event doesn't end the stream.
    """

    def __init__(self) -> None:
        self._event = "message"
        self._data: list[str] = []
        self._id: str | None = None

    def feed(self, line: str) -> SseEvent | None:
        line = line.removesuffix("\r")
        if line == "":
            return self._dispatch()
        if line.startswith(":"):
            return None
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        elif field == "id":
            self._id = value
        return None

    def _dispatch(self) -> SseEvent | None:
        try:
            if not self._data:
                return None
            try:
                data = json.loads("\n".join(self._data))
            except ValueError:
                return None
            return SseEvent(event=self._event, data=data, id=self._id)
        finally:
            self._event = "message"
            self._data = []
            self._id = None
