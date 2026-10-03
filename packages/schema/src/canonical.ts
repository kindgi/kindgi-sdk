// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Canonical JSON serialization — deterministic, reproducible byte-shape
 * suitable for signing.
 *
 * A simplified RFC 8785 (JSON Canonicalization Scheme, JCS) implementation
 * covering the subset of JSON the framework emits: primitives, arrays, and
 * objects with sorted string keys.
 *
 * Rules:
 *   - Object keys are sorted lexicographically.
 *   - `undefined` values are omitted entirely (they're never signed).
 *   - `null` is preserved.
 *   - Numbers are serialized via `JSON.stringify` — sufficient for the
 *     integer + normal-float range the framework emits; if callers ever
 *     emit denormalized doubles or high-precision values, revisit.
 *   - Strings use JSON escaping (again via `JSON.stringify`).
 *   - No whitespace between tokens.
 *
 * This lives in the public `@kindgi/schema` package because:
 *   - Signature verifiers on the SDK side must reproduce the exact
 *     same bytes to check signatures — moving this to closed code
 *     would break client-side verify.
 *   - The algorithm is a public commitment: existing signatures become
 *     unverifiable if this changes.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => canonicalize(item));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}
