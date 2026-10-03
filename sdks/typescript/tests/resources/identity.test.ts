// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };
const API = 'https://api.example.com';

const SAMPLE_USER = {
  userId: 'u1',
  tenantId: 'tenant-1',
  displayName: 'A. Reviewer',
  primaryEmail: 'a@example.com',
  createdAt: '2026-09-23T00:00:00Z',
};

describe('identity — wire round-trips', () => {
  it('whoami + users.list/get/listSessions/revokeSessions', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ tenantId: 'tenant-1', scopes: ['read'] }) },
      { status: 200, body: JSON.stringify({ data: [SAMPLE_USER], hasMore: false }) },
      { status: 200, body: JSON.stringify(SAMPLE_USER) },
      { status: 200, body: JSON.stringify({ data: [], hasMore: false }) },
      { status: 200, body: JSON.stringify({ userId: 'u1', revokedCount: 2 }) },
    ]);
    const client = createClient({ apiUrl: API, auth: AUTH, fetch: stub.fetch });
    await client.identity.whoami();
    await client.identity.users.list({ query: 'a' });
    await client.identity.users.get('u1');
    await client.identity.users.listSessions('u1');
    await client.identity.users.revokeSessions('u1', { idempotencyKey: 'idem-revoke' });
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /v1/identity/whoami',
      'GET /v1/identity/users',
      'GET /v1/identity/users/u1',
      'GET /v1/identity/users/u1/sessions',
      'POST /v1/identity/users/u1/revoke-sessions',
    ]);
    expect(stub.calls[1]?.url).toMatch(/query=a/);
    expect(stub.calls[4]?.headers['idempotency-key']).toBe('idem-revoke');
  });
});
