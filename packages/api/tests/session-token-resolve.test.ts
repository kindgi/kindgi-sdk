// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { MULTI_TENANT_LOOKUP, SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  RunHandlerBinding,
  Session,
  SessionCreateInput,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * A session store that owns its tokens (`resolveToken`): the middleware
 * hands it every `kgi_sk_` token and never looks a session up across
 * tenants; the routes hand out the token the store minted. An older store
 * (no `resolveToken`) keeps the `kgi_sk_<sessionId>` path.
 */

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const BEARER = 'session-resolve-bearer';
const FAR = '2099-01-01T00:00:00.000Z' as Timestamp;

const noopRunHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
} as unknown as RunHandlerBinding;

const bearerResolver: TokenResolver = async (token) =>
  token === BEARER ? { tenantId: tenantA, scopes: [] } : null;

const noProviders: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();

interface Calls {
  get: Array<{ tenantId: string; sessionId: string }>;
  touch: Array<{ tenantId: string; sessionId: string }>;
}

/** Mints `kgi_sk_<tenant>.<id>.<secret>`; keeps only the hash. */
function makeTokenOwningStore() {
  const rows = new Map<string, { session: Session; hash: Buffer }>();
  const calls: Calls = { get: [], touch: [] };
  const store: SessionStoreBinding = {
    async create(input: SessionCreateInput) {
      const id = randomUUID() as unknown as SessionId;
      const token = `${SESSION_TOKEN_PREFIX}${input.tenantId}.${id}.${randomBytes(32).toString('base64url')}`;
      const session: Session = {
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        providerId: input.providerId,
        ...(input.accessToken !== undefined && { accessToken: input.accessToken }),
        expiresAt: input.expiresAt,
        scopes: input.scopes,
        createdAt: new Date().toISOString() as Timestamp,
      };
      rows.set(`${input.tenantId}:${id}`, { session, hash: sha256(token) });
      return { sessionId: id, expiresAt: input.expiresAt, token };
    },
    async resolveToken({ token }) {
      const [tenant, id] = token.slice(SESSION_TOKEN_PREFIX.length).split('.');
      const row = rows.get(`${tenant}:${id}`);
      if (row === undefined) return null;
      const presented = sha256(token);
      return timingSafeEqual(presented, row.hash) ? row.session : null;
    },
    async get({ tenantId, sessionId }) {
      calls.get.push({ tenantId: tenantId as string, sessionId: sessionId as string });
      return rows.get(`${tenantId}:${sessionId}`)?.session ?? null;
    },
    async list() {
      return { data: [...rows.values()].map((r) => r.session) };
    },
    async revoke({ tenantId, sessionId, reason }) {
      const row = rows.get(`${tenantId}:${sessionId}`);
      if (row === undefined || row.session.revokedAt !== undefined) return { revoked: false };
      const now = new Date().toISOString() as Timestamp;
      row.session = {
        ...row.session,
        revokedAt: now,
        ...(reason === 'rotate' && { rotatedAt: now }),
      };
      return { revoked: true };
    },
    async revokeAllForUser() {
      return { revokedCount: 0 };
    },
    async touch({ tenantId, sessionId }) {
      calls.touch.push({ tenantId: tenantId as string, sessionId: sessionId as string });
      return { touched: true };
    },
  };
  const patch = (tenantId: TenantId, sessionId: SessionId, fields: Partial<Session>) => {
    const row = rows.get(`${tenantId}:${sessionId}`);
    if (row !== undefined) row.session = { ...row.session, ...fields };
  };
  return { store, calls, patch };
}

function makeApp(store: SessionStoreBinding) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken: bearerResolver,
    runHandler: noopRunHandler,
    sessionStore: store,
    identityProvider: noProviders,
    exchangeCode: async () => {
      throw new Error('not used');
    },
  });
}

async function mint(store: SessionStoreBinding, tenantId: TenantId = tenantA) {
  const created = await store.create({
    tenantId,
    userId: 'user-alice' as never,
    providerId: 'acme-sso',
    accessToken: 'unused',
    expiresAt: FAR,
    scopes: [],
  });
  if (created.token === undefined) throw new Error('store minted no token');
  return { ...created, token: created.token };
}

const codeOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

const whoami = (app: ReturnType<typeof makeApp>, token: string) =>
  app.request('/v1/identity/whoami', { headers: { authorization: `Bearer ${token}` } });

