// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createRequire } from 'node:module';

import type { Result } from '@kindgi/types';

import type { InvalidZodConversionError } from './errors.js';

// `createRequire` is Node's ESM-side bridge to CJS-style synchronous
// resolution. We only use it to resolve the `zod` peer dependency
// synchronously — the actual JSON conversion function works ESM or CJS.
const nodeRequire = createRequire(import.meta.url);

/**
 * Wire-authoritative JSON Schema shape. Matches the JsonSchema alias used by
 * `@kindgi/tools` and `@kindgi/guardrails` — a Draft 2020-12 object
 * with `type`, `properties`, etc. Kept as `Readonly<Record<string, unknown>>`
 * here to avoid importing any consumer type.
 */
export type JSONSchemaObject = Readonly<Record<string, unknown>>;

/**
 * Structural shape of a Zod v4 schema. We deliberately avoid importing
 * `zod` at type-position here so `@kindgi/schema` keeps zero runtime OR
 * peer dependency on Zod — the utils compile even in a workspace that
 * never installs `zod`. Downstream packages that DO peer-depend on `zod`
 * import `z.ZodType` themselves and pass instances through this alias.
 *
 * Zod v4 schemas carry `_zod` (internals) + `~standard` (Standard Schema
 * spec adapter) at the type-level; both properties are stable across
 * Zod v4's minor releases.
 */
export interface ZodLikeSchema {
  readonly _zod: unknown;
  readonly '~standard': unknown;
}

/**
 * The alternate authoring input accepted at framework boundaries. Callers
 * pass either a JSON Schema object (Draft 2020-12) or a Zod v4 schema.
 *
 * Non-TS consumers see no change — the framework converts Zod to JSON
 * Schema at author time via `toJSONSchema`, and the wire form is always
 * JSON Schema.
 */
export type AnySchema = JSONSchemaObject | ZodLikeSchema;

/**
 * Structural detection. Returns true iff `value` looks like a Zod v4
 * schema — `_zod` property present AND `~standard` present. Purely
 * structural: never imports from `zod` at runtime, so the check is safe
 * even when zod is not installed at all.
 *
 * The check is deliberately narrow — a JSON Schema object never has a
 * `_zod` property, so the two authoring surfaces cannot collide. A schema
 * from zod 3 has no `_zod` either; `isOlderZodSchema` tells it apart.
 */
export function isZodSchema(value: unknown): value is ZodLikeSchema {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return '_zod' in rec && '~standard' in rec && typeof rec._zod === 'object';
}

/**
 * Structural detection of a schema from zod 3: the zod 3.x package's `zod`
 * (not its `zod/v4`), or zod 4's `zod/v3`. It has `_def` and `safeParse`,
 * and no `_zod`. Kindgi converts zod 4 schemas only; read as a JSON Schema
 * object, such a schema fails to compile with a message that never says
 * zod. A JSON Schema object holds no function, so the two can't collide.
 */
function isOlderZodSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    !('_zod' in rec) &&
    typeof rec._def === 'object' &&
    rec._def !== null &&
    typeof rec.safeParse === 'function'
  );
}

/** What a schema from zod 3 gets, wherever it's passed. */
function olderZodSchemaError(): InvalidZodConversionError {
  return {
    code: 'invalid-zod-conversion',
    message:
      'The schema is from zod 3 (the zod 3.x package, or `zod/v3`), and Kindgi takes zod 4 schemas: ' +
      "write it as a JSON Schema object, e.g. `{ type: 'object', additionalProperties: false, required: ['orderId'], properties: { orderId: { type: 'string' } } }`, " +
      'or import `z` from `zod` 4 (>=4.0.0).',
    cause: new Error('zod 3 schema'),
  };
}

/**
 * Structural detection for a JSON Schema object. Cheap heuristic — accepts
 * any object that isn't a Zod schema, of zod 4 or of zod 3. JSON Schema
 * validity (Draft 2020-12 compilability) is checked separately by each
 * consumer via Ajv.
 */
export function isJsonSchemaObject(value: unknown): value is JSONSchemaObject {
  if (value === null || typeof value !== 'object') return false;
  if (isZodSchema(value) || isOlderZodSchema(value)) return false;
  return true;
}

/**
 * Author-time detection: how to interpret an `AnySchema` value. Used by
 * downstream packages when they need to route on the authoring surface —
 * for example, to preserve the original Zod schema for TS `z.infer<...>`
 * while caching the converted JSON Schema for wire use.
 */
export type SchemaKind = 'zod' | 'json-schema';

