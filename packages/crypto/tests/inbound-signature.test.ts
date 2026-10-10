// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { inspect } from 'node:util';

import { describe, expect, test } from 'vitest';

import type { WebhookSignatureScheme } from '@kindgi/types';

import { inboundSigningKey, verifyInboundSignature } from '../src/index.js';

// GitHub's published example ("Validating webhook deliveries"): this
// secret and payload give `sha256=757107ea…`. The base64 form is the same
// digest, as WooCommerce and Shopify send it (checked with
// `openssl dgst -sha256 -hmac … -binary | base64`).
const SECRET = "It's a Secret to Everybody";
const BODY = 'Hello, World!';
const HEX = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
const BASE64 = 'dXEH6g6yUJ/CESIczphLijdXC211hsIsRvQ3nIsEPhc=';

const HUB: WebhookSignatureScheme = {
  kind: 'hmac-sha256',
  encoding: 'hex',
  header: 'X-Hub-Signature-256',
  prefix: 'sha256=',
};
const WOO: WebhookSignatureScheme = {
  kind: 'hmac-sha256',
  encoding: 'base64',
  header: 'X-WC-Webhook-Signature',
};

describe('verifyInboundSignature, hmac-sha256', () => {
  test("hex after a prefix: GitHub's published vector, and Drupal's Webhooks module's shape", () => {
    expect(
      verifyInboundSignature({
        scheme: HUB,
        secret: SECRET,
        headers: { 'x-hub-signature-256': `sha256=${HEX}` },
        body: BODY,
      }),
    ).toEqual({ kind: 'ok' });
  });

  test("base64 with no prefix: WooCommerce's and Shopify's shape", () => {
    expect(
      verifyInboundSignature({
        scheme: WOO,
        secret: SECRET,
        headers: { 'X-WC-Webhook-Signature': BASE64 },
        body: BODY,
      }),
    ).toEqual({ kind: 'ok' });
  });

  test('the raw bytes are what is signed: a Uint8Array body verifies the same', () => {
    expect(
      verifyInboundSignature({
        scheme: WOO,
        secret: SECRET,
        headers: { 'x-wc-webhook-signature': BASE64 },
        body: new TextEncoder().encode(BODY),
      }),
    ).toEqual({ kind: 'ok' });
  });

  test('the header name is matched case-insensitively, through a Headers object too', () => {
    const headers = new Headers({ 'X-WC-WEBHOOK-SIGNATURE': BASE64 });
    expect(verifyInboundSignature({ scheme: WOO, secret: SECRET, headers, body: BODY })).toEqual({
      kind: 'ok',
    });
  });

  test('hex in upper case is the same digest', () => {
    expect(
      verifyInboundSignature({
        scheme: HUB,
        secret: SECRET,
        headers: { 'x-hub-signature-256': `sha256=${HEX.toUpperCase()}` },
        body: BODY,
      }),
    ).toEqual({ kind: 'ok' });
  });

  test.each([
    ['one byte of the body changed', { body: 'Hello, World?' }],
    ['the secret changed', { secret: "It's a Secret to Everybody!" }],
    ['a body re-serialized with a trailing newline', { body: `${BODY}\n` }],
  ])('%s: signature-invalid', (_, change) => {
    expect(
      verifyInboundSignature({
        scheme: WOO,
        secret: SECRET,
        headers: { 'x-wc-webhook-signature': BASE64 },
        body: BODY,
        ...change,
      }),
    ).toEqual({ kind: 'err', reason: 'signature-invalid' });
  });

  test.each([
    ['the prefix missing', HUB, HEX],
    ['the wrong prefix', HUB, `sha1=${HEX}`],
    ['hex where base64 is expected', WOO, HEX],
    ['base64 where hex is expected', HUB, `sha256=${BASE64}`],
    ['a truncated digest', HUB, `sha256=${HEX.slice(0, 62)}`],
    ['base64 without its padding', WOO, BASE64.slice(0, -1)],
    ['base64 of the wrong length', WOO, Buffer.alloc(31).toString('base64')],
    ['not hex at all', HUB, `sha256=${'z'.repeat(64)}`],
  ])('%s: signature-invalid', (_, scheme, value) => {
    const header = scheme.kind === 'hmac-sha256' ? scheme.header : '';
    expect(
      verifyInboundSignature({ scheme, secret: SECRET, headers: { [header]: value }, body: BODY }),
    ).toEqual({ kind: 'err', reason: 'signature-invalid' });
  });

  test('one flipped character in the digest: signature-invalid', () => {
    const flipped = `${HEX.slice(0, 10)}${HEX[10] === '0' ? '1' : '0'}${HEX.slice(11)}`;
    expect(
      verifyInboundSignature({
        scheme: HUB,
        secret: SECRET,
        headers: { 'x-hub-signature-256': `sha256=${flipped}` },
        body: BODY,
      }),
    ).toEqual({ kind: 'err', reason: 'signature-invalid' });
  });

  test("no header, or an empty one, or only another scheme's header: signature-missing", () => {
    for (const headers of [
      {},
      { 'x-hub-signature-256': '' },
      { 'x-hub-signature': `sha1=${HEX}` },
    ]) {
      expect(verifyInboundSignature({ scheme: HUB, secret: SECRET, headers, body: BODY })).toEqual({
        kind: 'err',
        reason: 'signature-missing',
      });
    }
  });

  test('an empty secret is never one: secret-invalid', () => {
    expect(
      verifyInboundSignature({
        scheme: WOO,
        secret: '',
        headers: { 'x-wc-webhook-signature': BASE64 },
        body: BODY,
      }),
    ).toEqual({ kind: 'err', reason: 'secret-invalid' });
  });
});

