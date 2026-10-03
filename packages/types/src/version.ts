// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Brand } from './ids.js';

/**
 * A semver version string (major.minor.patch, with optional pre-release).
 *
 * Regex convention: `^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`.
 *
 * Used for:
 *   - Artifact versions (flow.version, policy.version, provenance.version).
 *   - Pack manifest versions.
 *   - Schema versions in `$comment: "schema-version: X.Y.Z"`.
 *
 * The brand prevents mixing free-form strings with validated semver values.
 */
export type Semver = Brand<string, 'Semver'>;

/**
 * Major version number extracted from a semver, used for schema $id path segments.
 *
 * Convention: `1`, `2`, `3` (positive integer). No `v` prefix — the `v` is added
 * by the URL scheme (`/v1/flow.schema.json`), not part of the value.
 */
export type SchemaMajor = Brand<number, 'SchemaMajor'>;

/**
 * Version-pinned artifact reference. Combines an artifact id with an exact
 * semver, so replays and audit trails always know which version was in force.
 *
 * @example
 * const flowRef: VersionedRef<FlowId> = {
 *   id: 'acme.contract-review' as FlowId,
 *   version: '1.2.3' as Semver,
 * };
 */
export interface VersionedRef<Id extends string> {
  readonly id: Id;
  readonly version: Semver;
}
