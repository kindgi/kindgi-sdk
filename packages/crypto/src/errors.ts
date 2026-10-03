// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Typed errors returned from the crypto primitives. Cryptographic operations
 * fall into two buckets: (a) caller-recoverable errors — malformed key
 * material, wrong-shape input, bad PEM headers — and (b) system-level errors
 * from the underlying primitive that a caller cannot recover from. The
 * former return as `Result<T, CryptoError>`; the latter throw. This file
 * declares (a).
 */

export type CryptoError = MalformedKeyError | MalformedSignatureError | UnsupportedFormatError;

/**
 * Key material could not be parsed. Covers malformed PEM headers, wrong
 * base64, DER envelopes with unexpected OIDs, and byte-length mismatches
 * for the declared algorithm.
 */
export interface MalformedKeyError {
  readonly code: 'malformed-key';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Signature bytes are the wrong length or shape for the declared algorithm.
 * Returned by verify when the caller-supplied signature can be rejected
 * without invoking the underlying primitive.
 */
export interface MalformedSignatureError {
  readonly code: 'malformed-signature';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * A serialization format was requested that this package does not support
 * (e.g., a PEM label the parser does not recognize).
 */
export interface UnsupportedFormatError {
  readonly code: 'unsupported-format';
  readonly message: string;
  readonly cause?: unknown;
}

export function malformedKey(
  message: string,
  cause?: unknown,
): { readonly kind: 'err'; readonly error: MalformedKeyError } {
  return {
    kind: 'err',
    error:
      cause === undefined
        ? { code: 'malformed-key', message }
        : { code: 'malformed-key', message, cause },
  };
}

export function malformedSignature(
  message: string,
  cause?: unknown,
): { readonly kind: 'err'; readonly error: MalformedSignatureError } {
  return {
    kind: 'err',
    error:
      cause === undefined
        ? { code: 'malformed-signature', message }
        : { code: 'malformed-signature', message, cause },
  };
}

export function unsupportedFormat(
  message: string,
  cause?: unknown,
): { readonly kind: 'err'; readonly error: UnsupportedFormatError } {
  return {
    kind: 'err',
    error:
      cause === undefined
        ? { code: 'unsupported-format', message }
        : { code: 'unsupported-format', message, cause },
  };
}
