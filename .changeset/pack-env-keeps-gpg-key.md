---
"@kindgi/handler-runtime": patch
"@kindgi/pack-conformance": patch
---

A pack service keeps `GPG_KEY`, so a Python pack's service no longer warns at start that it dropped it. Python's base image sets it, it holds no secret, and nothing reads it. The keep list is the same in TypeScript, in Python and in the JVM launcher, and the conformance suite now starts each service with `GPG_KEY` set and checks that it reaches the pack's code.
