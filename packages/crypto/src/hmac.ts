// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * HMAC-SHA256 message authentication. Symmetric: sender and receiver share
 * a secret. Suited to signing webhook-style payloads — the receiver
 * verifies with the same secret. Follows the common webhook convention
 * of a hex-encoded signature over the raw payload bytes.
 *
 * Verify uses a constant-time comparison to prevent timing side channels
 * from leaking the correct signature byte-by-byte.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the HMAC-SHA256 of `message` under `secret`. Returns the
 * signature hex-encoded (lowercase) — the wire form of the common
 * "hex HMAC over the raw body" webhook convention.
 */
export function hmacSha256Sign(secret: string | Uint8Array, message: string | Uint8Array): string {
  const secretBuf = normalizeSecret(secret);
  const mac = createHmac('sha256', secretBuf);
  mac.update(message);
  return mac.digest('hex');
}

/**
 * Verify an HMAC-SHA256 signature in constant time. Returns `false` on
 * length mismatch or hex-decode failure (both are shape errors the caller
 * should treat as authentication failure — a well-formed signer would
 * never produce them, so distinguishing them from a genuine mismatch
 * offers no operational value and leaks structural information to an
 * attacker probing the endpoint).
 */
export function hmacSha256Verify(
  secret: string | Uint8Array,
  message: string | Uint8Array,
  signature: string,
): boolean {
  if (typeof signature !== 'string') return false;
  const expected = hmacSha256Sign(secret, message);
  // Length mismatch is a definitive no; short-circuit before allocating.
  if (expected.length !== signature.length) return false;
  // timingSafeEqual requires equal-length buffers. Both are 64-char hex
  // (32-byte SHA-256), pre-verified above.
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function normalizeSecret(secret: string | Uint8Array): Buffer {
  if (typeof secret === 'string') return Buffer.from(secret, 'utf-8');
  return Buffer.from(secret);
}