describe('session store with resolveToken', () => {
  test("the store's token authenticates; no cross-tenant lookup", async () => {
    const { store, calls } = makeTokenOwningStore();
    const app = makeApp(store);
    const { token, sessionId } = await mint(store);
    const res = await whoami(app, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string; sessionId?: string; userId?: string };
    expect(body.tenantId).toBe(tenantA);
    expect(body.sessionId).toBe(sessionId);
    expect(body.userId).toBe('user-alice');
    expect(calls.get.some((c) => c.tenantId === (MULTI_TENANT_LOOKUP as string))).toBe(false);
  });

  test('touch runs with the session’s own tenant', async () => {
    const { store, calls } = makeTokenOwningStore();
    const app = makeApp(store);
    const { token, sessionId } = await mint(store, tenantB);
    expect((await whoami(app, token)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.touch).toEqual([{ tenantId: tenantB, sessionId }]);
  });

  test('the older kgi_sk_<sessionId> shape is refused, without a cross-tenant read', async () => {
    const { store, calls } = makeTokenOwningStore();
    const app = makeApp(store);
    const { sessionId } = await mint(store);
    const res = await whoami(app, `${SESSION_TOKEN_PREFIX}${sessionId}`);
    expect(res.status).toBe(401);
    expect(calls.get).toEqual([]);
  });

  test('a tampered secret is refused', async () => {
    const { store } = makeTokenOwningStore();
    const app = makeApp(store);
    const { token } = await mint(store);
    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await whoami(app, tampered)).status).toBe(401);
  });

  test('revoked, rotated and expired sessions keep their distinct codes', async () => {
    const { store, patch } = makeTokenOwningStore();
    const app = makeApp(store);
    const now = new Date().toISOString() as Timestamp;

    const revoked = await mint(store);
    patch(tenantA, revoked.sessionId, { revokedAt: now });
    const r1 = await whoami(app, revoked.token);
    expect(r1.status).toBe(401);
    expect(await codeOf(r1)).toBe('auth-revoked');

    const rotated = await mint(store);
    patch(tenantA, rotated.sessionId, { revokedAt: now, rotatedAt: now });
    const r2 = await whoami(app, rotated.token);
    expect(await codeOf(r2)).toBe('refresh-token-invalid');

    const expired = await mint(store);
    patch(tenantA, expired.sessionId, { expiresAt: '2001-01-01T00:00:00.000Z' as Timestamp });
    const r3 = await whoami(app, expired.token);
    expect(await codeOf(r3)).toBe('session-expired');
  });

  test('refresh hands out the token the store minted, and the old one is rotated', async () => {
    const { store } = makeTokenOwningStore();
    const app = makeApp(store);
    const { token } = await mint(store);
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; sessionId: string };
    expect(body.sessionToken).not.toBe(`${SESSION_TOKEN_PREFIX}${body.sessionId}`);
    expect((await whoami(app, body.sessionToken)).status).toBe(200);
    const old = await whoami(app, token);
    expect(await codeOf(old)).toBe('refresh-token-invalid');
  });
});

describe('session store without resolveToken (older stores)', () => {
  test('kgi_sk_<sessionId> still resolves through get with MULTI_TENANT_LOOKUP', async () => {
    const sessions = new Map<string, Session>();
    const seen: string[] = [];
    const store: SessionStoreBinding = {
      async create(input) {
        const id = randomUUID() as unknown as SessionId;
        sessions.set(id, {
          id,
          tenantId: input.tenantId,
          userId: input.userId,
          providerId: input.providerId,
          ...(input.accessToken !== undefined && { accessToken: input.accessToken }),
          expiresAt: input.expiresAt,
          scopes: input.scopes,
          createdAt: new Date().toISOString() as Timestamp,
        });
        return { sessionId: id, expiresAt: input.expiresAt };
      },
      async get({ tenantId, sessionId }) {
        seen.push(tenantId as string);
        return sessions.get(sessionId) ?? null;
      },
      async list() {
        return { data: [] };
      },
      async revoke() {
        return { revoked: false };
      },
      async revokeAllForUser() {
        return { revokedCount: 0 };
      },
    };
    const app = makeApp(store);
    const created = await store.create({
      tenantId: tenantA,
      userId: 'user-bob' as never,
      providerId: 'acme-sso',
      accessToken: 'unused',
      expiresAt: FAR,
      scopes: [],
    });
    expect(created.token).toBeUndefined();
    const res = await whoami(app, `${SESSION_TOKEN_PREFIX}${created.sessionId}`);
    expect(res.status).toBe(200);
    expect(seen[0]).toBe(MULTI_TENANT_LOOKUP as string);
  });
});
