// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * API keys for people and service accounts: whom a key acts for, its role
 * as a ceiling, its project as a limit; service accounts; adding a person.
 * In-memory doubles for the key store, the service accounts, the directory
 * and the authorization check.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type AuthzCheckBinding,
  type Decision,
  type ResourceRef,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import { createStubAppBindings } from '@kindgi/testing';
import type { ApiTokenId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { Hono } from 'hono';

import { createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  IdentityDirectoryBinding,
  PersonGrantsBinding,
  RunHandlerBinding,
  ServiceAccount,
  ServiceAccountBinding,
  TokenAdmin,
  TokenMintInput,
  TokenMintRefusal,
  TokenPrincipal,
  TokenResolver,
  UserRecord,
} from '../src/index.js';
import { createAuthorizer } from '../src/middleware/authorize.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';

/** Alice is a tenant admin; Bob is not. */
const ALICE = 'static-alice';
const BOB = 'static-bob';
const ADMINS = new Set(['user:alice']);

const runHandler = {} as RunHandlerBinding;

type StoredKey = ApiTokenRecord & { secret: string };

function harness(options: { createUser?: boolean; personGrants?: boolean } = {}) {
  /** Who is a tenant admin; a person's grant or ungrant changes it. */
  const admins = new Set(ADMINS);
  const users = new Map<string, UserRecord>(
    ['alice', 'bob'].map((id) => [
      id,
      {
        userId: id as UserId,
        tenantId,
        displayName: id,
        primaryEmail: `${id}@acme.test`,
        createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
      },
    ]),
  );
  const accounts = new Map<string, ServiceAccount>();
  const keys = new Map<string, StoredKey>();
  /** Who each change was made by, as the routes pass it to the stores. */
  const changedBy: string[] = [];

  const isAdmin = (p: TokenPrincipal): boolean =>
    p.kind === 'user'
      ? admins.has(`user:${p.userId}`)
      : (accounts.get(p.serviceAccountId)?.grants.some((g) => g.kind === 'tenant-admin') ?? false);

  const exists = (p: TokenPrincipal): boolean => {
    if (p.kind === 'user') return users.has(p.userId);
    const account = accounts.get(p.serviceAccountId);
    return account !== undefined && account.unregisteredAt === undefined;
  };
  const refusal = (input: TokenMintInput): TokenMintRefusal | undefined => {
    const p = input.principal;
    if (p === undefined) return undefined;
    if (!exists(p)) return { kind: 'principal-not-found', message: 'no such principal' };
    if (input.role === 'admin' && !isAdmin(p)) {
      return { kind: 'role-exceeds-principal', message: 'not a tenant admin' };
    }
    return undefined;
  };

  const tokenAdmin: TokenAdmin = {
    async mint(input) {
      const refused = refusal(input);
      if (refused !== undefined) return refused;
      const p = input.principal;
      const tokenId = randomUUID() as ApiTokenId;
      const secret = `kgi_ak_test_${keys.size + 1}`;
      const record: StoredKey = {
        tokenId,
        secret,
        ...(p !== undefined && { principal: p }),
        role: input.role,
        capabilities: input.capabilities,
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, keys.size)),
      };
      keys.set(tokenId as unknown as string, record);
      return { record, token: secret };
    },
    async list({ limit, principal }) {
      return [...keys.values()]
        .filter(
          (k) =>
            principal === undefined || JSON.stringify(k.principal) === JSON.stringify(principal),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },
    async get({ tokenId }) {
      return keys.get(tokenId as unknown as string);
    },
    async revoke({ tokenId, revokedBy }) {
      changedBy.push(`revoke:${revokedBy}`);
      const k = keys.get(tokenId as unknown as string);
      if (k === undefined) return { kind: 'not-found' };
      keys.set(tokenId as unknown as string, { ...k, revokedAt: new Date() });
      return { kind: 'ok' };
    },
  };

  const resolveToken: TokenResolver = async (token) => {
    if (token === ALICE) {
      return { tenantId, userId: 'alice' as UserId, scopes: [], capabilities: ['env:write'] };
    }
    if (token === BOB) {
      return { tenantId, userId: 'bob' as UserId, scopes: [], capabilities: ['env:write'] };
    }
    const k = [...keys.values()].find((x) => x.secret === token);
    if (k === undefined || k.revokedAt !== undefined) return null;
    return {
      tenantId,
      tokenId: k.tokenId,
      scopes: [],
      capabilities: k.capabilities,
      tokenRole: k.role,
      ...(k.principal?.kind === 'user' && { userId: k.principal.userId as UserId }),
      ...(k.principal?.kind === 'service-account' && {
        serviceAccountId: k.principal.serviceAccountId,
      }),
      ...(k.projectId !== undefined && { tokenProjectId: k.projectId as unknown as string }),
    };
  };

  /** Only `admin` on the tenant is held back: for tenant admins. */
  const checked: string[] = [];
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (principal, action, resource) => {
      const actor = principal.actor;
      const who: TokenPrincipal =
        actor.kind === 'user'
          ? { kind: 'user', userId: actor.id }
          : { kind: 'service-account', serviceAccountId: actor.id };
      checked.push(`${actor.kind}:${actor.id} ${action} ${resource.type}`);
      const allowed = !(action === 'admin' && resource.type === 'tenant') || isAdmin(who);
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not a tenant admin',
        evidence: { action, relation: '', resource: resource.id, actorSubject: actor.id },
      } satisfies Decision;
    },
    checkBatch: async () => [],
  };

  const serviceAccountBinding: ServiceAccountBinding = {
    async create(input) {
      const taken = [...accounts.values()].some(
        (a) => a.name === input.name && a.unregisteredAt === undefined,
      );
      if (taken) {
        return {
          kind: 'err',
          error: { code: 'service-account-name-taken', message: 'taken' },
        };
      }
      const account: ServiceAccount = {
        serviceAccountId: `sa-${input.name}`,
        tenantId,
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        grants: input.grants,
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: '2026-10-01T00:00:00.000Z' as Timestamp,
      };
      accounts.set(account.serviceAccountId, account);
      return { kind: 'ok', value: account };
    },
    async get({ serviceAccountId }) {
      return accounts.get(serviceAccountId) ?? null;
    },
    async list({ includeUnregistered }) {
      return {
        data: [...accounts.values()].filter(
          (a) => includeUnregistered === true || a.unregisteredAt === undefined,
        ),
      };
    },
    async grant({ serviceAccountId, grant, by }) {
      changedBy.push(`grant:${by}`);
      const a = accounts.get(serviceAccountId);
      if (a === undefined) {
        return { kind: 'err', error: { code: 'service-account-not-found', message: 'none' } };
      }
      if (a.unregisteredAt !== undefined) {
        return {
          kind: 'err',
          error: { code: 'service-account-unregistered', message: 'unregistered' },
        };
      }
      const others = a.grants.filter((g) =>
        grant.kind === 'project'
          ? !(g.kind === 'project' && g.projectId === grant.projectId)
          : g.kind !== grant.kind,
      );
      const next = { ...a, grants: [...others, grant] };
      accounts.set(serviceAccountId, next);
      return { kind: 'ok', value: next };
    },
    async ungrant({ serviceAccountId, grant }) {
      const a = accounts.get(serviceAccountId);
      if (a === undefined) {
        return { kind: 'err', error: { code: 'service-account-not-found', message: 'none' } };
      }
      const next = {
        ...a,
        grants: a.grants.filter((g) =>
          grant.kind === 'project'
            ? !(g.kind === 'project' && g.projectId === grant.projectId)
            : g.kind !== grant.kind,
        ),
      };
      accounts.set(serviceAccountId, next);
      return { kind: 'ok', value: next };
    },
    async unregister({ serviceAccountId }) {
      const a = accounts.get(serviceAccountId);
      if (a === undefined) {
        return { kind: 'err', error: { code: 'service-account-not-found', message: 'none' } };
      }
      const next: ServiceAccount = {
        ...a,
        grants: [],
        unregisteredAt: a.unregisteredAt ?? ('2026-10-02T00:00:00.000Z' as Timestamp),
      };
      accounts.set(serviceAccountId, next);
      return { kind: 'ok', value: next };
    },
  };

  const identityDirectory: IdentityDirectoryBinding = {
    getUser: async ({ userId }) => users.get(userId as unknown as string) ?? null,
    listUsers: async () => ({ data: [...users.values()] }),
    listSessions: async () => ({ data: [] }),
    revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
    ...(options.createUser !== false && {
      createUser: async (input) => {
        const holder = [...users.values()].find(
          (u) => input.primaryEmail !== undefined && u.primaryEmail === input.primaryEmail,
        );
        if (holder !== undefined) return { kind: 'email-taken', userId: holder.userId };
        const user: UserRecord = {
          userId: `u-${users.size + 1}` as UserId,
          tenantId,
          displayName: input.displayName,
          ...(input.primaryEmail !== undefined && { primaryEmail: input.primaryEmail }),
          createdAt: '2026-10-03T00:00:00.000Z' as Timestamp,
        };
        users.set(user.userId as unknown as string, user);
        return { kind: 'created', user };
      },
    }),
  };

  /** Alice is the seed user; Bob is an editor on P1; Alice is on the reviewer roster. */
  const personGrants: PersonGrantsBinding = {
    async read({ userId }) {
      if (!users.has(userId)) return null;
      return {
        userId,
        tenantAdmin: admins.has(`user:${userId}`),
        projects: userId === 'bob' ? [{ projectId: P1, role: 'editor' }] : [],
        teams: [],
        ...(userId === 'alice' && { reviewer: { role: 'admin' as const } }),
      };
    },
    async grant(input) {
      changedBy.push(`person-grant:${input.by}`);
      if (!users.has(input.userId)) {
        return { kind: 'err', error: { code: 'identity-user-not-found', message: 'none' } };
      }
      admins.add(`user:${input.userId}`);
      return { kind: 'ok', value: (await personGrants.read(input)) as never };
    },
    async ungrant(input) {
      if (!users.has(input.userId)) {
        return { kind: 'err', error: { code: 'identity-user-not-found', message: 'none' } };
      }
      const people = [...admins].filter((a) => a.startsWith('user:'));
      if (people.length === 1 && people[0] === `user:${input.userId}`) {
        return { kind: 'err', error: { code: 'last-tenant-admin', message: 'the only one' } };
      }
      if (input.userId === 'alice') {
        return { kind: 'err', error: { code: 'seed-user-admin', message: 'the seed user' } };
      }
      admins.delete(`user:${input.userId}`);
      return { kind: 'ok', value: (await personGrants.read(input)) as never };
    },
  };

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tokenAdmin,
    serviceAccountBinding,
    identityDirectory,
    ...(options.personGrants !== false && { personGrants }),
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });

  const call = async (
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  /** Mint as `as`, expecting success: the secret and the key's id. */
  const mint = async (as: string, body: Record<string, unknown> = {}) => {
    const r = await call(as, 'POST', '/v1/tokens', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { token: r.body.token as string, tokenId: r.body.tokenId as string, body: r.body };
  };
  return { call, code, mint, checked, changedBy };
}

describe('API keys act for a principal', () => {
  test('a person mints their own key: it acts for them, and whoami says so', async () => {
    const h = harness();
    const bob = await h.mint(BOB, { label: 'laptop' });
    expect(bob.body).toMatchObject({
      principal: { kind: 'user', id: 'bob' },
      role: 'member',
      createdBy: 'user:bob',
    });
    const me = await h.call(bob.token, 'GET', '/v1/identity/whoami');
    expect(me.body).toMatchObject({
      userId: 'bob',
      principal: { kind: 'user', id: 'bob' },
      tokenId: bob.tokenId,
      role: 'member',
    });
    expect(me.body.projectId).toBeUndefined();
  });

  test('only a tenant admin mints for someone else, or an admin key', async () => {
    const h = harness();
    const forAlice = await h.call(BOB, 'POST', '/v1/tokens', {
      for: { kind: 'user', id: 'alice' },
    });
    expect(forAlice.status).toBe(403);
    expect(h.code(forAlice)).toBe('permission-denied');
    const adminKey = await h.call(BOB, 'POST', '/v1/tokens', { role: 'admin' });
    expect(adminKey.status).toBe(403);

    const forBob = await h.mint(ALICE, { for: { kind: 'user', id: 'bob' } });
    expect(forBob.body).toMatchObject({
      principal: { kind: 'user', id: 'bob' },
      createdBy: 'user:alice',
    });
    expect((await h.mint(ALICE, { role: 'admin' })).body.role).toBe('admin');
  });

  test("the store's refusals: no such principal 404; an admin key for a non-admin 403", async () => {
    const h = harness();
    const nobody = await h.call(ALICE, 'POST', '/v1/tokens', {
      for: { kind: 'user', id: 'carol' },
    });
    expect(nobody.status).toBe(404);
    expect(h.code(nobody)).toBe('principal-not-found');
    const exceeds = await h.call(ALICE, 'POST', '/v1/tokens', {
      for: { kind: 'user', id: 'bob' },
      role: 'admin',
    });
    expect(exceeds.status).toBe(403);
    expect(h.code(exceeds)).toBe('role-exceeds-principal');
  });

  test('`for` must name a person or a service account', async () => {
    const h = harness();
    for (const bad of [{ kind: 'team', id: 'x' }, { kind: 'user' }, 'bob']) {
      const r = await h.call(ALICE, 'POST', '/v1/tokens', { for: bad });
      expect(r.status).toBe(400);
      expect(h.code(r)).toBe('bad-input');
    }
  });

  test('a person sees, reads and revokes only their own keys; an admin, every key', async () => {
    const h = harness();
    const alices = await h.mint(ALICE);
    const bobs = await h.mint(BOB);

    const bobList = await h.call(BOB, 'GET', '/v1/tokens');
    expect((bobList.body.data as { tokenId: string }[]).map((k) => k.tokenId)).toEqual([
      bobs.tokenId,
    ]);
    const all = await h.call(ALICE, 'GET', '/v1/tokens');
    expect((all.body.data as unknown[]).length).toBe(2);
    const onlyBob = await h.call(ALICE, 'GET', '/v1/tokens?principal=user:bob');
    expect((onlyBob.body.data as { tokenId: string }[]).map((k) => k.tokenId)).toEqual([
      bobs.tokenId,
    ]);
    expect((await h.call(ALICE, 'GET', '/v1/tokens?principal=bob')).status).toBe(400);

    expect((await h.call(BOB, 'GET', `/v1/tokens/${alices.tokenId}`)).status).toBe(404);
    expect((await h.call(BOB, 'POST', `/v1/tokens/${alices.tokenId}/revoke`)).status).toBe(404);
    expect((await h.call(ALICE, 'GET', `/v1/tokens/${bobs.tokenId}`)).status).toBe(200);
    expect((await h.call(BOB, 'POST', `/v1/tokens/${bobs.tokenId}/revoke`)).status).toBe(200);
    expect((await h.call(bobs.token, 'GET', '/v1/identity/whoami')).status).toBe(401);
  });

  test("a member key is no admin, even for an admin: it can't mint for others", async () => {
    const h = harness();
    const daily = await h.mint(ALICE, { role: 'member' });
    const r = await h.call(daily.token, 'POST', '/v1/tokens', {
      for: { kind: 'user', id: 'bob' },
    });
    expect(r.status).toBe(403);
    // Its own keys it still manages.
    expect((await h.call(daily.token, 'GET', '/v1/tokens')).status).toBe(200);
    const admin = await h.mint(ALICE, { role: 'admin' });
    await h.mint(admin.token, { for: { kind: 'user', id: 'bob' } });
  });
});

describe('a key limited to a project', () => {
  test('names no other project: path, query or body', async () => {
    const h = harness();
    const key = await h.mint(BOB, { projectId: P1 });
    expect((await h.call(key.token, 'GET', '/v1/identity/whoami')).body.projectId).toBe(P1);
    const refused = [
      await h.call(key.token, 'GET', `/v1/projects/${P2}`),
      await h.call(key.token, 'GET', `/v1/agents?projectId=${P2}`),
      await h.call(key.token, 'GET', `/v1/agents?scopeKind=project&scopeId=${P2}`),
      await h.call(key.token, 'POST', '/v1/runs', { agent: 'acme.agent', projectId: P2 }),
      await h.call(key.token, 'POST', '/v1/agents/acme.agent/live/rollback', {
        scope: { kind: 'project', projectId: P2 },
      }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({
        code: 'key-project-mismatch',
        details: { keyProjectId: P1, projectId: P2 },
      });
    }
    const own = await h.call(key.token, 'GET', `/v1/agents?projectId=${P1}`);
    expect(h.code(own)).not.toBe('key-project-mismatch');
  });

  test('mints only keys limited to the same project', async () => {
    const h = harness();
    const key = await h.mint(BOB, { projectId: P1 });
    const unlimited = await h.call(key.token, 'POST', '/v1/tokens', {});
    expect(unlimited.status).toBe(403);
    expect(h.code(unlimited)).toBe('key-project-mismatch');
    const other = await h.call(key.token, 'POST', '/v1/tokens', { projectId: P2 });
    expect(h.code(other)).toBe('key-project-mismatch');
    expect((await h.mint(key.token, { projectId: P1 })).body.projectId).toBe(P1);
  });

  test("takes no admin action on the tenant, even an admin's admin key", async () => {
    const h = harness();
    const key = await h.mint(ALICE, { role: 'admin', projectId: P1 });
    const r = await h.call(key.token, 'POST', '/v1/service-accounts', { name: 'acme-ci' });
    expect(r.status).toBe(403);
    expect(h.code(r)).toBe('permission-denied');
  });

  test('a request from any other caller passes the guard untouched', async () => {
    const h = harness();
    const r = await h.call(BOB, 'GET', `/v1/agents?projectId=${P2}`);
    expect(h.code(r)).not.toBe('key-project-mismatch');
  });
});

describe('/v1/service-accounts', () => {
  test('tenant admins only', async () => {
    const h = harness();
    for (const [method, path] of [
      ['POST', '/v1/service-accounts'],
      ['GET', '/v1/service-accounts'],
      ['GET', '/v1/service-accounts/sa-acme-ci'],
      ['POST', '/v1/service-accounts/sa-acme-ci/grant'],
      ['POST', '/v1/service-accounts/sa-acme-ci/ungrant'],
      ['POST', '/v1/service-accounts/sa-acme-ci/unregister'],
    ] as const) {
      const r = await h.call(BOB, method, path, method === 'POST' ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  test('create with grants, then keys for it act as it', async () => {
    const h = harness();
    const created = await h.call(ALICE, 'POST', '/v1/service-accounts', {
      name: 'acme-ci',
      description: 'CI pipeline',
      grants: [{ kind: 'project', projectId: P1, role: 'editor' }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      serviceAccountId: 'sa-acme-ci',
      name: 'acme-ci',
      grants: [{ kind: 'project', projectId: P1, role: 'editor' }],
      createdBy: 'user:alice',
    });
    expect(h.code(await h.call(ALICE, 'POST', '/v1/service-accounts', { name: 'acme-ci' }))).toBe(
      'service-account-name-taken',
    );

    const key = await h.mint(ALICE, {
      for: { kind: 'service-account', id: 'sa-acme-ci' },
      projectId: P1,
    });
    const me = await h.call(key.token, 'GET', '/v1/identity/whoami');
    expect(me.body).toMatchObject({
      principal: { kind: 'service-account', id: 'sa-acme-ci' },
      tokenId: key.tokenId,
      role: 'member',
      projectId: P1,
    });
    // An admin key needs an account that is a tenant admin.
    const adminFor = { for: { kind: 'service-account', id: 'sa-acme-ci' }, role: 'admin' };
    const exceeds = await h.call(ALICE, 'POST', '/v1/tokens', adminFor);
    expect(h.code(exceeds)).toBe('role-exceeds-principal');
    await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'tenant-admin',
    });
    const adminKey = await h.mint(ALICE, adminFor);
    // The authorizer is asked about the account, not the key.
    const all = await h.call(adminKey.token, 'GET', '/v1/tokens');
    expect(h.checked).toContain('service_account:sa-acme-ci admin tenant');
    expect(all.body.data as unknown[]).toHaveLength(2);
  });

  test('bad input: name, description, grants', async () => {
    const h = harness();
    for (const body of [
      {},
      { name: 'Acme CI' },
      { name: 'acme-ci', description: 7 },
      { name: 'acme-ci', grants: {} },
      { name: 'acme-ci', grants: [{ kind: 'team' }] },
      { name: 'acme-ci', grants: [{ kind: 'project', projectId: P1 }] },
      { name: 'acme-ci', grants: [{ kind: 'project', projectId: P1, role: 'boss' }] },
    ]) {
      const r = await h.call(ALICE, 'POST', '/v1/service-accounts', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  test('tenant member is a grant of its own: on create, after, and taken back', async () => {
    const h = harness();
    const created = await h.call(ALICE, 'POST', '/v1/service-accounts', {
      name: 'acme-deploy',
      grants: [{ kind: 'tenant-member' }, { kind: 'project', projectId: P1, role: 'editor' }],
    });
    expect(created.status).toBe(201);
    expect(created.body.grants).toEqual([
      { kind: 'tenant-member' },
      { kind: 'project', projectId: P1, role: 'editor' },
    ]);
    await h.call(ALICE, 'POST', '/v1/service-accounts', { name: 'acme-ci' });
    const granted = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'tenant-member',
    });
    expect(granted.body.grants).toEqual([{ kind: 'tenant-member' }]);
    const admin = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'tenant-admin',
    });
    // Tenant admin doesn't replace tenant member: each is its own grant.
    expect(admin.body.grants).toEqual([{ kind: 'tenant-member' }, { kind: 'tenant-admin' }]);
    const ungranted = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/ungrant', {
      kind: 'tenant-member',
    });
    expect(ungranted.body.grants).toEqual([{ kind: 'tenant-admin' }]);
    const bad = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'tenant-reader',
    });
    expect(bad.status).toBe(400);
  });

  test('grant, ungrant, list, get, unregister', async () => {
    const h = harness();
    await h.call(ALICE, 'POST', '/v1/service-accounts', { name: 'acme-ci' });
    const granted = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'tenant-admin',
    });
    expect(granted.body.grants).toEqual([{ kind: 'tenant-admin' }]);
    const project = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'project',
      projectId: P2,
      role: 'viewer',
    });
    expect(project.body.grants).toHaveLength(2);
    const notUuid = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'project',
      projectId: 'acme',
      role: 'viewer',
    });
    expect(notUuid.status).toBe(400);
    const ungranted = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/ungrant', {
      kind: 'project',
      projectId: P2,
    });
    expect(ungranted.body.grants).toEqual([{ kind: 'tenant-admin' }]);

    const list = await h.call(ALICE, 'GET', '/v1/service-accounts');
    expect((list.body.data as { name: string }[]).map((a) => a.name)).toEqual(['acme-ci']);
    expect(list.body.hasMore).toBe(false);
    const missing = await h.call(ALICE, 'GET', '/v1/service-accounts/sa-nobody');
    expect(missing.status).toBe(404);
    expect(h.code(missing)).toBe('service-account-not-found');

    const gone = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/unregister');
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ grants: [], unregisteredAt: '2026-10-02T00:00:00.000Z' });
    expect(
      (await h.call(ALICE, 'GET', '/v1/service-accounts')).body.data as unknown[],
    ).toHaveLength(0);
    expect(
      (await h.call(ALICE, 'GET', '/v1/service-accounts?includeUnregistered=true')).body
        .data as unknown[],
    ).toHaveLength(1);
    const late = await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', {
      kind: 'tenant-admin',
    });
    expect(late.status).toBe(409);
    expect(h.code(late)).toBe('service-account-unregistered');
  });
});

