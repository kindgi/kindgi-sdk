// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { jsonFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const KEY = {
  id: '6f1c2c0e-3b0a-4f1e-9a51-0c1d2e3f4a5b',
  label: 'orchestrator',
  scopes: ['system:deployments'],
  createdAt: '2026-10-12T09:00:00.000Z',
  mintedBy: 'boot',
};

describe('systemKeys — wire round-trip', () => {
  it('mint: POST /v1/system/keys with the spec; the token comes back once', async () => {
    const minted = { ...KEY, token: 'kgi_sy_example' };
    const stub = jsonFetch(minted, { status: 201 });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    const spec = {
      scopes: ['system:deployments' as const],
      label: 'orchestrator',
      expiresAt: '2026-10-12T15:00:00.000Z',
    };
    expect(await client.systemKeys.mint(spec, { idempotencyKey: 'mint-1' })).toEqual(minted);
    const call = stub.calls[0]!;
    expect(`${call.method} ${call.url}`).toBe(`POST ${API}/v1/system/keys`);
    expect(JSON.parse(call.body ?? '{}')).toEqual(spec);
    expect(call.headers['idempotency-key']).toBe('mint-1');
  });

  it('list: GET /v1/system/keys, the keys without secrets', async () => {
    const stub = jsonFetch({ data: [KEY] });
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemKeys.list()).toEqual([KEY]);
    expect(`${stub.calls[0]!.method} ${stub.calls[0]!.url}`).toBe(`GET ${API}/v1/system/keys`);
  });

  it('revoke: POST /v1/system/keys/{keyId}/revoke, the key id path-encoded', async () => {
    const revoked = { ...KEY, revokedAt: '2026-10-12T10:00:00.000Z', alsoRevoked: [] };
    const stub = jsonFetch(revoked);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    expect(await client.systemKeys.revoke('a/b')).toEqual(revoked);
    expect(`${stub.calls[0]!.method} ${stub.calls[0]!.url}`).toBe(
      `POST ${API}/v1/system/keys/a%2Fb/revoke`,
    );
  });
});
