// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `whoami` says whether the caller is a tenant admin (`tenantAdmin`),
 * decided as the admin routes decide it: the authorizer when there is one,
 * otherwise a full key's `tenant-admin` scope. A console signed in with an
 * API token is a session, and the session carries the key's scopes, no
 * more: with authorization off, an admin key's session is still an admin.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ApiTokenId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';

import { SESSION_COOKIE_NAME, SESSION_TOKEN_PREFIX, createApp } from '../src/index.js';
import type {
  IdentityDirectoryBinding,
  RunHandlerBinding,
  Session,
  SessionStoreBinding,
  TokenResolution,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const ann = 'user-ann' as UserId;
const bo = 'user-bo' as UserId;
const CONSOLE = 'https://kindgi.example.com';

/** The keys this deployment knows, by token. */
const KEYS: Record<string, TokenResolution> = {
  // An admin key: `tenant-admin`, as the runtime resolves an `admin` key.
  kgi_ann_admin: {
    tenantId,
    userId: ann,
    tokenId: 'tok-ann' as ApiTokenId,
    tokenRole: 'admin',
    scopes: ['tenant-admin'],
  },
  // A full key without it.
  kgi_bo_full: { tenantId, userId: bo, tokenId: 'tok-bo' as ApiTokenId, scopes: [] },
  // Narrowed keys: never an admin, whatever their scopes say.
  kgi_ann_member: {
    tenantId,
    userId: ann,
    tokenId: 'tok-ann-m' as ApiTokenId,
    tokenRole: 'member',
    scopes: ['tenant-admin'],
  },
  kgi_ann_project: {
    tenantId,
    userId: ann,
    tokenId: 'tok-ann-p' as ApiTokenId,
    tokenProjectId: randomUUID(),
    scopes: ['tenant-admin'],
  },
  // The deployment's own token (no key id), as the runtime resolves it.
  kgi_deployment: { tenantId, userId: ann, scopes: ['tenant-admin'] },
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function sessions(): SessionStoreBinding {
  const rows = new Map<string, { session: Session; hash: string }>();
  return {
    async create(input) {
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
    async revoke() {
      return { revoked: false };
    },
    async revokeAllForUser() {
      return { revokedCount: 0 };
    },
  };
}

const directory: IdentityDirectoryBinding = {
  getUser: async () => null,
  listUsers: async () => ({ data: [] }),
  listSessions: async () => ({ data: [] }),
  revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
};

/** With `admins`, an authorizer: `admin` on the tenant for those users only. */
function makeApp(admins?: readonly UserId[]) {
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (principal, action, resource) => {
      const allowed =
        !(action === 'admin' && resource.type === 'tenant') ||
        (admins ?? []).includes(principal.actor.id as UserId);
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not a tenant admin',
        evidence: { action, relation: '', resource: resource.id, actorSubject: principal.actor.id },
      } satisfies Decision;
    },
    checkBatch: async () => [],
  };
  return createApp({
    ...createStubAppBindings(),
    resolveToken: async (token) => KEYS[token] ?? null,
    runHandler: {} as RunHandlerBinding,
    sessionStore: sessions(),
    identityDirectory: directory,
    session: { ttl: 60 * 60 * 1000, cookie: { allowedOrigins: [CONSOLE] }, tokenSignIn: true },
    ...(admins !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });
}
type App = ReturnType<typeof makeApp>;

/** The console's session for a key: token sign-in, then the cookie alone. */
async function sessionOf(app: App, token: string): Promise<string> {
  const res = await app.request('/v1/auth/token-sign-in', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] as string;
  expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
  return cookie;
}

const whoami = async (app: App, headers: Record<string, string>) =>
  (await (await app.request('/v1/identity/whoami', { headers })).json()) as {
    scopes: string[];
    tenantAdmin?: boolean;
    sessionId?: string;
  };
const people = async (app: App, headers: Record<string, string>) =>
  (await app.request('/v1/identity/users', { headers })).status;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('with authorization off (the scopes decide)', () => {
  test("an admin key's console session is an admin: whoami says so, and an admin route answers", async () => {
    const app = makeApp();
    const cookie = await sessionOf(app, 'kgi_ann_admin');
    const me = await whoami(app, { cookie });
    expect(me.sessionId).toBeDefined();
    expect(me).toMatchObject({ scopes: ['tenant-admin'], tenantAdmin: true });
    expect(await people(app, { cookie })).toBe(200);
  });

  test("a key without tenant-admin: its session isn't widened, and the admin route refuses", async () => {
    const app = makeApp();
    const cookie = await sessionOf(app, 'kgi_bo_full');
    expect(await whoami(app, { cookie })).toMatchObject({ scopes: [], tenantAdmin: false });
    expect(await people(app, { cookie })).toBe(403);
  });

  test("the deployment's own token: an admin, as a bearer and as a console session", async () => {
    const app = makeApp();
    expect((await whoami(app, bearer('kgi_deployment'))).tenantAdmin).toBe(true);
    const cookie = await sessionOf(app, 'kgi_deployment');
    expect((await whoami(app, { cookie })).tenantAdmin).toBe(true);
  });

  test('keys as bearers: an admin key is; a member key or one limited to a project is not', async () => {
    const app = makeApp();
    expect((await whoami(app, bearer('kgi_ann_admin'))).tenantAdmin).toBe(true);
    expect((await whoami(app, bearer('kgi_ann_member'))).tenantAdmin).toBe(false);
    expect((await whoami(app, bearer('kgi_ann_project'))).tenantAdmin).toBe(false);
    expect((await whoami(app, bearer('kgi_bo_full'))).tenantAdmin).toBe(false);
  });
});

describe('with authorization on (the authorizer decides, scopes are ignored)', () => {
  test("a key with tenant-admin whose person isn't an admin: not one, as a bearer or a session", async () => {
    const app = makeApp([]);
    expect((await whoami(app, bearer('kgi_ann_admin'))).tenantAdmin).toBe(false);
    const cookie = await sessionOf(app, 'kgi_ann_admin');
    expect((await whoami(app, { cookie })).tenantAdmin).toBe(false);
    expect(await people(app, { cookie })).toBe(403);
  });

  test('a person the authorizer makes an admin: one, even through a key without the scope', async () => {
    const app = makeApp([bo]);
    const cookie = await sessionOf(app, 'kgi_bo_full');
    expect(await whoami(app, { cookie })).toMatchObject({ scopes: [], tenantAdmin: true });
    expect(await people(app, { cookie })).toBe(200);
  });
});
