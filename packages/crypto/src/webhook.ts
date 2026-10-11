// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Webhook signatures in the Standard Webhooks format
 * (https://www.standardwebhooks.com), symmetric variant `v1`:
 *
 *   webhook-id:        the message id (the same on every retry)
 *   webhook-timestamp: Unix seconds when the message was signed
 *   webhook-signature: `v1,<base64 HMAC-SHA256>`, space-separated when
 *                      several secrets sign (secret rotation)
 *
 * The signed content is `${id}.${timestamp}.${body}`, with `body` the raw
 * request body exactly as sent. Secrets are `whsec_` + base64 of the key
 * bytes. A receiver can verify with this module or with any Standard
 * Webhooks library.
 */

import { type KeyObject, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Result } from '@kindgi/types';

import { malformedKey } from './errors.js';
import type { MalformedKeyError } from './errors.js';

/** Prefix of a webhook signing secret. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** The three request headers a signed webhook carries. */
export const WEBHOOK_HEADERS = {
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
} as const;

/** How far a message's timestamp may be from the receiver's clock (seconds). */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

const SIGNATURE_VERSION = 'v1';
const SECRET_BYTES = 32;

/** The fewest random bytes a webhook secret may have (Standard Webhooks: 24–64). */
export const WEBHOOK_SECRET_MIN_BYTES = 24;

/** A new random signing secret: `whsec_` + base64 of 32 random bytes. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64')}`;
}

/**
 * Whether a secret is usable for signing: `whsec_` + base64 (or the bare
 * base64) of at least {@link WEBHOOK_SECRET_MIN_BYTES} bytes.
 */
export function isStrongWebhookSecret(secret: string): boolean {
  const key = parseWebhookSecret(secret);
  return key !== null && key.length >= WEBHOOK_SECRET_MIN_BYTES;
}

export interface SignWebhookInput {
  /**
   * The endpoint's secret. During a rotation, pass the new and the
   * previous secret: the header then carries one signature per secret,
   * and a receiver holding either one accepts the message.
   */
  readonly secret: string | readonly string[];
  /** The message id; stays the same across retries of one message. */
  readonly id: string;
  /** Unix seconds. */
  readonly timestamp: number;
  /** The raw request body, exactly as sent. */
  readonly body: string | Uint8Array;
}

/**
 * The `webhook-signature` header value: `v1,<base64>` per secret,
 * space-separated. A malformed secret is a `malformed-key` error. An
 * empty secret list or a timestamp that isn't a non-negative integer is
 * a caller bug and throws.
 */
export function signWebhook(input: SignWebhookInput): Result<string, MalformedKeyError> {
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new TypeError('signWebhook: timestamp must be a non-negative integer (Unix seconds)');
  }
  const secrets = typeof input.secret === 'string' ? [input.secret] : input.secret;
  if (secrets.length === 0) throw new TypeError('signWebhook: at least one secret is required');
  const content = signedContent(input.id, String(input.timestamp), input.body);
  const signatures: string[] = [];
  for (const secret of secrets) {
    const key = parseWebhookSecret(secret);
    if (key === null) return malformedKey('webhook secret must be `whsec_` + base64 key bytes');
    signatures.push(`${SIGNATURE_VERSION},${hmac(key, content).toString('base64')}`);
  }
  return { kind: 'ok', value: signatures.join(' ') };
}

/** The three signed headers for a message, ready to send. */
export function webhookHeaders(
  input: SignWebhookInput,
): Result<Readonly<Record<string, string>>, MalformedKeyError> {
  const signature = signWebhook(input);
  if (signature.kind === 'err') return signature;
  return {
    kind: 'ok',
    value: {
      [WEBHOOK_HEADERS.id]: input.id,
      [WEBHOOK_HEADERS.timestamp]: String(input.timestamp),
      [WEBHOOK_HEADERS.signature]: signature.value,
    },
  };
}

/** Request headers as a `Headers` object or a plain (Node-style) record. */
export type WebhookRequestHeaders =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookInput {
  readonly secret: string;
  readonly headers: WebhookRequestHeaders;
  /** The raw request body, exactly as received — not a re-serialized JSON value. */
  readonly body: string | Uint8Array;
  /** Default {@link DEFAULT_WEBHOOK_TOLERANCE_SECONDS}. */
  readonly toleranceSeconds?: number;
  /** Clock in milliseconds; default `Date.now`. */
  readonly now?: () => number;
}

export type VerifyWebhookFailure =
  | 'missing-headers'
  | 'invalid-timestamp'
  | 'timestamp-out-of-tolerance'
  | 'invalid-secret'
  | 'no-matching-signature';

export type VerifyWebhookResult =
  | { readonly kind: 'ok'; readonly id: string; readonly timestamp: number }
  | { readonly kind: 'err'; readonly reason: VerifyWebhookFailure };

/**
 * Verify a received webhook: the timestamp is within tolerance and at
 * least one `v1` signature in the header matches. Comparison is
 * constant-time. On `ok`, deduplicate on `id` — delivery is at least once.
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  return verifyWebhookWith(input, input.secret);
}

/**
 * {@link verifyWebhook} with the secret as given, or as the key already
 * decoded from it (a `KeyObject`, which a receiver can keep without holding
 * the secret as a string). Within the package.
 */
export function verifyWebhookWith(
  input: Omit<VerifyWebhookInput, 'secret'>,
  secret: string | KeyObject,
): VerifyWebhookResult {
  const id = readHeader(input.headers, WEBHOOK_HEADERS.id);
  const timestampRaw = readHeader(input.headers, WEBHOOK_HEADERS.timestamp);
  const signatureHeader = readHeader(input.headers, WEBHOOK_HEADERS.signature);
  if (id === undefined || timestampRaw === undefined || signatureHeader === undefined) {
    return { kind: 'err', reason: 'missing-headers' };
  }
  if (!/^\d{1,15}$/.test(timestampRaw)) return { kind: 'err', reason: 'invalid-timestamp' };
  const timestamp = Number(timestampRaw);
  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return { kind: 'err', reason: 'timestamp-out-of-tolerance' };
  }
  const key = typeof secret === 'string' ? parseWebhookSecret(secret) : secret;
  if (key === null) return { kind: 'err', reason: 'invalid-secret' };

  const expected = hmac(key, signedContent(id, timestampRaw, input.body));
  for (const part of signatureHeader.split(' ')) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== SIGNATURE_VERSION) continue;
    const provided = Buffer.from(part.slice(comma + 1), 'base64');
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return { kind: 'ok', id, timestamp };
    }
  }
  return { kind: 'err', reason: 'no-matching-signature' };
}

function signedContent(id: string, timestamp: string, body: string | Uint8Array): Buffer {
  const prefix = Buffer.from(`${id}.${timestamp}.`, 'utf-8');
  const bodyBytes = typeof body === 'string' ? Buffer.from(body, 'utf-8') : Buffer.from(body);
  return Buffer.concat([prefix, bodyBytes]);
}

function hmac(key: Buffer | KeyObject, content: Buffer): Buffer {
  return createHmac('sha256', key).update(content).digest();
}

/** Key bytes of a `whsec_…` (or bare base64) secret; `null` when malformed. Within the package. */
export function parseWebhookSecret(secret: string): Buffer | null {
  const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length === 0 ? null : key;
}

/** A header's first value (`name` in lower case, matched case-insensitively); `undefined` when absent or empty. */
export function readHeader(headers: WebhookRequestHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value === null || value.length === 0 ? undefined : value;
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue;
    const first = typeof value === 'string' ? value : value?.[0];
    return first === undefined || first.length === 0 ? undefined : first;
  }
  return undefined;
}
