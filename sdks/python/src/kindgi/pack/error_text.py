# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""What a thrown error says in a failed call's answer, as the TypeScript service says it: its
message masked, with its causes (`kindgi.log.describe_causes`), and its `cause` field, each with
the call's own values taken out first."""

from __future__ import annotations

import json
import traceback
from collections.abc import Callable
from typing import Any

from ..log import REDACTED, describe_causes, scrub_text
from .context import ToolContext

MIN_SECRET_LENGTH = 4
"""A secret of fewer characters isn't looked for. It would turn up inside ordinary words, and
masking each of those would garble the message without hiding the secret."""


def _same(text: str) -> str:
    return text


def said(cause: BaseException, without: Callable[[str], str] = _same) -> str:
    """The error for a failure's message: `Name: message`, masked with `scrub_text`'s full mask,
    then its causes. The message reaches the run's record, the console and the model, which are
    more readers than a log's. Text with no cause and no secret shape reads as it did.
    `without` takes the call's values out first (`without_values`)."""
    try:
        message = str(cause)
    except Exception:
        message = ""
    head = scrub_text(without(f"{type(cause).__name__}: {message}"), full_mask=True)
    return head + describe_causes(cause, first=without)


def serialize_cause(cause: BaseException, without: Callable[[str], str] = _same) -> dict[str, Any]:
    """The error for a failure's `cause` field: its class's name, its message and its traceback
    (its causes' too), with the call's values taken out."""
    return {
        "name": type(cause).__name__,
        "message": without(str(cause)),
        "stack": without("".join(traceback.format_exception(cause))),
    }


def without_values(ctx: ToolContext) -> Callable[[str], str]:
    """A text with the call's values replaced by `[redacted]`: first each connection's token,
    wherever the text spells it, then each secret, and the call's files token
    (`MIN_SECRET_LENGTH` characters or more; a value that isn't a string is passed over), as it
    is or escaped the way a JSON string writes it, for a request body quoted in a message. A
    secret's first part counts too, up to the last place in it where the text stops: a line
    break, the text's end, or just before `"...`, where a quoted value was shortened. So a key of
    several lines that the text quotes only in part loses every line up to the one where the
    text goes on differently. Matches that overlap or touch become one `[redacted]`."""
    tokens = list(
        dict.fromkeys(c.access_token for c in ctx.connections.values() if c.access_token != "")
    )
    secrets: list[Any] = list(ctx.secrets.values())
    if ctx.files is not None:
        secrets.append(ctx.files._token)
    spellings = list(
        dict.fromkeys(
            spelling
            for secret in secrets
            if isinstance(secret, str) and len(secret) >= MIN_SECRET_LENGTH
            for spelling in (secret, json.dumps(secret, ensure_ascii=False)[1:-1])
        )
    )
    if not tokens and not spellings:
        return _same

    def without(text: str) -> str:
        return _masked(_tokened(text, tokens), spellings)

    return without


def _tokened(text: str, tokens: list[str]) -> str:
    """`text` with every place a token spells replaced."""
    hidden = bytearray(len(text))
    for token in tokens:
        at = text.find(token)
        while at != -1:
            hidden[at : at + len(token)] = b"\x01" * len(token)
            at = text.find(token, at + 1)
    return _joined(text, hidden)


def _masked(text: str, spellings: list[str]) -> str:
    """`text` with every stretch a secret spells, whole or as a first part up to where the text
    stops, replaced."""
    hidden = bytearray(len(text))
    for spelling in spellings:
        # Every place the secret's first characters appear: from each, how much of it the text
        # spells there.
        opening = spelling[:MIN_SECRET_LENGTH]
        at = text.find(opening)
        while at != -1:
            n = _hidden_length(text, at, spelling)
            hidden[at : at + n] = b"\x01" * n
            at = text.find(opening, at + 1)
    return _joined(text, hidden)


def _hidden_length(text: str, at: int, spelling: str) -> int:
    """How many characters of `text` from `at` are `spelling`'s to hide: all it spells there
    when that's the whole of it; else up to the last place in what it spells,
    `MIN_SECRET_LENGTH` characters in or more, where the text stops; else none."""
    run = 0
    while run < len(spelling) and at + run < len(text) and text[at + run] == spelling[run]:
        run += 1
    if run == len(spelling):
        return run
    for end in range(run, MIN_SECRET_LENGTH - 1, -1):
        if _stops_at(text, at + end):
            return end
    return 0


def _stops_at(text: str, at: int) -> bool:
    return at == len(text) or text[at] in "\n\r" or text.startswith('"...', at)


def _joined(text: str, hidden: bytearray) -> str:
    """`text` with each run of hidden characters as one `[redacted]`."""
    out: list[str] = []
    for i, ch in enumerate(text):
        if not hidden[i]:
            out.append(ch)
        elif i == 0 or not hidden[i - 1]:
            out.append(REDACTED)
    return "".join(out)
