# `@kindgi/schema` — Specification

*Deep spec for humans. Complements the JSON Schemas in `@kindgi/specs` (the wire contracts) and `packages/types/SPEC.md` (the foundational types).*

## Purpose in the OS

Every artifact in Kindgi has its shape defined by a JSON Schema in `@kindgi/specs/*.schema.json`. Those schemas are authoritative — they cross the boundary to Python runtimes, third-party MCP tools, community adapters. But TypeScript code inside the OS needs to *use* those schemas at runtime: validate incoming data, look up schemas by `$id`, parse schema versions.

`@kindgi/schema` is the layer that turns the JSON files into runtime-usable objects. It sits below every kernel/memory/tools/agents package.

## Design principles

1. **Ajv is the validation engine.** Not a leaky abstraction; downstream packages don't need to know about Ajv. But when they need to inspect a validation failure in detail, the raw Ajv error is available via `SchemaError.errors[]`.
2. **Two-pass registration.** All schemas registered first, then validators compiled. This is the only way cross-schema `$ref`s (e.g. `pack.schema.json` → `tool.schema.json`) resolve correctly.
3. **Typed `Result` errors, never thrown.** Every fallible operation returns `Result<T, SchemaError>`. Consumers explicitly handle both branches.
4. **Sync when possible, async only when doing I/O.** `createSpecRegistry(schemas)` is sync; `loadSpecRegistry(dir)` is async. Not everything has to be a Promise.
5. **Fail-fast at construction.** A broken schema during registration returns immediately — downstream validators would be meaningless.

## The Registry

```
┌───────────────────────────────────────────────────────────────┐
│ SpecRegistry                                                    │
│                                                                 │
│  schemas:    Map<$id, unknown>       ← raw parsed JSON         │
│  validators: Map<$id, ValidateFn>    ← compiled Ajv validators │
│                                                                 │
│  validate<T>(id, data) → Result<T, SchemaError>                │
│  getSchema(id)         → Result<unknown, SchemaError>          │
│  ids()                 → readonly string[]                     │
└───────────────────────────────────────────────────────────────┘
```

### Construction paths

Two entry points, one internal builder:

- `createSpecRegistry(schemas)` — synchronous. Every schema is already parsed. Suitable for tests and in-memory use.
- `loadSpecRegistry(dir)` — asynchronous. Reads every `*.schema.json` from `dir`, parses JSON, delegates.

Both return `Result<SpecRegistry, SchemaError>`. Failure at any point (bad `$id`, non-parseable JSON, Ajv rejection) surfaces as `err`.

### Validate semantics

`validate<T>(id, data)` returns:
- `{ kind: 'ok', value: data as T }` on success. The `T` type parameter is caller-asserted — Ajv validated the shape matches the JSON Schema, but the caller declares what TypeScript type that corresponds to. Callers keep the pairing correct until we add TS codegen from schemas.
- `{ kind: 'err', error }` on failure. The error is a discriminated union: `schema-not-found` (id not registered), `validation-error` (Ajv rejected the data, raw `errors[]` available).

Validators are pre-compiled at construction time — `validate` is a hot-path operation with no per-call compilation cost.

## Version extraction

`versionOf(schema)` parses two things:
- **Major version** from `$id` — the `v<N>` segment in `https://kindgi.com/schemas/v<N>/<name>.schema.json`. Returned as `SchemaMajor` (branded number).
- **Full semver** from `$comment: "schema-version: X.Y.Z"`. Returned as `Semver` (branded string).

The regex patterns are strict:
```
$id:      ^https://kindgi\.com/schemas/v(\d+)/([a-z][a-z0-9-]*)\.schema\.json$
$comment: ^schema-version: (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$
```

Semver prereleases (`1.0.0-rc.3`) are supported. Non-conforming `$id` or `$comment` returns `err`.

**Not checked here:** consistency between the `$id` major (`v1`) and the `$comment` major (`1.x.y`). That's a lint concern — if `$id: v2` but `$comment: schema-version: 1.5.0`, this function still returns ok with major=2 and semver=1.5.0. A separate consistency check (in `@kindgi/specs`' `scripts/validate.mjs`, run by `pnpm run spec:validate`) catches drift.

## Error shapes

`SchemaError` is a discriminated union. Consumers switch on `code`:

