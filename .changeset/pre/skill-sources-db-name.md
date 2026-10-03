---
"@kindgi/env-schema": patch
"@kindgi/sdk": patch
---

- `@kindgi/env-schema`: `KINDGI_DATABASE_URL`'s documented dev default is now `postgres://localhost:5432/kindgi`, matching the runtime's new default database name.
- `@kindgi/sdk`: the `kindgi-getting-started`, `kindgi-authoring-mcp-servers` and `kindgi-framework-feedback` skills no longer list `sources:` paths outside this repository.
