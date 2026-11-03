// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Reading an error's fields without throwing, for the logger's records
 * and for `describeCauses`: both run where an error is being handled, so
 * a getter that throws or a revoked proxy can't be let out.
 */

/** `err[key]`, or undefined when reading it throws (a getter, a revoked proxy). */
export function fieldOf(err: object, key: string): unknown {
  try {
    return (err as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

/** A string or numeric `code`, as a string. */
export function codeOf(err: object): { readonly code?: string } {
  const code = fieldOf(err, 'code');
  return typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {};
}

/** `err instanceof Error`, and false where asking throws (a revoked proxy). */
export function isError(err: unknown): err is Error {
  try {
    return err instanceof Error;
  } catch {
    return false;
  }
}

/**
 * `String(value)`, for a value that isn't an error. One that can't be made
 * a string (no prototype, a throwing `toString`) is its
 * `Object.prototype.toString` tag, and a revoked proxy `[unreadable]`:
 * logging it never throws.
 */
export function textOf(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '[unreadable]';
    }
  }
}
