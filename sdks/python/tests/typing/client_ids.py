# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A model's id passes straight back into the client (T309).

Not a test pytest runs: pyright type-checks it (strict, `pyproject.toml`'s
`include`), so a method that took only `str` for an id the models carry
as `UUID` fails CI here, as it would in a user's code.
"""

from kindgi.client import AsyncKindgi, Kindgi, models


def sync_ids(kindgi: Kindgi, run: models.Run, approval: models.Approval) -> None:
    kindgi.runs.get(run.id)
    kindgi.approvals.complete(approval.id, decision="approve")
    kindgi.approvals.list(wait_token_id=[run.id])
    kindgi.runs.get(str(run.id))


async def async_ids(kindgi: AsyncKindgi, run: models.Run, approval: models.Approval) -> None:
    await kindgi.runs.get(run.id)
    await kindgi.approvals.complete(approval.id, decision="approve")
