// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { ApiTokenId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { SESSION_COOKIE_NAME, SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityProviderBinding,
  RunHandlerBinding,
  Session,
  SessionConfig,
  SessionCreateInput,
  SessionStoreBinding,
  TokenResolution,
} from '../src/index.js';

/**
 * Signing in to the console with an API token: a person's full key is
 * exchanged once for a browser session in the cookie, so the browser never
 * keeps the token. Service-account keys and narrowed keys can't, and the
 * deployment decides whether it's allowed at all.
 */

const tenantId = randomUUID() as TenantId;
const alice = 'user-alice' as UserId;
const CONSOLE = 'https://kindgi.example.com';
const HOUR = 60 * 60 * 1000;

/** The keys this deployment knows, by token. */
const KEYS: Record<string, TokenResolution> = {
  kgi_person_full: { tenantId, userId: alice, tokenId: 'tok-1' as ApiTokenId, tokenRole: 'admin' },
  kgi_seeded: { tenantId, userId: alice },
  kgi_person_soon: {
    tenantId,
    userId: alice,
    tokenId: 'tok-2' as ApiTokenId,
    expiresAt: new Date(Date.now() + HOUR),
  },
  kgi_service: { tenantId, tokenId: 'tok-3' as ApiTokenId, serviceAccountId: 'sa-ci' },
  kgi_no_principal: { tenantId, tokenId: 'tok-4' as ApiTokenId },
  // A service account's key never opens a session, even one naming a user.
  kgi_service_with_user: {
    tenantId,
    userId: alice,
    tokenId: 'tok-7' as ApiTokenId,
    serviceAccountId: 'sa-deploy',
  },
  kgi_member: { tenantId, userId: alice, tokenId: 'tok-5' as ApiTokenId, tokenRole: 'member' },
  kgi_one_project: {
    tenantId,
    userId: alice,
    tokenId: 'tok-6' as ApiTokenId,
    tokenProjectId: randomUUID(),
  },
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function makeStore() {
  const created: SessionCreateInput[] = [];
  const rows = new Map<string, { session: Session; hash: string }>();
  const store: SessionStoreBinding = {
    async create(input) {
      created.push(input);
      const id = randomUUID() as unknown as SessionId;
      const token = `${SESSION_TOKEN_PREFIX}${id}.${randomBytes(16).toString('hex')}`;
      rows.set(id, {
        session: {
          id,
          tenantId: input.tenantId,
          userId: input.userId,
          providerId: input.providerId,
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
  return { store, created };
}

const someProviders: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
  signInOptions: async () => [],
};

function makeApp(
  session: SessionConfig | null = {
    ttl: 12 * HOUR,
    cookie: { allowedOrigins: [CONSOLE] },
    tokenSignIn: true,
  },
  extra: { identityProvider?: IdentityProviderBinding; withStore?: boolean } = {},
) {
  const { store, created } = makeStore();
  const audit: AuditEvent[] = [];
  const auditEvents = {
    append: async (events: readonly AuditEvent[]) => {
      audit.push(...events);
      return { kind: 'ok', value: undefined };
    },
  } as unknown as AuditEventBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) => KEYS[token] ?? null,
    runHandler: {} as RunHandlerBinding,
    ...(extra.withStore !== false && { sessionStore: store }),
    ...(extra.identityProvider !== undefined && { identityProvider: extra.identityProvider }),
    ...(session !== null && { session }),
    auditEvents,
  });
  return { app, created, audit };
}

const signIn = (app: ReturnType<typeof makeApp>['app'], token: string) =>
  app.request('/v1/auth/token-sign-in', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
const codeOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

describe('POST /v1/auth/token-sign-in', () => {
  test("a person's full key: a session in the cookie, never the key", async () => {
    const { app, created, audit } = makeApp();
    const res = await signIn(app, 'kgi_person_full');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; expiresAt: string };
    expect(body.userId).toBe(alice);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=${SESSION_TOKEN_PREFIX}`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('kgi_person_full');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tenantId, userId: alice, providerId: 'api-token:tok-1' });
    const lifetime = Date.parse(body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(11.9 * HOUR);
    expect(lifetime).toBeLessThanOrEqual(12 * HOUR);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'signed-in',
      actor: `user:${alice}`,
      payload: { doc: { method: 'api-token', tokenId: 'tok-1' } },
    });
  });

  test('the session works as a browser session afterwards', async () => {
    const { app } = makeApp();
    const res = await signIn(app, 'kgi_person_full');
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const whoami = await app.request('/v1/identity/whoami', { headers: { cookie } });
    expect(whoami.status).toBe(200);
    expect(((await whoami.json()) as { userId: string }).userId).toBe(alice);
  });

  test('with no identity providers, the console can still sign out', async () => {
    const { app } = makeApp();
    const res = await signIn(app, 'kgi_person_full');
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const out = await app.request('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE },
    });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const after = await app.request('/v1/identity/whoami', { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  test("the deployment's own seeded token (a person, no key id) signs in too", async () => {
    const { app, created } = makeApp();
    expect((await signIn(app, 'kgi_seeded')).status).toBe(200);
    expect(created[0]?.providerId).toBe('api-token');
  });

  test('a key that expires sooner: the session ends with it', async () => {
    const { app } = makeApp();
    const res = await signIn(app, 'kgi_person_soon');
    const { expiresAt } = (await res.json()) as { expiresAt: string };
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(
      Date.parse(KEYS.kgi_person_soon?.expiresAt?.toISOString() ?? ''),
    );
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThan(1.01 * HOUR);
  });

  test.each([
    ['kgi_service', "a service account's key is for machines"],
    ['kgi_no_principal', "a service account's key is for machines"],
    ['kgi_service_with_user', "a service account's key is for machines"],
    ['kgi_member', 'narrowed key'],
    ['kgi_one_project', 'narrowed key'],
  ])('%s is refused: 403 token-sign-in-not-allowed', async (token, says) => {
    const { app, created } = makeApp();
    const res = await signIn(app, token);
    expect(res.status).toBe(403);
    const error = await codeOf(res);
    expect(error.code).toBe('token-sign-in-not-allowed');
    expect(error.message.toLowerCase()).toContain(says.toLowerCase());
    expect(created).toHaveLength(0);
  });

  test('already signed in by a session: 400, nothing to exchange', async () => {
    const { app } = makeApp();
    const first = await signIn(app, 'kgi_person_full');
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const res = await app.request('/v1/auth/token-sign-in', {
      method: 'POST',
      headers: { cookie, origin: CONSOLE },
    });
    expect(res.status).toBe(400);
    expect((await codeOf(res)).code).toBe('token-sign-in-needs-an-api-token');
  });

  test("the deployment doesn't allow it: 403 token-sign-in-off, no session", async () => {
    const { app, created } = makeApp({ cookie: { allowedOrigins: [CONSOLE] } });
    const res = await signIn(app, 'kgi_person_full');
    expect(res.status).toBe(403);
    expect((await codeOf(res)).code).toBe('token-sign-in-off');
    expect(created).toHaveLength(0);
  });

  test('a bad token: 401, as for any route', async () => {
    const { app } = makeApp();
    expect((await signIn(app, 'kgi_nobody')).status).toBe(401);
  });

  test('no browser sessions (no cookie configured): 403 token-sign-in-off, even when allowed', async () => {
    const { app, created } = makeApp({ tokenSignIn: true });
    const res = await signIn(app, 'kgi_person_full');
    expect(res.status).toBe(403);
    expect((await codeOf(res)).code).toBe('token-sign-in-off');
    expect(created).toHaveLength(0);
  });

  test('no browser sessions at all: still 403 token-sign-in-off, not 404', async () => {
    const { app } = makeApp(null);
    const res = await signIn(app, 'kgi_person_full');
    expect(res.status).toBe(403);
    expect((await codeOf(res)).code).toBe('token-sign-in-off');
  });
});

describe('GET /v1/auth/sign-in-options: the ways in', () => {
  const lookup = (app: ReturnType<typeof makeApp>['app']) =>
    app.request('/v1/auth/sign-in-options');

  test('no identity providers, token sign-in on: mounted, says so', async () => {
    const { app } = makeApp();
    const res = await lookup(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      methods: { identityProviders: false, apiToken: true },
    });
  });

  test('identity providers, token sign-in off', async () => {
    const { app } = makeApp(
      { cookie: { allowedOrigins: [CONSOLE] } },
      { identityProvider: someProviders },
    );
    expect(((await (await lookup(app)).json()) as { methods: unknown }).methods).toEqual({
      identityProviders: true,
      apiToken: false,
    });
  });

  test('neither identity providers nor browser sessions: mounted, says there is no way in', async () => {
    const { app } = makeApp(null);
    const res = await lookup(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: [],
      methods: { identityProviders: false, apiToken: false },
    });
  });
});

describe('what token sign-in and sign-out leave in the audit trail', () => {
  test('a refusal: who tried, and why (never the key)', async () => {
    const { app, audit } = makeApp();
    const res = await signIn(app, 'kgi_service');
    expect(res.status).toBe(403);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      kind: 'sign-in-refused',
      actor: 'service_account:sa-ci',
      outcome: 'denied',
      payload: { doc: { method: 'api-token', reason: 'token-sign-in-not-allowed' } },
    });
    expect(JSON.stringify(audit)).not.toContain('kgi_service');
  });

  test('signing out: signed-out, with the session', async () => {
    const { app, audit } = makeApp();
    const res = await signIn(app, 'kgi_person_full');
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
    await app.request('/v1/auth/logout', { method: 'POST', headers: { cookie, origin: CONSOLE } });
    const out = audit.find((e) => e.kind === 'signed-out');
    expect(out).toMatchObject({ actor: `user:${alice}`, outcome: 'succeeded' });
    expect((out?.payload as { doc: { sessionId?: string } }).doc.sessionId).toBeDefined();
  });
});

describe('cookie sessions need a store that resolves its own tokens', () => {
  test('without resolveToken, createApp refuses: the session id would be the credential', () => {
    const { store } = makeStore();
    const { resolveToken: _gone, ...older } = store;
    expect(() =>
      createApp({
        ...createStubAppBindings(),
        resolveToken: async () => null,
        runHandler: {} as RunHandlerBinding,
        sessionStore: older as SessionStoreBinding,
        session: { cookie: { allowedOrigins: [CONSOLE] }, tokenSignIn: true },
      }),
    ).toThrow(/resolveToken/);
  });
});
