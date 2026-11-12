// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `bearerAuthMiddleware`, from the package's index: the function
 * `createApp` mounts on `/v1/*`, so a deployment's own route that mounts
 * it with the same options admits a caller exactly as `/v1` does.
 */

import type { Context } from 'hono';
import { describe, expect, test } from 'vitest';

import type { ApiTokenId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { bearerAuthMiddleware as mountedOnV1 } from '../src/middleware/auth.js';
import { createStubAppBindings } from '../src/testing/index.js';

import {
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_PREFIX,
  bearerAuthMiddleware,
  createApp,
  tokenSignInKey,
} from '../src/index.js';
import type {
  AppEnv,
  BearerAuthMiddlewareOptions,
  RunHandlerBinding,
  Session,
  SessionCookieOptions,
  SessionStoreBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';

const tenantA = '00000000-0000-4000-8000-00000000000a' as TenantId;
const ALICE = 'user-alice' as UserId;
const FAR = '2099-01-01T00:00:00.000Z' as Timestamp;
const PAST = '2020-01-01T00:00:00.000Z' as Timestamp;
/** An API key acting for Alice. */
const ALICE_KEY = 'kgi_ak_alice';
const INACTIVITY_MS = 60 * 60 * 1000;
const cookie: SessionCookieOptions = { allowedOrigins: ['https://console.example'] };

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
  // Opened by token sign-in with Alice's key `key-1`, which is live.
  'alice-key': { providerId: 'api-token:key-1' },
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

/** Alice's key `key-1`, live. */
const apiKeys: Pick<TokenAdmin, 'get'> = {
  get: async ({ tokenId }) =>
    tokenId === ('key-1' as ApiTokenId)
      ? { tokenId, role: 'member', capabilities: [], createdAt: new Date(PAST) }
      : undefined,
};

describe('bearerAuthMiddleware from the index', () => {
  test("is /v1's, and on a deployment's own route admits and refuses as /v1 does", async () => {
    expect(bearerAuthMiddleware).toBe(mountedOnV1);

    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      sessionStore,
      tokenAdmin: apiKeys as TokenAdmin,
      session: { inactivityTimeout: INACTIVITY_MS, cookie },
    });
    const options: BearerAuthMiddlewareOptions = {
      sessionStore,
      apiKeys,
      inactivityTimeoutMs: INACTIVITY_MS,
      sessionCookie: cookie,
    };
    app.use('/own/*', bearerAuthMiddleware(resolveToken, options));
    const page = (c: Context<AppEnv>) =>
      c.json({
        userId: c.get('userId'),
        sessionId: c.get('sessionId') ?? null,
        providerId: c.get('providerId') ?? null,
      });
    app.get('/own/page', page);
    app.post('/own/page', page);
    const call = async (path: string, token: string) => {
      const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    expect(await call('/own/page', `${SESSION_TOKEN_PREFIX}alice`)).toEqual({
      status: 200,
      body: { userId: ALICE, sessionId: 'session-alice', providerId: 'acme-sso' },
    });
    // An API key is admitted too, with no session: a route that admits
    // only a session checks `sessionId`.
    expect(await call('/own/page', ALICE_KEY)).toEqual({
      status: 200,
      body: { userId: ALICE, sessionId: null, providerId: null },
    });
    // A session token sign-in opened with a live key is admitted with its
    // session id: a route that admits only a session a person signed in
    // to refuses it by its key.
    const keySession = await call('/own/page', `${SESSION_TOKEN_PREFIX}alice-key`);
    expect(keySession).toEqual({
      status: 200,
      body: { userId: ALICE, sessionId: 'session-alice-key', providerId: 'api-token:key-1' },
    });
    expect(tokenSignInKey(keySession.body.providerId as string)).toBe('key-1');
    expect(tokenSignInKey('acme-sso')).toBeUndefined();
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
    // The cookie's origin rule: a POST signed in by the cookie with no
    // `Origin` is refused, on the deployment's route as on `/v1`.
    for (const path of ['/own/page', '/v1/agents']) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN_PREFIX}alice` },
      });
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ error: { code: 'csrf-origin-mismatch' } });
    }
  });
});
