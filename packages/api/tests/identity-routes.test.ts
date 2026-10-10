// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { MULTI_TENANT_LOOKUP, SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  RunHandlerBinding,
  Session,
  SessionStoreBinding,
  TokenResolver,
  UserRecord,
} from '../src/index.js';

/**
 * Identity routes tests. Binding is caller-plugged;
 * these tests back it with an in-memory `Map`-based adapter — same
 * pattern as `policies-routes.test.ts`. Covers list + get (happy /
 * 404), sessions (happy / empty), revoke (happy / idempotent-repeat),
 * whoami (bearer vs session-token flavors), tenant isolation, and
 * the unmounted-route 404 when the binding is absent.
 */

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const BEARER_TOKEN = 'identity-bearer-abc';
/** A tenant admin: listing people, and reading or revoking someone else's sessions, needs one. */
const ADMIN_TOKEN = 'identity-bearer-admin';
/** A member who is `u-a`: not a tenant admin. */
const MEMBER_TOKEN = 'identity-bearer-member';
const SESSION_ID = 'ses-abc-123' as SessionId;
const SESSION_USER = 'user-alice' as UserId;

const noopRunHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

function makeInMemoryDirectory(): {
  readonly binding: IdentityDirectoryBinding;
  readonly setUser: (user: UserRecord) => void;
  readonly setSessions: (tenantId: TenantId, userId: UserId, sessions: readonly Session[]) => void;
} {
  const users = new Map<string, UserRecord>(); // key: `${tenantId}:${userId}`
  const sessionsByUser = new Map<string, Session[]>(); // key: `${tenantId}:${userId}`

  function key(tenantId: TenantId, userId: UserId): string {
    return `${tenantId as unknown as string}:${userId as unknown as string}`;
  }

  const binding: IdentityDirectoryBinding = {
    async getUser({ tenantId, userId }) {
      return users.get(key(tenantId, userId)) ?? null;
    },
    async listUsers({ tenantId, limit, query }) {
      const forTenant = [...users.values()]
        .filter((u) => (u.tenantId as unknown as string) === (tenantId as unknown as string))
        .filter((u) =>
          query === undefined || query.length === 0
            ? true
            : (u.displayName ?? '').startsWith(query),
        )
        .sort((a, b) =>
          (a.userId as unknown as string).localeCompare(b.userId as unknown as string),
        );
      return { data: forTenant.slice(0, limit) };
    },
    async listSessions({ tenantId, userId }) {
      const rows = sessionsByUser.get(key(tenantId, userId)) ?? [];
      return {
        data: rows
          .filter((s) => s.revokedAt === undefined)
          .map((s) => ({
            sessionId: s.id as unknown as string,
            userId: s.userId,
            providerId: s.providerId,
            createdAt: s.createdAt,
            expiresAt: s.expiresAt,
            scopes: s.scopes,
            ...(s.revokedAt !== undefined && { revokedAt: s.revokedAt }),
          })),
      };
    },
    async revokeAllSessions({ tenantId, userId }) {
      const rows = sessionsByUser.get(key(tenantId, userId)) ?? [];
      let revoked = 0;
      const nowIso = new Date().toISOString() as unknown as Timestamp;
      for (const row of rows) {
        if (row.revokedAt === undefined) {
          (row as { revokedAt?: Timestamp }).revokedAt = nowIso;
          revoked += 1;
        }
      }
      return { userId, revokedCount: revoked };
    },
  };

  return {
    binding,
    setUser(u) {
      users.set(key(u.tenantId, u.userId), u);
    },
    setSessions(t, u, s) {
      sessionsByUser.set(key(t, u), [...s] as Session[]);
    },
  };
}

