# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`pins_digest` computes the runtime's string for an agent version's pins.

The literal is asserted in `packages/agents/tests/pins.test.ts` too, so the
two SDKs agree byte for byte.
"""

from __future__ import annotations

from kindgi._json import canonical_dumps
from kindgi.client import models, pins_digest

PINS = {
    "tools": {"acme.lookup": "1.2.0", "acme.score": "2.0.0", "acme.ä-tool": "0.1.0"},
    "prompts": {},
    "settings": {"acme.weights": "3.1.4"},
}


def test_the_same_string_as_typescript() -> None:
    assert (
        pins_digest(PINS)
        == "sha256:9c6cc0500541a8d9120df89781d6abb173c249711fda3545b0bb6011327d85cc"
    )


def test_key_order_does_not_change_it_a_version_does() -> None:
    reordered = {
        "settings": PINS["settings"],
        "prompts": {},
        "tools": dict(reversed(PINS["tools"].items())),
    }
    assert pins_digest(reordered) == pins_digest(PINS)
    bumped = {**PINS, "tools": {**PINS["tools"], "acme.score": "2.0.1"}}
    assert pins_digest(bumped) != pins_digest(PINS)


def test_an_agent_versions_pins_model() -> None:
    assert pins_digest(models.AgentPins.model_validate(PINS)) == pins_digest(PINS)


def test_canonical_dumps_is_compact_and_sorted() -> None:
    assert canonical_dumps({"b": [1, 2.5, None], "a": {"d": True, "c": "x"}}) == (
        '{"a":{"c":"x","d":true},"b":[1,2.5,null]}'
    )
