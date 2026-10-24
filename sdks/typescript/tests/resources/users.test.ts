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

const WIRE_INVITE = {
  state: 'pending',
  expiresAt: '2026-01-08T00:00:00.000Z',
  sentAt: '2026-01-01T00:00:00.000Z',
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

describe('users.unregister — POST /v1/identity/users/{userId}/unregister', () => {
  it('removes a person: the record with unregisteredAt, and what went', async () => {
    const stub = jsonFetch({
      user: { ...WIRE_USER, unregisteredAt: '2026-10-07T12:00:00.000Z' },
      keysRevoked: 2,
      sessionsRevoked: 1,
      grantsRemoved: 3,
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });

    const result = await client.users.unregister('user-alice' as never, {
      idempotencyKey: 'idem-rm',
    });
    expect(result.user.unregisteredAt).toBe('2026-10-07T12:00:00.000Z');
    expect(result).toMatchObject({ keysRevoked: 2, sessionsRevoked: 1, grantsRemoved: 3 });
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/identity/users/user-alice/unregister');
    expect(req.headers['idempotency-key']).toBe('idem-rm');
  });

  it('a refusal is a conflict naming its reason', async () => {
    for (const code of ['last-tenant-admin', 'identity-user-unregister-refused']) {
      const stub = errorFetch(409, { code, message: 'refused' });
      const client = createClient({
        apiUrl: 'https://api.example.com',
        auth: AUTH,
        fetch: stub.fetch,
      });
      await expect(client.users.unregister('user-alice' as never)).rejects.toMatchObject({
        error: { code: 'conflict', reason: code },
      });
    }
  });

  it('list asks for removed people too only when told', async () => {
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [WIRE_USER], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [WIRE_USER], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await client.users.list();
    await client.users.list({ includeUnregistered: true });
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/users');
    expect(stub.calls[1]?.url).toBe(
      'https://api.example.com/v1/identity/users?includeUnregistered=true',
    );
  });

  it('list asks for only the invited people when told, and reads their invitation', async () => {
    const invited = { ...WIRE_USER, invite: WIRE_INVITE };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify({ data: [invited], hasMore: false }) },
      { status: 200, body: JSON.stringify({ data: [WIRE_USER], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const page = await client.users.list({ pending: true });
    await client.users.list({ pending: false });
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/users?pending=true');
    expect(stub.calls[1]?.url).toBe('https://api.example.com/v1/identity/users');
    expect(page.data[0]?.invite).toEqual(WIRE_INVITE);
  });

  it('list keeps a pending page to the invited when the runtime lists everyone', async () => {
    // A runtime from before invitations ignores `pending`.
    const invited = { ...WIRE_USER, userId: 'carol', invite: WIRE_INVITE };
    const everyone = JSON.stringify({ data: [WIRE_USER, invited], hasMore: false });
    const stub = recordingFetch([
      { status: 200, body: everyone },
      { status: 200, body: everyone },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const pending = await client.users.list({ pending: true });
    const all = await client.users.list();
    expect(pending.data.map((u) => u.userId)).toEqual(['carol']);
    expect(pending.hasMore).toBe(false);
    expect(all.data).toHaveLength(2);
  });

  it("list carries each person's grants only when asked", async () => {
    const grants = { userId: WIRE_USER.userId, tenantAdmin: false, projects: [], teams: [] };
    const stub = recordingFetch([
      {
        status: 200,
        body: JSON.stringify({ data: [{ ...WIRE_USER, grants }], hasMore: false }),
      },
      { status: 200, body: JSON.stringify({ data: [WIRE_USER], hasMore: false }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const page = await client.users.list({ includeGrants: true });
    expect(stub.calls[0]?.url).toBe('https://api.example.com/v1/identity/users?include=grants');
    expect(page.data[0]?.grants).toEqual(grants);
    await client.identity.users.list({ includeGrants: true, query: 'a' });
    expect(stub.calls[1]?.url).toBe(
      'https://api.example.com/v1/identity/users?query=a&include=grants',
    );
  });
});

describe('users.create — POST /v1/identity/users', () => {
  it('adds a person and returns them, with whether their invitation was emailed', async () => {
    const wire = { ...WIRE_USER, invite: WIRE_INVITE, inviteEmail: { sent: true } };
    const stub = jsonFetch(wire, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const created = await client.users.create(
      { displayName: 'Alice', email: 'alice@example.com' },
      { idempotencyKey: 'idem-u' },
    );
    expect(created).toEqual(wire);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/identity/users');
    expect(req.headers['idempotency-key']).toBe('idem-u');
    expect(JSON.parse(req.body ?? '{}')).toEqual({
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
    });
  });

  it('from a runtime that does not invite, the person has no inviteEmail', async () => {
    const stub = jsonFetch(WIRE_USER, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const created = await client.users.create({ displayName: 'Alice' });
    expect(created).toEqual(WIRE_USER);
    expect('inviteEmail' in created).toBe(false);
  });

  it('sendInvite: false goes on the wire, and the invitation says not-requested', async () => {
    const wire = {
      ...WIRE_USER,
      invite: { state: 'pending', expiresAt: WIRE_INVITE.expiresAt },
      inviteEmail: { sent: false, reason: 'not-requested' },
    };
    const stub = jsonFetch(wire, { status: 201 });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const created = await client.users.create({
      displayName: 'Alice',
      email: 'alice@example.com',
      sendInvite: false,
    });
    expect(created.inviteEmail).toEqual({ sent: false, reason: 'not-requested' });
    expect(JSON.parse(stub.calls[0]?.body ?? '{}')).toEqual({
      displayName: 'Alice',
      primaryEmail: 'alice@example.com',
      sendInvite: false,
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

describe('users.resendInvite — POST /v1/identity/users/{userId}/invite', () => {
  it('renews the invitation and says whether it was emailed again', async () => {
    const wire = { user: { ...WIRE_USER, invite: WIRE_INVITE }, inviteEmail: { sent: true } };
    const stub = jsonFetch(wire);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    const renewed = await client.users.resendInvite('user/alice' as never, {
      idempotencyKey: 'idem-i',
    });
    expect(renewed).toEqual(wire);
    const req = stub.calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/v1/identity/users/user%2Falice/invite');
    expect(req.headers['idempotency-key']).toBe('idem-i');
    expect(JSON.parse(req.body ?? 'null')).toEqual({});
  });

  it('someone who has joined is a conflict', async () => {
    const stub = errorFetch(409, {
      code: 'identity-user-not-invited',
      message: 'joined',
      details: { userId: 'user-alice' },
    });
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await expect(client.users.resendInvite('user-alice' as never)).rejects.toMatchObject({
      error: { code: 'conflict', reason: 'identity-user-not-invited' },
    });
  });

  it('too many resends is rate-limited, with the wait from Retry-After', async () => {
    const stub = recordingFetch([
      {
        status: 429,
        body: JSON.stringify({
          error: { requestId: 'req-test', code: 'invite-capped', message: 'later' },
        }),
        headers: { 'Retry-After': '43' },
      },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    await expect(client.users.resendInvite('user-alice' as never)).rejects.toMatchObject({
      error: { code: 'rate-limited', serverCode: 'invite-capped', retryAfterSeconds: 43 },
    });
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

describe("users.secondFactor and removeSecondFactor — a person's second factor", () => {
  it('reads theirs, and removes it with an Idempotency-Key', async () => {
    const status = {
      setUp: true,
      since: '2026-10-17T00:00:00.000Z',
      recoveryCodesLeft: 3,
      usable: true,
      required: false,
    };
    const stub = recordingFetch([
      { status: 200, body: JSON.stringify(status) },
      { status: 200, body: JSON.stringify({ removed: true }) },
    ]);
    const client = createClient({
      apiUrl: 'https://api.example.com',
      auth: AUTH,
      fetch: stub.fetch,
    });
    expect(await client.users.secondFactor('user/bob' as never)).toEqual(status);
    expect(
      await client.users.removeSecondFactor('user/bob' as never, { idempotencyKey: 'idem-sf' }),
    ).toEqual({ removed: true });
    const [read, removed] = stub.calls;
    expect(`${read?.method} ${read?.url}`).toBe(
      'GET https://api.example.com/v1/identity/users/user%2Fbob/second-factor',
    );
    expect(`${removed?.method} ${removed?.url}`).toBe(
      'POST https://api.example.com/v1/identity/users/user%2Fbob/second-factor/remove',
    );
    expect(removed?.headers['idempotency-key']).toBe('idem-sf');
    expect(JSON.parse(removed?.body ?? 'null')).toEqual({});
  });
});