function makeInMemorySessionStore(): {
  readonly binding: SessionStoreBinding;
  readonly setSession: (session: Session) => void;
} {
  const sessions = new Map<string, Session>(); // key: `${tenantId}:${sessionId}` OR just sessionId for MULTI_TENANT_LOOKUP

  const binding: SessionStoreBinding = {
    async create({ tenantId, userId, providerId, expiresAt, scopes }) {
      const id = `ses-${sessions.size}` as SessionId;
      const created = new Date().toISOString() as unknown as Timestamp;
      const session: Session = {
        id,
        tenantId,
        userId,
        providerId,
        expiresAt,
        scopes,
        createdAt: created,
      };
      sessions.set(`${tenantId as unknown as string}:${id as unknown as string}`, session);
      return { sessionId: id, expiresAt };
    },
    async get({ tenantId, sessionId }) {
      if ((tenantId as unknown as string) === (MULTI_TENANT_LOOKUP as unknown as string)) {
        for (const s of sessions.values()) {
          if ((s.id as unknown as string) === (sessionId as unknown as string)) return s;
        }
        return null;
      }
      return (
        sessions.get(`${tenantId as unknown as string}:${sessionId as unknown as string}`) ?? null
      );
    },
    async list() {
      return { data: [...sessions.values()] };
    },
    async revoke({ tenantId, sessionId }) {
      const s = sessions.get(`${tenantId as unknown as string}:${sessionId as unknown as string}`);
      if (s === undefined) return { revoked: false };
      if (s.revokedAt !== undefined) return { revoked: false };
      (s as { revokedAt?: Timestamp }).revokedAt = new Date().toISOString() as unknown as Timestamp;
      return { revoked: true };
    },
    async revokeAllForUser() {
      return { revokedCount: 0 };
    },
  };

  return {
    binding,
    setSession(s) {
      sessions.set(`${s.tenantId as unknown as string}:${s.id as unknown as string}`, s);
    },
  };
}

function baseUser(
  overrides: Partial<UserRecord> & Pick<UserRecord, 'userId' | 'tenantId'>,
): UserRecord {
  return {
    userId: overrides.userId,
    tenantId: overrides.tenantId,
    primaryEmail: overrides.primaryEmail ?? `${overrides.userId as unknown as string}@example.com`,
    displayName: overrides.displayName ?? `User ${overrides.userId as unknown as string}`,
    createdAt: (overrides.createdAt ?? '2026-01-01T00:00:00.000Z') as Timestamp,
    ...(overrides.lastActiveAt !== undefined && { lastActiveAt: overrides.lastActiveAt }),
    ...(overrides.metadata !== undefined && { metadata: overrides.metadata }),
  };
}

const bearerResolver: TokenResolver = async (token) => {
  if (token === BEARER_TOKEN) return { tenantId: tenantA };
  if (token === ADMIN_TOKEN) return { tenantId: tenantA, scopes: ['tenant-admin'] };
  if (token === MEMBER_TOKEN) return { tenantId: tenantA, userId: 'u-a' as UserId };
  return null;
};

function makeApp(
  options: { readonly mountDirectory?: boolean; readonly withSessionStore?: boolean } = {},
) {
  const mount = options.mountDirectory !== false;
  const directory = mount ? makeInMemoryDirectory() : null;
  const sessionStoreHarness = options.withSessionStore === true ? makeInMemorySessionStore() : null;

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: bearerResolver,
    runHandler: noopRunHandler,
    ...(directory !== null && { identityDirectory: directory.binding }),
    ...(sessionStoreHarness !== null && { sessionStore: sessionStoreHarness.binding }),
  });
  return { app, directory, sessionStoreHarness };
}

async function jsonGet(app: ReturnType<typeof makeApp>['app'], path: string, token = BEARER_TOKEN) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

async function jsonPost(
  app: ReturnType<typeof makeApp>['app'],
  path: string,
  token = BEARER_TOKEN,
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
}

describe('API — identity list users', () => {
  test('empty directory → empty list', async () => {
    const { app } = makeApp();
    const res = await jsonGet(app, '/v1/identity/users', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: readonly unknown[]; hasMore: boolean };
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  test('happy path returns seeded users for this tenant only', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    directory?.setUser(baseUser({ userId: 'u-b' as UserId, tenantId: tenantA }));
    // Cross-tenant row must not leak.
    directory?.setUser(baseUser({ userId: 'u-c' as UserId, tenantId: tenantB }));
    const res = await jsonGet(app, '/v1/identity/users', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string }[]; hasMore: boolean };
    expect(body.data.map((u) => u.userId).sort()).toEqual(['u-a', 'u-b']);
  });

  test('query filter matches displayName prefix', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(
      baseUser({ userId: 'u-a' as UserId, tenantId: tenantA, displayName: 'Alice Alpha' }),
    );
    directory?.setUser(
      baseUser({ userId: 'u-b' as UserId, tenantId: tenantA, displayName: 'Bob Beta' }),
    );
    const res = await jsonGet(app, '/v1/identity/users?query=Alice', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userId: string }[] };
    expect(body.data.map((u) => u.userId)).toEqual(['u-a']);
  });

  test('anyone but a tenant admin: 403, the directory not asked', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    directory?.setUser(baseUser({ userId: 'u-b' as UserId, tenantId: tenantA }));
    for (const token of [BEARER_TOKEN, MEMBER_TOKEN]) {
      const res = await jsonGet(app, '/v1/identity/users', token);
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('permission-denied');
      expect(text).not.toContain('u-b@example.com');
    }
  });
});

