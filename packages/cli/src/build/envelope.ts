// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Deploy envelope shape emitted by `kindgi build` — the file
 * `kindgi deploy` reads and POSTs to `POST /v1/deployments`.
 *
 * Includes a canonicalizer that stably-serialises the signature body
 * (sort-keyed JSON, no whitespace) so the same inputs produce the same
 * bytes on every machine. The server applies the same canonicalization
 * when it verifies the signature.
 */

export const DEPLOY_ENVELOPE_SCHEMA = 'kindgi-deploy-envelope/v1' as const;

export interface SignatureBody {
  readonly imageDigest: string;
  readonly artifactVersion: string;
  readonly indexHash: string;
  readonly tenantId: string;
  readonly publishedAt: string;
}

export interface DeployEnvelope {
  readonly $schema: typeof DEPLOY_ENVELOPE_SCHEMA;
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly artifactVersion: string;
  readonly index: Readonly<Record<string, unknown>>;
  readonly indexHash: string;
  readonly tenantId: string;
  readonly publishedAt: string;
  /** Optional — omitted when `--skip-sign` is set. */
  readonly signerKeyId?: string;
  /** Optional — omitted when `--skip-sign` is set. */
  readonly signerPublicKey?: string;
  /** Optional — omitted when `--skip-sign` is set. */
  readonly signature?: string;
  readonly buildLogsUrl?: string;
}

/**
 * Canonicalise the signature body. Same shape the server's deployment
 * route verifies against. Sorted-key JSON with no whitespace —
 * byte-identical output for identical inputs across every JS runtime.
 *
 * Framework-grade note: we intentionally do NOT reach into
 * `packages/compliance-pipeline/src/canonical.ts` or
 * `packages/handler-runtime/src/kindgi-index.ts`'s stableStringify.
 * The CLI package's canonicalization is a leaf primitive — no
 * cross-package coupling. All three implementations produce the same
 * bytes (verified via the round-trip tests in each package).
 */
export function canonicaliseSignatureBody(body: SignatureBody): Uint8Array {
  const canonical = {
    artifactVersion: body.artifactVersion,
    imageDigest: body.imageDigest,
    indexHash: body.indexHash,
    publishedAt: body.publishedAt,
    tenantId: body.tenantId,
  };
  return new TextEncoder().encode(stableStringify(canonical));
}

/**
 * Sort-keyed JSON.stringify. Objects recurse; arrays keep order (arrays
 * are ordered data — sorting them would corrupt).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export interface BuildEnvelopeInputs {
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly artifactVersion: string;
  readonly index: Readonly<Record<string, unknown>>;
  readonly indexHash: string;
  readonly tenantId: string;
  readonly publishedAt: string;
  readonly buildLogsUrl?: string;
  readonly signature?: { readonly signatureBase64: string; readonly publicKeyPem: string; readonly keyId: string };
}

/** Assemble the deploy envelope JSON. Signed / unsigned depends on inputs. */
export function buildEnvelope(inputs: BuildEnvelopeInputs): DeployEnvelope {
  return {
    $schema: DEPLOY_ENVELOPE_SCHEMA,
    imageRef: inputs.imageRef,
    imageDigest: inputs.imageDigest,
    artifactVersion: inputs.artifactVersion,
    index: inputs.index,
    indexHash: inputs.indexHash,
    tenantId: inputs.tenantId,
    publishedAt: inputs.publishedAt,
    ...(inputs.signature !== undefined && {
      signerKeyId: inputs.signature.keyId,
      signerPublicKey: inputs.signature.publicKeyPem,
      signature: inputs.signature.signatureBase64,
    }),
    ...(inputs.buildLogsUrl !== undefined && { buildLogsUrl: inputs.buildLogsUrl }),
  };
}

/** Utility used by tests + defaults: sha256 hex prefixed `sha256:`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  h.update(bytes);
  return `sha256:${h.digest('hex')}`;
}