describe("a key limited to a project reaches only that project's resources", () => {
  /** An authorizer whose store places agents `a1` in P1 and `a2` in P2, and allows any grant. */
  function authorizerWith(placed: boolean) {
    const asked: string[] = [];
    const binding = {
      check: async () => ({ allowed: true }),
      checkBatch: async (_p: unknown, _a: unknown, refs: readonly ResourceRef[]) =>
        refs.map(() => ({ allowed: true })),
      ...(placed && {
        inProject: async (_p: unknown, r: ResourceRef, projectId: string) => {
          asked.push(`${r.type}:${r.id}@${projectId}`);
          return (r.id === 'a1' && projectId === P1) || (r.id === 'a2' && projectId === P2);
        },
      }),
    } as unknown as AuthzCheckBinding;
    return { authorizer: createAuthorizer(binding), asked };
  }
  async function decide(placed: boolean, keyProject: string | undefined, agentId: string) {
    const { authorizer, asked } = authorizerWith(placed);
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('principal' as never, userPrincipal('bob' as UserId, tenantId) as never);
      if (keyProject !== undefined) c.set('tokenProjectId', keyProject);
      return c.json(await authorizer.check(c, 'read', ref('agent', agentId)));
    });
    return { decision: (await (await r.request('/')).json()) as Decision, asked };
  }

  test('in its project: allowed; in another: denied, as the scope', async () => {
    expect((await decide(true, P1, 'a1')).decision.allowed).toBe(true);
    const other = await decide(true, P1, 'a2');
    expect(other.decision).toMatchObject({ allowed: false, failing: 'scope' });
    expect(other.decision.reason).toContain(P1);
  });

  test("a store that can't place resources: the key reaches none", async () => {
    expect((await decide(false, P1, 'a1')).decision.allowed).toBe(false);
  });

  test('a caller without a limited key is never asked about projects', async () => {
    const { decision, asked } = await decide(true, undefined, 'a2');
    expect(decision.allowed).toBe(true);
    expect(asked).toEqual([]);
  });

  test("filterByCan keeps the key's project's resources only", async () => {
    const { authorizer } = authorizerWith(true);
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('principal' as never, userPrincipal('bob' as UserId, tenantId) as never);
      c.set('tokenProjectId', P1);
      return c.json(
        await authorizer.filterByCan(c, 'read', ['a1', 'a2'], (id) => ref('agent', id)),
      );
    });
    expect(await (await r.request('/')).json()).toEqual(['a1']);
  });

  test('admin on an org or a team is above the key', async () => {
    const { authorizer } = authorizerWith(true);
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('principal' as never, userPrincipal('bob' as UserId, tenantId) as never);
      c.set('tokenProjectId', P1);
      return c.json([
        (await authorizer.check(c, 'admin', ref('org', 'o1'))).allowed,
        (await authorizer.check(c, 'admin', ref('team', 't1'))).allowed,
        (await authorizer.check(c, 'read', ref('org', 'o1'))).allowed,
      ]);
    });
    expect(await (await r.request('/')).json()).toEqual([false, false, true]);
  });
});

