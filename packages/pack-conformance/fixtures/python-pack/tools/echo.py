# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from pydantic import BaseModel, ConfigDict, Field

from kindgi import tool


class EchoInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1)


class EchoOutput(BaseModel):
    message: str


@tool(id="conformance.echo")
async def echo(input: EchoInput) -> EchoOutput:
    """Returns its message."""
    return EchoOutput(message=input.message)
