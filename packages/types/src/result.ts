// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A discriminated-union result type. Preferred over throwing for boundary
 * operations where the caller must handle both success and failure explicitly.
 *
 * Every member carries a runtime `kind` tag so consumers can narrow via
 * `if (r.kind === 'ok') { ... }`. This is the codebase's standard shape;
 * do not invent parallel Ok/Err representations.
 *
 * @example
 * function loadSchema(path: string): Result<Schema, SchemaLoadError> {
 *   try {
 *     return { kind: 'ok', value: parse(readFileSync(path)) };
 *   } catch (cause) {
 *     return { kind: 'err', error: { code: 'load-failed', path, cause } };
 *   }
 * }
 *
 * const r = loadSchema('./flow.schema.json');
 * if (r.kind === 'ok') { use(r.value); } else { handle(r.error); }
 */
export type Result<T, E> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'err'; readonly error: E };

/**
 * Extract the success type from a Result.
 *
 * @example
 * type Value = OkOf<Result<number, string>>; // number
 */
export type OkOf<R> = R extends { readonly kind: 'ok'; readonly value: infer T } ? T : never;

/**
 * Extract the error type from a Result.
 *
 * @example
 * type Failure = ErrOf<Result<number, string>>; // string
 */
export type ErrOf<R> = R extends { readonly kind: 'err'; readonly error: infer E } ? E : never;
