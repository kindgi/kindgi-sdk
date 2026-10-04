# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

"""Where a client finds its Kindgi runtime when it's given no URL or token.

The same rules as the TypeScript SDK's `createClient()`:

1. the `base_url=` / `token=` arguments;
2. `KINDGI_API_URL` and `KINDGI_API_TOKEN` from the environment;
3. outside production, the running `kindgi dev`, from the nearest
   `.kindgirc.json` at or above the working directory (it records the
   runtime's `apiUrl` and the dev `token`), with a one-time warning to put
   them in the app's env file;
4. otherwise, an error that says what to set.

Production (`KINDGI_ENV` or `NODE_ENV` set to `production`) never reads
`.kindgirc.json`. Whatever the source, a token that differs from the
running `kindgi dev`'s for the same URL (the stale token after
`kindgi dev --reset`) is warned about once.
"""

from __future__ import annotations

import json
import os
import warnings
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

__all__ = ["DEV_RUNTIME_FILE", "KindgiConfigWarning", "find_dev_runtime", "resolve_settings"]

DEV_RUNTIME_FILE = ".kindgirc.json"
"""The file `kindgi dev` writes in the pack directory."""

_ENV_FILE_HINT = "your env file (.env / .env.local)"

_warned: set[str] = set()


class KindgiConfigWarning(UserWarning):
    """How the client found its runtime needs your attention (a fallback, a stale token)."""


@dataclass(frozen=True)
class DevRuntime:
    """What a client needs from a running `kindgi dev`."""

    api_url: str
    token: str
    path: Path
    """The `.kindgirc.json` it came from."""


def _warn_once(key: str, message: str) -> None:
    if key in _warned:
        return
    _warned.add(key)
    warnings.warn(f"[kindgi] {message}", KindgiConfigWarning, stacklevel=4)


def is_production(env: Mapping[str, str]) -> bool:
    return env.get("KINDGI_ENV") == "production" or env.get("NODE_ENV") == "production"


def resolve_settings(
    base_url: str | None,
    token: str | None,
    *,
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
) -> tuple[str, str]:
    """The client's URL and token, every missing one resolved (see the module docstring).

    Raises `ValueError` when no URL or no token can be found.
    """
    environ: Mapping[str, str] = os.environ if env is None else env
    dev = None if is_production(environ) else find_dev_runtime(Path.cwd() if cwd is None else cwd)

    url = base_url or environ.get("KINDGI_API_URL") or None
    secret = token or environ.get("KINDGI_API_TOKEN") or None

    if (url is None or secret is None) and dev is not None:
        used: list[str] = []
        if url is None:
            url = dev.api_url
            used.append("KINDGI_API_URL")
        if secret is None:
            secret = dev.token
            used.append("KINDGI_API_TOKEN")
        _warn_once(
            f"fallback:{dev.path}",
            f"Using the running kindgi dev from {dev.path} for {' and '.join(used)}. "
            f"Set them in {_ENV_FILE_HINT}, and in production, "
            f"where there's no {DEV_RUNTIME_FILE}.",
        )

    if url is None or secret is None:
        missing = [
            *(["KINDGI_API_URL"] if url is None else []),
            *(["KINDGI_API_TOKEN"] if secret is None else []),
        ]
        verb, pronoun = ("isn't", "it") if len(missing) == 1 else ("aren't", "them")
        hint = (
            ""
            if is_production(environ)
            else " In development, run `kindgi dev` in the app: it writes them to "
            f"{DEV_RUNTIME_FILE}, which the client reads."
        )
        raise ValueError(
            f"Kindgi(): {' and '.join(missing)} {verb} set. Set {pronoun} in {_ENV_FILE_HINT}, "
            f"or pass base_url= and token=.{hint}"
        )

    if dev is not None and secret != dev.token and _same_url(url, dev.api_url):
        _warn_once(
            f"stale:{dev.path}:{dev.token}",
            f"The API token doesn't match the running kindgi dev's ({dev.path}). After "
            f"`kindgi dev --reset` the token changes: copy the new one into {_ENV_FILE_HINT}.",
        )

    return url, secret


def find_dev_runtime(start: Path) -> DevRuntime | None:
    """The running `kindgi dev`'s URL and token, from the nearest `.kindgirc.json`.

    Searches `start` and its parents; `None` when there's none, or it can't be read.
    """
    for directory in (start, *start.parents):
        candidate = directory / DEV_RUNTIME_FILE
        if candidate.is_file():
            return _read_dev_runtime(candidate)
    return None


def _read_dev_runtime(file: Path) -> DevRuntime | None:
    try:
        parsed = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    fields = cast("dict[str, object]", parsed)
    api_url = fields.get("apiUrl")
    token = fields.get("token")
    if not isinstance(api_url, str) or not api_url or not isinstance(token, str) or not token:
        return None
    return DevRuntime(api_url=api_url, token=token, path=file)


def _same_url(a: str, b: str) -> bool:
    return a.rstrip("/") == b.rstrip("/")


def reset_warnings_for_tests() -> None:
    """Tests only: forget which warnings were shown."""
    _warned.clear()
