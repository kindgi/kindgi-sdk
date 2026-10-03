# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from kindgi import Flow

from ..tools.echo import echo

echo_flow = Flow(
    id="conformance.echo-flow",
    version="1.0.0",
    nodes=[{"id": "echo", "kind": "tool", "ref": echo}],
    edges=[
        {"id": "e-start", "from": "$start", "to": "echo"},
        {"id": "e-end", "from": "echo", "to": "$end"},
    ],
)
