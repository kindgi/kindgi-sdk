// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { SessionId, TenantId, Timestamp } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { SESSION_COOKIE_NAME, SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  RunHandlerBinding,
  Session,
  SessionConfig,
  SessionStoreBinding,
  TokenResolver,
} from '../src/index.js';

/**
 * Browser sessions in a cookie: the middleware takes a session token from
 * `SESSION_COOKIE_NAME` when there's no `Authorization` header, and a
 * cookie-authenticated unsafe request needs an allowed `Origin`
 * (403 `csrf-origin-mismatch`, a missing `Origin` included).
 */

const tenantId = randomUUID() as TenantId;
const BEARER = 'cookie-suite-bearer';
const CONSOLE = 'https://kindgi.example.com';
const FAR = '2099-01-01T00:00:00.000Z' as Timestamp;

const bearerResolver: TokenResolver = async (token) =>
  token === BEARER ? { tenantId, scopes: [] } : null;

const noProviders: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function makeStore() {
  const rows = new Map<string, { session: Session; hash: string }>();
  const store: SessionStoreBinding = {
    async create(input) {
      const id = randomUUID() as unknown as SessionId;
      const token = `${SESSION_TOKEN_PREFIX}${id}.${randomBytes(16).toString('hex')}`;
      rows.set(id, {
        session: {
          id,
          tenantId: input.tenantId,
          userId: input.userId,
          providerId: input.providerId,
          ...(input.accessToken !== undefined && { accessToken: input.accessToken }),
          expiresAt: input.expiresAt,
          scopes: input.scopes,
          createdAt: new Date().toISOString() as Timestamp,
        },
        hash: sha(token),
      });
      return { sessionId: id, expiresAt: input.expiresAt, token };
    },
    async resolveToken({ token }) {
      const id = token.slice(SESSION_TOKEN_PREFIX.length).split('.')[0] ?? '';
      const row = rows.get(id);
      return row !== undefined && row.hash === sha(token) ? row.session : null;
    },
    async get({ sessionId }) {
      return rows.get(sessionId)?.session ?? null;
    },
    async list() {
      return { data: [] };
    },
    async revoke({ sessionId }) {
      const row = rows.get(sessionId);
      if (row === undefined || row.session.revokedAt !== undefined) return { revoked: false };
      row.session = { ...row.session, revokedAt: new Date().toISOString() as Timestamp };
      return { revoked: true };
    },
    async revokeAllForUser() {
      return { revokedCount: 0 };
    },
  };
  return store;
}

function makeApp(
  session: SessionConfig | null = { cookie: { allowedOrigins: [CONSOLE] } },
  { withExchange = true }: { withExchange?: boolean } = {},
) {
  const store = makeStore();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: bearerResolver,
    runHandler: {} as RunHandlerBinding,
    sessionStore: store,
    identityProvider: noProviders,
    ...(withExchange && {
      exchangeCode: async () => {
        throw new Error('not used');
      },
    }),
    ...(session !== null && { session }),
  });
  return { app, store };
}

async function signedIn(store: SessionStoreBinding) {
  const created = await store.create({
    tenantId,
    userId: 'user-alice' as never,
    providerId: 'acme-sso',
    accessToken: 'unused',
    expiresAt: FAR,
    scopes: [],
  });
  return { sessionId: created.sessionId, cookie: `${SESSION_COOKIE_NAME}=${created.token}` };
}

const codeOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe('session cookie', () => {
  test('a GET signed in by the cookie alone is the session', async () => {
    const { app, store } = makeApp();
    const { sessionId, cookie } = await signedIn(store);
    const res = await app.request('/v1/identity/whoami', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessionId?: string }).sessionId).toBe(sessionId);
  });

  test('an unsafe request from the console origin passes', async () => {
    const { app, store } = makeApp();
    const { cookie } = await signedIn(store);
    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE },
    });
    expect(res.status).toBe(200);
  });

  test('an unsafe request from another origin is refused, and does nothing', async () => {
    const { app, store } = makeApp();
    const { sessionId, cookie } = await signedIn(store);
    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('csrf-origin-mismatch');
    expect((await store.get({ tenantId, sessionId }))?.revokedAt).toBeUndefined();
  });

  test('an unsafe request with no Origin at all is refused', async () => {
    const { app, store } = makeApp();
    const { cookie } = await signedIn(store);
    const res = await app.request('/v1/auth/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('csrf-origin-mismatch');
  });

  test('only a session token is taken from the cookie', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/identity/whoami', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${BEARER}` },
    });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('auth-missing');
  });

  test('the Authorization header wins, and a bearer request has no Origin rule', async () => {
    const { app, store } = makeApp();
    const { cookie } = await signedIn(store);
    const res = await app.request('/v1/identity/whoami', {
      method: 'GET',
      headers: { cookie, authorization: `Bearer ${BEARER}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sessionId?: string }).sessionId).toBeUndefined();
    const post = await app.request('/v1/auth/providers', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${BEARER}`,
        origin: 'https://elsewhere.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(post.status).not.toBe(403);
  });

  test('a revoked session in the cookie says auth-revoked', async () => {
    const { app, store } = makeApp();
    const { sessionId, cookie } = await signedIn(store);
    await store.revoke({ tenantId, sessionId });
    const res = await app.request('/v1/identity/whoami', { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('auth-revoked');
  });

  test('without cookie sessions turned on, the cookie is ignored', async () => {
    const { app, store } = makeApp(null);
    const { cookie } = await signedIn(store);
    const res = await app.request('/v1/identity/whoami', { headers: { cookie } });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe('auth-missing');
  });
});

describe('same origin: a deployment that does not know its public URL', () => {
  const sameOrigin = { cookie: { allowedOrigins: [], sameOrigin: true } };
  const logout = (app: ReturnType<typeof makeApp>['app'], headers: Record<string, string>) =>
    app.request('http://kindgi.internal:8080/v1/auth/logout', { method: 'POST', headers });

  test('an Origin naming the host the request went to passes', async () => {
    const { app, store } = makeApp(sameOrigin);
    const { cookie } = await signedIn(store);
    const res = await logout(app, { cookie, origin: 'http://kindgi.internal:8080' });
    expect(res.status).toBe(200);
  });

  test('behind a TLS proxy: the host matches whatever the scheme', async () => {
    const { app, store } = makeApp(sameOrigin);
    const { cookie } = await signedIn(store);
    const res = await logout(app, {
      cookie,
      origin: 'https://kindgi.acme.example',
      'x-forwarded-host': 'kindgi.acme.example',
    });
    expect(res.status).toBe(200);
  });

  test('another host is still refused; so is no Origin', async () => {
    const { app, store } = makeApp(sameOrigin);
    const { cookie } = await signedIn(store);
    const evil = await logout(app, { cookie, origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    expect(await codeOf(evil)).toBe('csrf-origin-mismatch');
    const none = await logout(app, { cookie });
    expect(none.status).toBe(403);
  });

  test('without sameOrigin, the same request is refused (allowed origins only)', async () => {
    const { app, store } = makeApp({ cookie: { allowedOrigins: [] } });
    const { cookie } = await signedIn(store);
    const res = await logout(app, { cookie, origin: 'http://kindgi.internal:8080' });
    expect(res.status).toBe(403);
  });
});

describe('cookie sessions: logout and refresh', () => {
  test('logout from the cookie revokes the session and clears the cookie', async () => {
    const { app, store } = makeApp();
    const { sessionId, cookie } = await signedIn(store);
    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBe(
      `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    );
    expect((await store.get({ tenantId, sessionId }))?.revokedAt).toBeDefined();
  });

  test('logout with a bearer session token sets no cookie', async () => {
    const { app, store } = makeApp();
    const created = await store.create({
      tenantId,
      userId: 'user-bob' as never,
      providerId: 'acme-sso',
      accessToken: 'unused',
      expiresAt: FAR,
      scopes: [],
    });
    const res = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('refresh from the cookie is refused: a new token never reaches page scripts', async () => {
    const { app, store } = makeApp();
    const { sessionId, cookie } = await signedIn(store);
    const res = await app.request('/v1/auth/refresh', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('cookie-session-not-refreshable');
    expect((await store.get({ tenantId, sessionId }))?.revokedAt).toBeUndefined();
  });
});

describe('without exchangeCode (sign-in runs elsewhere)', () => {
  test('the provider catalog, refresh and logout mount; the OAuth flow does not', async () => {
    const { app, store } = makeApp(undefined, { withExchange: false });
    const list = await app.request('/v1/auth/providers', {
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(list.status).toBe(200);
    const login = await app.request('/v1/auth/login/acme-sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}` },
    });
    expect(login.status).toBe(404);
    // Not mounted outside the auth chain any more: unauthenticated it's a
    // 401 like any /v1 path, and with a token there's no such route.
    const callback = await app.request('/v1/auth/callback/acme-sso', {
      method: 'POST',
      headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'c', state: 's' }),
    });
    expect(callback.status).toBe(404);
    const { cookie } = await signedIn(store);
    const out = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE },
    });
    expect(out.status).toBe(200);
  });
});
