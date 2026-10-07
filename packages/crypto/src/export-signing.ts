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
 * Two algorithms, chosen per key (`ExportSigningKey.algorithm`):
 * `ed25519`, the default for a key in memory or a file, and
 * `ecdsa-p256-sha256`, for a KMS that has no Ed25519. An ECDSA signature
 * travels as IEEE P1363 `r‖s` (64 bytes), the form Web Crypto verifies;
 * a KMS that answers DER converts with `ecdsaDerToP1363`.
 *
 * Not the same seam as `SigningKeyBinding` (raw key bytes, read
 * synchronously, for public run tokens on the request path).
 * `exportSignerFromSigningKeyBinding` adapts one to the other.
 */

import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
} from 'node:crypto';

import type { Result } from '@kindgi/types';

import type { SigningKeyBinding } from './binding.js';
import { parsePrivateKeyPem, serializePublicKeyPem, signEd25519 } from './ed25519.js';
import { ED25519_RAW_KEY_BYTES, unwrapPublicKeySpki, wrapPrivateKeyPkcs8 } from './encoding.js';
import type { CryptoError } from './errors.js';
import { malformedKey } from './errors.js';

/** The algorithms an export can be signed with. */
export const EXPORT_SIGNING_ALGORITHMS = ['ed25519', 'ecdsa-p256-sha256'] as const;
export type ExportSigningAlgorithm = (typeof EXPORT_SIGNING_ALGORITHMS)[number];

/** A key exports are signed with, as a verifier sees it. No private material. */
export interface ExportSigningKey {
  /**
   * `ex_` and 16 base64url characters of the SHA-256 of the raw public
   * key: Ed25519's 32 bytes, P-256's 65-byte uncompressed point.
   */
  readonly keyId: string;
  readonly algorithm: ExportSigningAlgorithm;
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

/**
 * The `ExportSigningKey` for a raw public key, under its derived id: a
 * 32-byte Ed25519 key (the default), or a 65-byte uncompressed P-256 point
 * for `ecdsa-p256-sha256`.
 */
export function exportSigningKey(
  publicKey: Uint8Array,
  algorithm: ExportSigningAlgorithm = 'ed25519',
): ExportSigningKey {
  const keyId = `ex_${sha256(publicKey).toString('base64url').slice(0, 16)}`;
  return algorithm === 'ed25519'
    ? describeKey(keyId, publicKey)
    : {
        keyId,
        algorithm,
        publicKeyPem: p256PublicKeyPem(publicKey),
        fingerprint: `sha256:${sha256(publicKey).toString('hex')}`,
      };
}

/**
 * An export signer over an EC P-256 private key held in memory (PKCS#8 or
 * SEC1 PEM): `ecdsa-p256-sha256`, its signatures as P1363 `r‖s`. `err`
 * when the key isn't a P-256 private key.
 */
export function createEcdsaP256ExportSigner(input: {
  readonly privateKeyPem: string;
}): Result<ExportSigningBinding, CryptoError> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: input.privateKeyPem, format: 'pem' });
  } catch (cause) {
    return malformedKey('the export signing key is not a readable PEM private key', cause);
  }
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (privateKey.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
    return malformedKey(
      `the export signing key is ${describeKeyType(privateKey)}, not an EC P-256 key`,
    );
  }
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]);
  const key = exportSigningKey(new Uint8Array(point), 'ecdsa-p256-sha256');
  return ok({
    activeKey: () => key,
    listKeys: () => [key],
    async sign(bytes, options) {
      if (options?.keyId !== undefined && options.keyId !== key.keyId) {
        return { kind: 'err', error: keyNotFound(options.keyId, [key]) };
      }
      try {
        const signature = nodeSign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
        return ok({ key, signature: new Uint8Array(signature) });
      } catch (cause) {
        return {
          kind: 'err',
          error: { code: 'export-signing-failed', message: 'ECDSA P-256 signing failed', cause },
        };
      }
    },
  });
}

/**
 * The export signer for a PEM private key, its algorithm read from the
 * key: Ed25519 → `ed25519`, EC P-256 → `ecdsa-p256-sha256`. Any other key
 * is `err`, naming what it is.
 */
export function createExportSignerFromPem(
  privateKeyPem: string,
): Result<ExportSigningBinding, CryptoError> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch (cause) {
    return malformedKey('the export signing key is not a readable PEM private key', cause);
  }
  if (privateKey.asymmetricKeyType === 'ed25519')
    return createEd25519ExportSigner({ privateKeyPem });
  if (privateKey.asymmetricKeyType === 'ec') return createEcdsaP256ExportSigner({ privateKeyPem });
  return malformedKey(
    `the export signing key is ${describeKeyType(privateKey)}: exports are signed with an Ed25519 or an EC P-256 key`,
  );
}

/**
 * An ECDSA signature from DER (`SEQUENCE { INTEGER r, INTEGER s }`, what
 * Cloud KMS and AWS KMS answer) to IEEE P1363 `r‖s`, each half `size`
 * bytes (32 for P-256): the form exports carry and Web Crypto verifies.
 */
export function ecdsaDerToP1363(der: Uint8Array, size = 32): Result<Uint8Array, CryptoError> {
  const bad = () => malformedKey('the ECDSA signature is not a DER SEQUENCE of two INTEGERs');
  let at = 0;
  const readLength = (): number | undefined => {
    const first = der[at++];
    if (first === undefined) return undefined;
    if (first < 0x80) return first;
    const bytes = first & 0x7f;
    if (bytes === 0 || bytes > 2) return undefined;
    let length = 0;
    for (let i = 0; i < bytes; i += 1) {
      const b = der[at++];
      if (b === undefined) return undefined;
      length = length * 256 + b;
    }
    return length;
  };
  const readInteger = (): Uint8Array | undefined => {
    if (der[at++] !== 0x02) return undefined;
    const length = readLength();
    if (length === undefined || at + length > der.length) return undefined;
    let value = der.subarray(at, at + length);
    at += length;
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) return undefined;
    const out = new Uint8Array(size);
    out.set(value, size - value.length);
    return out;
  };
  if (der[at++] !== 0x30 || readLength() === undefined) return bad();
  const r = readInteger();
  const s = readInteger();
  if (r === undefined || s === undefined || at !== der.length) return bad();
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return ok(out);
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

/** A 65-byte uncompressed P-256 point as a PEM SPKI public key. */
function p256PublicKeyPem(point: Uint8Array): string {
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
      y: Buffer.from(point.subarray(33, 65)).toString('base64url'),
    },
    format: 'jwk',
  });
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function describeKeyType(key: KeyObject): string {
  const type = key.asymmetricKeyType ?? 'an unknown kind of key';
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return curve !== undefined ? `an ${type} key on ${curve}` : `an ${type} key`;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function ok<T>(value: T): { readonly kind: 'ok'; readonly value: T } {
  return { kind: 'ok', value };
}
