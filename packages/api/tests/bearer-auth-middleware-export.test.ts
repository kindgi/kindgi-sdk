// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `bearerAuthMiddleware`, from the package's index: the function
 * `createApp` mounts on `/v1/*`, so a deployment's own route that mounts
 * it with the same options admits a caller exactly as `/v1` does.
 */

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { bearerAuthMiddleware as mountedOnV1 } from '../src/middleware/auth.js';
import { createStubAppBindings } from '../src/testing/index.js';

import { SESSION_TOKEN_PREFIX, bearerAuthMiddleware, createApp } from '../src/index.js';
import type {
  BearerAuthMiddlewareOptions,
  RunHandlerBinding,
  Session,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

const tenantA = '00000000-0000-4000-8000-00000000000a' as TenantId;
const ALICE = 'user-alice' as UserId;
const FAR = '2099-01-01T00:00:00.000Z' as Timestamp;
const PAST = '2020-01-01T00:00:00.000Z' as Timestamp;
/** An API key acting for Alice. */
const ALICE_KEY = 'kgi_ak_alice';
const INACTIVITY_MS = 60 * 60 * 1000;

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'unused' } }),
} as unknown as RunHandlerBinding;

/** Alice's sessions by token: `kgi_sk_<name>`. */
const sessions: Record<string, Partial<Session>> = {
  alice: {},
  'alice-expired': { expiresAt: PAST },
  'alice-revoked': { revokedAt: PAST },
  'alice-idle': { lastActiveAt: PAST },
};

const sessionStore: SessionStoreBinding = {
  create: async () => {
    throw new Error('unused');
  },
  resolveToken: async ({ token }) => {
    const name = token.slice(SESSION_TOKEN_PREFIX.length);
    const session = sessions[name];
    if (session === undefined) return null;
    return {
      id: `session-${name}` as unknown as SessionId,
      tenantId: tenantA,
      userId: ALICE,
      providerId: 'acme-sso',
      expiresAt: FAR,
      scopes: [],
      createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
      ...session,
    };
  },
  get: async () => null,
  list: async () => ({ data: [] }),
  revoke: async () => ({ revoked: false }),
  revokeAllForUser: async () => ({ revokedCount: 0 }),
};

const resolveToken: TokenResolver = async (token) =>
  token === ALICE_KEY ? { tenantId: tenantA, userId: ALICE, scopes: [], capabilities: [] } : null;

describe('bearerAuthMiddleware from the index', () => {
  test("is /v1's, and on a deployment's own route admits and refuses as /v1 does", async () => {
    expect(bearerAuthMiddleware).toBe(mountedOnV1);

    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      sessionStore,
      session: { inactivityTimeout: INACTIVITY_MS },
    });
    const options: BearerAuthMiddlewareOptions = {
      sessionStore,
      inactivityTimeoutMs: INACTIVITY_MS,
    };
    app.use('/own/*', bearerAuthMiddleware(resolveToken, options));
    app.get('/own/page', (c) =>
      c.json({ userId: c.get('userId'), sessionId: c.get('sessionId') ?? null }),
    );
    const call = async (path: string, token: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    expect(await call('/own/page', `${SESSION_TOKEN_PREFIX}alice`)).toEqual({
      status: 200,
      body: { userId: ALICE, sessionId: 'session-alice' },
    });
    // An API key is admitted too, with no session: a route that admits
    // only a session checks `sessionId`.
    expect(await call('/own/page', ALICE_KEY)).toEqual({
      status: 200,
      body: { userId: ALICE, sessionId: null },
    });
    for (const [name, code] of [
      ['alice-expired', 'session-expired'],
      ['alice-revoked', 'auth-revoked'],
      ['alice-idle', 'session-inactive'],
      ['nobody', 'auth-missing'],
    ] as const) {
      const own = await call('/own/page', `${SESSION_TOKEN_PREFIX}${name}`);
      const v1 = await call('/v1/agents', `${SESSION_TOKEN_PREFIX}${name}`);
      expect(own.status, name).toBe(401);
      expect(own.body, name).toMatchObject({ error: { code } });
      expect(v1.status, name).toBe(own.status);
      expect((v1.body as { error: unknown }).error, name).toMatchObject({ code });
    }
  });
});
