// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Typed errors emitted by @kindgi/schema.
 *
 * Every error carries:
 *   - `code`  — machine-readable discriminator for `if (err.code === ...)` matching.
 *   - `message` — human-readable summary.
 *   - Case-specific fields (path, id, cause, errors[]).
 *
 * Consumers should switch on `code`, not on `message`. Message strings are
 * documentation-grade but not part of the API contract.
 */
export type SchemaError =
  | SchemaLoadError
  | SchemaParseError
  | SchemaCompileError
  | SchemaNotFoundError
  | ValidationError
  | InvalidZodConversionError;

/** Filesystem error while reading a schema file or specs directory. */
export interface SchemaLoadError {
  readonly code: 'schema-load-error';
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

/** JSON parse error while reading a schema file. */
export interface SchemaParseError {
  readonly code: 'schema-parse-error';
  readonly message: string;
  readonly path: string;
  readonly cause: unknown;
}

/**
 * Ajv rejected the schema during registration/compilation.
 * Also used when a schema is structurally invalid (missing `$id`, etc).
 */
export interface SchemaCompileError {
  readonly code: 'schema-compile-error';
  readonly message: string;
  readonly id: string;
  readonly cause: unknown;
}

/** Requested a schema by `$id` that isn't registered. */
export interface SchemaNotFoundError {
  readonly code: 'schema-not-found';
  readonly message: string;
  readonly id: string;
}

/**
 * Data did not validate against the schema. `errors` holds Ajv's error report,
 * intentionally typed as `unknown[]` — consumers must cast to `AjvError[]` if
 * they want to inspect fields, so this package doesn't leak the Ajv API shape.
 */
export interface ValidationError {
  readonly code: 'validation-error';
  readonly message: string;
  readonly id: string;
  readonly errors: readonly unknown[];
}

/**
 * A Zod schema was passed at an authoring boundary and either
 *   - the `zod` peer dependency is not installed, or
 *   - `z.toJSONSchema(schema)` threw (unrepresentable Zod construct —
 *     e.g. `.transform()` targeting a runtime side-effect, function
 *     schemas, uncontained cycles).
 *
 * `cause` is the underlying Error, preserved for surfacing to the author.
 */
export interface InvalidZodConversionError {
  readonly code: 'invalid-zod-conversion';
  readonly message: string;
  readonly cause: unknown;
}
