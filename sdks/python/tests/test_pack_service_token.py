# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The pack service reads `KINDGI_PACK_SERVICE_TOKEN` as the server does.

The token travels in an HTTP header, which never carries surrounding
whitespace: a secret stored with a trailing newline matches once both
sides drop it. A token a header can't carry is a startup error.
"""

from __future__ import annotations

import pytest

from kindgi.pack.serve import ServeConfig, read_config

REFUSED = (
    "KINDGI_PACK_SERVICE_TOKEN may hold only printable ASCII without spaces "
    "(it travels in an HTTP header). Use a random value such as `openssl rand -hex 32`."
)


@pytest.mark.parametrize("raw", ["3f9ac0ffee", "3f9ac0ffee\n", "  3f9ac0ffee\r\n"])
def test_surrounding_whitespace_is_dropped(raw: str) -> None:
    config = read_config([], {"KINDGI_PACK_SERVICE_TOKEN": raw})
    assert isinstance(config, ServeConfig)
    assert config.token == "3f9ac0ffee"


@pytest.mark.parametrize("raw", ["", " \n"])
def test_unset_or_blank_is_required(raw: str) -> None:
    assert read_config([], {"KINDGI_PACK_SERVICE_TOKEN": raw}) == [
        "KINDGI_PACK_SERVICE_TOKEN is required"
    ]


@pytest.mark.parametrize("raw", ["two words", "tab\tinside", "line\nbreak", "café"])
def test_what_a_header_cant_carry_is_refused(raw: str) -> None:
    assert read_config([], {"KINDGI_PACK_SERVICE_TOKEN": raw}) == [REFUSED]