| Code | Fields | When |
|---|---|---|
| `schema-load-error` | `path`, `cause` | Filesystem I/O failed |
| `schema-parse-error` | `path`, `cause` | JSON.parse threw |
| `schema-compile-error` | `id`, `cause` | Schema structurally invalid or Ajv rejected during registration |
| `schema-not-found` | `id` | Validate/get for an unregistered `$id` |
| `validation-error` | `id`, `errors[]` | Ajv found data invalid; `errors[]` is the raw Ajv report |

Every error has `code` and `message`. Consumers should match on `code`; `message` is documentation-grade but not part of the contract.

## Testing strategy

**Unit** (`src/*.test.ts`):
- `version.test.ts` — valid and invalid `$id` / `$comment` combinations, prereleases, higher majors.
- `registry.test.ts` — empty registry, populated registry, cross-`$ref` resolution, missing `$id`, non-object schemas, validate positive/negative, `getSchema`, `schema-not-found`.

**Integration** (`tests/*.test.ts`):
- `specs-integration.test.ts` — loads the real `@kindgi/specs` directory, exercises every registered schema, validates a real flow document, confirms error paths.

## Zod as optional authoring surface

JSON Schema stays the **authoritative wire form**. Every artifact registered in `SpecRegistry`, every manifest exchanged over MCP / HTTP / cross-runtime discovery, every schema published in `@kindgi/specs/*.schema.json` remains a Draft 2020-12 JSON Schema document. Nothing changes for non-TS consumers.

With Zod v4 as the workspace-wide version, `@kindgi/schema` exposes three helpers that let downstream packages (`@kindgi/tools`, `@kindgi/guardrails`, and consumers below) accept **either** JSON Schema **or** Zod v4 schemas at authoring time:

- `isZodSchema(value): value is ZodLikeSchema` — structural check for the `_zod` + `~standard` shape Zod v4 stamps on every schema. No runtime import of `zod`; safe when the peer dep is absent.
- `schemaKindOf(value): 'zod' | 'json-schema'` — sugar over `isZodSchema`.
- `toJSONSchema(schema): Result<JSONSchemaObject, InvalidZodConversionError>` — async, dynamic-imports `zod` on first use. Companion `toJSONSchemaSync` accepts a pre-loaded converter for sync authoring paths; the corresponding `loadZodConverterSync()` uses Node's `createRequire` so `defineTool` / `defineCheck` stay synchronous.

**`zod` is a peer dependency** on every package that accepts Zod authoring. Workspaces that never write Zod never install it and never pay any resolution cost. Callers who pass a Zod schema without `zod` on their `node_modules` get a typed `invalid-zod-conversion` error surfaced through the returned `Result` — never a module-resolution crash.

**Fidelity + limitations** — `z.toJSONSchema()` covers Zod primitives, objects, arrays, unions, discriminated unions, literals, enums, records, tuples, optional/nullable/nonoptional wrappers, defaults, catches, coerced primitives, refinements, and pipes. Unrepresentable constructs (`z.function()`, `z.symbol()`, `.transform()` chains whose output has no JSON Schema equivalent) throw at conversion — we surface those as `invalid-zod-conversion` at the boundary so authors see the failure immediately, not at wire time.

**Not supported** — `z.fromJSONSchema()` (the reverse direction) and other TS validation libraries (Effect Schema, Valibot, …).

## Non-goals

- **No wire-level Zod.** Every artifact on the wire is a JSON Schema. Language-agnostic MCP + OpenAPI + Python/Go/Rust consumers must never see Zod.
- **No TS type generation from JSON Schemas.** Callers maintain matching TS types by hand, or author with Zod and derive them via `z.infer<...>`.
- **No custom Ajv keywords or extensions.** Stock Ajv + `ajv-formats` only: Draft 2020-12 for Kindgi's own schemas, and `compileJsonSchema` compiles a schema from elsewhere (an MCP server's) with Ajv's class for the dialect it declares.
- **No schema migration between majors.** Not needed until any schema has a v2.
- **No caching of loaded registries across calls.** Callers manage their own registry lifecycle.

## Change discipline

`SpecRegistry` is a stable interface — additions are non-breaking, removals or signature changes are semver-major.

`SchemaError` union is stable — adding a new variant is non-breaking as long as consumers exhaustively switch on `code` with a default case (or accept unknown codes gracefully).

`versionOf` output shape (`{ major, semver }`) is stable. Adding fields (e.g. `prerelease`) is non-breaking.
