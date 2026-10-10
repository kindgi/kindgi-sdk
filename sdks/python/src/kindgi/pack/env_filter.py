# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Only the names a pack declares reach its code.

Before the pack's code loads, the pack service drops from its own environment
every name the pack doesn't declare (`env.required`, `env.optional`), except
`KINDGI_*` (the service's own settings) and the platform's: the process's
basics, the language runtime's settings, the port, network trust, and the
platform's own workload identity and metadata (Cloud Run, AWS, Azure). Static
credentials (`AWS_SECRET_ACCESS_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
`AZURE_CLIENT_SECRET`) aren't among them: a pack that needs one declares it.

`KINDGI_PACK_ENV_FILTER=off` keeps everything (`kindgi dev` sets it). The lists
are the TypeScript pack service's (`@kindgi/handler-runtime`'s `pack-env.ts`)
and the Java launcher's; the conformance suite checks all of them.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

EnvFilter = Literal["on", "off"]
ENV_FILTERS: tuple[EnvFilter, ...] = ("on", "off")
ENV_FILTER_VAR = "KINDGI_PACK_ENV_FILTER"

PLATFORM_ENV_NAMES: frozenset[str] = frozenset(
    {
        # the process
        "PATH",
        "HOME",
        "HOSTNAME",
        "USER",
        "LANG",
        "LANGUAGE",
        "TZ",
        "TMPDIR",
        "TMP",
        "TEMP",
        "PWD",
        "SHLVL",
        "_",
        "__CF_USER_TEXT_ENCODING",
        # the language runtime (with the version its base image names)
        "NODE_ENV",
        "NODE_VERSION",
        "YARN_VERSION",
        "NODE_OPTIONS",
        "NODE_EXTRA_CA_CERTS",
        "JAVA_HOME",
        "JAVA_VERSION",
        "JAVA_TOOL_OPTIONS",
        "JDK_JAVA_OPTIONS",
        "_JAVA_OPTIONS",
        "VIRTUAL_ENV",
        # the port
        "PORT",
        # network trust
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        # Cloud Run
        "K_SERVICE",
        "K_REVISION",
        "K_CONFIGURATION",
        # AWS (ECS, App Runner, EKS)
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_EXECUTION_ENV",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
        "ECS_CONTAINER_METADATA_URI",
        "ECS_CONTAINER_METADATA_URI_V4",
        # Azure (Container Apps, managed and workload identity)
        "IDENTITY_ENDPOINT",
        "IDENTITY_HEADER",
        "MSI_ENDPOINT",
        "MSI_SECRET",
        "AZURE_CLIENT_ID",
        "AZURE_TENANT_ID",
        "AZURE_FEDERATED_TOKEN_FILE",
        "AZURE_AUTHORITY_HOST",
    }
)

# The locale, Python's settings, OpenTelemetry's exporter, and Cloud Run's and
# Container Apps' metadata. `KINDGI_*` is kept too.
PLATFORM_ENV_PREFIXES: tuple[str, ...] = ("LC_", "PYTHON", "OTEL_", "CLOUD_RUN_", "CONTAINER_APP_")


def undeclared_pack_env(
    declaration: Mapping[str, Any] | None, environment: Mapping[str, str]
) -> list[str]:
    """The names in `environment` the pack service drops; sorted.

    `declaration` is the index's `env` (absent when the pack declares nothing, which
    keeps only `KINDGI_*` and the platform's names).
    """
    declared = {
        *(str(n) for n in (declaration or {}).get("required", [])),
        *(str(n) for n in (declaration or {}).get("optional", [])),
    }
    return sorted(
        name
        for name in environment
        if name not in declared
        and not name.startswith("KINDGI_")
        and name not in PLATFORM_ENV_NAMES
        and not name.startswith(PLATFORM_ENV_PREFIXES)
    )