describe('API — identity get user', () => {
  test('happy path returns the user record', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    const res = await jsonGet(app, '/v1/identity/users/u-a', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; primaryEmail: string };
    expect(body.userId).toBe('u-a');
    expect(body.primaryEmail).toBe('u-a@example.com');
  });

  test('unknown user id → 404 identity-user-not-found', async () => {
    const { app } = makeApp();
    const res = await jsonGet(app, '/v1/identity/users/nope', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('identity-user-not-found');
  });

  test('cross-tenant lookup returns 404 (tenant isolation)', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-c' as UserId, tenantId: tenantB }));
    const res = await jsonGet(app, '/v1/identity/users/u-c', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });

  test("a member reads their own record; someone else's is 403", async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    directory?.setUser(baseUser({ userId: 'u-b' as UserId, tenantId: tenantA }));
    const own = await jsonGet(app, '/v1/identity/users/u-a', MEMBER_TOKEN);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { userId: string }).userId).toBe('u-a');
    const other = await jsonGet(app, '/v1/identity/users/u-b', MEMBER_TOKEN);
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain('u-b@example.com');
  });
});

describe('API — identity list sessions', () => {
  test('happy path returns the active sessions (excluding revoked)', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    directory?.setSessions(tenantA, 'u-a' as UserId, [
      {
        id: 's-1' as SessionId,
        tenantId: tenantA,
        userId: 'u-a' as UserId,
        providerId: 'google',
        expiresAt: '2027-01-01T00:00:00.000Z' as Timestamp,
        scopes: ['openid'],
        createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
      },
      {
        id: 's-2' as SessionId,
        tenantId: tenantA,
        userId: 'u-a' as UserId,
        providerId: 'google',
        expiresAt: '2027-01-01T00:00:00.000Z' as Timestamp,
        scopes: ['openid'],
        createdAt: '2026-01-02T00:00:00.000Z' as Timestamp,
        revokedAt: '2026-01-03T00:00:00.000Z' as Timestamp,
      },
    ]);
    const res = await jsonGet(app, '/v1/identity/users/u-a/sessions', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { sessionId: string; providerId: string }[] };
    expect(body.data.map((s) => s.sessionId)).toEqual(['s-1']);
    expect(body.data[0]?.providerId).toBe('google');
  });

  test('unknown user id returns an empty list (no 404)', async () => {
    const { app } = makeApp();
    const res = await jsonGet(app, '/v1/identity/users/never-seen/sessions', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: readonly unknown[] };
    expect(body.data).toEqual([]);
  });

  test("a member reads their own sessions; someone else's are 403", async () => {
    const { app } = makeApp();
    expect((await jsonGet(app, '/v1/identity/users/u-a/sessions', MEMBER_TOKEN)).status).toBe(200);
    const other = await jsonGet(app, '/v1/identity/users/u-b/sessions', MEMBER_TOKEN);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
      'permission-denied',
    );
  });
});

describe('API — identity revoke sessions', () => {
  test('happy path returns the revoked count', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    directory?.setSessions(tenantA, 'u-a' as UserId, [
      {
        id: 's-1' as SessionId,
        tenantId: tenantA,
        userId: 'u-a' as UserId,
        providerId: 'google',
        expiresAt: '2027-01-01T00:00:00.000Z' as Timestamp,
        scopes: [],
        createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
      },
      {
        id: 's-2' as SessionId,
        tenantId: tenantA,
        userId: 'u-a' as UserId,
        providerId: 'google',
        expiresAt: '2027-01-01T00:00:00.000Z' as Timestamp,
        scopes: [],
        createdAt: '2026-01-02T00:00:00.000Z' as Timestamp,
      },
    ]);
    const res = await jsonPost(app, '/v1/identity/users/u-a/revoke-sessions', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; revokedCount: number };
    expect(body).toEqual({ userId: 'u-a', revokedCount: 2 });
  });

  test('idempotent — a second revoke returns 0 (already fully signed out)', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    directory?.setSessions(tenantA, 'u-a' as UserId, [
      {
        id: 's-1' as SessionId,
        tenantId: tenantA,
        userId: 'u-a' as UserId,
        providerId: 'google',
        expiresAt: '2027-01-01T00:00:00.000Z' as Timestamp,
        scopes: [],
        createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
      },
    ]);
    const first = await jsonPost(app, '/v1/identity/users/u-a/revoke-sessions', ADMIN_TOKEN);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { revokedCount: number };
    expect(firstBody.revokedCount).toBe(1);

    const second = await jsonPost(app, '/v1/identity/users/u-a/revoke-sessions', ADMIN_TOKEN);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { revokedCount: number };
    expect(secondBody.revokedCount).toBe(0);
  });

  test('the directory hears who asked, for its audit trail', async () => {
    const { app, directory } = makeApp();
    directory?.setUser(baseUser({ userId: 'u-a' as UserId, tenantId: tenantA }));
    const asked: unknown[] = [];
    if (directory === null) throw new Error('no directory');
    const revokeAll = directory.binding.revokeAllSessions.bind(directory.binding);
    (directory.binding as { revokeAllSessions: typeof revokeAll }).revokeAllSessions = async (
      input,
    ) => {
      asked.push(input);
      return revokeAll(input);
    };
    // Your own sessions: a member may.
    const res = await jsonPost(app, '/v1/identity/users/u-a/revoke-sessions', MEMBER_TOKEN);
    expect(res.status).toBe(200);
    expect(asked).toEqual([{ tenantId: tenantA, userId: 'u-a', revokedBy: 'user:u-a' }]);
  });
});

