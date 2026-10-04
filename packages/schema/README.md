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
- **`compileInlineSchema(schema)`** — compile one anonymous JSON Schema (no `$id`, no cross-schema `$ref`) into a `CompiledInlineSchema` whose `validate<T>(data)` returns `Result<T, ValidationErrorLike>`.
- **`compileJsonSchema(schema, options?)`** — compile one JSON Schema into an Ajv `ValidateFunction`, in the dialect it declares in `$schema` (draft-06, draft-07, 2019-09 or 2020-12; 2020-12 when it declares none), with formats checked. `dialects` limits the ones it may declare. `strict` (default `true`) is Ajv's strict mode, a lint for the schemas you write; turn it off for a schema from elsewhere, such as an MCP server's. `useDefaults` fills in each property's `default`. Throws for another dialect, or a schema that doesn't compile.
- **`jsonSchemaDialect(schema, allowed?)`** — the dialect a schema declares, as `'draft-06' | 'draft-07' | '2019-09' | '2020-12'`; throws, naming it, for one Kindgi doesn't validate (or one not in `allowed`).
- **`versionOf(schema)`** — extract `{ major, semver }` from a schema's `$id` and `$comment`.
- **Zod authoring helpers** — `AnySchema` (a JSON Schema object or a Zod v4 schema), `isZodSchema`, `isJsonSchemaObject`, `schemaKindOf`, and `toJSONSchema` / `toJSONSchemaSync` (with `loadZodConverter` / `loadZodConverterSync`), which convert Zod to JSON Schema through Zod's native `z.toJSONSchema()`. `zod` is an optional peer dependency: it is imported only when a Zod schema is passed, and a missing or failed conversion is an `invalid-zod-conversion` error, not a throw.
- **`canonicalize(value)`** — deterministic JSON serialization (sorted keys, `undefined` omitted, no whitespace), a subset of RFC 8785 used for signing.
- **`SchemaError`** — typed discriminated union covering load / parse / compile / not-found / validation / Zod-conversion errors.

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
- **No custom Ajv extensions.** Uses stock Ajv + `ajv-formats`, with no custom keywords. Kindgi's own schemas are Draft 2020-12; `compileJsonSchema` compiles a schema from elsewhere with Ajv's class for its declared dialect.
