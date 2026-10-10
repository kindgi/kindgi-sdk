# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Only the names a pack declares reach its code (`kindgi.pack.env_filter`).

The same lists as the TypeScript pack service's; `@kindgi/pack-conformance`
checks both pack services black-box. These tests pin the Python config and boot.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from kindgi.pack.env_filter import undeclared_pack_env
from kindgi.pack.index import run_indexer
from kindgi.pack.serve import ServeConfig, load_service, read_config
from kindgi.pack.service import PackService

PINS = {"artifact_version": "20261010.1", "published_at": "2026-10-10T00:00:00.000Z"}
BASE_ENV = {"KINDGI_PACK_SERVICE_TOKEN": "t"}

# Records, when it's imported, whether it saw an undeclared and a declared name.
PROBE = """
import os
from typing import Any
from kindgi import tool

os.environ["PROBE_SEEN_AT_IMPORT"] = (
    ("undeclared" if os.environ.get("ACME_UNDECLARED_KEY") else "-")
    + "/"
    + ("declared" if os.environ.get("A_URL") else "-")
)

@tool(id="acme.echo")
def echo(input: dict[str, Any]) -> dict[str, Any]:
    "Echoes."
    return input
"""


@pytest.fixture
def restored_environ() -> Iterator[None]:
    """The filter works on this process's own environment: restore it exactly."""
    saved = dict(os.environ)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


def test_undeclared_go_declared_kindgi_and_platform_stay() -> None:
    env = {
        "A_URL": "postgres://db",
        "CACHE_DIR": "/tmp/c",
        "ANTHROPIC_API_KEY": "fake-not-a-key",
        "AWS_SECRET_ACCESS_KEY": "fake",
        "DATABASE_URL": "postgres://other",
        "KINDGI_LOG_FORMAT": "json",
        "PATH": "/bin",
        "PORT": "8080",
        "NODE_OPTIONS": "--max-old-space-size=512",
        "LC_ALL": "C.UTF-8",
        "PYTHONPATH": "/app",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318",
        "K_SERVICE": "pack",
        "CONTAINER_APP_NAME": "pack",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/v2/credentials/x",
        "IDENTITY_ENDPOINT": "http://localhost:42356/msi/token",
    }
    declared = {"required": ["A_URL"], "optional": ["CACHE_DIR"]}
    assert undeclared_pack_env(declared, env) == [
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "DATABASE_URL",
    ]
    # Declaring nothing keeps only Kindgi's and the platform's.
    assert undeclared_pack_env(None, env) == [
        "ANTHROPIC_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "A_URL",
        "CACHE_DIR",
        "DATABASE_URL",
    ]


@pytest.mark.parametrize(
    ("value", "expected"), [(None, "on"), ("", "on"), ("on", "on"), ("off", "off")]
)
def test_the_filter_setting(value: str | None, expected: str) -> None:
    env = BASE_ENV if value is None else {**BASE_ENV, "KINDGI_PACK_ENV_FILTER": value}
    config = read_config([], env)
    assert isinstance(config, ServeConfig)
    assert config.env_filter == expected


def test_any_other_filter_value_is_a_startup_error() -> None:
    assert read_config([], {**BASE_ENV, "KINDGI_PACK_ENV_FILTER": "no"}) == [
        'KINDGI_PACK_ENV_FILTER must be `on` or `off`, not "no"'
    ]


def _pack(make_pack: Callable[..., Path]) -> Path:
    root = make_pack(
        {"tools/echo.py": PROBE},
        pyproject='[tool.kindgi.pack]\nid = "acme"\nversion = "1.2.3"\n\n'
        '[tool.kindgi.env]\nrequired = ["A_URL"]\n',
    )
    outcome = run_indexer(root, **PINS)
    assert outcome["kind"] == "ok", outcome
    return Path(outcome["value"]["outputPath"])


@pytest.mark.usefixtures("restored_environ")
def test_on_the_undeclared_are_gone_before_the_pack_loads_and_the_warning_names_them(
    make_pack: Callable[..., Path], capsys: pytest.CaptureFixture[str]
) -> None:
    index_path = _pack(make_pack)
    # Indexing imported the probe already, in this process. A pack service starts in a
    # fresh one: forget the pack's modules, so only the service's own import counts.
    root = str(index_path.parent)
    for name, module in list(sys.modules.items()):
        if str(getattr(module, "__file__", "") or "").startswith(root):
            del sys.modules[name]
    os.environ.pop("PROBE_SEEN_AT_IMPORT", None)
    os.environ.update(
        {
            "ACME_UNDECLARED_KEY": "fake-not-a-key",
            "A_URL": "postgres://db",
            "OTEL_SERVICE_NAME": "pack",
            "KINDGI_PACK_TEST": "1",
        }
    )
    config = read_config(
        ["--index", str(index_path), "--module-root", str(index_path.parent)], BASE_ENV
    )
    assert isinstance(config, ServeConfig)
    assert config.env_filter == "on"
    loaded = load_service(config, dict(os.environ))
    assert isinstance(loaded, PackService), loaded
    loaded.close()

    assert os.environ["PROBE_SEEN_AT_IMPORT"] == "-/declared"
    assert "ACME_UNDECLARED_KEY" not in os.environ
    assert os.environ["A_URL"] == "postgres://db"
    assert os.environ["OTEL_SERVICE_NAME"] == "pack"
    assert os.environ["KINDGI_PACK_TEST"] == "1"
    err = capsys.readouterr().err
    assert "fake-not-a-key" not in err
    dropped = [
        line for line in map(json.loads, err.splitlines()) if line.get("kind") == "env-dropped"
    ]
    assert len(dropped) == 1
    assert "ACME_UNDECLARED_KEY" in dropped[0]["names"]
    assert "A_URL" not in dropped[0]["names"]


@pytest.mark.usefixtures("restored_environ")
def test_a_config_built_in_process_drops_nothing(make_pack: Callable[..., Path]) -> None:
    index_path = _pack(make_pack)
    os.environ.update({"ACME_UNDECLARED_KEY": "fake-not-a-key", "A_URL": "postgres://db"})
    config = ServeConfig(index_path, index_path.parent, "t", 0, None, None)
    loaded = load_service(config, dict(os.environ))
    assert isinstance(loaded, PackService), loaded
    loaded.close()
    assert os.environ["ACME_UNDECLARED_KEY"] == "fake-not-a-key"
