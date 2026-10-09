---
"@kindgi/tools": patch
"@kindgi/sdk": patch
---

**A tool's secret can be optional.** A secret declared in `needsSpec.secrets` with a schema that accepts `null` (`{ type: ['string', 'null'] }`) is optional. When the env doesn't have it, or has it empty, it's left out of `ctx.secrets` and the call goes on, with the call's log line naming it. A value that is set is still checked against the schema. A revoked secret, or a secrets backend that fails, still fails the call. This needs runtime 0.1.6 or later: an older runtime requires every declared secret, failing a call without one with `secret-unavailable`. The guide ("An optional secret"), the authoring skills for every pack language, and the TypeScript and Python context types say so.