describe('verifyInboundSignature, standard-webhooks', () => {
  // The test vector published with the Standard Webhooks specification
  // (the same one `webhook.test.ts` signs with).
  const VECTOR = {
    secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: 1614265330,
    body: '{"test": 2432232314}',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };
  const SW: WebhookSignatureScheme = { kind: 'standard-webhooks' };
  const headers = {
    'webhook-id': VECTOR.id,
    'webhook-timestamp': String(VECTOR.timestamp),
    'webhook-signature': VECTOR.signature,
  };
  const at = (seconds: number) => () => seconds * 1000;

  test('the published vector verifies, and the signed id comes back', () => {
    expect(
      verifyInboundSignature({
        scheme: SW,
        secret: VECTOR.secret,
        headers,
        body: VECTOR.body,
        now: at(VECTOR.timestamp),
      }),
    ).toEqual({ kind: 'ok', signedId: VECTOR.id });
  });

  test('outside the default 300 s: stale; a wider tolerance takes it', () => {
    const late = at(VECTOR.timestamp + 301);
    const input = { secret: VECTOR.secret, headers, body: VECTOR.body, now: late };
    expect(verifyInboundSignature({ scheme: SW, ...input })).toEqual({
      kind: 'err',
      reason: 'stale',
    });
    expect(
      verifyInboundSignature({
        scheme: { kind: 'standard-webhooks', toleranceSeconds: 600 },
        ...input,
      }),
    ).toEqual({ kind: 'ok', signedId: VECTOR.id });
  });

  test('a changed body: signature-invalid; no headers: signature-missing', () => {
    const input = { scheme: SW, secret: VECTOR.secret, now: at(VECTOR.timestamp) };
    expect(verifyInboundSignature({ ...input, headers, body: `${VECTOR.body} ` })).toEqual({
      kind: 'err',
      reason: 'signature-invalid',
    });
    expect(verifyInboundSignature({ ...input, headers: {}, body: VECTOR.body })).toEqual({
      kind: 'err',
      reason: 'signature-missing',
    });
  });

  test('a secret that is not a whsec_ key: secret-invalid', () => {
    expect(
      verifyInboundSignature({
        scheme: SW,
        secret: 'not base64!',
        headers,
        body: VECTOR.body,
        now: at(VECTOR.timestamp),
      }),
    ).toEqual({ kind: 'err', reason: 'secret-invalid' });
  });
});

describe('inboundSigningKey', () => {
  const VECTOR = {
    secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: 1614265330,
    body: '{"test": 2432232314}',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };
  const keyOf = (scheme: WebhookSignatureScheme, secret: string) => {
    const derived = inboundSigningKey(scheme, secret);
    if (derived.kind !== 'ok') throw new Error('no key');
    return derived.key;
  };

  test('the key verifies what the secret does: the published vectors in each scheme', () => {
    expect(
      verifyInboundSignature({
        scheme: HUB,
        secret: keyOf(HUB, SECRET),
        headers: { 'x-hub-signature-256': `sha256=${HEX}` },
        body: BODY,
      }),
    ).toEqual({ kind: 'ok' });
    expect(
      verifyInboundSignature({
        scheme: WOO,
        secret: keyOf(WOO, SECRET),
        headers: { 'x-wc-webhook-signature': BASE64 },
        body: BODY,
      }),
    ).toEqual({ kind: 'ok' });
    const SW: WebhookSignatureScheme = { kind: 'standard-webhooks' };
    expect(
      verifyInboundSignature({
        scheme: SW,
        secret: keyOf(SW, VECTOR.secret),
        headers: {
          'webhook-id': VECTOR.id,
          'webhook-timestamp': String(VECTOR.timestamp),
          'webhook-signature': VECTOR.signature,
        },
        body: VECTOR.body,
        now: () => VECTOR.timestamp * 1000,
      }),
    ).toEqual({ kind: 'ok', signedId: VECTOR.id });
  });

  test("another secret's key: signature-invalid", () => {
    expect(
      verifyInboundSignature({
        scheme: WOO,
        secret: keyOf(WOO, 'acmeOtherSecret1'),
        headers: { 'x-wc-webhook-signature': BASE64 },
        body: BODY,
      }),
    ).toEqual({ kind: 'err', reason: 'signature-invalid' });
  });

  test('a secret the scheme cannot use: secret-invalid, and no key', () => {
    expect(inboundSigningKey(WOO, '')).toEqual({ kind: 'err', reason: 'secret-invalid' });
    expect(inboundSigningKey({ kind: 'standard-webhooks' }, 'not base64!')).toEqual({
      kind: 'err',
      reason: 'secret-invalid',
    });
  });

  test('a key never shows its secret: not serialized, inspected or stringified', () => {
    const key = keyOf(WOO, SECRET);
    const sw = keyOf({ kind: 'standard-webhooks' }, VECTOR.secret);
    const shown = [
      JSON.stringify(key),
      JSON.stringify({ key }),
      inspect(key, { showHidden: true, depth: 5 }),
      String(key),
      JSON.stringify(sw),
      inspect(sw, { showHidden: true, depth: 5 }),
    ].join('\n');
    for (const leak of [
      SECRET,
      Buffer.from(SECRET).toString('base64'),
      Buffer.from(SECRET).toString('hex'),
      VECTOR.secret.slice('whsec_'.length),
    ]) {
      expect(shown).not.toContain(leak);
    }
    expect(JSON.stringify(key)).toBe('{}');
  });
});
