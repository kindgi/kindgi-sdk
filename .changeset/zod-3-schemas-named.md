---
"@kindgi/schema": patch
"@kindgi/tools": patch
"@kindgi/agents": patch
"@kindgi/guardrails": patch
"@kindgi/handler-runtime": patch
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**An app on zod 3 is shown the way to JSON Schema.**

- **A schema from zod 3 is refused by name**, from the zod 3.x package or from zod 4's `zod/v3`. That's a tool's `input` or `output`, an agent's `output.schema` or a check's `configSchema`, and a tool's raw `input` or `output` when the build reads a tool not made with `defineTool`. The message says Kindgi takes zod 4 schemas, and shows the JSON Schema object to write instead. Before, such a schema was read as JSON Schema and failed to compile with a message that never said zod.
- **An older zod is named.** A zod 4 schema, such as `zod/v4` from zod 3.25, used with a `zod` older than zod 4 installed, now says the installed `zod` is older than zod 4, not that it isn't installed. When loading `zod` throws, the error keeps what it threw as its cause.
- **`kindgi init`'s warning names both ways** for an app on zod 3: move the app to zod 4, or write Kindgi's schemas as JSON Schema objects, with an example.
- **The `kindgi-authoring-tools` skill** says the same.
