# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from kindgi import Agent

from ..guardrails.checks import min_length
from ..tools.echo import echo

echo_agent = Agent(
    id="conformance.echo-agent",
    version="1.0.0",
    name="Echo agent",
    instructions="Call conformance.echo with the message.",
    capabilities=[{"needs": [{"feature": "tool-use"}]}],
    tools=[echo],
    guardrails=[min_length],
)
