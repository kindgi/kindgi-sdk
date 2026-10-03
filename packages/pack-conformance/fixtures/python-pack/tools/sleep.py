# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

import asyncio

from pydantic import BaseModel, Field

from kindgi import tool


class SleepInput(BaseModel):
    ms: int = Field(ge=0)


class Slept(BaseModel):
    slept: int


@tool(id="conformance.sleep")
async def sleep(input: SleepInput) -> Slept:
    """Waits `ms` milliseconds, or until the call is cancelled."""
    await asyncio.sleep(input.ms / 1000)
    return Slept(slept=input.ms)