/**
 * Return `'zod'` for Zod schemas, `'json-schema'` for JSON Schema objects.
 * A schema from zod 3 answers `'json-schema'` too, so the union keeps its
 * two kinds: `isJsonSchemaObject` tells the two apart, and both converters
 * refuse it.
 */
export function schemaKindOf(value: AnySchema): SchemaKind {
  return isZodSchema(value) ? 'zod' : 'json-schema';
}

/**
 * Which side of a schema a JSON Schema describes:
 *
 *   - `input` — what a caller may send. A field with a `.default()` is
 *     optional (the default fills it). Tool inputs, guardrail config.
 *   - `output` — what parsing produces. A defaulted field is always
 *     present. Tool outputs, an agent's typed answer.
 *
 * Every conversion names one: they differ exactly where Zod defaults,
 * so the wrong one silently requires fields callers may leave out.
 */
export type SchemaIo = 'input' | 'output';

/**
 * Convert an `AnySchema` to its authoritative JSON Schema wire form.
 *
 * - Zod schema → calls `z.toJSONSchema(schema, { io })` (Zod v4 native —
 *   no third-party `zod-to-json-schema` dependency).
 * - A schema from zod 3 → `err`, naming zod 3 and the JSON Schema way.
 * - JSON Schema object → returned as-is.
 * - Anything else → `err`.
 *
 * Conversion failures (unrepresentable Zod types like `.transform()`,
 * cycles without a registry, function schemas) surface as
 * `InvalidZodConversionError` with the underlying cause preserved. No
 * throws escape.
 *
 * Zod is imported dynamically the first time a Zod schema flows through:
 * a workspace that never uses Zod never pays the import cost, and one
 * that hasn't installed the peer dep gets a clean typed error instead of
 * a module-resolution crash.
 */
export async function toJSONSchema(
  schema: AnySchema,
  io: SchemaIo,
): Promise<Result<JSONSchemaObject, InvalidZodConversionError>> {
  if (!isZodSchema(schema)) {
    return isOlderZodSchema(schema)
      ? { kind: 'err', error: olderZodSchemaError() }
      : { kind: 'ok', value: schema };
  }
  const converterResult = await loadZodToJSONSchema();
  if (converterResult.kind === 'err') return converterResult;
  try {
    const converted = converterResult.value(schema, { io });
    return { kind: 'ok', value: converted as JSONSchemaObject };
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-zod-conversion',
        message: `z.toJSONSchema() failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      },
    };
  }
}

/**
 * Synchronous variant — for defineTool / validateGuardrail sites that must
 * stay sync. Requires the caller to have already resolved the converter
 * (via `loadZodConverter()`) at package init. When there's no converter
 * but a Zod schema is passed, returns `err` saying why, as the load found
 * it: the `zod` peer dependency isn't installed, or it's older than zod 4.
 * A schema from zod 3 gets `err` too, naming zod 3.
 */
export function toJSONSchemaSync(
  schema: AnySchema,
  converter: ZodConverter | undefined,
  io: SchemaIo,
): Result<JSONSchemaObject, InvalidZodConversionError> {
  if (!isZodSchema(schema)) {
    return isOlderZodSchema(schema)
      ? { kind: 'err', error: olderZodSchemaError() }
      : { kind: 'ok', value: schema };
  }
  if (converter === undefined) {
    return { kind: 'err', error: missingConverterError() };
  }
  try {
    const converted = converter(schema, { io });
    return { kind: 'ok', value: converted as JSONSchemaObject };
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'invalid-zod-conversion',
        message: `z.toJSONSchema() failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      },
    };
  }
}

/**
 * A resolved handle on `z.toJSONSchema`. Passed to `toJSONSchemaSync`
 * from consumers that eagerly loaded the peer dep once at package init.
 */
export type ZodConverter = (
  schema: ZodLikeSchema,
  params?: { readonly io?: SchemaIo },
) => JSONSchemaObject;

/** A problem `parseWithSchema` found, as the schema reported it. */
export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly unknown[];
}

/**
 * Parse a value with a Zod schema through its Standard Schema interface
 * (`'~standard'.validate`): the parsed value — defaults filled,
 * transforms and refinements applied — or the issues. What a handler
 * typed with `z.infer` of the schema expects to receive.
 */
