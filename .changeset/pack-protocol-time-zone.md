---
"@kindgi/specs": patch
"@kindgi/handler-runtime": patch
"@kindgi/pack-conformance": patch
---

**Pack protocol 2.12.0: the workspace's time zone.** A call's `ctx` can carry `timeZone`, an IANA name such as `America/Toronto`, the one `@kindgi/tools`' `ToolContext.timeZone` has: an agent turn reads it once, and every call the turn makes gets the same one, `UTC` when the workspace sets none or it can't be read. `pack-protocol.schema.json` (schema-version 2.12.0) gains it, optional, and the Python SDK's copy matches. The Python and JVM packs hand it to the handler as `ToolContext.time_zone` and `ToolContext.timeZone()` (`None` or `null` from an older runtime), and a TypeScript pack service passes it on as it is. A pack service from before 2.12.0 ignores it. In all four languages, the conformance suite sends it and checks that each SDK hands it to the handler, that a call without it gives the handler none, and that an older service still answers a call that carries it.
