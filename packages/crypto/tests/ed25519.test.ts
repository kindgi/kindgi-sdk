// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, test } from 'vitest';

import {
  ED25519_RAW_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  generateEd25519KeyPair,
  parsePrivateKeyBase64,
  parsePrivateKeyPem,
  parsePublicKeyBase64,
  parsePublicKeyPem,
  serializePrivateKeyBase64,
  serializePrivateKeyPem,
  serializePublicKeyBase64,
  serializePublicKeyPem,
  signEd25519,
  verifyEd25519,
} from '../src/index.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('generateEd25519KeyPair', () => {
  test('produces two independent raw 32-byte keys', () => {
    const kp = generateEd25519KeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(ED25519_RAW_KEY_BYTES);
    expect(kp.privateKey.length).toBe(ED25519_RAW_KEY_BYTES);
  });

  test('two invocations produce distinct keys', () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    expect(Buffer.from(a.privateKey).equals(Buffer.from(b.privateKey))).toBe(false);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(false);
  });
});

describe('signEd25519 + verifyEd25519', () => {
  test('sign → verify round-trip on a plain message', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const message = utf8('the message under test');
    const sig = signEd25519(privateKey, message);
    expect(sig.kind).toBe('ok');
    if (sig.kind !== 'ok') return;
    expect(sig.value.length).toBe(ED25519_SIGNATURE_BYTES);

    const v = verifyEd25519(publicKey, message, sig.value);
    expect(v).toEqual({ kind: 'ok', value: true });
  });

  test('sign is deterministic for the same input', () => {
    const { privateKey } = generateEd25519KeyPair();
    const message = utf8('deterministic-input');
    const a = signEd25519(privateKey, message);
    const b = signEd25519(privateKey, message);
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('sign failed');
    expect(Buffer.from(a.value).equals(Buffer.from(b.value))).toBe(true);
  });

  test('tampered message fails verify', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const original = utf8('the original');
    const sig = signEd25519(privateKey, original);
    if (sig.kind !== 'ok') throw new Error('sign failed');

    const tampered = utf8('the tampered');
    const v = verifyEd25519(publicKey, tampered, sig.value);
    expect(v).toEqual({ kind: 'ok', value: false });
  });

  test('tampered signature fails verify', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const message = utf8('a message');
    const sig = signEd25519(privateKey, message);
    if (sig.kind !== 'ok') throw new Error('sign failed');

    const tampered = new Uint8Array(sig.value);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const v = verifyEd25519(publicKey, message, tampered);
    expect(v).toEqual({ kind: 'ok', value: false });
  });

  test('wrong public key fails verify', () => {
    const kpA = generateEd25519KeyPair();
    const kpB = generateEd25519KeyPair();
    const message = utf8('signed by A, verified against B');
    const sig = signEd25519(kpA.privateKey, message);
    if (sig.kind !== 'ok') throw new Error('sign failed');

    const v = verifyEd25519(kpB.publicKey, message, sig.value);
    expect(v).toEqual({ kind: 'ok', value: false });
  });

  test('malformed private key returns typed error, does not throw', () => {
    const bad = new Uint8Array(10); // wrong length
    const r = signEd25519(bad, utf8('irrelevant'));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('malformed-key');
  });

  test('malformed public key returns typed error, does not throw', () => {
    const bad = new Uint8Array(10);
    const r = verifyEd25519(bad, utf8('m'), new Uint8Array(ED25519_SIGNATURE_BYTES));
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('malformed-key');
  });

  test('malformed signature returns malformed-signature, not authenticity failure', () => {
    const { publicKey } = generateEd25519KeyPair();
    const badSig = new Uint8Array(63); // one byte short
    const r = verifyEd25519(publicKey, utf8('m'), badSig);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('malformed-signature');
  });
});

describe('PEM round-trip', () => {
  test('public key: serialize → parse recovers raw bytes', () => {
    const { publicKey } = generateEd25519KeyPair();
    const pem = serializePublicKeyPem(publicKey);
    expect(pem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(pem).toContain('-----END PUBLIC KEY-----');

    const parsed = parsePublicKeyPem(pem);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(Buffer.from(parsed.value).equals(Buffer.from(publicKey))).toBe(true);
  });

  test('private key: serialize → parse recovers raw bytes', () => {
    const { privateKey } = generateEd25519KeyPair();
    const pem = serializePrivateKeyPem(privateKey);
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');

    const parsed = parsePrivateKeyPem(pem);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(Buffer.from(parsed.value).equals(Buffer.from(privateKey))).toBe(true);
  });

  test('malformed PEM returns typed error (no header)', () => {
    const r = parsePublicKeyPem('not a pem at all');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('malformed-key');
  });

  test('PEM with wrong label returns unsupported-format', () => {
    const wrongLabel = '-----BEGIN RSA PUBLIC KEY-----\nAAAA\n-----END RSA PUBLIC KEY-----';
    const r = parsePublicKeyPem(wrongLabel);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('unsupported-format');
  });

  test('PEM with correct label but garbled base64 fails', () => {
    const garbled = '-----BEGIN PUBLIC KEY-----\n!@#$%^&*\n-----END PUBLIC KEY-----';
    const r = parsePublicKeyPem(garbled);
    expect(r.kind).toBe('err');
  });
});

describe('Base64 round-trip', () => {
  test('public key: serialize → parse recovers raw bytes', () => {
    const { publicKey } = generateEd25519KeyPair();
    const b64 = serializePublicKeyBase64(publicKey);
    expect(b64).not.toContain('\n');

    const parsed = parsePublicKeyBase64(b64);
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok') return;
    expect(Buffer.from(parsed.value).equals(Buffer.from(publicKey))).toBe(true);
  });

  test('private key: serialize → parse recovers raw bytes', () => {
    const { privateKey } = generateEd25519KeyPair();
    const b64 = serializePrivateKeyBase64(privateKey);
    const parsed = parsePrivateKeyBase64(b64);
    if (parsed.kind !== 'ok') throw new Error('parse failed');
    expect(Buffer.from(parsed.value).equals(Buffer.from(privateKey))).toBe(true);
  });

  test('malformed base64 returns typed error', () => {
    const r = parsePublicKeyBase64('***not valid***');
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('malformed-key');
  });

  test('base64 of wrong length (not an SPKI envelope) is rejected', () => {
    const wrongLength = Buffer.from(new Uint8Array(20)).toString('base64');
    const r = parsePublicKeyBase64(wrongLength);
    expect(r.kind).toBe('err');
    if (r.kind === 'err') expect(r.error.code).toBe('malformed-key');
  });
});

describe('cross-serialization equivalence', () => {
  test('a signature verifies whether the pubkey came from PEM or Base64', () => {
    const kp = generateEd25519KeyPair();
    const message = utf8('cross-format');
    const sig = signEd25519(kp.privateKey, message);
    if (sig.kind !== 'ok') throw new Error('sign failed');

    const viaPem = parsePublicKeyPem(serializePublicKeyPem(kp.publicKey));
    const viaB64 = parsePublicKeyBase64(serializePublicKeyBase64(kp.publicKey));
    if (viaPem.kind !== 'ok' || viaB64.kind !== 'ok') throw new Error('parse failed');

    const vPem = verifyEd25519(viaPem.value, message, sig.value);
    const vB64 = verifyEd25519(viaB64.value, message, sig.value);
    expect(vPem).toEqual({ kind: 'ok', value: true });
    expect(vB64).toEqual({ kind: 'ok', value: true });
  });
});
