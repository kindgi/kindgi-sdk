---
"@kindgi/tools": patch
"@kindgi/sdk": patch
---

**`invokeTool` decides a tool's env values as the runtime does.** A tool's `needsSpec.env` used to reach a unit test only as the test passed it, so a handler had to repeat each default in code. Now, before the handler runs:
- each name the tool declares takes the context's `env` value, else its schema's `default`;
- each value is checked against its schema;
- the handler's `ctx.env` holds the declared names only, as from the runtime.

A name with neither a value nor a default, or a value its schema refuses, is `precondition-failed` (`env-value-missing`, `env-value-invalid`), and the handler doesn't run. The env is decided before the input is checked, in the runtime's order. A test that passed an env value a tool doesn't declare no longer sees it in the handler; neither would a run.
- **`toolContextForTest(overrides?)`** (`@kindgi/tools`, `@kindgi/sdk/define`): a context for a unit test, the TypeScript counterpart of Python's `ToolContext.for_test`. It holds tenant `tenant-test`, run `run-test` and an abort signal, with what you pass over them: `invokeTool(tool, input, toolContextForTest({ env: { … } }))`.
