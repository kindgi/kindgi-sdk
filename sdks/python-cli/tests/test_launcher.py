# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""The launcher: it execs the wheel's node on the CLI it carries, told it's the PyPI CLI."""

from __future__ import annotations

import os
import sys
import types

import pytest

from kindgi_cli import __main__ as launcher


@pytest.fixture
def fake_node(monkeypatch: pytest.MonkeyPatch, tmp_path):
    package = tmp_path / "nodejs_wheel"
    (package / "bin").mkdir(parents=True)
    executable = types.ModuleType("nodejs_wheel.executable")
    executable.__file__ = str(package / "executable.py")
    parent = types.ModuleType("nodejs_wheel")
    parent.executable = executable
    monkeypatch.setitem(sys.modules, "nodejs_wheel", parent)
    monkeypatch.setitem(sys.modules, "nodejs_wheel.executable", executable)
    return package


@pytest.mark.skipif(os.name == "nt", reason="POSIX execs node")
def test_main_execs_node_with_the_cli_and_the_pypi_flag(fake_node, monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, object] = {}

    def execve(path: str, argv: list[str], env: dict[str, str]) -> None:
        seen.update(path=path, argv=argv, env=env)

    monkeypatch.setattr(os, "execve", execve)
    monkeypatch.setattr(sys, "argv", ["kindgi", "dev", "--no-watch"])
    launcher.main()
    node = str(fake_node / "bin" / "node")
    assert seen["path"] == node
    assert seen["argv"] == [node, str(launcher.CLI), "dev", "--no-watch"]
    env = seen["env"]
    assert isinstance(env, dict) and env["KINDGI_CLI_INSTALL"] == "pypi"


def test_the_cli_path_is_the_published_layout():
    # dependency-specs.ts tells a published CLI by `node_modules` in its path.
    assert launcher.CLI.parts[-5:] == ("node_modules", "@kindgi", "cli", "dist", "cli.js")
