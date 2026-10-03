// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { canonicalize } from '@kindgi/schema';

import type { Provenance } from './types.js';

// `canonicalize` lives in @kindgi/schema, so external verifiers reproduce
// the exact same bytes from there. This file defines only `signingBytes` —
// the provenance-specific projection.

/**
 * The exact projection that gets signed. Excludes `signature` (obviously —
 * you can't sign a value that contains its own signature) and includes only
 * the fields that the schema commits to.
 *
 * Bumping the projection is a breaking signature change — existing signatures
 * become unverifiable. Never reorder or extend without a schema version bump.
 */
export function signingBytes(provenance: Provenance): Uint8Array {
  const projection = {
    id: provenance.id,
    runId: provenance.runId,
    tenantId: provenance.tenantId,
    version: provenance.version,
    createdAt: provenance.createdAt,
    flowRef: provenance.flowRef,
    nodes: provenance.nodes,
    edges: provenance.edges,
  };
  return new TextEncoder().encode(canonicalize(projection));
}
