---
"@kindgi/handler-runtime": patch
---

**Security:** a tool's context never shows its secrets. In the TypeScript pack service, `ctx.secrets` (and `ctx.log`) are not enumerable, so printing, spreading or serializing a context (`console.log(ctx)`, `{...ctx}`, `JSON.stringify(ctx)`) no longer includes the secrets' values. `ctx.secrets` still reads them.
