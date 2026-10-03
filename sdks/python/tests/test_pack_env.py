# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""R4: the process env a pack declares (`[tool.kindgi.env]`) — indexed, and checked at startup.

The readiness answers are also covered black-box, for both pack services,
by `@kindgi/pack-conformance`; these tests pin the Python config, indexer
and boot paths.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable, Mapping
from pathlib import Path
from typing import Any

import httpx
import pytest

from kindgi.pack.index import _spec, run_indexer
from kindgi.pack.serve import ServeConfig, load_service, read_config
from kindgi.pack.service import EnvCheck, PackService

PINS = {"artifact_version": "20261002.1", "published_at": "2026-10-02T00:00:00.000Z"}

ECHO = """
from typing import Any
from kindgi import tool

@tool(id="acme.echo")
def echo(input: dict[str, Any]) -> dict[str, Any]:
    "Echoes."
    return input
"""


def pyproject(env: str) -> str:
    return f'[tool.kindgi.pack]\nid = "acme"\nversion = "1.2.3"\n\n[tool.kindgi.env]\n{env}\n'


def indexed(root: Path) -> dict[str, Any]:
    outcome = run_indexer(root, **PINS)
    assert outcome["kind"] == "ok", outcome
    return json.loads(Path(outcome["value"]["outputPath"]).read_text())


# -- config + indexer ------------------------------------------------------


def test_the_index_carries_the_declared_env_sorted(make_pack: Callable[..., Path]) -> None:
    root = make_pack(
        {"tools/echo.py": ECHO},
        pyproject=pyproject('required = ["SENTRY_DSN", "DATABASE_URL"]\noptional = ["b_x", "B_X"]'),
    )
    index = indexed(root)
    assert index["env"] == {"optional": ["B_X", "b_x"], "required": ["DATABASE_URL", "SENTRY_DSN"]}
    assert _spec("pack-index").issues(index) == []


def test_either_list_may_be_left_out(make_pack: Callable[..., Path]) -> None:
    root = make_pack({"tools/echo.py": ECHO}, pyproject=pyproject('optional = ["SENTRY_DSN"]'))
    assert indexed(root)["env"] == {"optional": ["SENTRY_DSN"], "required": []}


def test_nothing_declared_leaves_env_out_of_the_index(make_pack: Callable[..., Path]) -> None:
    # Existing indexes stay byte-identical, so their signed hashes don't change.
    assert "env" not in indexed(make_pack({"tools/echo.py": ECHO}))
    empty = make_pack({"tools/echo.py": ECHO}, pyproject=pyproject("required = []"))
    assert "env" not in indexed(empty)


@pytest.mark.parametrize(
    ("env", "says"),
    [
        (
            'required = ["DATABASE-URL", "1ST"]',
            '"DATABASE-URL" in `env.required` isn\'t an environment variable name; '
            '"1ST" in `env.required` isn\'t an environment variable name',
        ),
        ('required = ["A\\n"]', '"A\\n" in `env.required` isn\'t an environment variable name'),
        (
            'optional = ["KINDGI_PACK_INDEX"]',
            '"KINDGI_PACK_INDEX" in `env.optional`: `KINDGI_*` names configure Kindgi, not the pack',
        ),
        ('required = ["A"]\noptional = ["A"]', '"A" is in both `env.required` and `env.optional`'),
        ('required = ["A", "A"]', '"A" is listed twice in `env.required`'),
        ('requried = ["A"]', "`env` takes only `required` and `optional`, not `requried`"),
        ('required = "A"', "`env.required` must be a list of names"),
        ("required = [1]", "`env.required` must be a list of names"),
    ],
)
def test_a_bad_declaration_fails_indexing(
    make_pack: Callable[..., Path], env: str, says: str
) -> None:
    root = make_pack({"tools/echo.py": ECHO}, pyproject=pyproject(env))
    error = run_indexer(root, **PINS)["error"]
    assert error == {
        "code": "config-invalid",
        "field": "env",
        "message": f"Config file {root / 'pyproject.toml'}: {says}",
        "filePath": str(root / "pyproject.toml"),
    }


def test_env_must_be_a_table(make_pack: Callable[..., Path]) -> None:
    root = make_pack(
        {"tools/echo.py": ECHO},
        pyproject='[tool.kindgi]\nenv = ["A"]\n\n[tool.kindgi.pack]\nid = "acme"\nversion = "1"\n',
    )
    assert run_indexer(root, **PINS)["error"]["code"] == "config-invalid"


# -- the service -----------------------------------------------------------

INDEX: dict[str, Any] = {
    "v": 1,
    "packId": "acme",
    "packVersion": "1.2.3",
    "artifactVersion": "1",
    "publishedAt": "2026-10-02T00:00:00.000Z",
    "tools": [],
    "guardrails": [],
    "agents": [],
    "flows": [],
    "env": {"optional": ["SENTRY_DSN"], "required": ["BUCKET", "DATABASE_URL", "REGION"]},
}

TOKEN = {"kindgi-pack-token": "tok"}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def service(
    tmp_path: Path,
    environ: Mapping[str, str],
    env_check: EnvCheck = "strict",
    index: Mapping[str, Any] = INDEX,
) -> PackService:
    return PackService(index, tmp_path, "tok", env_check=env_check, environ=environ)