export async function parseWithSchema(
  schema: ZodLikeSchema,
  value: unknown,
): Promise<
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'err'; readonly issues: readonly SchemaIssue[] }
> {
  const standard = schema['~standard'] as {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value?: unknown; readonly issues?: readonly SchemaIssue[] }
      | Promise<{ readonly value?: unknown; readonly issues?: readonly SchemaIssue[] }>;
  };
  const result = await standard.validate(value);
  return result.issues !== undefined
    ? {
        kind: 'err',
        issues: result.issues.map((i) => ({
          message: i.message,
          ...(i.path !== undefined && { path: [...i.path] }),
        })),
      }
    : { kind: 'ok', value: result.value };
}

let cachedConverter: ZodConverter | undefined | null = null;

/**
 * Why the load found no converter: `'older'` when the installed `zod` is
 * older than zod 4 (no `toJSONSchema`), else what loading it threw.
 */
let missingWhy: 'older' | { readonly thrown: unknown } | undefined;

/**
 * What a load of `zod` comes to, the same for both loaders: the module's
 * `toJSONSchema`, or no converter, keeping why for the error a Zod schema
 * then gets. The loaders differ only in how they load.
 */
function settleConverter(
  loaded: { readonly module: { readonly toJSONSchema?: unknown } } | { readonly thrown: unknown },
): ZodConverter | undefined {
  if ('thrown' in loaded) {
    missingWhy = { thrown: loaded.thrown };
  } else if (typeof loaded.module.toJSONSchema !== 'function') {
    missingWhy = 'older';
  } else {
    cachedConverter = loaded.module.toJSONSchema as ZodConverter;
    return cachedConverter;
  }
  cachedConverter = undefined;
  return undefined;
}

/**
 * Load `z.toJSONSchema` from the `zod` peer dependency. Returns
 * `undefined` when zod is not installed, or is older than zod 4 —
 * callers decide whether that's an error or a silent no-op
 * (JSON-Schema-only workspaces are legitimate).
 *
 * The result is cached — repeat calls resolve synchronously after the
 * first.
 */
export async function loadZodConverter(): Promise<ZodConverter | undefined> {
  if (cachedConverter !== null) return cachedConverter;
  try {
    return settleConverter({ module: (await import('zod')) as { toJSONSchema?: unknown } });
  } catch (thrown) {
    return settleConverter({ thrown });
  }
}

/**
 * Synchronous variant of `loadZodConverter`. Uses Node's `createRequire`
 * so sync surfaces (`defineTool`, `validateGuardrail`) can stay
 * sync even on their first Zod-authored call. Falls back cleanly when
 * `zod` isn't installed: returns `undefined` and callers surface the
 * missing peer dep as a typed error at the boundary.
 *
 * Runtime: Node ≥18 (both CJS and ESM entry points to zod resolve
 * through the same `createRequire` handle). No behavior change for
 * workspaces that never author with Zod — the first sync call to
 * `loadZodConverterSync` returns `undefined` cheaply.
 */
export function loadZodConverterSync(): ZodConverter | undefined {
  if (cachedConverter !== null) return cachedConverter;
  try {
    return settleConverter({ module: nodeRequire('zod') as { toJSONSchema?: unknown } });
  } catch (thrown) {
    return settleConverter({ thrown });
  }
}

async function loadZodToJSONSchema(): Promise<Result<ZodConverter, InvalidZodConversionError>> {
  const converter = await loadZodConverter();
  if (converter === undefined) {
    return { kind: 'err', error: missingConverterError() };
  }
  return { kind: 'ok', value: converter };
}

/**
 * What a Zod schema gets when the load found no converter, saying why: a
 * `zod` older than zod 4 (a `zod/v4` schema from zod 3 still needs zod 4
 * itself to convert), or none at all.
 */
function missingConverterError(): InvalidZodConversionError {
  const way = 'Install `zod` (>=4.0.0) or author with a JSON Schema object.';
  if (missingWhy === 'older') {
    return {
      code: 'invalid-zod-conversion',
      message: `Zod schema passed but the installed \`zod\` is older than zod 4: it has no \`toJSONSchema\`, and \`zod/v4\` from zod 3 isn't enough. ${way}`,
      cause: new Error('zod before 4 installed'),
    };
  }
  return {
    code: 'invalid-zod-conversion',
    message: `Zod schema passed but the \`zod\` peer dependency is not installed. ${way}`,
    // What the load threw, when it ran, so a broken install reads apart from an absent one.
    cause: missingWhy?.thrown ?? new Error('zod peer dep not installed'),
  };
}

/**
 * Test-only: reset the cached converter so tests can exercise both the
 * peer-dep-present and peer-dep-missing branches. Not part of the public
 * API — callers outside this package must not depend on this being
 * present.
 *
 * @internal
 */
export function __resetZodConverterCacheForTests(): void {
  cachedConverter = null;
  missingWhy = undefined;
}
