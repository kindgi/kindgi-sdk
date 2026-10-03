// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Webhook } from 'standardwebhooks';
import { describe, expect, test } from 'vitest';

import type { Result } from '@kindgi/types';

import {
  WEBHOOK_SECRET_PREFIX,
  generateWebhookSecret,
  isStrongWebhookSecret,
  signWebhook,
  verifyWebhook,
  webhookHeaders,
} from '../src/index.js';

// The test vector published with the Standard Webhooks specification.
const VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const atVector = (): number => VECTOR.timestamp * 1000;

function ok<T, E>(result: Result<T, E>): T {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

describe('signWebhook', () => {
  test('matches the Standard Webhooks test vector', () => {
    expect(ok(signWebhook(VECTOR))).toBe(VECTOR.signature);
  });

  test('signs once per secret during a rotation', () => {
    const next = generateWebhookSecret();
    const header = ok(signWebhook({ ...VECTOR, secret: [next, VECTOR.secret] }));
    const parts = header.split(' ');
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe(VECTOR.signature);
  });

  test('a malformed secret is a malformed-key error', () => {
    const result = signWebhook({ ...VECTOR, secret: 'whsec_not base64!' });
    expect(result.kind).toBe('err');
    if (result.kind === 'err') expect(result.error.code).toBe('malformed-key');
  });

  test('a non-integer timestamp throws', () => {
    expect(() => signWebhook({ ...VECTOR, timestamp: 1.5 })).toThrow(TypeError);
  });

  test('signs raw bytes the same as the equivalent string', () => {
    const bytes = new TextEncoder().encode(VECTOR.body);
    expect(ok(signWebhook({ ...VECTOR, body: bytes }))).toBe(VECTOR.signature);
  });
});

describe('verifyWebhook', () => {
  const headers = {
    'webhook-id': VECTOR.id,
    'webhook-timestamp': String(VECTOR.timestamp),
    'webhook-signature': VECTOR.signature,
  };

  test('accepts the test vector, from a plain record or a Headers object', () => {
    const fromRecord = verifyWebhook({
      secret: VECTOR.secret,
      headers,
      body: VECTOR.body,
      now: atVector,
    });
    expect(fromRecord).toEqual({ kind: 'ok', id: VECTOR.id, timestamp: VECTOR.timestamp });
    const fromHeaders = verifyWebhook({
      secret: VECTOR.secret,
      headers: new Headers(headers),
      body: VECTOR.body,
      now: atVector,
    });
    expect(fromHeaders.kind).toBe('ok');
  });

  test('header names match case-insensitively in a record', () => {
    const upper = {
      'Webhook-Id': VECTOR.id,
      'Webhook-Timestamp': String(VECTOR.timestamp),
      'Webhook-Signature': VECTOR.signature,
    };
    const result = verifyWebhook({
      secret: VECTOR.secret,
      headers: upper,
      body: VECTOR.body,
      now: atVector,
    });
    expect(result.kind).toBe('ok');
  });

  test('a changed body fails', () => {
    const result = verifyWebhook({
      secret: VECTOR.secret,
      headers,
      body: '{"test": 2432232315}',
      now: atVector,
    });
    expect(result).toEqual({ kind: 'err', reason: 'no-matching-signature' });
  });

  test('a changed id fails (the id is signed)', () => {
    const result = verifyWebhook({
      secret: VECTOR.secret,
      headers: { ...headers, 'webhook-id': 'msg_other' },
      body: VECTOR.body,
      now: atVector,
    });
    expect(result).toEqual({ kind: 'err', reason: 'no-matching-signature' });
  });

  test('another secret fails', () => {
    const result = verifyWebhook({
      secret: generateWebhookSecret(),
      headers,
      body: VECTOR.body,
      now: atVector,
    });
    expect(result).toEqual({ kind: 'err', reason: 'no-matching-signature' });
  });

  test('a timestamp outside the tolerance fails, in either direction', () => {
    for (const offset of [-301, 301]) {
      const result = verifyWebhook({
        secret: VECTOR.secret,
        headers,
        body: VECTOR.body,
        now: () => (VECTOR.timestamp + offset) * 1000,
      });
      expect(result).toEqual({ kind: 'err', reason: 'timestamp-out-of-tolerance' });
    }
    const inside = verifyWebhook({
      secret: VECTOR.secret,
      headers,
      body: VECTOR.body,
      now: () => (VECTOR.timestamp + 300) * 1000,
    });
    expect(inside.kind).toBe('ok');
  });

  test('missing headers and a malformed timestamp are reported', () => {
    const { 'webhook-signature': _omit, ...withoutSignature } = headers;
    expect(
      verifyWebhook({ secret: VECTOR.secret, headers: withoutSignature, body: VECTOR.body }),
    ).toEqual({ kind: 'err', reason: 'missing-headers' });
    expect(
      verifyWebhook({
        secret: VECTOR.secret,
        headers: { ...headers, 'webhook-timestamp': '16142e5' },
        body: VECTOR.body,
      }),
    ).toEqual({ kind: 'err', reason: 'invalid-timestamp' });
  });

  test('a malformed secret is reported', () => {
    const result = verifyWebhook({
      secret: 'whsec_',
      headers,
      body: VECTOR.body,
      now: atVector,
    });
    expect(result).toEqual({ kind: 'err', reason: 'invalid-secret' });
  });

  test('during a rotation, either secret verifies', () => {
    const previous = VECTOR.secret;
    const next = generateWebhookSecret();
    const rotated = ok(webhookHeaders({ ...VECTOR, secret: [next, previous] }));
    for (const secret of [next, previous]) {
      const result = verifyWebhook({ secret, headers: rotated, body: VECTOR.body, now: atVector });
      expect(result.kind).toBe('ok');
    }
  });

  test('ignores signature versions it does not know', () => {
    const result = verifyWebhook({
      secret: VECTOR.secret,
      headers: { ...headers, 'webhook-signature': `v1a,AAAA ${VECTOR.signature}` },
      body: VECTOR.body,
      now: atVector,
    });
    expect(result.kind).toBe('ok');
  });
});

describe('isStrongWebhookSecret', () => {
  test('24 bytes or more, with or without the whsec_ prefix', () => {
    const b24 = Buffer.alloc(24, 7).toString('base64');
    const b23 = Buffer.alloc(23, 7).toString('base64');
    expect(isStrongWebhookSecret(`whsec_${b24}`)).toBe(true);
    expect(isStrongWebhookSecret(b24)).toBe(true);
    expect(isStrongWebhookSecret(`whsec_${b23}`)).toBe(false);
    expect(isStrongWebhookSecret(generateWebhookSecret())).toBe(true);
    expect(isStrongWebhookSecret('password123')).toBe(false);
    expect(isStrongWebhookSecret('whsec_')).toBe(false);
  });
});

describe('generateWebhookSecret', () => {
  test('is whsec_ + base64 of 32 bytes, and unique', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
    expect(Buffer.from(a.slice(WEBHOOK_SECRET_PREFIX.length), 'base64')).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

// Interoperability with the reference Standard Webhooks library, both ways.
describe('interop with the reference implementation (standardwebhooks)', () => {
  test('the reference library verifies what signWebhook produces', () => {
    const secret = generateWebhookSecret();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: 'run.finished', data: { run: { id: 'r1' } } });
    const signed = ok(webhookHeaders({ secret, id: 'evt-1', timestamp, body }));
    expect(() => new Webhook(secret).verify(body, signed)).not.toThrow();
  });

  test('verifyWebhook accepts what the reference library signs', () => {
    const secret = generateWebhookSecret();
    const now = new Date();
    const body = '{"hello":"world"}';
    const signature = new Webhook(secret).sign('evt-2', now, body);
    const result = verifyWebhook({
      secret,
      headers: {
        'webhook-id': 'evt-2',
        'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
        'webhook-signature': signature,
      },
      body,
    });
    expect(result.kind).toBe('ok');
  });
});
