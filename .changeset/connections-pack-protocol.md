---
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
---

**Pack protocol 2.7.0: a pack tool's connections.** A call's context can carry `connections`, the accounts at other apps the tool declares (`needsSpec.connections`), each with a short-lived token. The pack service hands them to the handler as `ctx.connections`, not enumerable, like `ctx.secrets`, and never logs them. A handler that throws `ConnectionRejectedError` (`@kindgi/tools`, from any copy of it), or an error whose `cause` is one, answers the new error code `connection-rejected` with `connection`, the connection's name, so the runtime can renew that token once and run the call again. `pack-protocol.schema.json` (schema-version 2.7.0) gains both, with an example. A tool that declares no connections gets none.
