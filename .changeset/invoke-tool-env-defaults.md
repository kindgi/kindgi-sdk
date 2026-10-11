---
"@kindgi/tools": patch
"@kindgi/sdk": patch
---

**Test a tool with its env values decided as a run decides them.** A unit test reached a tool's `needsSpec.env` only as it passed it, so a handler had to repeat each default in code.
- **`invokeToolForTest(tool, input, context?)`** (`@kindgi/tools`, `@kindgi/sdk/define`) calls the tool through `invokeTool`, deciding its env values the way the runtime decides a pack tool's:
  - each declared name takes the context's `env` value, else its schema's `default`;
  - each value is checked against its schema;
  - the handler's `ctx.env` holds the declared names only.

  A name with neither, or a value its schema refuses, is `precondition-failed` (`env-value-missing`, then `env-value-invalid`), and the handler doesn't run. As in a run, the input is checked first.
- **`toolContextForTest(overrides?)`**: a context for a unit test, the TypeScript counterpart of Python's `ToolContext.for_test`. It holds tenant `tenant-test`, run `run-test` and an abort signal, with what you pass over them.
- **`invokeTool` is unchanged.** It passes `ctx.env` as given, because in a run the runtime's tool resolves its own env.
