# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

import os
from typing import Any

from kindgi import tool


@tool(id="conformance.process-env")
def process_env(input: dict[str, Any]) -> dict[str, Any]:
    """Returns the names in its process environment."""
    return {"names": sorted(os.environ)}