describe('API — identity whoami', () => {
  test('bearer-token caller gets minimal shape (tenant + empty scopes)', async () => {
    const { app } = makeApp();
    const res = await jsonGet(app, '/v1/identity/whoami');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      scopes: string[];
      sessionId?: string;
      user?: unknown;
    };
    expect(body.tenantId).toBe(tenantA as unknown as string);
    expect(body.scopes).toEqual([]);
    expect(body.sessionId).toBeUndefined();
    expect(body.user).toBeUndefined();
  });

  test('session-token caller gets fuller UserRecord shape + expiresAt', async () => {
    const { app, directory, sessionStoreHarness } = makeApp({ withSessionStore: true });
    directory?.setUser(baseUser({ userId: SESSION_USER, tenantId: tenantA }));
    sessionStoreHarness?.setSession({
      id: SESSION_ID,
      tenantId: tenantA,
      userId: SESSION_USER,
      providerId: 'google',
      expiresAt: '2027-06-01T00:00:00.000Z' as Timestamp,
      scopes: ['openid', 'email'],
      createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
    });
    const sessionToken = `${SESSION_TOKEN_PREFIX}${SESSION_ID as unknown as string}`;
    const res = await app.request('/v1/identity/whoami', {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      userId?: string;
      sessionId?: string;
      providerId?: string;
      scopes: string[];
      expiresAt?: string;
      user?: { userId: string; displayName?: string };
    };
    expect(body.userId).toBe(SESSION_USER as unknown as string);
    expect(body.sessionId).toBe(SESSION_ID as unknown as string);
    expect(body.providerId).toBe('google');
    expect(body.scopes).toEqual(['openid', 'email']);
    expect(body.expiresAt).toBe('2027-06-01T00:00:00.000Z');
    expect(body.user?.userId).toBe(SESSION_USER as unknown as string);
  });
});

describe('API — identity get user returns lastActiveAt + metadata', () => {
  test('optional fields survive the wire round-trip', async () => {
    const { app, directory } = makeApp();
    directory?.setUser({
      userId: 'u-full' as UserId,
      tenantId: tenantA,
      primaryEmail: 'full@example.com',
      displayName: 'Full Record',
      createdAt: '2026-01-01T00:00:00.000Z' as Timestamp,
      lastActiveAt: '2026-09-15T10:00:00.000Z' as Timestamp,
      metadata: { provisioningSource: 'scim', role: 'reviewer' },
    });
    const res = await jsonGet(app, '/v1/identity/users/u-full', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lastActiveAt?: string;
      metadata?: { provisioningSource?: string };
    };
    expect(body.lastActiveAt).toBe('2026-09-15T10:00:00.000Z');
    expect(body.metadata?.provisioningSource).toBe('scim');
  });
});

describe('API — identity revoke error surface', () => {
  test('binding throw → 500 identity-revoke-failed with the message', async () => {
    const brokenDirectory: IdentityDirectoryBinding = {
      async getUser() {
        return null;
      },
      async listUsers() {
        return { data: [] };
      },
      async listSessions() {
        return { data: [] };
      },
      async revokeAllSessions() {
        throw new Error('downstream session store unavailable');
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: bearerResolver,
      runHandler: noopRunHandler,
      identityDirectory: brokenDirectory,
    });
    const res = await app.request('/v1/identity/users/u-broken/revoke-sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('identity-revoke-failed');
    expect(body.error.message).toBe('downstream session store unavailable');
  });
});

describe('API — identity routes with no directory binding', () => {
  test('GET /v1/identity/users → 404 when identityDirectory unwired', async () => {
    const { app } = makeApp({ mountDirectory: false });
    const res = await jsonGet(app, '/v1/identity/users');
    expect(res.status).toBe(404);
  });

  test('GET /v1/identity/whoami → 200 (minimal shape) even without directory binding', async () => {
    // Whoami is unconditional — the canonical caller-identity surface.
    // Without a directory binding it returns tenantId + scopes only; no
    // `user` enrichment.
    const { app } = makeApp({ mountDirectory: false });
    const res = await jsonGet(app, '/v1/identity/whoami');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; user?: unknown };
    expect(typeof body.tenantId).toBe('string');
    expect(body.user).toBeUndefined();
  });
});

