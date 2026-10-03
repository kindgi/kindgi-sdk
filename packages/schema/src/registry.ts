// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
// Ajv 8's `/dist/2020` entry exports the Ajv2020 class as a named export.
// The named-import form is stable across ESM/CJS/bundler interop; the default form is not.
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { Result } from '@kindgi/types';

import type { SchemaError } from './errors.js';

// ajv-formats uses CJS `export = fn` style. In ESM with esModuleInterop, the
// module namespace holds the function either directly or under `.default`
// depending on the resolver. Runtime-check to unwrap regardless of shape.
type AddFormatsFn = (ajv: InstanceType<typeof Ajv2020>, opts?: unknown) => unknown;
const addFormatsRaw = addFormatsModule as unknown;
const addFormats: AddFormatsFn =
  typeof addFormatsRaw === 'function'
    ? (addFormatsRaw as AddFormatsFn)
    : (addFormatsRaw as { default: AddFormatsFn }).default;

/**
 * A registry of loaded and compiled JSON Schemas, keyed by `$id`.
 *
 * The registry pre-compiles a validator for every schema at construction time,
 * so `validate()` is a hot-path operation with no per-call compilation cost.
 * Cross-schema `$ref`s (e.g. pack manifest → tool schema) are resolved
 * automatically because all schemas are registered before compilation.
 */
export interface SpecRegistry {
  /**
   * Validate `data` against the schema with the given `$id`.
   *
   * The generic `T` is a caller-asserted type — the runtime does not verify
   * it beyond schema conformance. Consumers pair the `$id` with a manually
   * maintained TypeScript type (or, later, a codegen'd one).
   *
   * @example
   * const r = registry.validate<Flow>('https://kindgi.com/schemas/v1/flow.schema.json', input);
   * if (r.kind === 'ok') { runOnGraph(r.value); }
   */
  validate<T = unknown>(id: string, data: unknown): Result<T, SchemaError>;

  /** Retrieve the raw parsed schema JSON registered at `$id`. */
  getSchema(id: string): Result<unknown, SchemaError>;

  /** Return every registered schema `$id` in insertion order. */
  ids(): readonly string[];
}

interface RegistryState {
  readonly schemas: ReadonlyMap<string, unknown>;
  readonly validators: ReadonlyMap<string, ValidateFunction>;
}

function notFound(id: string): SchemaError {
  return {
    code: 'schema-not-found',
    message: `No schema registered with $id: ${id}`,
    id,
  };
}

function makeRegistry(state: RegistryState): SpecRegistry {
  return {
    validate<T = unknown>(id: string, data: unknown): Result<T, SchemaError> {
      const validator = state.validators.get(id);
      if (validator === undefined) {
        return { kind: 'err', error: notFound(id) };
      }
      if (validator(data)) {
        return { kind: 'ok', value: data as T };
      }
      return {
        kind: 'err',
        error: {
          code: 'validation-error',
          message: `Data does not validate against ${id}`,
          id,
          errors: validator.errors ?? [],
        },
      };
    },
    getSchema(id): Result<unknown, SchemaError> {
      const schema = state.schemas.get(id);
      if (schema === undefined) {
        return { kind: 'err', error: notFound(id) };
      }
      return { kind: 'ok', value: schema };
    },
    ids(): readonly string[] {
      return Array.from(state.schemas.keys());
    },
  };
}

function extractId(schema: unknown): Result<string, SchemaError> {
  if (typeof schema !== 'object' || schema === null || !('$id' in schema)) {
    return {
      kind: 'err',
      error: {
        code: 'schema-compile-error',
        message: 'Schema is missing top-level $id',
        id: '<unknown>',
        cause: schema,
      },
    };
  }
  const id = (schema as { $id: unknown }).$id;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      kind: 'err',
      error: {
        code: 'schema-compile-error',
        message: 'Schema $id is not a non-empty string',
        id: String(id),
        cause: schema,
      },
    };
  }
  return { kind: 'ok', value: id };
}

/**
 * Build a SpecRegistry from an array of already-parsed schema documents.
 *
 * All schemas are registered with the Ajv instance FIRST (so cross-schema
 * `$ref`s can resolve), then validators are compiled and cached.
 *
 * Returns `err` on the first failure — this is fail-fast on purpose. If a
 * spec is broken, downstream validators are meaningless.
 */
