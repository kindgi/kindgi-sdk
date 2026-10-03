// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Ed25519 digital signatures. Asymmetric: the signer holds a private key,
 * verifiers hold only the public key. Used by signed audit-bundle exports,
 * signed provenance exports, and any consumer that needs "prove this
 * artifact came from a party holding the private key" without trusting the
 * verifier.
 *
 * All APIs operate on raw 32-byte Uint8Arrays for keys. PEM / Base64
 * serialization is offered as helpers — the wire encoding is DER SPKI
 * (public) and DER PKCS8 (private).
 */

import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';

import type { Result } from '@kindgi/types';

import {
  ED25519_PKCS8_LENGTH,
  ED25519_RAW_KEY_BYTES,
  ED25519_SPKI_LENGTH,
  fromBase64,
  fromPem,
  toBase64,
  toPem,
  unwrapPrivateKeyPkcs8,
  unwrapPublicKeySpki,
  wrapPrivateKeyPkcs8,
  wrapPublicKeySpki,
} from './encoding.js';
import { malformedKey, malformedSignature } from './errors.js';
import type { CryptoError, MalformedKeyError } from './errors.js';

/** Byte length of an Ed25519 signature (always 64). */
export const ED25519_SIGNATURE_BYTES = 64;

/** Raw 32-byte key material — the wire form Ed25519 primitives operate on. */
export interface Ed25519KeyPair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

/**
 * Generate a fresh Ed25519 key pair. Intended for tests, local development,
 * and deployments that provision keys at boot. Production key material
 * typically lives in a KMS / HSM and is loaded through `SigningKeyBinding`.
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubUnwrap = unwrapPublicKeySpki(new Uint8Array(spki));
  const privUnwrap = unwrapPrivateKeyPkcs8(new Uint8Array(pkcs8));
  if (pubUnwrap.kind === 'err' || privUnwrap.kind === 'err') {
    throw new Error('generateEd25519KeyPair: unexpected Node key export shape');
  }
  return { publicKey: pubUnwrap.value, privateKey: privUnwrap.value };
}

/**
 * Sign a message with an Ed25519 private key. Returns the 64-byte signature.
 * Returns `Result` because the caller-supplied key may be malformed (wrong
 * length, wrong bytes); underlying primitive errors (system-level) throw.
 */
export function signEd25519(
  privateKey: Uint8Array,
  message: Uint8Array,
): Result<Uint8Array, MalformedKeyError> {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== ED25519_RAW_KEY_BYTES) {
    return malformedKey(
      `Ed25519 private key must be ${ED25519_RAW_KEY_BYTES} raw bytes, got ${privateKey.length}`,
    );
  }
  if (!(message instanceof Uint8Array)) {
    return malformedKey('Ed25519 message must be a Uint8Array');
  }
  let keyObject: KeyObject;
  try {
    keyObject = createPrivateKey({
      key: Buffer.from(wrapPrivateKeyPkcs8(privateKey)),
      format: 'der',
      type: 'pkcs8',
    });
  } catch (cause) {
    return malformedKey('Ed25519 private key rejected by underlying primitive', cause);
  }
  const signature = nodeSign(null, message, keyObject);
  return { kind: 'ok', value: new Uint8Array(signature) };
}

/**
 * Verify an Ed25519 signature. Returns `true` on cryptographic success,
 * `false` on cryptographic failure. Malformed key/signature bytes return
 * a typed error — the caller distinguishes "key/sig shape is wrong"
 * (an operational bug) from "signature does not match" (an authenticity
 * failure). Never returns `true` for a shape-error input.
 */
export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Result<boolean, CryptoError> {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== ED25519_RAW_KEY_BYTES) {
    return malformedKey(
      `Ed25519 public key must be ${ED25519_RAW_KEY_BYTES} raw bytes, got ${publicKey.length}`,
    );
  }
  if (!(message instanceof Uint8Array)) {
    return malformedKey('Ed25519 message must be a Uint8Array');
  }
  if (!(signature instanceof Uint8Array) || signature.length !== ED25519_SIGNATURE_BYTES) {
    return malformedSignature(
      `Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`,
    );
  }
  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey({
      key: Buffer.from(wrapPublicKeySpki(publicKey)),
      format: 'der',
      type: 'spki',
    });
  } catch (cause) {
    return malformedKey('Ed25519 public key rejected by underlying primitive', cause);
  }
  const ok = nodeVerify(null, message, keyObject, signature);
  return { kind: 'ok', value: ok };
}

