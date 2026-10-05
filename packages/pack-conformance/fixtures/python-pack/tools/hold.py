# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

import asyncio
import os

from pydantic import BaseModel, Field

from kindgi import tool


class HoldInput(BaseModel):
    release: str = Field(min_length=1)


class Held(BaseModel):
    released: bool


@tool(id="conformance.hold")
async def hold(input: HoldInput) -> Held:
    """Prints `hold: <release>` on stdout, then waits until the file `release` exists, or until the call is cancelled."""
    print(f"hold: {input.release}", flush=True)
    while not os.path.exists(input.release):
        await asyncio.sleep(0.01)
    return Held(released=True)
