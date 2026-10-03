// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Result, SchemaMajor, Semver } from '@kindgi/types';

import type { SchemaError } from './errors.js';

/** Parsed version information from a schema's `$id` and `$comment`. */
export interface SchemaVersion {
  /** Major version, parsed from the `$id` URL path segment (e.g. `v1` → 1). */
  readonly major: SchemaMajor;
  /** Full semver, parsed from `$comment: "schema-version: X.Y.Z"`. */
  readonly semver: Semver;
}

const ID_PATTERN = /^https:\/\/kindgi\.com\/schemas\/v(\d+)\/([a-z][a-z0-9-]*)\.schema\.json$/;
const COMMENT_PATTERN = /^schema-version: (\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

function compileError(id: string, message: string, cause: unknown = null): SchemaError {
  return { code: 'schema-compile-error', message, id, cause };
}

/**
 * Extract the schema version from a schema document.
 *
 * Requires BOTH:
 *   - A `$id` matching `https://kindgi.com/schemas/v<N>/<name>.schema.json`.
 *   - A `$comment: "schema-version: X.Y.Z"` line (semver, with optional prerelease).
 *
 * The major version comes from `$id`; the full semver comes from `$comment`.
 * A mismatch between them (e.g. `$id` says `v2` but comment says `1.0.0`) is
 * NOT detected here — that's a separate lint responsibility.
 *
 * @example
 * // SPECS_SCHEMAS_DIR from '@kindgi/specs'
 * const schema = JSON.parse(await readFile(join(SPECS_SCHEMAS_DIR, 'flow.schema.json'), 'utf-8'));
 * const result = versionOf(schema);
 * if (result.kind === 'ok') {
 *   console.log(result.value.major, result.value.semver);
 * }
 */
export function versionOf(schema: unknown): Result<SchemaVersion, SchemaError> {
  if (typeof schema !== 'object' || schema === null) {
    return { kind: 'err', error: compileError('<unknown>', 'Schema is not an object', schema) };
  }
  const s = schema as { $id?: unknown; $comment?: unknown };

  if (typeof s.$id !== 'string' || s.$id.length === 0) {
    return { kind: 'err', error: compileError('<unknown>', 'Schema $id is missing or empty') };
  }
  const idMatch = ID_PATTERN.exec(s.$id);
  if (idMatch === null) {
    return {
      kind: 'err',
      error: compileError(
        s.$id,
        `Schema $id does not match https://kindgi.com/schemas/v<N>/<name>.schema.json: ${s.$id}`,
      ),
    };
  }
  const majorStr = idMatch[1];
  if (majorStr === undefined) {
    // Regex guarantees the capture, but TS narrowing requires the check.
    return { kind: 'err', error: compileError(s.$id, 'Unreachable: $id regex captured no major') };
  }
  const major = Number(majorStr) as SchemaMajor;

  if (typeof s.$comment !== 'string') {
    return {
      kind: 'err',
      error: compileError(s.$id, 'Schema $comment is missing (expected `schema-version: X.Y.Z`)'),
    };
  }
  const commentMatch = COMMENT_PATTERN.exec(s.$comment);
  if (commentMatch === null) {
    return {
      kind: 'err',
      error: compileError(
        s.$id,
        `Schema $comment does not match \`schema-version: X.Y.Z\`: ${s.$comment}`,
      ),
    };
  }
  const semverStr = commentMatch[1];
  if (semverStr === undefined) {
    return {
      kind: 'err',
      error: compileError(s.$id, 'Unreachable: $comment regex captured no semver'),
    };
  }

  return { kind: 'ok', value: { major, semver: semverStr as Semver } };
}