describe('who made a change reaches the store', () => {
  test('revoke and grant name the caller', async () => {
    const h = harness();
    const key = await h.mint(BOB);
    await h.call(BOB, 'POST', `/v1/tokens/${key.tokenId}/revoke`);
    await h.call(ALICE, 'POST', '/v1/service-accounts', { name: 'acme-ci' });
    await h.call(ALICE, 'POST', '/v1/service-accounts/sa-acme-ci/grant', { kind: 'tenant-admin' });
    expect(h.changedBy).toEqual(['revoke:user:bob', 'grant:user:alice']);
  });
});

describe('revoking sessions', () => {
  test("a person revokes their own sessions; only a tenant admin someone else's", async () => {
    const h = harness();
    expect((await h.call(BOB, 'POST', '/v1/identity/users/bob/revoke-sessions')).status).toBe(200);
    const others = await h.call(BOB, 'POST', '/v1/identity/users/alice/revoke-sessions');
    expect(others.status).toBe(403);
    expect(h.code(others)).toBe('permission-denied');
    expect((await h.call(ALICE, 'POST', '/v1/identity/users/bob/revoke-sessions')).status).toBe(
      200,
    );
  });
});

describe('filterByCan holds a key to its limits too', () => {
  test("a key limited to a project keeps only that project's rows; the store isn't asked about others", async () => {
    const asked: string[][] = [];
    const authorizer = createAuthorizer({
      check: async () => ({ allowed: true }),
      checkBatch: async (_p: unknown, _a: unknown, refs: readonly ResourceRef[]) => {
        asked.push(refs.map((r) => r.id));
        return refs.map(() => ({ allowed: true }));
      },
    } as unknown as AuthzCheckBinding);
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('principal' as never, userPrincipal('bob' as UserId, tenantId) as never);
      c.set('tokenProjectId', P1);
      const kept = await authorizer.filterByCan(c, 'read', [P1, P2], (id) => ref('project', id));
      return c.json(kept);
    });
    expect(await (await r.request('/')).json()).toEqual([P1]);
    expect(asked).toEqual([[P1]]);
  });
});