@pytest.fixture
async def http() -> AsyncIterator[Callable[[PackService], httpx.AsyncClient]]:
    clients: list[httpx.AsyncClient] = []

    def open_client(app: PackService) -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://pack")
        clients.append(client)
        return client

    yield open_client
    for client in clients:
        await client.aclose()


def invoke() -> dict[str, Any]:
    return {
        "v": 2,
        "kind": "invoke",
        "tool": {"id": "acme.none"},
        "input": {},
        "ctx": {"tenantId": "t", "runId": "r"},
    }


# Unset or exactly "" is missing; whitespace is a value.
ENVIRON = {"DATABASE_URL": "", "REGION": " ", "SENTRY_DSN": ""}
MISSING = ["BUCKET", "DATABASE_URL"]


@pytest.mark.anyio
async def test_strict_holds_readiness_and_calls_naming_what_is_missing(
    tmp_path: Path, http: Callable[[PackService], httpx.AsyncClient]
) -> None:
    app = service(tmp_path, ENVIRON)
    assert app.prewarm() == []
    client = http(app)
    assert (await client.get("/healthz")).status_code == 200
    ready = await client.get("/readyz")
    assert ready.status_code == 503
    assert ready.json() == {"error": "missing env", "missingEnv": MISSING}
    assert ready.headers["retry-after"] == "1"
    called = await client.post("/v1/invoke", json=invoke(), headers=TOKEN)
    assert called.status_code == 503
    assert called.json() == {"error": "missing env", "missingEnv": MISSING}
    info = await client.get("/v1/info", headers=TOKEN)
    assert info.json()["missingEnv"] == MISSING


@pytest.mark.anyio
async def test_warn_serves_and_still_reports(
    tmp_path: Path, http: Callable[[PackService], httpx.AsyncClient]
) -> None:
    app = service(tmp_path, ENVIRON, env_check="warn")
    assert app.prewarm() == []
    client = http(app)
    ready = await client.get("/readyz")
    assert (ready.status_code, ready.json()) == (200, {"status": "ready"})
    called = await client.post("/v1/invoke", json=invoke(), headers=TOKEN)
    assert called.status_code == 200
    assert (await client.get("/v1/info", headers=TOKEN)).json()["missingEnv"] == MISSING


@pytest.mark.anyio
async def test_draining_comes_first_then_missing_env_then_not_ready(
    tmp_path: Path, http: Callable[[PackService], httpx.AsyncClient]
) -> None:
    app = service(tmp_path, ENVIRON)
    client = http(app)
    # Not prewarmed yet: a missing variable is often why a module won't load.
    assert (await client.get("/readyz")).json()["error"] == "missing env"
    app.begin_drain()
    assert (await client.get("/readyz")).json() == {"error": "draining"}
    complete = service(tmp_path, {"DATABASE_URL": "x", "BUCKET": "b", "REGION": "r"})
    assert (await http(complete).get("/readyz")).json() == {"error": "not ready"}


@pytest.mark.anyio
async def test_nothing_missing_is_an_empty_list(
    tmp_path: Path, http: Callable[[PackService], httpx.AsyncClient]
) -> None:
    undeclared = {key: value for key, value in INDEX.items() if key != "env"}
    for app in (
        service(tmp_path, {"DATABASE_URL": "x", "BUCKET": "b", "REGION": "r"}),
        service(tmp_path, {}, index=undeclared),
    ):
        assert app.prewarm() == []
        client = http(app)
        assert (await client.get("/readyz")).json() == {"status": "ready"}
        assert (await client.get("/v1/info", headers=TOKEN)).json()["missingEnv"] == []


# -- the process -----------------------------------------------------------

BASE_ENV = {"KINDGI_PACK_SERVICE_TOKEN": "tok"}


@pytest.mark.parametrize(
    ("value", "check"), [(None, "strict"), ("", "strict"), ("strict", "strict"), ("warn", "warn")]
)
def test_the_env_check_setting(value: str | None, check: str) -> None:
    env = BASE_ENV if value is None else {**BASE_ENV, "KINDGI_PACK_ENV_CHECK": value}
    config = read_config([], env)
    assert isinstance(config, ServeConfig)
    assert config.env_check == check


def test_any_other_env_check_is_a_startup_error() -> None:
    problems = read_config([], {**BASE_ENV, "KINDGI_PACK_ENV_CHECK": "off"})
    assert problems == ['KINDGI_PACK_ENV_CHECK must be `strict` or `warn`, not "off"']


def test_boot_logs_the_missing_names_once(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    index_path = tmp_path / "index.json"
    index_path.write_text(json.dumps(INDEX))
    config = read_config(
        ["--index", str(index_path)], {**BASE_ENV, "KINDGI_PACK_ENV_CHECK": "warn"}
    )
    assert isinstance(config, ServeConfig)
    loaded = load_service(config, ENVIRON)
    assert isinstance(loaded, PackService)
    loaded.close()
    lines = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert lines == [{"kind": "missing-env", "check": "warn", "names": MISSING}]