describe('API — removing a person (POST /users/:userId/unregister)', () => {
  function makeUnregisterApp(
    outcome: (
      userId: string,
    ) => Awaited<ReturnType<NonNullable<IdentityDirectoryBinding['unregisterUser']>>>,
  ) {
    const directory = makeInMemoryDirectory();
    const calls: { userId: string; includeUnregistered?: boolean }[] = [];
    const listCalls: (boolean | undefined)[] = [];
    const binding: IdentityDirectoryBinding = {
      ...directory.binding,
      async listUsers(input) {
        listCalls.push(input.includeUnregistered);
        return directory.binding.listUsers(input);
      },
      async unregisterUser({ userId }) {
        calls.push({ userId: userId as unknown as string });
        return outcome(userId as unknown as string);
      },
    };
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: bearerResolver,
      runHandler: noopRunHandler,
      identityDirectory: binding,
    });
    return { app, calls, listCalls };
  }
  const removed = (userId: string) => ({
    kind: 'unregistered' as const,
    user: {
      ...baseUser({ userId: userId as UserId, tenantId: tenantA }),
      unregisteredAt: '2026-10-07T12:00:00.000Z' as Timestamp,
    },
    keysRevoked: 2,
    sessionsRevoked: 1,
    grantsRemoved: 3,
  });

  test('a tenant admin removes a person: the record with unregisteredAt, and what went', async () => {
    const { app, calls } = makeUnregisterApp(removed);
    const res = await jsonPost(app, '/v1/identity/users/u-a/unregister', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { userId: 'u-a', unregisteredAt: '2026-10-07T12:00:00.000Z' },
      keysRevoked: 2,
      sessionsRevoked: 1,
      grantsRemoved: 3,
    });
    expect(calls).toEqual([{ userId: 'u-a' }]);
  });

  test('anyone else is refused before the directory is asked', async () => {
    const { app, calls } = makeUnregisterApp(removed);
    const res = await jsonPost(app, '/v1/identity/users/u-a/unregister', BEARER_TOKEN);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'permission-denied',
    );
    expect(calls).toEqual([]);
  });

  test('an unknown person is 404', async () => {
    const { app } = makeUnregisterApp(() => ({ kind: 'not-found' }));
    const res = await jsonPost(app, '/v1/identity/users/u-x/unregister', ADMIN_TOKEN);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'identity-user-not-found',
    );
  });

  test('yourself or the seed user: 409 with the reason; the only tenant admin: last-tenant-admin', async () => {
    for (const reason of ['yourself', 'seed-user'] as const) {
      const { app } = makeUnregisterApp(() => ({
        kind: 'refused',
        reason,
        message: `no: ${reason}`,
      }));
      const res = await jsonPost(app, '/v1/identity/users/u-a/unregister', ADMIN_TOKEN);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe('identity-user-unregister-refused');
      expect(JSON.stringify(body.error)).toContain(reason);
    }
    const { app } = makeUnregisterApp(() => ({
      kind: 'refused',
      reason: 'last-tenant-admin',
      message: 'the only tenant admin',
    }));
    const res = await jsonPost(app, '/v1/identity/users/u-a/unregister', ADMIN_TOKEN);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'last-tenant-admin',
    );
  });

  test('the list leaves removed people out unless includeUnregistered=true', async () => {
    const { app, listCalls } = makeUnregisterApp(removed);
    await jsonGet(app, '/v1/identity/users', ADMIN_TOKEN);
    await jsonGet(app, '/v1/identity/users?includeUnregistered=true', ADMIN_TOKEN);
    expect(listCalls).toEqual([undefined, true]);
  });

  test('without unregisterUser on the directory, the route is not mounted', async () => {
    const { app } = makeApp();
    const res = await jsonPost(app, '/v1/identity/users/u-a/unregister', ADMIN_TOKEN);
    expect(res.status).toBe(404);
  });
});
