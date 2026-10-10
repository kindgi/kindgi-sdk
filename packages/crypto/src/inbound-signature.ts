// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Verifying a request a webhook trigger receives, in the scheme its sender
 * signs with (`WebhookSignatureScheme`, `@kindgi/types`):
 *
 * - `hmac-sha256`: HMAC-SHA256 of the raw body under the secret's UTF-8
 *   bytes, read from one header (`hex` or `base64`, after an optional
 *   prefix). WooCommerce, Shopify, GitHub and Drupal's Webhooks module sign
 *   this way.
 * - `standard-webhooks`: {@link verifyWebhook}.
 *
 * The comparison is constant-time. A missing header, a malformed one and a
 * wrong signature are told apart only in the result's `reason`, for the
 * receiver's own record: a receiver answers all of them the same way.
 */

import { type KeyObject, createHmac, createSecretKey, timingSafeEqual } from 'node:crypto';

import type { WebhookSignatureScheme } from '@kindgi/types';

import {
  type WebhookRequestHeaders,
  parseWebhookSecret,
  readHeader,
  verifyWebhookWith,
} from './webhook.js';

const SHA256_BYTES = 32;

export interface VerifyInboundSignatureInput {
  readonly scheme: WebhookSignatureScheme;
  /**
   * The shared secret (its UTF-8 bytes for `hmac-sha256`; `whsec_…` for
   * `standard-webhooks`), or the key {@link inboundSigningKey} derived
   * from it for the same scheme.
   */
  readonly secret: string | KeyObject;
  readonly headers: WebhookRequestHeaders;
  /** The raw request body, exactly as received — never a re-serialized JSON value. */
  readonly body: string | Uint8Array;
  /** Clock in milliseconds, for a scheme with a timestamp; default `Date.now`. */
  readonly now?: () => number;
}

/**
 * Why a request isn't verified:
 * - `signature-missing`: the scheme's header (or headers) isn't there;
 * - `signature-invalid`: present, but malformed or not matching;
 * - `stale`: the signed timestamp is outside the tolerance;
 * - `secret-invalid`: the secret can't be used with the scheme (empty, or
 *   not a `whsec_` key for `standard-webhooks`).
 */
export type VerifyInboundSignatureFailure =
  | 'signature-missing'
  | 'signature-invalid'
  | 'stale'
  | 'secret-invalid';

export type VerifyInboundSignatureResult =
  | {
      readonly kind: 'ok';
      /** The id the scheme itself signs (`webhook-id`), when it signs one. */
      readonly signedId?: string;
    }
  | { readonly kind: 'err'; readonly reason: VerifyInboundSignatureFailure };

/**
 * A trigger's signing key, derived from its secret for its scheme: the
 * secret's UTF-8 bytes for `hmac-sha256`, the key a `whsec_…` secret
 * encodes for `standard-webhooks`. A `KeyObject`, so a receiver that keeps
 * it for a while holds no string of the secret, and nothing logs or
 * serializes it by accident (`JSON.stringify` gives `{}`).
 */
export function inboundSigningKey(
  scheme: WebhookSignatureScheme,
  secret: string,
):
  | { readonly kind: 'ok'; readonly key: KeyObject }
  | { readonly kind: 'err'; readonly reason: 'secret-invalid' } {
  const bytes =
    scheme.kind === 'standard-webhooks'
      ? parseWebhookSecret(secret)
      : secret.length === 0
        ? null
        : Buffer.from(secret, 'utf-8');
  if (bytes === null) return { kind: 'err', reason: 'secret-invalid' };
  const key = createSecretKey(bytes);
  // The key keeps its own copy.
  bytes.fill(0);
  return { kind: 'ok', key };
}

/** Verify a received request against its trigger's signature scheme. */
export function verifyInboundSignature(
  input: VerifyInboundSignatureInput,
): VerifyInboundSignatureResult {
  const { scheme } = input;
  if (scheme.kind === 'standard-webhooks') {
    const verified = verifyWebhookWith(
      {
        headers: input.headers,
        body: input.body,
        ...(scheme.toleranceSeconds !== undefined && {
          toleranceSeconds: scheme.toleranceSeconds,
        }),
        ...(input.now !== undefined && { now: input.now }),
      },
      input.secret,
    );
    if (verified.kind === 'ok') return { kind: 'ok', signedId: verified.id };
    switch (verified.reason) {
      case 'missing-headers':
        return { kind: 'err', reason: 'signature-missing' };
      case 'timestamp-out-of-tolerance':
        return { kind: 'err', reason: 'stale' };
      case 'invalid-secret':
        return { kind: 'err', reason: 'secret-invalid' };
      default:
        return { kind: 'err', reason: 'signature-invalid' };
    }
  }

  const { secret } = input;
  if (typeof secret === 'string' && secret.length === 0) {
    return { kind: 'err', reason: 'secret-invalid' };
  }
  const raw = readHeader(input.headers, scheme.header.toLowerCase());
  if (raw === undefined) return { kind: 'err', reason: 'signature-missing' };
  const prefix = scheme.prefix ?? '';
  if (!raw.startsWith(prefix)) return { kind: 'err', reason: 'signature-invalid' };
  const provided = decodeDigest(raw.slice(prefix.length).trim(), scheme.encoding);
  if (provided === undefined) return { kind: 'err', reason: 'signature-invalid' };
  const expected = createHmac(
    'sha256',
    typeof secret === 'string' ? Buffer.from(secret, 'utf-8') : secret,
  )
    .update(typeof input.body === 'string' ? Buffer.from(input.body, 'utf-8') : input.body)
    .digest();
  return timingSafeEqual(provided, expected)
    ? { kind: 'ok' }
    : { kind: 'err', reason: 'signature-invalid' };
}

/** A 32-byte digest from its `hex` or `base64` form; `undefined` when it isn't one. */
function decodeDigest(text: string, encoding: 'hex' | 'base64'): Buffer | undefined {
  if (encoding === 'hex') {
    return /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : undefined;
  }
  // Base64 of 32 bytes is 44 characters with one `=` of padding.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return undefined;
  const bytes = Buffer.from(text, 'base64');
  return bytes.length === SHA256_BYTES ? bytes : undefined;
}
