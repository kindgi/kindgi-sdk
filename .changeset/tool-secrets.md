---
"@kindgi/env-schema": minor
"@kindgi/handler-runtime": minor
"@kindgi/sdk": patch
"@kindgi/specs": minor
---

Tool secrets reach the tools that declare them.

- `@kindgi/env-schema`: `KINDGI_ENV`, the env a runtime serves. Secrets a tool declares by name (`needsSpec.secrets`) resolve under it; development mode defaults it to `local`.
- `@kindgi/handler-runtime`: the indexer carries a declarative tool's `spec` (`defineTool({ spec })`) into `index.json`, so the runtime runs the tool itself and resolves its `secretRef`s, instead of the pack service running it without them.
- `@kindgi/specs`: `pack-index.schema.json` 1.2.0 adds a tool's optional `spec`. The Python SDK's vendored copy matches.
- `@kindgi/sdk`: the `kindgi-python-authoring-tools` skill — and the Python SDK's README and `ToolContext.secrets` docstring — say how to declare a secret (`needs_spec={"secrets": …}`) and read it from `ctx.secrets`; `ctx.env` and `ctx.config` are still empty.
