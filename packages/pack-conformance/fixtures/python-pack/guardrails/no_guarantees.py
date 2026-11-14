# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 Kindgi Inc.

from kindgi import built_in_guardrail

# Names a built-in check: the runtime runs it, and the pack ships no check for it.
no_guarantees = built_in_guardrail(
    id="conformance.no-guarantees",
    check="forbidden-substring",
    config={"patterns": ["guaranteed", "we promise"]},
    at="model-step",
    on_violation="halt",
)
