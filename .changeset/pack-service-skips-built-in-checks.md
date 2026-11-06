---
"@kindgi/handler-runtime": patch
---

A pack service lists no check for a guardrail that names a built-in check (`checkBuiltIn` in its index entry), as the Python and JVM pack services do: the runtime runs a built-in, and the pack has no code for it. `GET /v1/info`'s `checks` leaves it out, and a `check-invoke` naming it answers `check-not-in-pack`.
