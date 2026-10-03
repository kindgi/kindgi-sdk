// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { canonicalize } from '@kindgi/schema';

import type { Provenance } from './types.js';

/**
 * Export a provenance record as a canonical JSON string. Round-trippable
 * via `JSON.parse` — the parsed object hashes to the same signing bytes,
 * so `verifyExported` still verifies against the provided public key.
 *
 * Use this to hand a customer a self-verifying artifact. They store the
 * JSON alongside the deployment's (or tenant's) public key; anyone with
 * both can prove the DAG was signed by that key and hasn't been altered.
 */
export function exportProvenance(provenance: Provenance): string {
  // The full document — signature included — is serialised canonically.
  // The signing surface is the signature-less projection (see
  // `canonical.ts.signingBytes`), so this canonical form and the signing
  // form are distinct: importers use `verifyExported` which re-projects
  // internally.
  return canonicalize(provenance);
}

/**
 * Parse an exported provenance string back into a `Provenance` object.
 * Thin wrapper over `JSON.parse` — kept as an explicit function so callers
 * that want to add validation later have a stable insertion point.
 */
export function importProvenance(json: string): Provenance {
  return JSON.parse(json) as Provenance;
}
