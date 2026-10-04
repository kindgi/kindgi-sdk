# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Where a client finds its runtime: the same rules as the TypeScript SDK's."""

from __future__ import annotations

import json
import warnings
from collections.abc import Iterator
from pathlib import Path

import pytest

from kindgi.client import Kindgi, KindgiConfigWarning
from kindgi.client._runtime_config import (
    find_dev_runtime,
    reset_warnings_for_tests,
    resolve_settings,
)

DEV = {"apiUrl": "http://127.0.0.1:4000", "token": "kgi_bt_dev"}


@pytest.fixture(autouse=True)
def _fresh_warnings() -> Iterator[None]:
    reset_warnings_for_tests()
    yield
    reset_warnings_for_tests()


def dev_pack(tmp_path: Path, content: object = DEV) -> Path:
    """A pack with a running kindgi dev's `.kindgirc.json`, and a subfolder of it."""
    (tmp_path / ".kindgirc.json").write_text(
        content if isinstance(content, str) else json.dumps(content), encoding="utf-8"
    )
    sub = tmp_path / "app" / "routes"
    sub.mkdir(parents=True)
    return sub


def config_warnings(record: list[warnings.WarningMessage]) -> list[str]:
    return [str(w.message) for w in record if issubclass(w.category, KindgiConfigWarning)]


def test_env_wins_with_no_warning_when_there_is_no_kindgi_dev(tmp_path: Path) -> None:
    env = {"KINDGI_API_URL": "http://env.test", "KINDGI_API_TOKEN": "kgi_bt_env"}
    with warnings.catch_warnings(record=True) as record:
        warnings.simplefilter("always")
        assert resolve_settings(None, None, env=env, cwd=tmp_path) == (
            "http://env.test",
            "kgi_bt_env",
        )
    assert config_warnings(record) == []


def test_arguments_win_over_env(tmp_path: Path) -> None:
    env = {"KINDGI_API_URL": "http://env.test", "KINDGI_API_TOKEN": "kgi_bt_env"}
    assert resolve_settings("http://arg.test", "kgi_bt_arg", env=env, cwd=tmp_path) == (
        "http://arg.test",
        "kgi_bt_arg",
    )


def test_no_env_in_development_uses_the_running_kindgi_dev_with_one_warning(tmp_path: Path) -> None:
    sub = dev_pack(tmp_path)
    with warnings.catch_warnings(record=True) as record:
        warnings.simplefilter("always")
        assert resolve_settings(None, None, env={}, cwd=sub) == (DEV["apiUrl"], DEV["token"])
        resolve_settings(None, None, env={}, cwd=sub)
    messages = config_warnings(record)
    assert len(messages) == 1
    assert "KINDGI_API_URL and KINDGI_API_TOKEN" in messages[0]
    assert "your env file (.env / .env.local)" in messages[0]


def test_only_the_missing_field_comes_from_kindgi_dev(tmp_path: Path) -> None:
    sub = dev_pack(tmp_path)
    with warnings.catch_warnings(record=True) as record:
        warnings.simplefilter("always")
        url, token = resolve_settings(None, None, env={"KINDGI_API_URL": DEV["apiUrl"]}, cwd=sub)
    assert (url, token) == (DEV["apiUrl"], DEV["token"])
    [message] = config_warnings(record)
    assert "for KINDGI_API_TOKEN." in message


def test_production_never_reads_kindgirc(tmp_path: Path) -> None:
    sub = dev_pack(tmp_path)
    for env in ({"KINDGI_ENV": "production"}, {"NODE_ENV": "production"}):
        with pytest.raises(ValueError) as raised:
            resolve_settings(None, None, env=env, cwd=sub)
        assert "kindgi dev" not in str(raised.value)


def test_nothing_anywhere_says_what_to_set_and_where(tmp_path: Path) -> None:
    with pytest.raises(ValueError) as raised:
        resolve_settings(None, None, env={}, cwd=tmp_path)
    message = str(raised.value)
    assert "KINDGI_API_URL and KINDGI_API_TOKEN aren't set" in message
    assert "your env file (.env / .env.local)" in message
    assert "run `kindgi dev`" in message


def test_a_stale_token_for_the_same_url_warns_once(tmp_path: Path) -> None:
    sub = dev_pack(tmp_path)
    env = {"KINDGI_API_URL": DEV["apiUrl"] + "/", "KINDGI_API_TOKEN": "kgi_bt_old"}
    with warnings.catch_warnings(record=True) as record:
        warnings.simplefilter("always")
        assert resolve_settings(None, None, env=env, cwd=sub)[1] == "kgi_bt_old"
        resolve_settings(None, None, env=env, cwd=sub)
    [message] = config_warnings(record)
    assert "kindgi dev --reset" in message


def test_a_different_url_is_not_warned_about(tmp_path: Path) -> None:
    sub = dev_pack(tmp_path)
    env = {"KINDGI_API_URL": "https://staging.example.com", "KINDGI_API_TOKEN": "kgi_bt_staging"}
    with warnings.catch_warnings(record=True) as record:
        warnings.simplefilter("always")
        resolve_settings(None, None, env=env, cwd=sub)
    assert config_warnings(record) == []


def test_find_dev_runtime_ignores_an_unusable_kindgirc(tmp_path: Path) -> None:
    for content in ({"apiUrl": "http://127.0.0.1:4000"}, {"token": "kgi_bt_dev"}, "{not json"):
        case = tmp_path / f"case-{len(list(tmp_path.iterdir()))}"
        case.mkdir()
        sub = dev_pack(case, content)
        assert find_dev_runtime(sub) is None


def test_the_clients_use_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sub = dev_pack(tmp_path)
    monkeypatch.delenv("KINDGI_API_URL", raising=False)
    monkeypatch.delenv("KINDGI_API_TOKEN", raising=False)
    monkeypatch.delenv("KINDGI_ENV", raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.chdir(sub)
    with pytest.warns(KindgiConfigWarning), Kindgi() as api:
        assert (api.base_url, api.token) == (DEV["apiUrl"], DEV["token"])
