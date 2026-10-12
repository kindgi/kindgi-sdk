---
"@kindgi/schema": patch
"@kindgi/guardrails": patch
"@kindgi/tools": patch
"@kindgi/bounds": patch
---

**`compileJsonSchema` and `compileInlineSchema` compile under the process's bounds (`@kindgi/bounds`),** and compile each schema once.
- A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON.
- A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, naming the limit: 64 levels and 1 MiB unless the server sets other bounds.
- Validators are kept by the schema's JSON as written and the options it was compiled with, the least recently used dropped once `schemaCacheEntries` are kept or their schemas' JSON passes `schemaCacheMaxBytes`. A schema that didn't compile throws the same error again. The cache is all that keeps a compiled schema: `compileInlineSchema`'s result keeps the schema's cache key, not its validator, and compiles it again on `validate` once the cache has dropped it; a tool's validators are taken from the cache on each call.
- Each tenant's compiles share a budget, `schemaCompileBudgetMs` in any 60 seconds (hosted 2 s, self-hosted none). `runAsTenant` (new in `@kindgi/bounds`) says whose compile it is and which count: by default only a schema compiled again after the cache dropped it; with `{ compiles: 'all' }`, every compile. Past the budget, a compile that counts throws `SchemaCompileBudgetError` with `retryAfterMs`, from `compileInlineSchema` too; `defineTool`, `validateToolManifest` and a guardrail's config check pass it on rather than report the schema as invalid, and `compileInlineSchema`'s `validate` throws it when it compiles again. A tenant that compiled nothing for an hour is forgotten: its next compiles are first ones again, as after a restart. `runOutsideTenant` (new) runs Kindgi's own work, started inside a tenant's scope, outside it.
- Under the hosted profile, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth). Patterns (`pattern`, `patternProperties`, `propertyNames`) run on RE2 through `compileTenantPattern`, and a schema with one RE2 can't run doesn't compile. Formats are ajv-formats' `fast` ones (looser in places: `date` accepts `2026-02-30`), with `regex` a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`, new in `@kindgi/bounds`; a pattern RE2 refuses only for its size passes), and `url` written without its backtracking. `uniqueItems` finds a repeat by a key for each item, with Ajv's verdict and error.
- `createSpecRegistry` and `loadSpecRegistry` run the patterns of Kindgi's own schemas on V8.
- A guardrail's config is checked against its check's schema through `compileJsonSchema`, so the same bounds apply.