describe('POST /v1/identity/users: add a person', () => {
  test('a tenant admin adds a person, who can then be given a key', async () => {
    const h = harness();
    const added = await h.call(ALICE, 'POST', '/v1/identity/users', {
      displayName: ' Carol ',
      primaryEmail: 'carol@acme.test',
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ displayName: 'Carol', primaryEmail: 'carol@acme.test' });
    const carol = added.body.userId as string;
    const key = await h.mint(ALICE, { for: { kind: 'user', id: carol } });
    expect(key.body.principal).toEqual({ kind: 'user', id: carol });
  });

  test('refusals: not an admin 403; a taken email 409; bad input 400', async () => {
    const h = harness();
    const bob = await h.call(BOB, 'POST', '/v1/identity/users', { displayName: 'Carol' });
    expect(bob.status).toBe(403);
    const taken = await h.call(ALICE, 'POST', '/v1/identity/users', {
      displayName: 'Bob again',
      primaryEmail: 'bob@acme.test',
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({
      code: 'identity-user-email-taken',
      details: { userId: 'bob' },
    });
    for (const body of [{}, { displayName: '  ' }, { displayName: 'C', primaryEmail: 'nope' }]) {
      expect((await h.call(ALICE, 'POST', '/v1/identity/users', body)).status).toBe(400);
    }
  });

  test('not mounted when the directory cannot add people', async () => {
    const h = harness({ createUser: false });
    const r = await h.call(ALICE, 'POST', '/v1/identity/users', { displayName: 'Carol' });
    expect(r.status).toBe(404);
  });
});

describe("a person's grants", () => {
  test("a person reads their own; a tenant admin reads anyone's", async () => {
    const h = harness();
    const own = await h.call(BOB, 'GET', '/v1/identity/users/bob/grants');
    expect(own.status).toBe(200);
    expect(own.body).toEqual({
      userId: 'bob',
      tenantAdmin: false,
      projects: [{ projectId: P1, role: 'editor' }],
      teams: [],
    });
    const other = await h.call(BOB, 'GET', '/v1/identity/users/alice/grants');
    expect([other.status, h.code(other)]).toEqual([403, 'permission-denied']);
    const alice = await h.call(ALICE, 'GET', '/v1/identity/users/alice/grants');
    expect(alice.body).toMatchObject({ tenantAdmin: true, reviewer: { role: 'admin' } });
    const nobody = await h.call(ALICE, 'GET', '/v1/identity/users/nobody/grants');
    expect([nobody.status, h.code(nobody)]).toEqual([404, 'identity-user-not-found']);
  });

  test('a tenant admin makes a person tenant admin: it holds on their next request', async () => {
    const h = harness();
    const before = await h.call(BOB, 'POST', '/v1/tokens', { for: { kind: 'user', id: 'alice' } });
    expect(before.status).toBe(403);
    const denied = await h.call(BOB, 'POST', '/v1/identity/users/bob/grant', {
      kind: 'tenant-admin',
    });
    expect([denied.status, h.code(denied)]).toEqual([403, 'permission-denied']);
    const granted = await h.call(ALICE, 'POST', '/v1/identity/users/bob/grant', {
      kind: 'tenant-admin',
    });
    expect(granted.status).toBe(200);
    expect(granted.body).toMatchObject({ userId: 'bob', tenantAdmin: true });
    expect(h.changedBy).toContain('person-grant:user:alice');
    const after = await h.call(BOB, 'POST', '/v1/tokens', { for: { kind: 'user', id: 'alice' } });
    expect(after.status).toBe(201);
  });

  test('a member key of a tenant admin changes no grants', async () => {
    const h = harness();
    const key = await h.mint(ALICE, { role: 'member' });
    const r = await h.call(key.token, 'POST', '/v1/identity/users/bob/grant', {
      kind: 'tenant-admin',
    });
    expect([r.status, h.code(r)]).toEqual([403, 'permission-denied']);
  });

  test('only tenant admin is granted here; project and team roles have their routes', async () => {
    const h = harness();
    for (const body of [
      { kind: 'project', projectId: P1, role: 'editor' },
      { kind: 'tenant-admin', role: 'admin' },
      [],
    ]) {
      const r = await h.call(ALICE, 'POST', '/v1/identity/users/bob/grant', body);
      expect([r.status, h.code(r)]).toEqual([400, 'bad-input']);
      expect(JSON.stringify(r.body)).toContain('/memberships');
    }
  });

  test('ungrant: refused for the only tenant admin and for the seed user; otherwise removed', async () => {
    const h = harness();
    const only = await h.call(ALICE, 'POST', '/v1/identity/users/alice/ungrant', {
      kind: 'tenant-admin',
    });
    expect([only.status, h.code(only)]).toEqual([409, 'last-tenant-admin']);
    await h.call(ALICE, 'POST', '/v1/identity/users/bob/grant', { kind: 'tenant-admin' });
    const seed = await h.call(ALICE, 'POST', '/v1/identity/users/alice/ungrant', {
      kind: 'tenant-admin',
    });
    expect([seed.status, h.code(seed)]).toEqual([409, 'seed-user-admin']);
    const removed = await h.call(ALICE, 'POST', '/v1/identity/users/bob/ungrant', {
      kind: 'tenant-admin',
    });
    expect(removed.body).toMatchObject({ userId: 'bob', tenantAdmin: false });
  });

  test('a runtime without the binding says so (after the admin check)', async () => {
    const h = harness({ personGrants: false });
    const read = await h.call(BOB, 'GET', '/v1/identity/users/bob/grants');
    expect([read.status, h.code(read)]).toEqual([501, 'person-grants-unsupported']);
    const bob = await h.call(BOB, 'POST', '/v1/identity/users/bob/grant', { kind: 'tenant-admin' });
    expect(bob.status).toBe(403);
    const alice = await h.call(ALICE, 'POST', '/v1/identity/users/bob/grant', {
      kind: 'tenant-admin',
    });
    expect([alice.status, h.code(alice)]).toEqual([501, 'person-grants-unsupported']);
  });
});
