// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The envelope a deployment's signature covers. A deploy verifies it over
 * the fields it's sent; a promotion verifies it again over the fields the
 * deployment keeps, so a build moves only while its signature still
 * holds.
 */

/**
 * How a build may reach a project in production. `'promote-only'`: only by
 * promotion from a project before it in its environment order, never by a
 * deploy. Absent: either way.
 */
export type ProductionEntry = 'promote-only';

/**
 * A signing key whose id starts with this signs only `'promote-only'`
 * builds, whatever its envelopes say: a deploy into a project in
 * production refuses them, as it refuses a key with the same public key.
 */
export const PROMOTE_ONLY_KEY_PREFIX = 'kindgi-promote-only:';

/**
 * What a build was made from, when its builder says, signed with the rest
 * of the envelope: the project and the person it names are the signer's
 * word, not the deploy's. `'kept-repo'`: a commit of a repository the
 * runtime keeps for a project without a GitHub repository, built for the
 * person who asked.
 */
export interface BuiltFrom {
  readonly kind: 'kept-repo';
  /** The project whose repository holds the commit: its id, lower case. */
  readonly projectId: string;
  /** The commit built, its full hex id, lower case. */
  readonly commit: string;
  /** Who asked for the build: `user:` and their id. */
  readonly requestedBy: string;
}

/** The kinds of `BuiltFrom` this runtime knows. */
export const BUILT_FROM_KINDS: readonly BuiltFrom['kind'][] = ['kept-repo'];

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
  /** Signed only when present, so an envelope without it signs as before. */
  readonly productionEntry?: ProductionEntry;
  /** Signed only when present, as `productionEntry` is. */
  readonly builtFrom?: BuiltFrom;
}

/**
 * Canonical form of the signed envelope: JSON object with sorted keys
 * (`builtFrom`'s too), no whitespace, UTF-8. Deterministic by construction — the same field
 * values always produce byte-identical output.
 */
export function canonicalizeEnvelope(fields: EnvelopeFields): Uint8Array {
  const ordered: Record<string, string | Record<string, string>> = {
    artifactVersion: fields.artifactVersion,
    ...(fields.builtFrom !== undefined && {
      // Its keys sorted too.
      builtFrom: {
        commit: fields.builtFrom.commit,
        kind: fields.builtFrom.kind,
        projectId: fields.builtFrom.projectId,
        requestedBy: fields.builtFrom.requestedBy,
      },
    }),
    imageDigest: normaliseSha256Hex(fields.imageDigest),
    indexHash: normaliseSha256Hex(fields.indexHash),
    ...(fields.productionEntry !== undefined && { productionEntry: fields.productionEntry }),
    publishedAt: fields.publishedAt,
    tenantId: fields.tenantId,
  };
  const json = JSON.stringify(ordered);
  return new TextEncoder().encode(json);
}
