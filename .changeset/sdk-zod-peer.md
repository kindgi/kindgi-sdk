---
"@kindgi/sdk": patch
---

**`@kindgi/sdk` declares zod v4 as an optional peer dependency** (`zod: ^4.0.0`), as its tool, agent, guardrail, schema and handler-runtime packages already do. Schemas can be JSON Schema or zod v4, so zod stays optional; an app that has zod 3 is now flagged by its package manager at install. An app whose own code imports zod (every example does) still lists `zod` in its own dependencies, which `kindgi init` adds.
