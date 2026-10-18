// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The envelope a deployment's signature covers. A deploy verifies it over
 * the fields it's sent; a promotion verifies it again over the fields the
 * deployment keeps, so a build moves only while its signature still
 * holds.
 */

/** A `sha256` digest as the envelope holds it: lower case, with its `sha256:` prefix. */
export function normaliseSha256Hex(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.startsWith('sha256:') ? lower : `sha256:${lower}`;
}

export interface EnvelopeFields {
  readonly imageDigest: string;
  readonly artifactVersion: string;
  readonly indexHash: string;
  readonly tenantId: string;
  readonly publishedAt: string;
}

/**
 * Canonical form of the signed envelope: JSON object with sorted keys,
 * no whitespace, UTF-8. Deterministic by construction — the same field
 * values always produce byte-identical output.
 */
export function canonicalizeEnvelope(fields: EnvelopeFields): Uint8Array {
  const ordered: Record<string, string> = {
    artifactVersion: fields.artifactVersion,
    imageDigest: normaliseSha256Hex(fields.imageDigest),
    indexHash: normaliseSha256Hex(fields.indexHash),
    publishedAt: fields.publishedAt,
    tenantId: fields.tenantId,
  };
  const json = JSON.stringify(ordered);
  return new TextEncoder().encode(json);
}
