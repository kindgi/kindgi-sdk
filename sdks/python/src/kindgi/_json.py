# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Canonical JSON — the byte form of a pack index.

`stable_dumps` writes what the TypeScript indexer writes for the same value:
keys sorted at every level (UTF-16 code-unit order, as JavaScript sorts),
two-space indentation, and numbers formatted the way `JSON.stringify` formats
them (`1` not `1.0`, `1e-7` not `1e-07`). Same value, same bytes — the
property a build's integrity check depends on.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

__all__ = ["compact_dumps", "js_number", "stable_dumps"]


def stable_dumps(value: Any) -> str:
    """Serialize `value` canonically (no trailing newline)."""
    out: list[str] = []
    _write(value, 0, out)
    return "".join(out)


def compact_dumps(value: Any) -> str:
    """Serialize `value` without whitespace — a response body."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _write(value: Any, depth: int, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        out.append(js_number(value))
    elif isinstance(value, Mapping):
        mapping: Mapping[Any, Any] = value  # pyright: ignore[reportUnknownVariableType]
        keys = sorted((_key(k) for k in mapping), key=_utf16)
        if not keys:
            out.append("{}")
            return
        inner = "  " * (depth + 1)
        out.append("{\n")
        for i, key in enumerate(keys):
            if i:
                out.append(",\n")
            out.append(f"{inner}{json.dumps(key, ensure_ascii=False)}: ")
            _write(mapping[key], depth + 1, out)
        out.append(f"\n{'  ' * depth}}}")
    elif isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        items: Sequence[Any] = value  # pyright: ignore[reportUnknownVariableType]
        if not items:
            out.append("[]")
            return
        inner = "  " * (depth + 1)
        out.append("[\n")
        for i, item in enumerate(items):
            if i:
                out.append(",\n")
            out.append(inner)
            _write(item, depth + 1, out)
        out.append(f"\n{'  ' * depth}]")
    else:
        raise TypeError(f"{type(value).__name__} is not JSON-serializable")


def _key(key: Any) -> str:
    if not isinstance(key, str):
        raise TypeError(f"JSON object keys must be strings, got {type(key).__name__}")
    return key


def _utf16(key: str) -> bytes:
    # Big-endian UTF-16 bytes compare in code-unit order — JavaScript's string order.
    return key.encode("utf-16-be", "surrogatepass")


def js_number(value: float) -> str:
    """Format a float as ECMAScript `Number.prototype.toString` does."""
    if not math.isfinite(value):
        raise ValueError(f"{value!r} is not valid JSON")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    # repr gives the shortest digits that round-trip — the same digits JavaScript picks.
    digits_tuple = Decimal(repr(abs(value))).as_tuple()
    digits = "".join(str(d) for d in digits_tuple.digits).lstrip("0")
    exponent = int(digits_tuple.exponent)  # value = int(all digits) * 10**exponent
    stripped = digits.rstrip("0")
    exponent += len(digits) - len(stripped)
    digits = stripped
    k = len(digits)
    n = exponent + k  # value = 0.digits * 10**n
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    mantissa = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{sign}{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"
