# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""A stdio MCP endpoint's `secretEnv`, as the client's models read and send it."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from kindgi.client import models

REF = {"envName": "production", "name": "FILES_GITHUB_TOKEN"}
ENDPOINT: dict[str, Any] = {
    "endpointId": "acme-files",
    "name": "Files",
    "transport": "stdio",
    "config": {
        "transport": "stdio",
        "command": "/usr/local/bin/files-mcp",
        "env": {"LOG_LEVEL": "[redacted]"},
    },
    "secretEnv": {"GITHUB_TOKEN": REF},
}


def test_an_endpoint_reads_its_secret_env_by_reference_and_writes_it_back() -> None:
    endpoint = models.MCPEndpoint.model_validate(ENDPOINT)
    assert endpoint.secret_env is not None
    ref = endpoint.secret_env["GITHUB_TOKEN"]
    assert (ref.env_name, ref.name) == ("production", "FILES_GITHUB_TOKEN")
    assert endpoint.model_dump(by_alias=True, exclude_none=True) == ENDPOINT


def test_an_endpoint_without_secret_env_reads_as_before() -> None:
    older = {key: value for key, value in ENDPOINT.items() if key != "secretEnv"}
    assert models.MCPEndpoint.model_validate(older).secret_env is None


@pytest.mark.parametrize(
    "secret_env",
    [
        {},
        {f"SECRET_{i}": REF for i in range(17)},
        {"": REF},
        {"GITHUB=TOKEN": REF},
        {"GITHUB\u0000TOKEN": REF},
        {"GITHUB_TOKEN": {"envName": "Production", "name": "x"}},
    ],
)
def test_a_register_body_takes_1_to_16_variables_by_reference(secret_env: dict[str, Any]) -> None:
    body = {**ENDPOINT, "scopeKind": "tenant"}
    sixteen = {f"SECRET_{i}": REF for i in range(16)}
    assert models.RegisterMCPEndpointBody.model_validate({**body, "secretEnv": sixteen}).secret_env
    with pytest.raises(ValidationError):
        models.RegisterMCPEndpointBody.model_validate({**body, "secretEnv": secret_env})
