---
"@kindgi/tools": patch
"@kindgi/sdk": patch
---

**An HTTP tool's templates hold only what the runtime fills.** `defineTool`, and `validateToolManifest` (so `POST /v1/tools` and a deployment), refuse three things, naming the field:

- A brace in `urlTemplate` that isn't part of a `{field}` placeholder, such as `{{id}}`, `{?q}`, `{order-id}` or a lone brace: "has a brace that isn't part of a {field} placeholder; write a literal one as %7B or %7D".
- A `{name}` in a `text` body or a header value whose name isn't ASCII, such as `{größe}`, which the runtime never fills. The braces of JSON, or of GraphQL with spaces inside them, still pass.
- A placeholder in `urlTemplate` or a `text` body that the input schema has no field for, as the Java and Python SDKs already refuse. Before, `defineTool` built the tool: the call then failed on such a name in the URL, and sent one in the body as text. A compact GraphQL selection, `{name}`, reads as a placeholder; write it `{ name }`.

A tool the runtime rebuilds from what it stored, `defineTool(tool, { stored: true })`, skips these checks, so one registered or deployed before keeps working. The authoring skills say so: `kindgi-authoring-tools` 0.5.2, `kindgi-java-authoring-tools` 0.1.6, `kindgi-python-authoring-tools` 0.1.8 and `kindgi-scala-authoring-tools` 0.1.6.
