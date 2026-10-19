// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Compile a JSON Schema in the dialect it declares (`$schema`). Kindgi's
 * own schemas are Draft 2020-12, the default when a schema declares none.
 * A schema from elsewhere (an MCP server: the TypeScript MCP SDK emits
 * draft-07) means its keywords as its dialect defines them: draft-07's
 * array-form `items` is a tuple, 2020-12's is not. So each dialect gets
 * Ajv's class for it, not 2020-12's with another meta-schema added.
 *
 * `strict` is Ajv's strict mode, an authoring lint (unknown keywords and
 * formats, loose tuples): right for the schemas a pack's author writes,
 * wrong for a schema someone else's server sends, which is valid JSON Schema
 * without being written to that standard. A union of types
 * (`type: ['string', 'number']`) is standard JSON Schema, and what Zod 4
 * writes for a union of scalars, so it's allowed in either mode
 * (`ALLOW_UNION_TYPES`).
 */

import type { ValidateFunction } from 'ajv';

import { type TenantSchemaCompile, compileTenantSchema, holdTenantSchema } from './bounded.js';

/**
 * Every Kindgi schema compiler takes a union of types (`type: ['string', 'number']`): standard
 * JSON Schema, which Ajv's strict mode otherwise refuses, and what Zod 4 writes for
 * `z.union([z.string(), z.number()])`. The pack services' validators agree (Python's
 * `jsonschema`, Java's `SchemaValidator`).
 */
export const ALLOW_UNION_TYPES = true;

/** The JSON Schema dialects a schema may declare. */
export type JsonSchemaDialect = 'draft-06' | 'draft-07' | '2019-09' | '2020-12';

const DIALECTS: ReadonlyMap<string, JsonSchemaDialect> = new Map<string, JsonSchemaDialect>([
  ['http://json-schema.org/draft-06/schema', 'draft-06'],
  ['http://json-schema.org/draft-07/schema', 'draft-07'],
  ['https://json-schema.org/draft/2019-09/schema', '2019-09'],
  ['https://json-schema.org/draft/2020-12/schema', '2020-12'],
]);

const ALL_DIALECTS: readonly JsonSchemaDialect[] = [...DIALECTS.values()];

/**
 * The dialect `schema` declares in `$schema` (2020-12 when it declares
 * none). Throws for a dialect that isn't one of `allowed` (by default,
 * every one Kindgi validates), naming it and them.
 */
export function jsonSchemaDialect(
  schema: Readonly<Record<string, unknown>>,
  allowed: readonly JsonSchemaDialect[] = ALL_DIALECTS,
): JsonSchemaDialect {
  const declared = schema.$schema;
  const dialect =
    declared === undefined
      ? '2020-12'
      : typeof declared === 'string'
        ? DIALECTS.get(declared.replace(/#$/, ''))
        : undefined;
  if (dialect === undefined || !allowed.includes(dialect)) {
    const where = allowed.length < ALL_DIALECTS.length ? ' here' : '';
    throw new Error(
      `The schema's $schema ${JSON.stringify(declared)} isn't a JSON Schema dialect Kindgi validates${where}: ${listOf(allowed)}.`,
    );
  }
  return dialect;
}

/** `a`, `a or b`, `a, b or c`. */
function listOf(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

export interface CompileJsonSchemaOptions {
  /** The dialects the schema may declare. Default: every one Kindgi validates. */
  readonly dialects?: readonly JsonSchemaDialect[];
  /** Ajv's strict mode. Default `true`; `false` for a schema from elsewhere (see above). */
  readonly strict?: boolean;
  /** Fill in each property's `default` in the data validated (Ajv's `useDefaults`). */
  readonly useDefaults?: boolean;
}

/**
 * A validator for `schema`, compiled in its declared dialect under the
 * process's bounds (`compileTenantSchema`). Throws when the dialect isn't
 * supported (or allowed), the schema is over a bound, or it doesn't
 * compile, as `ajv.compile` does.
 */
export function compileJsonSchema(
  schema: Readonly<Record<string, unknown>>,
  options: CompileJsonSchemaOptions = {},
): ValidateFunction {
  return compileTenantSchema(schema, compileFor(schema, options));
}

/**
 * `compileJsonSchema` for a caller that keeps the schema: compiled now,
 * and what to call for its validator each time (`holdTenantSchema`). The
 * cache stays all that holds a JSON schema's validator. A schema JSON
 * can't carry (a key whose value is `undefined`, say) is never cached, so
 * it's held as compiled rather than compiled on every call.
 */
export function holdJsonSchema(
  schema: Readonly<Record<string, unknown>>,
  options: CompileJsonSchemaOptions = {},
): () => ValidateFunction {
  return holdTenantSchema(schema, compileFor(schema, options));
}

function compileFor(
  schema: Readonly<Record<string, unknown>>,
  options: CompileJsonSchemaOptions,
): TenantSchemaCompile {
  return {
    dialect: jsonSchemaDialect(schema, options.dialects),
    options: {
      strict: options.strict ?? true,
      allErrors: true,
      allowUnionTypes: ALLOW_UNION_TYPES,
      ...(options.useDefaults === true && { useDefaults: true }),
    },
  };
}
