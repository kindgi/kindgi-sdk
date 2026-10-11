// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  createEcdsaP256ExportSigner,
  createEd25519ExportSigner,
  createExportSignerFromPem,
  ecdsaDerToP1363,
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

describe('ecdsa-p256-sha256: for a KMS without Ed25519', () => {
  const p256 = () =>
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();

  test('signs P1363 r‖s that the key verifies; the key id comes from the 65-byte point', async () => {
    const pem = p256();
    const made = createEcdsaP256ExportSigner({ privateKeyPem: pem });
    if (made.kind !== 'ok') throw new Error(made.error.message);
    const key = made.value.activeKey();
    expect(key).toMatchObject({ algorithm: 'ecdsa-p256-sha256' });
    expect(key.keyId).toMatch(/^ex_[A-Za-z0-9_-]{16}$/);
    const bytes = new TextEncoder().encode('{"a":1}');
    const signed = await made.value.sign(bytes);
    if (signed.kind !== 'ok') throw new Error(signed.error.message);
    expect(signed.value.signature).toHaveLength(64);
    const pub = createPublicKey(key.publicKeyPem);
    expect(
      verify('sha256', bytes, { key: pub, dsaEncoding: 'ieee-p1363' }, signed.value.signature),
    ).toBe(true);
    // The same key, loaded again, has the same id.
    const again = createEcdsaP256ExportSigner({ privateKeyPem: pem });
    expect(again.kind === 'ok' && again.value.activeKey().keyId).toBe(key.keyId);
  });

  test('createExportSignerFromPem reads the algorithm from the key, and names a key it refuses', () => {
    const ed = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const fromEd = createExportSignerFromPem(ed);
    const fromEc = createExportSignerFromPem(p256());
    expect(fromEd.kind === 'ok' && fromEd.value.activeKey().algorithm).toBe('ed25519');
    expect(fromEc.kind === 'ok' && fromEc.value.activeKey().algorithm).toBe('ecdsa-p256-sha256');
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const refused = [
      createExportSignerFromPem(p384),
      createExportSignerFromPem(rsa),
      createExportSignerFromPem('not a key'),
    ];
    expect(refused.map((r) => (r.kind === 'err' ? r.error.message : 'ok'))).toEqual([
      'the export signing key is an ec key on secp384r1, not an EC P-256 key',
      'the export signing key is an rsa key: exports are signed with an Ed25519 or an EC P-256 key',
      'the export signing key is not a readable PEM private key',
    ]);
  });

  test('ecdsaDerToP1363: a KMS DER signature becomes the r‖s exports carry', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const bytes = new TextEncoder().encode('evidence');
    for (let i = 0; i < 20; i += 1) {
      const der = sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' });
      const p1363 = ecdsaDerToP1363(new Uint8Array(der));
      if (p1363.kind !== 'ok') throw new Error(p1363.error.message);
      expect(p1363.value).toHaveLength(64);
      expect(
        verify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, p1363.value),
      ).toBe(true);
    }
    expect(ecdsaDerToP1363(new Uint8Array([0x30, 0x02, 0x02, 0x00])).kind).toBe('err');
    expect(ecdsaDerToP1363(new Uint8Array(64)).kind).toBe('err');
  });
});
