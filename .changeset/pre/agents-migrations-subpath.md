---
'@kindgi/agents': patch
'@kindgi/sdk': patch
---

`@kindgi/sdk/define` bundles in an app: Next.js (Turbopack) failed to build a route that imported an agent file's exported schema, on `@kindgi/agents`' `new URL('../migrations/', import.meta.url)`. `AGENTS_MIGRATIONS_DIR` moved to a runtime-only subpath, `@kindgi/agents/migrations`, and is no longer exported from `@kindgi/agents`' main entry. A test bundles `@kindgi/sdk/define` and fails if any module it reaches resolves a file from its own URL. The `serverExternalPackages` workaround is no longer needed.
