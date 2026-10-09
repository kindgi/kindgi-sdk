// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The renewal protocol's deployment side, pinned by the vectors
 * access.kindgi.com checks itself against (the same seed, ids, bodies and
 * signatures): a change here is a change to the protocol. And the offline
 * check of a license key, as the runtime makes it.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  KINDGI_LICENSE_PUBLIC_KEYS,
  LICENSE_KEY_PREFIX,
  checkLicenseKey,
} from '../src/license/license-key.js';
import {
  decodeRenewerPrivateKey,
  encodeRenewerPrivateKey,
  enrollLine,
  renewSigningInput,
  signRenewRequest,
} from '../src/license/protocol.js';

const ORIGIN = 'https://access.kindgi.com';
/** Ed25519 with the seed 0x00…0x1f. */
const SEED_LINE = 'kgi_lrk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('the vectors', () => {
  const key = decodeRenewerPrivateKey(SEED_LINE);

  test('the private key line, the public key and the renewer id', () => {
    expect(key?.renewerId).toBe('lr_Vkdap1RjR0wChd9dvyvKtz');
    expect(Buffer.from(key?.publicKey ?? []).toString('base64url')).toBe(
      'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
    );
    expect(key && encodeRenewerPrivateKey(key)).toBe(SEED_LINE);
  });

  test('a renewal: the body, what the signature covers, the signature', () => {
    if (key === undefined) throw new Error('no key');
    const { body, signature } = signRenewRequest(key, {
      origin: ORIGIN,
      now: 1791500000,
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
    });
    expect(body).toBe(
      '{"renewerId":"lr_Vkdap1RjR0wChd9dvyvKtz","ts":1791500000,"nonce":"AAECAwQFBgcICQoLDA0ODw"}',
    );
    expect(renewSigningInput(ORIGIN, Buffer.from(body))).toBe(
      'kindgi-license-renew-v1\nPOST https://access.kindgi.com/v1/renew\ne_LG7EFnZropPLMO_qYoBkKwVaHMijevuBUaFCWTn_w',
    );
    expect(signature).toBe(
      'sBz-6xCVEm556M-FqA8PA1NeKFkXHCtjEMq44xhpIF8ZpqmSJcuJAuZl19t_UuWNOgUl-VwYH3qrv-oGeSUaDQ',
    );
  });

  test('the enroll line for a GitHub login (lowercased)', () => {
    if (key === undefined) throw new Error('no key');
    expect(enrollLine(key, 'Octo', ORIGIN)).toBe(
      'kgi_lrp_A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg.b2N0bw.maGDYEL20aRM-cR0Kv2Aw6uRjwpjk4kbJdf6QIsbcaXUZB7pTL7_AX3W0HzCm-4bk4eO223o85covkpRDAQ-AQ',
    );
  });

  test('anything else in the store is not a private key', () => {
    for (const value of [
      '',
      'kgi_lk_abc.def',
      `${SEED_LINE}AA`,
      'kgi_lrk_!!!',
      SEED_LINE.slice(0, -2),
    ]) {
      expect(decodeRenewerPrivateKey(value), value).toBeUndefined();
    }
    expect(decodeRenewerPrivateKey(`  ${SEED_LINE}\n`)?.renewerId).toBe(
      'lr_Vkdap1RjR0wChd9dvyvKtz',
    );
  });
});

describe('a license key, checked offline', () => {
  const pair = generateKeyPairSync('ed25519');
  const raw = pair.publicKey.export({ format: 'jwk' }).x as string;
  const publicKeys = { 'test-lk': Buffer.from(raw, 'base64url').toString('base64') };
  const payload = {
    v: 1,
    kid: 'test-lk',
    sub: 'dom-acme.example',
    name: 'acme.example',
    use: 'non-production',
    iat: 1_791_000_000,
    exp: 1_794_888_000,
  };
  const keyFor = (p: Record<string, unknown>, signer = pair.privateKey) => {
    const signed = `${LICENSE_KEY_PREFIX}${Buffer.from(JSON.stringify(p)).toString('base64url')}`;
    return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), signer).toString('base64url')}`;
  };

  test('a key Kindgi signed: what it says', () => {
    expect(checkLicenseKey(keyFor(payload), publicKeys)).toEqual({
      kind: 'ok',
      claims: {
        keyId: 'test-lk',
        subject: 'dom-acme.example',
        name: 'acme.example',
        use: 'non-production',
        issuedAt: new Date(1_791_000_000_000),
        expiresAt: new Date(1_794_888_000_000),
      },
    });
  });

  test('signed by another key, an unknown kid, or not a key at all: refused, saying which', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(checkLicenseKey(keyFor(payload, other), publicKeys)).toEqual({
      kind: 'err',
      reason: 'bad-signature',
    });
    expect(checkLicenseKey(keyFor({ ...payload, kid: 'lk-2099-1' }), publicKeys).kind).toBe('err');
    expect(checkLicenseKey(keyFor({ ...payload, kid: 'lk-2099-1' }), publicKeys)).toMatchObject({
      reason: 'unknown-key',
    });
    for (const bad of [
      'kgi_lk_',
      'not a key',
      keyFor({ ...payload, v: 2 }),
      keyFor({ ...payload, use: 'forever' }),
      keyFor({ ...payload, exp: payload.iat }),
    ]) {
      expect(checkLicenseKey(bad, publicKeys), bad).toMatchObject({
        kind: 'err',
        reason: 'malformed',
      });
    }
  });

  test("Kindgi's own signing key, as a released runtime trusts it", () => {
    const pub = KINDGI_LICENSE_PUBLIC_KEYS['lk-2026-1'];
    expect(Buffer.from(pub ?? '', 'base64')).toHaveLength(32);
    // A key signed with anything else under that kid is refused.
    expect(checkLicenseKey(keyFor({ ...payload, kid: 'lk-2026-1' })).kind).toBe('err');
  });
});
