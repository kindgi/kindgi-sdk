// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `SigningKeyBinding` — the seam between the crypto primitives and a
 * deployment's key store. The framework does not persist key material;
 * it never has direct access to a KMS. Instead, callers implement this
 * binding against whatever store they run (an env-var-backed key for
 * local dev, a cloud KMS or secrets vault in production, a hardware
 * token).
 *
 * Consumers that need to sign or verify look up a key by `SigningKeyId`
 * through the binding. The binding returns `null` when a key is not
 * present — callers translate that to the appropriate domain error
 * (e.g., "signing key for tenant T is not provisioned").
 *
 * Not defined here: rotation, revocation, tenant-scoped key selection.
 * Those are lifecycle concerns handled outside this package.
 */

import type { SigningKeyId } from '@kindgi/types';

/** Which signature algorithm the key is for. */
export type SigningAlgorithm = 'ed25519' | 'hmac-sha256';

/** Metadata about a key registered with a binding. */
export interface SigningKeyDescriptor {
  readonly keyId: SigningKeyId;
  readonly algorithm: SigningAlgorithm;
  /** ISO-8601 timestamp when the key was first registered with this binding. */
  readonly createdAt: string;
}

/**
 * A caller-provided key store. Deployments plug in KMS, env-var-backed,
 * or in-memory-for-tests implementations. Framework code never persists
 * or generates key material through this interface — it only reads.
 *
 * Contracts:
 *   - `getPublicKey` returns raw bytes. For Ed25519, 32 bytes; for
 *     HMAC-SHA256, the shared secret (the binding does not distinguish
 *     the "public" side for symmetric algorithms; verifiers hold the
 *     same secret as signers).
 *   - `getPrivateKey` returns raw bytes. For Ed25519, 32-byte seed;
 *     for HMAC-SHA256, the shared secret.
 *   - `null` return means "no key by that id" — never throw.
 *   - `listKeys` MUST NOT expose key material, only descriptors.
 */
export interface SigningKeyBinding {
  getPublicKey(keyId: SigningKeyId): Uint8Array | null;
  getPrivateKey(keyId: SigningKeyId): Uint8Array | null;
  listKeys(): readonly SigningKeyDescriptor[];
}

/**
 * In-memory implementation. Intended for tests and local development —
 * production deployments implement `SigningKeyBinding` against their own
 * KMS. Keys are held by strong reference; the binding does not touch
 * disk or the network.
 */
export function createInMemorySigningKeyBinding(
  entries: readonly {
    readonly keyId: SigningKeyId;
    readonly algorithm: SigningAlgorithm;
    readonly publicKey: Uint8Array;
    readonly privateKey: Uint8Array;
    readonly createdAt?: string;
  }[],
): SigningKeyBinding {
  const map = new Map<
    SigningKeyId,
    {
      readonly publicKey: Uint8Array;
      readonly privateKey: Uint8Array;
      readonly descriptor: SigningKeyDescriptor;
    }
  >();
  for (const entry of entries) {
    if (map.has(entry.keyId)) {
      throw new Error(`Duplicate SigningKeyId in binding: "${entry.keyId}"`);
    }
    map.set(entry.keyId, {
      publicKey: entry.publicKey,
      privateKey: entry.privateKey,
      descriptor: {
        keyId: entry.keyId,
        algorithm: entry.algorithm,
        createdAt: entry.createdAt ?? new Date().toISOString(),
      },
    });
  }
  return {
    getPublicKey(keyId) {
      return map.get(keyId)?.publicKey ?? null;
    },
    getPrivateKey(keyId) {
      return map.get(keyId)?.privateKey ?? null;
    },
    listKeys() {
      return Array.from(map.values(), (v) => v.descriptor);
    },
  };
}
