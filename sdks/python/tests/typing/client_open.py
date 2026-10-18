# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A response's enums and tagged unions are typed open: a newer runtime's value is text,
a newer union member its `<Union>Unrecognized` (`kindgi.client._open`).

Not a test pytest runs: pyright type-checks it (strict, `pyproject.toml`'s
`include`). Code that matches every known value must still handle the rest.
"""

from typing import Literal, assert_type

from kindgi.client import Kindgi, models


def read_open(kindgi: Kindgi) -> None:
    promotion = kindgi.agents.live.unpin("acme.triage", scope={"kind": "tenant"})
    assert_type(promotion.action, Literal["promote", "rollback", "unpin"] | str)
    scope = promotion.scope
    if isinstance(scope, models.LiveScopeUnrecognized):
        assert_type(scope.kind, str)
    elif scope.kind == "tenant":
        assert_type(scope, models.LiveScopeTenant)


def read_open_one_value(kindgi: Kindgi) -> None:
    # An enum of one value may gain values: open as well. A `const` stays closed.
    key = kindgi.signing_keys.trust(keyId="acme-1", publicKey="acme-public-key")
    assert_type(key.algorithm, Literal["ed25519"] | str)
