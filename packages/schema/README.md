# `@kindgi/schema`

JSON Schema utilities for Kindgi. Loads specs, provides Ajv-based validation, extracts schema versions, converts Zod v4 schemas to JSON Schema, and serializes JSON canonically for signing. Consumers use this to validate incoming data against the wire contracts in [`@kindgi/specs`](../specs/).

## Purpose

Turn the JSON Schemas that live in `@kindgi/specs/*.schema.json` into runtime-usable validators, with cross-schema `$ref` resolution handled correctly (two-pass registration), typed `Result` errors, and version extraction that respects our `$id` + `$comment` convention.

## Exports

- **`createSpecRegistry(schemas)`** — build a registry from already-parsed schema documents (synchronous, no filesystem access).
- **`loadSpecRegistry(dir)`** — build a registry by reading every `*.schema.json` from a directory (async).
- **`SpecRegistry`** — the resulting interface:
  - `validate<T>(id, data)` — validate data against a schema by `$id`, returning `Result<T, SchemaError>`.
  - `getSchema(id)` — retrieve the raw parsed schema JSON.
  - `ids()` — list every registered `$id`.
- **`compileInlineSchema(schema)`** — compile one anonymous JSON Schema (no `$id`, no cross-schema `$ref`) into a `CompiledInlineSchema` whose `validate<T>(data)` returns `Result<T, ValidationErrorLike>`. Compiled under the process's bounds (see [Bounds](#bounds)); a schema over them is a `compile` error.
- **`compileJsonSchema(schema, options?)`** — compile one JSON Schema into an Ajv `ValidateFunction`, in the dialect it declares in `$schema` (draft-06, draft-07, 2019-09 or 2020-12; 2020-12 when it declares none), with formats checked. `dialects` limits the ones it may declare. `strict` (default `true`) is Ajv's strict mode, a lint for the schemas you write; turn it off for a schema from elsewhere, such as an MCP server's. `useDefaults` fills in each property's `default`. Compiled under the process's bounds (see [Bounds](#bounds)). Throws for another dialect, a schema over the bounds, or one that doesn't compile.
- **`holdJsonSchema(schema, options?)`** — `compileJsonSchema` for a caller that keeps the schema. It compiles the schema now and returns a function that gives its validator on each call. It keeps a JSON schema's cache key, not its validator, so the cache stays all that holds it: once the cache drops it, the next call compiles it again, a recompile the budget counts. A schema JSON can't carry is held as compiled.
- **`jsonSchemaDialect(schema, allowed?)`** — the dialect a schema declares, as `'draft-06' | 'draft-07' | '2019-09' | '2020-12'`; throws, naming it, for one Kindgi doesn't validate (or one not in `allowed`).
- **`versionOf(schema)`** — extract `{ major, semver }` from a schema's `$id` and `$comment`.
- **Zod authoring helpers** — `AnySchema` (a JSON Schema object or a Zod v4 schema), `isZodSchema`, `isJsonSchemaObject`, `schemaKindOf`, and `toJSONSchema` / `toJSONSchemaSync` (with `loadZodConverter` / `loadZodConverterSync`), which convert Zod to JSON Schema through Zod's native `z.toJSONSchema()`. `zod` is an optional peer dependency: it is imported only when a Zod schema is passed, and a missing or failed conversion is an `invalid-zod-conversion` error, not a throw.
- **`canonicalize(value)`** — deterministic JSON serialization (sorted keys, `undefined` omitted, no whitespace), a subset of RFC 8785 used for signing.
- **`SchemaError`** — typed discriminated union covering load / parse / compile / not-found / validation / Zod-conversion errors.

## Bounds

`compileJsonSchema` and `compileInlineSchema` compile a schema under the process's bounds, from [`@kindgi/bounds`](../bounds/):

- A schema nested deeper than `schemaMaxDepth`, or larger than `schemaMaxBytes` as JSON, is refused before it's compiled, with an error naming the limit.
- A `$ref` is compiled once, where its target is, not copied into each place that uses it (Ajv's `inlineRefs: false`), so the code a schema compiles to grows with its JSON, not with its targets' sizes times their uses.
- Each schema is compiled once and its validator kept, by the schema's JSON as written and the options it was compiled with. The cache holds at most `schemaCacheEntries` validators and `schemaCacheMaxBytes` of their schemas' JSON, and drops the least recently used first. A schema that didn't compile is kept too, weighing nothing, and throws the same error again.

Under `HOSTED_BOUNDS`, whose patterns run on RE2, every check a schema makes of the data runs in time linear in the data (`uniqueItems`: in its size times its depth):

- `pattern`, `patternProperties` and `propertyNames` run on RE2, through `compileTenantPattern`. A schema with a pattern RE2 can't run (a lookahead, a backreference) doesn't compile, and the error names the pattern and why.
- Formats are ajv-formats' `fast` ones. `regex` accepts a pattern whose syntax `compileTenantPattern` accepts, checked without building RE2's program (`tenantPatternSyntaxProblem`). A pattern RE2 refuses only when it builds the program still passes here: one too large (a repeat over 1,000) or with an escape the check doesn't name (`\cA`, `\p{Letter}`). `url` is ajv-formats' own, written without its backtracking. `fast` is looser in places: `date` accepts `2026-02-30`.
- `uniqueItems` looks for a repeat by a key for each item, not pair by pair. The verdict and the error are Ajv's, down to the pair of items it names. One difference: an object with its own `valueOf` or `toString` key is compared by its keys, where Ajv's compare throws.

Under `SELF_HOSTED_BOUNDS`, patterns run on V8, formats are ajv-formats' `full` ones, and `uniqueItems` is Ajv's own.

### Compile time

Compiling a large schema holds the event loop, so each tenant's compiles share a budget: `schemaCompileBudgetMs` of compiling in any 60 seconds (2 seconds under `HOSTED_BOUNDS`, none under `SELF_HOSTED_BOUNDS`). A compile is a tenant's when it runs inside `runAsTenant` from `@kindgi/bounds`, and which compiles count is the scope's:

- By default, only a schema compiled again: one the tenant compiled before in this process, dropped from the cache since. A tenant's first compile of a schema is free, for its first 4,096 schemas; past them, every compile counts.
- With `{ compiles: 'all' }`, which a request that publishes schemas uses, every compile counts, the first ones too.

Once a tenant has spent its budget, a compile that counts throws `SchemaCompileBudgetError` (its `budgetMs`, and `retryAfterMs` until enough of its compiles leave the window), from `compileInlineSchema` as from `compileJsonSchema`: it isn't the schema's fault, so it isn't returned as a compile error, and it isn't kept. Validators already kept still serve. A compile isn't stopped part way, so a tenant's minute can run over by one compile. Outside a scope, nothing is refused.

`createSpecRegistry` and `loadSpecRegistry` compile Kindgi's own schemas, in `@kindgi/specs`, and run their patterns on V8; the formats and `uniqueItems` follow the bounds as above.

## Example

```ts
import { loadSpecRegistry, versionOf } from '@kindgi/schema';
import type { Flow } from '@kindgi/flow';

const registry = await loadSpecRegistry('./specs');
if (registry.kind === 'err') {
  console.error(registry.error);
  process.exit(1);
}

const incoming = JSON.parse(await readFile('user-flow.json', 'utf-8'));
const validated = registry.value.validate<Flow>(
  'https://kindgi.com/schemas/v1/flow.schema.json',
  incoming,
);

if (validated.kind === 'ok') {
  runGraph(validated.value);
} else {
  console.error(validated.error.code, validated.error.message);
}
```

## Non-goals

- **No Zod on the wire, and no JSON Schema → Zod conversion.** Zod is an authoring convenience: schemas are converted one way, Zod → JSON Schema, and every schema that is registered or exchanged is JSON Schema.
- **No schema migration helpers.** Every schema is at its first major version, so there is nothing to migrate between.
- **No TypeScript type generation.** Callers define TypeScript types that match schema shapes by hand, or author with Zod and derive them with `z.infer`.
- **No custom Ajv keywords.** Uses Ajv + `ajv-formats` and the keywords they define; under `HOSTED_BOUNDS`, `uniqueItems` and the `url` and `regex` formats are replaced with linear versions of the same checks (see [Bounds](#bounds)). Kindgi's own schemas are Draft 2020-12; `compileJsonSchema` compiles a schema from elsewhere with Ajv's class for its declared dialect.