// ============ serialization helpers ============

const PEM_PUBLIC_LABEL = 'PUBLIC KEY';
const PEM_PRIVATE_LABEL = 'PRIVATE KEY';

/**
 * Serialize a raw Ed25519 public key to PEM (standard "PUBLIC KEY" label
 * wrapping a DER SPKI envelope). Interoperable with OpenSSL and any
 * consumer that speaks RFC 5280 SPKI.
 */
export function serializePublicKeyPem(publicKey: Uint8Array): string {
  return toPem(wrapPublicKeySpki(publicKey), PEM_PUBLIC_LABEL);
}

/**
 * Parse a PEM "PUBLIC KEY" (DER SPKI Ed25519) into raw 32 bytes.
 */
export function parsePublicKeyPem(pem: string): Result<Uint8Array, CryptoError> {
  const der = fromPem(pem, PEM_PUBLIC_LABEL);
  if (der.kind === 'err') return der;
  if (der.value.length !== ED25519_SPKI_LENGTH) {
    return malformedKey(
      `PEM decoded to ${der.value.length} bytes; Ed25519 SPKI is ${ED25519_SPKI_LENGTH}`,
    );
  }
  return unwrapPublicKeySpki(der.value);
}

/**
 * Serialize a raw Ed25519 private key seed to PEM (standard "PRIVATE KEY"
 * label wrapping a DER PKCS8 envelope). WARNING: private key material —
 * never log this, never emit it in journals, never send it over the wire
 * to a verifier.
 */
export function serializePrivateKeyPem(privateKey: Uint8Array): string {
  return toPem(wrapPrivateKeyPkcs8(privateKey), PEM_PRIVATE_LABEL);
}

/** Parse a PEM "PRIVATE KEY" (DER PKCS8 Ed25519) into raw 32 bytes. */
export function parsePrivateKeyPem(pem: string): Result<Uint8Array, CryptoError> {
  const der = fromPem(pem, PEM_PRIVATE_LABEL);
  if (der.kind === 'err') return der;
  if (der.value.length !== ED25519_PKCS8_LENGTH) {
    return malformedKey(
      `PEM decoded to ${der.value.length} bytes; Ed25519 PKCS8 is ${ED25519_PKCS8_LENGTH}`,
    );
  }
  return unwrapPrivateKeyPkcs8(der.value);
}

/**
 * Serialize a raw Ed25519 public key to base64-encoded DER SPKI. This is
 * the compact JSON-wire form — smaller than PEM (no header lines) and
 * still interoperable with OpenSSL by wrapping in PEM downstream.
 */
export function serializePublicKeyBase64(publicKey: Uint8Array): string {
  return toBase64(wrapPublicKeySpki(publicKey));
}

/** Parse a base64-encoded DER SPKI Ed25519 public key into raw 32 bytes. */
export function parsePublicKeyBase64(b64: string): Result<Uint8Array, CryptoError> {
  const der = fromBase64(b64);
  if (der.kind === 'err') return der;
  if (der.value.length !== ED25519_SPKI_LENGTH) {
    return malformedKey(
      `Base64 decoded to ${der.value.length} bytes; Ed25519 SPKI is ${ED25519_SPKI_LENGTH}`,
    );
  }
  return unwrapPublicKeySpki(der.value);
}

/**
 * Serialize a raw Ed25519 private key seed to base64-encoded DER PKCS8.
 * WARNING: private key material. See `serializePrivateKeyPem` note.
 */
export function serializePrivateKeyBase64(privateKey: Uint8Array): string {
  return toBase64(wrapPrivateKeyPkcs8(privateKey));
}

/** Parse a base64-encoded DER PKCS8 Ed25519 private key into raw 32 bytes. */
export function parsePrivateKeyBase64(b64: string): Result<Uint8Array, CryptoError> {
  const der = fromBase64(b64);
  if (der.kind === 'err') return der;
  if (der.value.length !== ED25519_PKCS8_LENGTH) {
    return malformedKey(
      `Base64 decoded to ${der.value.length} bytes; Ed25519 PKCS8 is ${ED25519_PKCS8_LENGTH}`,
    );
  }
  return unwrapPrivateKeyPkcs8(der.value);
}
