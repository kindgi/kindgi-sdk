---
"@kindgi/specs": patch
"@kindgi/pack-conformance": patch
---

**Pack protocol 2.11.0: a connection's name.** Each entry of a call's `ctx.connections` can carry `name`, the connection's name: its label, else its account's, as `@kindgi/tools`' `ToolConnection.name` has it. `pack-protocol.schema.json` (schema-version 2.11.0) gains it, optional, and the Python SDK's copy matches. The Python and JVM packs hand it to the handler as `ToolConnection.name` (`None` or `null` from an older runtime), and a TypeScript pack service passes it on as it is. A pack service from before 2.11.0 ignores it. In all four languages, the conformance suite sends it and checks that each SDK hands it to the handler. The suite also checks that its own call matches the schema, and that an older service still answers a call that carries it.
