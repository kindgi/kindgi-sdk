// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * DER envelope + PEM wrapping helpers for Ed25519 keys.
 *
 * Ed25519 keys have a fixed 32-byte raw form. Interop with Node's
 * `crypto.createPublicKey` / `createPrivateKey` requires wrapping the raw
 * bytes in a standard envelope (SPKI for public, PKCS8 for private) —
 * fixed-prefix DER structures whose only variable part is the 32-byte key
 * material itself. Doing this by hand keeps the package free of ASN.1
 * dependencies and portable across Node / Bun / Deno.
 *
 * The prefixes below encode the AlgorithmIdentifier for Ed25519
 * (OID 1.3.101.112, no parameters) plus the outer SEQUENCE / OCTET STRING
 * wrappers that SPKI (RFC 5280) and PKCS8 (RFC 5958) require. They are
 * constant for Ed25519.
 */

import type { Result } from '@kindgi/types';

import { malformedKey, unsupportedFormat } from './errors.js';
import type { MalformedKeyError, UnsupportedFormatError } from './errors.js';

export const ED25519_RAW_KEY_BYTES = 32;

// SPKI (SubjectPublicKeyInfo) prefix for Ed25519 (12 bytes). Full envelope
// is 44 bytes: prefix (12) + raw public key (32).
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
export const ED25519_SPKI_LENGTH = ED25519_SPKI_PREFIX.length + ED25519_RAW_KEY_BYTES; // 44

// PKCS8 (PrivateKeyInfo) prefix for Ed25519 (16 bytes). Full envelope is
// 48 bytes: prefix (16) + raw private key seed (32).
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
export const ED25519_PKCS8_LENGTH = ED25519_PKCS8_PREFIX.length + ED25519_RAW_KEY_BYTES; // 48

/** Wrap a raw 32-byte Ed25519 public key in a DER SPKI envelope. */
export function wrapPublicKeySpki(rawPublicKey: Uint8Array): Uint8Array {
  if (rawPublicKey.length !== ED25519_RAW_KEY_BYTES) {
    throw new Error(
      `Ed25519 raw public key must be ${ED25519_RAW_KEY_BYTES} bytes, got ${rawPublicKey.length}`,
    );
  }
  const out = new Uint8Array(ED25519_SPKI_LENGTH);
  out.set(ED25519_SPKI_PREFIX, 0);
  out.set(rawPublicKey, ED25519_SPKI_PREFIX.length);
  return out;
}

/** Wrap a raw 32-byte Ed25519 private key seed in a DER PKCS8 envelope. */
export function wrapPrivateKeyPkcs8(rawPrivateKey: Uint8Array): Uint8Array {
  if (rawPrivateKey.length !== ED25519_RAW_KEY_BYTES) {
    throw new Error(
      `Ed25519 raw private key must be ${ED25519_RAW_KEY_BYTES} bytes, got ${rawPrivateKey.length}`,
    );
  }
  const out = new Uint8Array(ED25519_PKCS8_LENGTH);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(rawPrivateKey, ED25519_PKCS8_PREFIX.length);
  return out;
}

/** Strip the DER SPKI envelope off an Ed25519 public key, returning the 32 raw bytes. */
export function unwrapPublicKeySpki(spki: Uint8Array): Result<Uint8Array, MalformedKeyError> {
  if (spki.length !== ED25519_SPKI_LENGTH) {
    return malformedKey(
      `Ed25519 SPKI envelope must be ${ED25519_SPKI_LENGTH} bytes, got ${spki.length}`,
    );
  }
  for (let i = 0; i < ED25519_SPKI_PREFIX.length; i++) {
    if (spki[i] !== ED25519_SPKI_PREFIX[i]) {
      return malformedKey('Ed25519 SPKI prefix mismatch — not an Ed25519 public key envelope');
    }
  }
  return { kind: 'ok', value: spki.slice(ED25519_SPKI_PREFIX.length) };
}

/** Strip the DER PKCS8 envelope off an Ed25519 private key, returning the 32 raw seed bytes. */
export function unwrapPrivateKeyPkcs8(pkcs8: Uint8Array): Result<Uint8Array, MalformedKeyError> {
  if (pkcs8.length !== ED25519_PKCS8_LENGTH) {
    return malformedKey(
      `Ed25519 PKCS8 envelope must be ${ED25519_PKCS8_LENGTH} bytes, got ${pkcs8.length}`,
    );
  }
  for (let i = 0; i < ED25519_PKCS8_PREFIX.length; i++) {
    if (pkcs8[i] !== ED25519_PKCS8_PREFIX[i]) {
      return malformedKey('Ed25519 PKCS8 prefix mismatch — not an Ed25519 private key envelope');
    }
  }
  return { kind: 'ok', value: pkcs8.slice(ED25519_PKCS8_PREFIX.length) };
}

// ============ base64 ============

/** Encode bytes as standard base64. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decode a base64 string into bytes. Returns a typed error on invalid input. */
export function fromBase64(b64: string): Result<Uint8Array, MalformedKeyError> {
  if (typeof b64 !== 'string' || b64.length === 0) {
    return malformedKey('base64 input must be a non-empty string');
  }
  // Buffer.from is lenient about non-base64 characters; validate strictly.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    return malformedKey('base64 input contains characters outside the standard alphabet');
  }
  try {
    const buf = Buffer.from(b64, 'base64');
    // Round-trip to detect padding / silent truncation.
    if (buf.toString('base64').replace(/=+$/u, '') !== b64.replace(/=+$/u, '')) {
      return malformedKey('base64 input did not round-trip cleanly');
    }
    return { kind: 'ok', value: new Uint8Array(buf) };
  } catch (cause) {
    return malformedKey('base64 decode failed', cause);
  }
}

// ============ PEM ============

/** Wrap DER bytes in a PEM envelope with the given label. */
export function toPem(derBytes: Uint8Array, label: string): string {
  const b64 = toBase64(derBytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Parse a PEM envelope for the given label. Rejects unexpected labels,
 * missing header/footer, or base64 payload that does not decode cleanly.
 */
export function fromPem(
  pem: string,
  expectedLabel: string,
): Result<Uint8Array, MalformedKeyError | UnsupportedFormatError> {
  if (typeof pem !== 'string' || pem.length === 0) {
    return malformedKey('PEM input must be a non-empty string');
  }
  const trimmed = pem.trim();
  const header = `-----BEGIN ${expectedLabel}-----`;
  const footer = `-----END ${expectedLabel}-----`;
  const startIdx = trimmed.indexOf(header);
  const endIdx = trimmed.indexOf(footer);
  if (startIdx === -1 || endIdx === -1) {
    // Detect a *different* PEM label (e.g., someone passed an RSA key here).
    const otherLabelMatch = /-----BEGIN ([^-]+)-----/.exec(trimmed);
    if (otherLabelMatch && otherLabelMatch[1] !== expectedLabel) {
      return unsupportedFormat(
        `PEM label mismatch — expected "${expectedLabel}", got "${otherLabelMatch[1]}"`,
      );
    }
    return malformedKey(`PEM envelope missing "${expectedLabel}" header/footer`);
  }
  if (endIdx < startIdx) {
    return malformedKey('PEM footer appears before header');
  }
  const body = trimmed.slice(startIdx + header.length, endIdx).replace(/\s+/g, '');
  return fromBase64(body);
}
