# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from pydantic import BaseModel

from kindgi import http_tool


class Input(BaseModel):
    path: str


class Output(BaseModel):
    url: str


# A declarative HTTP tool: no handler — the runtime makes the request from the spec.
http = http_tool(
    id="conformance.http",
    description="Reads a path from the example API.",
    input=Input,
    output=Output,
    method="GET",
    url_template="https://api.example.com/{path}",
    headers={"Accept": "application/json"},
    authorization={"kind": "bearer", "secretRef": {"envName": "local", "name": "API_TOKEN"}},
    success_status=(200, 299),
)