export function createSpecRegistry(schemas: readonly unknown[]): Result<SpecRegistry, SchemaError> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: false,
  });
  addFormats(ajv);

  const schemaMap = new Map<string, unknown>();

  // Pass 1: register every schema so $refs can resolve during compilation.
  for (const schema of schemas) {
    const idResult = extractId(schema);
    if (idResult.kind === 'err') {
      return idResult;
    }
    const id = idResult.value;
    try {
      ajv.addSchema(schema as object, id);
      schemaMap.set(id, schema);
    } catch (cause) {
      return {
        kind: 'err',
        error: {
          code: 'schema-compile-error',
          message: `Failed to register schema with $id ${id}`,
          id,
          cause,
        },
      };
    }
  }

  // Pass 2: compile validators, now that cross-refs resolve.
  const validators = new Map<string, ValidateFunction>();
  for (const id of schemaMap.keys()) {
    let validator: ValidateFunction | undefined;
    try {
      validator = ajv.getSchema(id);
    } catch (cause) {
      return {
        kind: 'err',
        error: {
          code: 'schema-compile-error',
          message: `Failed to compile validator for $id ${id}`,
          id,
          cause,
        },
      };
    }
    if (validator === undefined) {
      return {
        kind: 'err',
        error: {
          code: 'schema-compile-error',
          message: `Ajv did not return a validator for $id ${id}`,
          id,
          cause: null,
        },
      };
    }
    validators.set(id, validator);
  }

  return { kind: 'ok', value: makeRegistry({ schemas: schemaMap, validators }) };
}

/**
 * A compiled inline JSON Schema. Unlike `SpecRegistry`, which stores schemas
 * addressed by `$id`, this represents a single anonymous schema (e.g. a loop
 * node's `outputSchema`) whose validator has already been compiled.
 *
 * Callers compile once (at flow load time) and validate many times (each
 * loop iteration).
 */
export interface CompiledInlineSchema {
  /**
   * Validate `data`. Returns the original value on success (typed as `T`
   * for caller convenience — the runtime does not verify the T assertion
   * beyond schema conformance).
   */
  validate<T = unknown>(data: unknown): Result<T, ValidationErrorLike>;
  /** The raw schema JSON, for round-tripping or debugging. */
  readonly source: unknown;
}

/**
 * Structural shape of a validation failure, decoupled from the `SchemaError`
 * discriminated union (which requires an `id`). Consumers that want to
 * surface an inline-schema validation failure typically wrap this in their
 * own domain error.
 */
export interface ValidationErrorLike {
  readonly code: 'validation-error';
  readonly message: string;
  readonly errors: readonly unknown[];
}

/**
 * Compile a single anonymous JSON Schema (draft 2020-12) into a reusable
 * validator. Returns `err` if the schema itself is malformed (Ajv rejects
 * it), which is how the flow loader surfaces `LoopOutputSchemaError` and
 * similar load-time diagnostics.
 *
 * Design note: this is intentionally decoupled from `SpecRegistry` — inline
 * schemas don't have a `$id` and don't need cross-schema `$ref` resolution.
 */
export function compileInlineSchema(schema: unknown): Result<CompiledInlineSchema, SchemaError> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: false,
  });
  addFormats(ajv);

  let validator: ValidateFunction;
  try {
    validator = ajv.compile(schema as object);
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'schema-compile-error',
        message: `Inline schema failed to compile: ${(cause as Error)?.message ?? String(cause)}`,
        id: '<inline>',
        cause,
      },
    };
  }

  return {
    kind: 'ok',
    value: {
      source: schema,
      validate<T = unknown>(data: unknown): Result<T, ValidationErrorLike> {
        if (validator(data)) {
          return { kind: 'ok', value: data as T };
        }
        return {
          kind: 'err',
          error: {
            code: 'validation-error',
            message: 'Data does not validate against inline schema',
            errors: validator.errors ?? [],
          },
        };
      },
    },
  };
}

/**
 * Load a SpecRegistry from a directory of `*.schema.json` files.
 *
 * Reads every `*.schema.json` in the directory (non-recursive), parses each,
 * and delegates to `createSpecRegistry`. Files are loaded in sorted order for
 * deterministic behavior across environments.
 */
export async function loadSpecRegistry(dir: string): Promise<Result<SpecRegistry, SchemaError>> {
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch (cause) {
    return {
      kind: 'err',
      error: {
        code: 'schema-load-error',
        message: `Cannot read specs directory: ${dir}`,
        path: dir,
        cause,
      },
    };
  }

  const files = entries.filter((n) => n.endsWith('.schema.json')).sort();
  const schemas: unknown[] = [];

  for (const file of files) {
    const fullPath = join(dir, file);
    let raw: string;
    try {
      raw = await readFile(fullPath, 'utf-8');
    } catch (cause) {
      return {
        kind: 'err',
        error: {
          code: 'schema-load-error',
          message: `Cannot read schema file: ${fullPath}`,
          path: fullPath,
          cause,
        },
      };
    }
    try {
      schemas.push(JSON.parse(raw));
    } catch (cause) {
      return {
        kind: 'err',
        error: {
          code: 'schema-parse-error',
          message: `Invalid JSON in schema file: ${fullPath}`,
          path: fullPath,
          cause,
        },
      };
    }
  }

  return createSpecRegistry(schemas);
}
