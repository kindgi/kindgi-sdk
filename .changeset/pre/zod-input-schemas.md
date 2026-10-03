---
"@kindgi/schema": minor
"@kindgi/tools": minor
"@kindgi/handler-runtime": patch
"@kindgi/guardrails": patch
"@kindgi/agents": patch
"@kindgi/sdk": patch
---

Tool inputs get their Zod defaults, transforms and refinements.

- `@kindgi/schema`:
  - `toJSONSchema(schema, io)` and `toJSONSchemaSync(schema, converter, io)` take a required `io` (`SchemaIo`, `'input'` or `'output'`). The two sides differ exactly where Zod defaults: on the input side a `.default()` field is optional, on the output side it is required. Before, every conversion produced the output side.
  - `parseWithSchema(schema, value)` parses through a Zod schema's Standard Schema interface: defaults, transforms and refinements applied, or the issues.
- `@kindgi/tools`:
  - A tool's advertised input schema is the input side, so a model may leave a defaulted field out.
  - `invokeTool` validates a copy of the input, filling in JSON Schema `default`s. A Zod-authored tool's input is then parsed with `inputZod`, so the handler gets its parsed input. A failed refinement is `input-validation-failed`, with the field's path.
  - A handler's input type defaults to `InferOutput` of the input schema, the parsed type.
- `@kindgi/handler-runtime`: `runWorker`, which the pack service runs tools through, prepares the input the same way. The indexer converts tool inputs and guardrail config on the input side.
- `@kindgi/guardrails`: a check's config schema converts on the input side.
- `@kindgi/agents`: a typed agent's output schema converts on the output side, so downstream steps can rely on every field.
- `@kindgi/sdk`: the tools skill explains what a handler receives.
