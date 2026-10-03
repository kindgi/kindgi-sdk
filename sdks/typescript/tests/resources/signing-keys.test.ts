// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const KEY = {
  keyId: 'ci-2026-10',
  tenantId: '00000000-0000-4000-8000-00000000000a',
  algorithm: 'ed25519',
  publicKey: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
  label: 'ci',
  createdAt: '2026-10-02T00:00:00Z',
};

describe('signingKeys — wire round-trips', () => {
  it('trust: POST /v1/signing-keys with the key', async () => {
    const stub = jsonFetch(KEY, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const trusted = await client.signingKeys.trust(
      { keyId: KEY.keyId, publicKey: KEY.publicKey, label: 'ci' },
      { idempotencyKey: 'k-1' },
    );
    expect(trusted.keyId).toBe('ci-2026-10');
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`POST ${API}/v1/signing-keys`);
    expect(call.headers['idempotency-key']).toBe('k-1');
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      keyId: KEY.keyId,
      publicKey: KEY.publicKey,
      label: 'ci',
    });
  });

  it('list, get, revoke: methods, paths and query', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [KEY], hasMore: false }) },
      { status: 200, body: JSON.stringify(KEY) },
      { status: 200, body: JSON.stringify({ keyId: 'ci/2026', revoked: true }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.signingKeys.list({ includeRevoked: true, label: 'ci' });
    await client.signingKeys.get('ci-2026-10');
    const revoked = await client.signingKeys.revoke('ci/2026', { reason: 'rotated' });
    expect(revoked).toEqual({ keyId: 'ci/2026', revoked: true });
    expect(stub.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/v1/signing-keys?includeRevoked=true&label=ci`,
      `GET ${API}/v1/signing-keys/ci-2026-10`,
      `POST ${API}/v1/signing-keys/ci%2F2026/revoke`,
    ]);
    expect(JSON.parse(stub.calls[2]?.body ?? '{}')).toEqual({ reason: 'rotated' });
  });
});
