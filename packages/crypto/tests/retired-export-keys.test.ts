// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type ExportSigningBinding,
  createExportSignerFromPem,
  parseRetiredExportKeys,
  withRetiredExportKeys,
} from '../src/index.js';

/** A key pair as PEM: the private half signs, the public half is what a deployment retires. */
function pair(type: 'ed25519' | 'p256' | 'p384' | 'rsa') {
  const { privateKey, publicKey } =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : type === 'rsa'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : generateKeyPairSync('ec', { namedCurve: type === 'p256' ? 'prime256v1' : 'secp384r1' });
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function signer(privatePem: string): ExportSigningBinding {
  const made = createExportSignerFromPem(privatePem);
  if (made.kind === 'err') throw new Error(made.error.message);
  return made.value;
}

describe('parseRetiredExportKeys', () => {
  test('Ed25519 and P-256 public keys, in order, under the ids their own signers use', () => {
    const ed = pair('ed25519');
    const ec = pair('p256');
    const parsed = parseRetiredExportKeys(`${ed.publicPem}\n${ec.publicPem}`);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(parsed.value.map((k) => [k.keyId, k.algorithm])).toEqual([
      [signer(ed.privatePem).activeKey().keyId, 'ed25519'],
      [signer(ec.privatePem).activeKey().keyId, 'ecdsa-p256-sha256'],
    ]);
    expect(parsed.value.map((k) => k.fingerprint)).toEqual([
      signer(ed.privatePem).activeKey().fingerprint,
      signer(ec.privatePem).activeKey().fingerprint,
    ]);
  });

  test.each([
    [
      'a private key',
      () => `${pair('ed25519').publicPem}${pair('ed25519').privatePem}`,
      'block 2 of 2 is a private key (PRIVATE KEY): retired keys are public keys only',
    ],
    [
      'another kind of block',
      () => '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      'block 1 of 1 is a CERTIFICATE, not a PUBLIC KEY',
    ],
    [
      'an unreadable block',
      () => '-----BEGIN PUBLIC KEY-----\nbm90IGEga2V5\n-----END PUBLIC KEY-----\n',
      'block 1 of 1 is not a readable PEM public key',
    ],
    [
      'an RSA key',
      () => pair('rsa').publicPem,
      'block 1 of 1 is an rsa key: exports are signed with Ed25519 or EC P-256 keys',
    ],
    [
      'a P-384 key',
      () => pair('p384').publicPem,
      'block 1 of 1 is an ec key on secp384r1: exports are signed with Ed25519 or EC P-256 keys',
    ],
    ['no block', () => 'not a pem\n', 'it holds no PEM block (-----BEGIN PUBLIC KEY-----)'],
  ])('refuses %s, naming the block', (_name, bundle, message) => {
    const parsed = parseRetiredExportKeys(bundle());
    expect(parsed.kind).toBe('err');
    if (parsed.kind === 'err') expect(parsed.error.message).toContain(message);
  });
});

describe('withRetiredExportKeys', () => {
  const now = pair('ed25519');
  const old = pair('ed25519');
  const oldP256 = pair('p256');
  const retired = (() => {
    const parsed = parseRetiredExportKeys(`${old.publicPem}${oldP256.publicPem}`);
    if (parsed.kind === 'err') throw new Error(parsed.error.message);
    return parsed.value;
  })();

  test('lists the active key first, then the retired ones; the active key is still the one', () => {
    const binding = withRetiredExportKeys(signer(now.privatePem), retired);
    const active = signer(now.privatePem).activeKey();
    expect(binding.activeKey()).toEqual(active);
    expect(binding.listKeys().map((k) => k.keyId)).toEqual([
      active.keyId,
      ...retired.map((k) => k.keyId),
    ]);
  });

  test('never signs with a retired key: the default is the active one, a retired id is signing-key-not-found', async () => {
    const binding = withRetiredExportKeys(signer(now.privatePem), retired);
    const signed = await binding.sign(new Uint8Array([1, 2, 3]));
    expect(signed.kind === 'ok' && signed.value.key.keyId).toBe(
      signer(now.privatePem).activeKey().keyId,
    );
    const byRetired = await binding.sign(new Uint8Array([1, 2, 3]), { keyId: retired[0]!.keyId });
    expect(byRetired.kind === 'err' && byRetired.error.code).toBe('signing-key-not-found');
  });

  test('a key the binding already lists, or one given twice, is listed once', () => {
    const own = parseRetiredExportKeys(now.publicPem);
    if (own.kind === 'err') throw new Error(own.error.message);
    const binding = withRetiredExportKeys(signer(now.privatePem), [
      ...own.value,
      ...retired,
      ...retired,
    ]);
    expect(binding.listKeys()).toHaveLength(1 + retired.length);
  });

  test('an export the old key signed verifies against its listed public key', async () => {
    const bytes = new TextEncoder().encode('{"kind":"provenance"}');
    const signedBefore = await signer(old.privatePem).sign(bytes);
    if (signedBefore.kind === 'err') throw new Error(signedBefore.error.message);
    const listed = withRetiredExportKeys(signer(now.privatePem), retired)
      .listKeys()
      .find((k) => k.keyId === signedBefore.value.key.keyId);
    expect(listed?.publicKeyPem).toBeDefined();
    expect(
      verify(null, bytes, listed!.publicKeyPem, Buffer.from(signedBefore.value.signature)),
    ).toBe(true);
  });
});
