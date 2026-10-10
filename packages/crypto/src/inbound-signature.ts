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

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { WebhookSignatureScheme } from '@kindgi/types';

import { type WebhookRequestHeaders, readHeader, verifyWebhook } from './webhook.js';

const SHA256_BYTES = 32;

export interface VerifyInboundSignatureInput {
  readonly scheme: WebhookSignatureScheme;
  /** The shared secret: its UTF-8 bytes for `hmac-sha256`; `whsec_…` for `standard-webhooks`. */
  readonly secret: string;
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

/** Verify a received request against its trigger's signature scheme. */
export function verifyInboundSignature(
  input: VerifyInboundSignatureInput,
): VerifyInboundSignatureResult {
  const { scheme } = input;
  if (scheme.kind === 'standard-webhooks') {
    const verified = verifyWebhook({
      secret: input.secret,
      headers: input.headers,
      body: input.body,
      ...(scheme.toleranceSeconds !== undefined && { toleranceSeconds: scheme.toleranceSeconds }),
      ...(input.now !== undefined && { now: input.now }),
    });
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

  if (input.secret.length === 0) return { kind: 'err', reason: 'secret-invalid' };
  const raw = readHeader(input.headers, scheme.header.toLowerCase());
  if (raw === undefined) return { kind: 'err', reason: 'signature-missing' };
  const prefix = scheme.prefix ?? '';
  if (!raw.startsWith(prefix)) return { kind: 'err', reason: 'signature-invalid' };
  const provided = decodeDigest(raw.slice(prefix.length).trim(), scheme.encoding);
  if (provided === undefined) return { kind: 'err', reason: 'signature-invalid' };
  const expected = createHmac('sha256', Buffer.from(input.secret, 'utf-8'))
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
