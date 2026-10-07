// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createClient, verifySignedExport } from '../src/index.js';
import type { SignedExportEnvelope } from '../src/index.js';

/** A signed export as the API answers one, signed with a fresh key. */
function signedExport(body: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exportedAt = '2026-10-08T00:00:00.000Z';
  // Sorted-key JSON, as the API signs it.
  const full = { ...body, bundleSchemaVersion: '1.2.0', exportedAt };
  const sorted = Object.fromEntries(Object.entries(full).sort(([a], [b]) => a.localeCompare(b)));
  const bytes = Buffer.from(JSON.stringify(sorted), 'utf8');
  const envelope: SignedExportEnvelope = {
    kind: 'provenance',
    bundle: bytes.toString('base64'),
    bundleSchemaVersion: '1.2.0',
    algorithm: 'ed25519',
    signingKeyId: 'ex_testkey0000000',
    signature: sign(null, bytes, privateKey).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    canonicalization: 'sorted-key-json',
    exportedAt,
  };
  return { envelope, pem: envelope.publicKey };
}

const otherPem = () =>
  generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

describe('verifySignedExport', () => {
  test('a signed export verifies against its own key, and returns the signed body', async () => {
    const { envelope } = signedExport({ runId: 'r-1' });
    expect(await verifySignedExport(envelope)).toMatchObject({
      valid: true,
      checkedAgainst: 'its-own-key',
      body: { runId: 'r-1', bundleSchemaVersion: '1.2.0' },
    });
  });

  test('against keys you trust: one of them verifies; a key you do not trust is refused', async () => {
    const { envelope, pem } = signedExport();
    expect(await verifySignedExport(envelope, { trustedKeys: [otherPem(), pem] })).toMatchObject({
      valid: true,
      checkedAgainst: 'trusted-keys',
    });
    const refused = await verifySignedExport(envelope, { trustedKeys: [otherPem()] });
    expect(refused.valid).toBe(false);
    expect(refused.issues?.join(' ')).toContain("isn't one you trust");
  });

  test('a changed byte fails, and so does a changed (unsigned) envelope exportedAt', async () => {
    const { envelope } = signedExport({ runId: 'r-1' });
    const bytes = Buffer.from(envelope.bundle, 'base64').toString('utf8').replace('r-1', 'r-2');
    const changed = await verifySignedExport({
      ...envelope,
      bundle: Buffer.from(bytes, 'utf8').toString('base64'),
    });
    expect(changed.valid).toBe(false);
    expect(changed.issues?.join(' ')).toContain("doesn't match the bundle");
    const moved = await verifySignedExport({ ...envelope, exportedAt: '2027-01-01T00:00:00.000Z' });
    expect(moved.valid).toBe(false);
    expect(moved.issues?.join(' ')).toContain("isn't the signed one");
  });

  test('approvals.audit.verify and provenance.verify check against the key you pass', async () => {
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 't' },
    });
    const { envelope, pem } = signedExport();
    expect(await client.provenance.verify(envelope as never, pem)).toEqual({ valid: true });
    const refused = await client.approvals.audit.verify(envelope as never, otherPem());
    expect(refused.valid).toBe(false);
  });
});
