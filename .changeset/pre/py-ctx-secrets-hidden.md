---
"@kindgi/client": patch
---

**Security (Python):** a tool's context never shows its secrets: `ToolContext.secrets` is left out of the context's `repr`, so printing or logging a context (`print(ctx)`, `f"{ctx}"`) no longer includes the secrets' values. `ctx.secrets` still reads them.
