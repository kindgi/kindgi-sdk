// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Interoperability tests. Proves that the primitives here haven't drifted
 * from the underlying Node crypto module — a signature this package
 * produces MUST verify when handed to Node's raw sign/verify with the
 * same key material, and vice versa. Guards against future refactors
 * accidentally introducing a wire-format divergence (byte order, envelope,
 * hash prehashing, etc.).
 */

import { createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  generateEd25519KeyPair,
  hmacSha256Sign,
  serializePrivateKeyPem,
  serializePublicKeyPem,
  signEd25519,
  verifyEd25519,
} from '../src/index.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('Ed25519 interop with node:crypto', () => {
  test("this package's signature verifies with Node's raw verify", () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const message = utf8('interop message');

    const sig = signEd25519(privateKey, message);
    if (sig.kind !== 'ok') throw new Error('signEd25519 failed');

    // Feed the same public key (as PEM SPKI) into Node's verify.
    const pubKeyObj = createPublicKey(serializePublicKeyPem(publicKey));
    const ok = verify(null, message, pubKeyObj, sig.value);
    expect(ok).toBe(true);
  });

  test("a signature from Node's raw sign verifies with this package's verify", () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const message = utf8('the other direction');

    const privKeyObj = createPrivateKey(serializePrivateKeyPem(privateKey));
    const nodeSig = sign(null, message, privKeyObj);

    const v = verifyEd25519(publicKey, message, new Uint8Array(nodeSig));
    expect(v).toEqual({ kind: 'ok', value: true });
  });
});

describe('HMAC-SHA256 interop with node:crypto', () => {
  test("this package's signature matches Node's raw HMAC output", () => {
    const secret = 'shared-secret';
    const message = 'payload bytes';

    const ours = hmacSha256Sign(secret, message);
    const raw = createHmac('sha256', secret).update(message).digest('hex');

    expect(ours).toBe(raw);
  });
});
