// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `ExportSigningBinding` — the key a deployment signs its exports with:
 * audit bundles, provenance exports and compliance evidence. Async, so
 * a KMS that never hands out its private key (Cloud KMS
 * `asymmetricSign`) can implement it as well as a key file can.
 *
 * One key signs at a time (`activeKey`); `listKeys` is every key a
 * verifier should trust, active first. A key's id is derived from its
 * public key (`exportSigningKey`), so the same key has the same id
 * across restarts and deployments, with nothing to configure.
 *
 * Not the same seam as `SigningKeyBinding` (raw key bytes, read
 * synchronously, for public run tokens on the request path).
 * `exportSignerFromSigningKeyBinding` adapts one to the other.
 */

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

import type { Result } from '@kindgi/types';

import type { SigningKeyBinding } from './binding.js';
import { parsePrivateKeyPem, serializePublicKeyPem, signEd25519 } from './ed25519.js';
import { ED25519_RAW_KEY_BYTES, unwrapPublicKeySpki, wrapPrivateKeyPkcs8 } from './encoding.js';
import type { CryptoError } from './errors.js';
import { malformedKey } from './errors.js';

/** A key exports are signed with, as a verifier sees it. No private material. */
export interface ExportSigningKey {
  /** `ex_` and 16 base64url characters of the SHA-256 of the raw public key. */
  readonly keyId: string;
  readonly algorithm: 'ed25519';
  /** The public key, PEM SPKI. */
  readonly publicKeyPem: string;
  /** `sha256:` and the hex SHA-256 of the raw public key: to pin it, or compare by eye. */
  readonly fingerprint: string;
}

export type ExportSigningError =
  | {
      /** `keyId` was asked for and isn't a key this binding signs with. */
      readonly code: 'signing-key-not-found';
      readonly message: string;
      readonly keyId: string;
    }
  | {
      /** The signer failed: a KMS that refused or didn't answer, a malformed key. */
      readonly code: 'export-signing-failed';
      readonly message: string;
      readonly cause?: unknown;
    };

export interface ExportSignature {
  readonly key: ExportSigningKey;
  readonly signature: Uint8Array;
}

export interface ExportSigningBinding {
  /** The key `sign` uses when no `keyId` is asked for. */
  activeKey(): ExportSigningKey;
  /** Every key a verifier should trust, the active one first. */
  listKeys(): readonly ExportSigningKey[];
  /**
   * Sign `bytes` with the active key, or with `keyId` when given. A
   * `keyId` this binding can't sign with is `signing-key-not-found`.
   */
  sign(
    bytes: Uint8Array,
    options?: { readonly keyId?: string },
  ): Promise<Result<ExportSignature, ExportSigningError>>;
}

/** The `ExportSigningKey` for a raw 32-byte Ed25519 public key, under its derived id. */
export function exportSigningKey(publicKey: Uint8Array): ExportSigningKey {
  return describeKey(`ex_${sha256(publicKey).toString('base64url').slice(0, 16)}`, publicKey);
}

/**
 * An export signer over an Ed25519 private key held in memory: a PEM
 * file's contents, a base64 env value decoded, a test's or a
 * development server's generated key. `err` when the key isn't an
 * Ed25519 PKCS#8 key.
 */
export function createEd25519ExportSigner(
  input: { readonly privateKeyPem: string } | { readonly privateKey: Uint8Array },
): Result<ExportSigningBinding, CryptoError> {
  const seed =
    'privateKeyPem' in input ? parsePrivateKeyPem(input.privateKeyPem) : ok(input.privateKey);
  if (seed.kind === 'err') return seed;
  const publicKey = publicKeyFromSeed(seed.value);
  if (publicKey.kind === 'err') return publicKey;
  const key = exportSigningKey(publicKey.value);
  const privateKey = seed.value;
  return ok({
    activeKey: () => key,
    listKeys: () => [key],
    async sign(bytes, options) {
      if (options?.keyId !== undefined && options.keyId !== key.keyId) {
        return { kind: 'err', error: keyNotFound(options.keyId, [key]) };
      }
      return signedWith(key, privateKey, bytes);
    },
  });
}

/**
 * The `ExportSigningBinding` over a `SigningKeyBinding`'s Ed25519 keys,
 * under the ids that binding gives them; the first is the active one.
 * `undefined` when it holds no Ed25519 key (nothing to sign with).
 */
export function exportSignerFromSigningKeyBinding(
  binding: SigningKeyBinding,
): ExportSigningBinding | undefined {
  const keys = binding
    .listKeys()
    .filter((d) => d.algorithm === 'ed25519')
    .flatMap((d) => {
      const pub = binding.getPublicKey(d.keyId);
      return pub === null ? [] : [describeKey(d.keyId as unknown as string, pub)];
    });
  const [active] = keys;
  if (active === undefined) return undefined;
  return {
    activeKey: () => active,
    listKeys: () => keys,
    async sign(bytes, options) {
      const key =
        options?.keyId === undefined ? active : keys.find((k) => k.keyId === options.keyId);
      const privateKey = key === undefined ? null : binding.getPrivateKey(key.keyId as never);
      if (key === undefined || privateKey === null) {
        return { kind: 'err', error: keyNotFound(options?.keyId ?? active.keyId, keys) };
      }
      return signedWith(key, privateKey, bytes);
    },
  };
}

function signedWith(
  key: ExportSigningKey,
  privateKey: Uint8Array,
  bytes: Uint8Array,
): Result<ExportSignature, ExportSigningError> {
  const signed = signEd25519(privateKey, bytes);
  if (signed.kind === 'err') {
    return {
      kind: 'err',
      error: { code: 'export-signing-failed', message: signed.error.message, cause: signed.error },
    };
  }
  return ok({ key, signature: signed.value });
}

function keyNotFound(keyId: string, keys: readonly ExportSigningKey[]): ExportSigningError {
  return {
    code: 'signing-key-not-found',
    message: `This deployment doesn't sign exports with key "${keyId}". It signs with ${keys.map((k) => `"${k.keyId}"`).join(', ')}; leave signingKeyId out to use the active one.`,
    keyId,
  };
}

function describeKey(keyId: string, publicKey: Uint8Array): ExportSigningKey {
  return {
    keyId,
    algorithm: 'ed25519',
    publicKeyPem: serializePublicKeyPem(publicKey),
    fingerprint: `sha256:${sha256(publicKey).toString('hex')}`,
  };
}

function publicKeyFromSeed(seed: Uint8Array): Result<Uint8Array, CryptoError> {
  if (seed.length !== ED25519_RAW_KEY_BYTES) {
    return malformedKey(
      `Ed25519 private key must be ${ED25519_RAW_KEY_BYTES} raw bytes, got ${seed.length}`,
    );
  }
  try {
    const priv = createPrivateKey({
      key: Buffer.from(wrapPrivateKeyPkcs8(seed)),
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
    return unwrapPublicKeySpki(new Uint8Array(spki));
  } catch (cause) {
    return malformedKey('Ed25519 private key rejected by underlying primitive', cause);
  }
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function ok<T>(value: T): { readonly kind: 'ok'; readonly value: T } {
  return { kind: 'ok', value };
}
