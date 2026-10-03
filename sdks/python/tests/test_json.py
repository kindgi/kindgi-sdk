# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from __future__ import annotations

import json

import pytest

from kindgi._json import js_number, stable_dumps


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1.0, "1"),
        (-0.0, "0"),
        (0.1, "0.1"),
        (1.5, "1.5"),
        (1e-7, "1e-7"),
        (0.000001, "0.000001"),
        (1e21, "1e+21"),
        (123456789012345680000.0, "123456789012345680000"),
        (1.2345678901234567e-8, "1.2345678901234567e-8"),
        (-2.5e30, "-2.5e+30"),
    ],
)
def test_numbers_print_as_javascript_prints_them(value: float, expected: str) -> None:
    assert js_number(value) == expected


def test_non_finite_numbers_are_refused() -> None:
    with pytest.raises(ValueError):
        js_number(float("nan"))


def test_canonical_form_sorts_keys_and_indents_by_two() -> None:
    text = stable_dumps({"b": [1, {"d": True, "c": None}], "a": {}, "e": []})
    assert (
        text
        == '{\n  "a": {},\n  "b": [\n    1,\n    {\n      "c": null,\n      "d": true\n    }\n  ],\n  "e": []\n}'
    )
    assert json.loads(text) == {"b": [1, {"d": True, "c": None}], "a": {}, "e": []}


def test_keys_sort_in_utf16_code_unit_order() -> None:
    # U+FF5E sorts after U+1F600 in code points, before it in UTF-16 code units (as JavaScript sorts).
    text = stable_dumps({"\U0001f600": 1, "～": 2})
    assert text.index("\U0001f600") < text.index("～")


def test_strings_keep_unicode_and_escape_controls() -> None:
    assert stable_dumps("é\n\x01") == '"é\\n\\u0001"'
