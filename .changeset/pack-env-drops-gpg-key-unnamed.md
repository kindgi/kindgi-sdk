---
"@kindgi/handler-runtime": patch
"@kindgi/pack-conformance": patch
---

A pack service no longer names `GPG_KEY` in its `env-dropped` line, so a Python pack's service no longer warns at every start: Python's base image sets it in every Python pack's image. The service still drops it like any name the pack doesn't declare, and a pack that reads it declares it. `QUIETLY_DROPPED_ENV_NAMES` lists the names it drops without naming them. The list is the same in TypeScript, Python and Java, and the conformance suite now starts each service with `GPG_KEY` as the only name the pack doesn't declare, and checks that it doesn't reach the pack's code and that no `env-dropped` line is written.
