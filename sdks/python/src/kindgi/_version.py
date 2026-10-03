# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("kindgi")
except PackageNotFoundError:  # running from a source tree
    __version__ = "0.0.0"
