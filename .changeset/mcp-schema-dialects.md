---
"@kindgi/schema": patch
"@kindgi/specs": patch
"@kindgi/tools": patch
---

Tools from MCP servers built with the TypeScript MCP SDK are no longer skipped. Their schemas declare JSON Schema draft-07 (`"$schema": "http://json-schema.org/draft-07/schema#"`), and every tool schema compiled as Draft 2020-12 only, so each one failed with `no schema with key or ref "http://json-schema.org/draft-07/schema#"`. An MCP tool's schemas (`transport: 'mcp'`) now compile in the dialect they declare: draft-06, draft-07, 2019-09 or 2020-12 (the default when they declare none), each with its own semantics (a draft-07 array-form `items` is a tuple), and without Ajv's strict mode, a lint for the schemas a pack writes: a server's union `type`s, open tuples and extension keywords are valid JSON Schema. Another dialect is refused, naming it. A pack's own tools are unchanged: Draft 2020-12, in strict mode; one declaring another dialect is refused with a message that says so. `@kindgi/schema` exports the compiler as `compileJsonSchema` (with `dialects` and `strict` options), and `jsonSchemaDialect`. `tool.schema.json`'s `input` and `output` descriptions say which dialects a tool's schemas may be in.
