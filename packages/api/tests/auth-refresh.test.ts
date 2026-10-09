// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, encodeSessionToken } from '../src/index.js';
import type {
  IdentityProviderBinding,
  RunHandlerBinding,
  Session,
  SessionCreateInput,
  SessionStoreBinding,
} from '../src/index.js';

/**
 * `POST /v1/auth/refresh` rotates the session token and nothing else: a
 * new session for the same person, provider, scopes, expiry and metadata,
 * the old one marked rotated. It never calls the provider, and a session
 * holds no provider tokens: a store that still returns some (written by
 * an earlier release) doesn't get them back.
 */

const tenantId = randomUUID() as TenantId;
const EXPIRES = '2099-01-01T00:00:00.000Z' as Timestamp;

const noopRunHandler = {} as unknown as RunHandlerBinding;

const noProviders: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
};

function makeStore() {
  const rows = new Map<string, Session>();
  const created: SessionCreateInput[] = [];
  const revoked: Array<{ sessionId: string; reason: string | undefined }> = [];
  const store: SessionStoreBinding = {
    async create(input) {
      created.push(input);
      const id = randomUUID() as unknown as SessionId;
      rows.set(id, {
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        providerId: input.providerId,
        expiresAt: input.expiresAt,
        scopes: input.scopes,
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        createdAt: new Date().toISOString() as Timestamp,
      });
      return { sessionId: id, expiresAt: input.expiresAt };
    },
    async get({ sessionId }) {
      return rows.get(sessionId) ?? null;
    },
    async list() {
      return { data: [] };
    },
    async revoke({ sessionId, reason }) {
      revoked.push({ sessionId, reason });
      const row = rows.get(sessionId);
      if (row === undefined || row.revokedAt !== undefined) return { revoked: false };
      const now = new Date().toISOString() as Timestamp;
      rows.set(sessionId, {
        ...row,
        revokedAt: now,
        ...(reason === 'rotate' && { rotatedAt: now }),
      });
      return { revoked: true };
    },
    async revokeAllForUser() {
      return { revokedCount: 0 };
    },
  };
  return { store, created, revoked };
}

function makeApp(store: SessionStoreBinding) {
  return createApp({
    ...createStubAppBindings(),
    resolveToken: async () => null,
    runHandler: noopRunHandler,
    sessionStore: store,
    identityProvider: noProviders,
  });
}

async function refresh(app: ReturnType<typeof makeApp>, token: string) {
  return app.request('/v1/auth/refresh', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('POST /v1/auth/refresh', () => {
  test('a new session like the old one, and the old one rotated', async () => {
    const { store, created, revoked } = makeStore();
    const app = makeApp(store);
    const first = await store.create({
      tenantId,
      userId: 'user-alice' as never,
      providerId: 'acme-sso',
      expiresAt: EXPIRES,
      scopes: ['openid', 'email'],
      metadata: { team: 'ops' },
    });

    const res = await refresh(app, encodeSessionToken(first.sessionId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionToken: string;
      sessionId: string;
      expiresAt: string;
    };
    expect(body.sessionId).not.toBe(first.sessionId);
    expect(body.expiresAt).toBe(EXPIRES);
    expect(created).toHaveLength(2);
    expect(created[1]).toEqual({
      tenantId,
      userId: 'user-alice',
      providerId: 'acme-sso',
      expiresAt: EXPIRES,
      scopes: ['openid', 'email'],
      metadata: { team: 'ops' },
    });
    expect(revoked).toEqual([{ sessionId: first.sessionId, reason: 'rotate' }]);

    // The old token is rotated; the new one works.
    expect((await refresh(app, encodeSessionToken(first.sessionId))).status).toBe(401);
    expect((await refresh(app, body.sessionToken)).status).toBe(200);
  });

  test("provider tokens a store still returns aren't handed to the new session", async () => {
    const { store, created } = makeStore();
    const first = await store.create({
      tenantId,
      userId: 'user-bob' as never,
      providerId: 'acme-sso',
      expiresAt: EXPIRES,
      scopes: [],
    });
    // A store written by an earlier release returns its stored tokens.
    const get = store.get.bind(store);
    const app = makeApp({
      ...store,
      get: async (input) => {
        const row = await get(input);
        return row === null
          ? null
          : ({ ...row, accessToken: 'stored-access', refreshToken: 'stored-refresh' } as Session);
      },
    });

    expect((await refresh(app, encodeSessionToken(first.sessionId))).status).toBe(200);
    expect(created[1]).toEqual({
      tenantId,
      userId: 'user-bob',
      providerId: 'acme-sso',
      expiresAt: EXPIRES,
      scopes: [],
    });
  });
});
