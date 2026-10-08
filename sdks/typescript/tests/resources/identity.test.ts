// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import type { UserId } from '@kindgi/types';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

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

describe("identity — a person's grants", () => {
  const GRANTS = {
    userId: 'u-1',
    tenantAdmin: false,
    projects: [{ projectId: 'p-1', role: 'editor' }],
    teams: [],
  };
  const client = (stub: { fetch: typeof fetch }) =>
    createClient({
      apiUrl: 'https://api.example.com',
      auth: { kind: 'apiToken', token: 't' },
      fetch: stub.fetch,
    });

  it('grants GETs them', async () => {
    const stub = jsonFetch(GRANTS);
    expect(await client(stub).users.grants('u 1' as UserId)).toEqual(GRANTS);
    expect(stub.calls[0]?.method).toBe('GET');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/users/u%201/grants');
  });

  it('grant and ungrant POST tenant admin', async () => {
    const body = JSON.stringify({ ...GRANTS, tenantAdmin: true });
    const stub = recordingFetch([
      { status: 200, body },
      { status: 200, body },
    ]);
    const after = await client(stub).users.grant(
      'u-1' as UserId,
      { kind: 'tenant-admin' },
      { idempotencyKey: 'idem-g' },
    );
    expect(after.tenantAdmin).toBe(true);
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/users/u-1/grant');
    expect(stub.calls[0]?.headers['idempotency-key']).toBe('idem-g');
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({ kind: 'tenant-admin' });
    await client(stub).users.ungrant('u-1' as UserId, { kind: 'tenant-admin' });
    expect(stub.calls[1]?.url).toBe('https://api.example.com/v1/identity/users/u-1/ungrant');
  });

  it('the last tenant admin is a typed 409', async () => {
    const stub = errorFetch(409, { code: 'last-tenant-admin', message: 'the only one' });
    await expect(
      client(stub).users.ungrant('u-1' as UserId, { kind: 'tenant-admin' }),
    ).rejects.toMatchObject({ error: { code: 'conflict', reason: 'last-tenant-admin' } });
  });
});
