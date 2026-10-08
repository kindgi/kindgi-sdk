// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { describe, expect, it } from 'vitest';

import { createClient } from '../../src/index.js';
import { errorFetch, jsonFetch, recordingFetch } from '../support/recording-fetch.js';

const AUTH = { kind: 'apiToken' as const, token: 't' };

const TENANT = '00000000-0000-4000-8000-000000000002';

const WIRE_USER = {
  userId: 'user-alice',
  tenantId: TENANT,
  primaryEmail: 'alice@example.com',
  displayName: 'Alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-09-20T00:00:00.000Z',
};

const WIRE_SESSION = {
  sessionId: 'sess-123',
  userId: 'user-alice',
  providerId: 'oauth-github',
  createdAt: '2026-09-20T00:00:00.000Z',
  expiresAt: '2026-09-27T00:00:00.000Z',
  scopes: ['read', 'write'],
};

describe('users.get / me / list — /v1/identity mapping', () => {
  it('GETs /v1/identity/users/{userId}', async () => {
    const stub = jsonFetch(WIRE_USER);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const u = await client.users.get('user-alice' as never);
    expect(u.displayName).toBe('Alice');
    expect(u.userId).toBe('user-alice');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/users/user-alice');
  });

  it('GETs /v1/identity/whoami and returns WhoamiResult (not User)', async () => {
    const stub = jsonFetch({
      tenantId: TENANT,
      scopes: ['read'],
      userId: 'user-alice',
      user: WIRE_USER,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const whoami = await client.users.me();
    expect(whoami.tenantId).toBe(TENANT);
    expect(whoami.scopes).toEqual(['read']);
    expect(whoami.user?.displayName).toBe('Alice');
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/whoami');
  });

  it('GETs /v1/identity/users with query filter', async () => {
    const stub = jsonFetch({ data: [WIRE_USER], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.users.list({ query: 'Ali', limit: 25 });
    expect(page.items[0]?.userId).toBe('user-alice');
    const url = new URL(stub.calls[0]?.url);
    expect(url.searchParams.get('query')).toBe('Ali');
    expect(url.searchParams.get('limit')).toBe('25');
  });

  it('maps 404 identity-user-not-found onto not-found', async () => {
    const stub = errorFetch(404, {
      code: 'identity-user-not-found',
      message: 'no such user',
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.users.get('nope' as never)).rejects.toMatchObject({
      error: { code: 'not-found' },
    });
  });
});

describe('users.sessions.list / revokeAll', () => {
  it('GETs /v1/identity/users/{userId}/sessions', async () => {
    const stub = jsonFetch({ data: [WIRE_SESSION], hasMore: false });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const page = await client.users.sessions.list('user-alice' as never);
    expect(page.items[0]?.sessionId).toBe('sess-123');
    expect(stub.calls[0]?.url).toBe(
      'https://api.example.com/v1/identity/users/user-alice/sessions',
    );
  });

  it('POSTs /v1/identity/users/{userId}/revoke-sessions with idempotency key', async () => {
    const stub = jsonFetch({ userId: 'user-alice', revokedCount: 3 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.users.sessions.revokeAll('user-alice' as never, {
      idempotencyKey: 'idem-rev',
    });
    expect(result.revokedCount).toBe(3);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/identity/users/user-alice/revoke-sessions');
    expect(req.headers['idempotency-key']).toBe('idem-rev');
  });
});

describe('users.create — POST /v1/identity/users', () => {
  it('adds a person and returns their id', async () => {
    const stub = jsonFetch(WIRE_USER, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const id = await client.users.create(
      { displayName: 'Alice', email: 'alice@example.com' },
      { idempotencyKey: 'idem-u' },
    );
    expect(id).toBe('user-alice');
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/identity/users');
    expect(req.headers['idempotency-key']).toBe('idem-u');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
    });
  });

  it('a taken email is a conflict', async () => {
    const stub = errorFetch(409, {
      code: 'identity-user-email-taken',
      message: 'taken',
      details: { userId: 'user-bob' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await expect(client.users.create({ displayName: 'B', email: 'b@x' })).rejects.toMatchObject({
      error: { code: 'conflict', reason: 'identity-user-email-taken' },
    });
  });

  it('orgId and metadata are not on the wire: not-yet-wired, nothing sent', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await expect(
      client.users.create({ displayName: 'X', orgId: 'o' as never }),
    ).rejects.toMatchObject({ error: { code: 'not-yet-wired', method: 'users.create' } });
    expect(stub.calls.length).toBe(0);
  });
});

describe('users not-yet-wired surface', () => {
  it('update / deactivate / sessions.revoke throw not-yet-wired', async () => {
    const stub = recordingFetch([]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    await expect(client.users.update('x' as never, { displayName: 'Y' })).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'users.update' },
    });
    await expect(client.users.deactivate('x' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'users.deactivate' },
    });
    await expect(client.users.sessions.revoke('sess-1' as never)).rejects.toMatchObject({
      error: { code: 'not-yet-wired', method: 'users.sessions.revoke' },
    });
    expect(stub.calls.length).toBe(0);
  });
});
