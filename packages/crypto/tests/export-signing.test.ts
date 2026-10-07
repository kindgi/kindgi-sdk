// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import type { SigningKeyId } from '@kindgi/types';

import {
  createEd25519ExportSigner,
  createInMemorySigningKeyBinding,
  exportSignerFromSigningKeyBinding,
  exportSigningKey,
  generateEd25519KeyPair,
  parsePublicKeyPem,
  serializePrivateKeyPem,
  verifyEd25519,
} from '../src/index.js';

const bytes = new TextEncoder().encode('{"a":1}');

describe('createEd25519ExportSigner', () => {
  test('signs with the PEM key, under an id derived from its public key', async () => {
    const pair = generateEd25519KeyPair();
    const made = createEd25519ExportSigner({
      privateKeyPem: serializePrivateKeyPem(pair.privateKey),
    });
    if (made.kind !== 'ok') throw new Error(made.error.message);
    const signer = made.value;
    const key = signer.activeKey();
    expect(key).toEqual(exportSigningKey(pair.publicKey));
    expect(key.keyId).toMatch(/^ex_[A-Za-z0-9_-]{16}$/);
    expect(key.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(signer.listKeys()).toEqual([key]);

    const signed = await signer.sign(bytes);
    if (signed.kind !== 'ok') throw new Error(signed.error.message);
    expect(signed.value.key).toEqual(key);
    const pub = parsePublicKeyPem(key.publicKeyPem);
    if (pub.kind !== 'ok') throw new Error(pub.error.message);
    expect(verifyEd25519(pub.value, bytes, signed.value.signature)).toEqual({
      kind: 'ok',
      value: true,
    });
  });

  test('the same key has the same id every time (restarts, other deployments)', () => {
    const pair = generateEd25519KeyPair();
    const a = createEd25519ExportSigner({ privateKey: pair.privateKey });
    const b = createEd25519ExportSigner({ privateKeyPem: serializePrivateKeyPem(pair.privateKey) });
    expect(a.kind === 'ok' && a.value.activeKey().keyId).toBe(
      b.kind === 'ok' && b.value.activeKey().keyId,
    );
  });

  test('asking for another key id is signing-key-not-found, naming the one it signs with', async () => {
    const made = createEd25519ExportSigner({ privateKey: generateEd25519KeyPair().privateKey });
    if (made.kind !== 'ok') throw new Error('no signer');
    const signed = await made.value.sign(bytes, { keyId: 'ex_someoneelse0000' });
    expect(signed).toMatchObject({
      kind: 'err',
      error: { code: 'signing-key-not-found', keyId: 'ex_someoneelse0000' },
    });
    expect(signed.kind === 'err' && signed.error.message).toContain(made.value.activeKey().keyId);
  });

  test('a key that is not an Ed25519 PKCS#8 PEM is refused', () => {
    expect(createEd25519ExportSigner({ privateKeyPem: 'not a pem' }).kind).toBe('err');
    expect(createEd25519ExportSigner({ privateKey: new Uint8Array(5) }).kind).toBe('err');
  });
});

describe('exportSignerFromSigningKeyBinding', () => {
  test("a SigningKeyBinding's Ed25519 keys, under its own ids, the first active", async () => {
    const one = generateEd25519KeyPair();
    const two = generateEd25519KeyPair();
    const binding = createInMemorySigningKeyBinding([
      {
        keyId: 'hmac' as SigningKeyId,
        algorithm: 'hmac-sha256',
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
      },
      { keyId: 'k1' as SigningKeyId, algorithm: 'ed25519', ...one },
      { keyId: 'k2' as SigningKeyId, algorithm: 'ed25519', ...two },
    ]);
    const signer = exportSignerFromSigningKeyBinding(binding);
    expect(signer?.listKeys().map((k) => k.keyId)).toEqual(['k1', 'k2']);
    expect(signer?.activeKey().keyId).toBe('k1');
    const byId = await signer?.sign(bytes, { keyId: 'k2' });
    expect(byId?.kind === 'ok' && byId.value.key.keyId).toBe('k2');
    expect((await signer?.sign(bytes, { keyId: 'hmac' }))?.kind).toBe('err');
  });

  test('no Ed25519 key: nothing to sign with', () => {
    expect(exportSignerFromSigningKeyBinding(createInMemorySigningKeyBinding([]))).toBeUndefined();
  });
});
