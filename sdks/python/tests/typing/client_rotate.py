# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""`secrets.rotate` answers a sync or an async rotation, told apart by `kind` (T327).

Not a test pytest runs: pyright type-checks it (strict, `pyproject.toml`'s
`include`). A method typed as the sync model alone would let `rotation_id`
fail here, as it would in a user's code.
"""

from typing import assert_type

from kindgi.client import AsyncKindgi, Kindgi, models


def sync_rotate(kindgi: Kindgi) -> None:
    answer = kindgi.secrets.rotate("db-password", env_name="prod", scope_kind="tenant")
    if answer.kind == "async":
        assert_type(answer, models.SecretRotateResponseAsync)
        print(answer.rotation_id, answer.events_url)
    else:
        assert_type(answer, models.SecretRotateResponseSync)
        print(answer.new_version_id, answer.old_version_id)


async def async_rotate(kindgi: AsyncKindgi) -> None:
    answer = await kindgi.secrets.rotate("db-password", env_name="prod", scope_kind="tenant")
    if isinstance(answer, models.SecretRotateResponseAsync):
        print(answer.status_url)
    else:
        print(answer.new_version_id)
