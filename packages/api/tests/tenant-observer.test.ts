// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The tenant's observer: a person in place of a member who only views the
 * projects they're given. They make no API key, public run link or
 * provenance export (403, `only_view`); they're added with `tenantRole`
 * (refused without an authorizer, `observer-not-served`), made one with
 * the person grant `tenant-observer`, and they hold nothing an observer
 * doesn't: tenant admin, the reviewer roster, a project role above
 * `viewer`, a team, a live key (409, each way). In-memory doubles for the
 * people, their grants, their keys and the authorization check.
 */

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type { ApiTokenId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  CreateAppInput,
  IdentityCreateUserInput,
  IdentityDirectoryBinding,
  MyAccessBinding,
  PersonGrant,
  PersonGrants,
  PersonGrantsBinding,
  TokenAdmin,
  TokenResolver,
  UserRecord,
} from '../src/index.js';
import { fullAppInput } from './support/full-app.js';

const tenantId = '00000000-0000-4000-8000-0000000000c1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000d1';
const RUN = '00000000-0000-4000-8000-0000000000e1';
const TEAM = '00000000-0000-4000-8000-0000000000f1';

/**
 * The tenant's people. Alice is a tenant admin on the reviewer roster;
 * Olive is the observer, a viewer on P1; Bob is an editor on P1; Carol a
 * viewer on P1 whose key was revoked; Dave is in a team; Rita is on the
 * roster; Kim holds a live key; Many holds a role above viewer on 25
 * projects; Eve holds only a key that expired, and Fay one that expires
 * later; Pat's live key is on the second page of their keys; Sam is a
 * person a site signs in, an editor on P1 and on the roster, as their
 * site's sign-in made them.
 */
const PEOPLE = [
  'alice',
  'olive',
  'bob',
  'carol',
  'dave',
  'rita',
  'kim',
  'many',
  'eve',
  'fay',
  'pat',
  'sam',
] as const;
const MANY_PROJECTS = Array.from({ length: 25 }, (_, i) => ({
  projectId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
  role: 'editor' as const,
}));

/** The bearer token each person calls with. */
const token = (who: string) => `static-${who}`;
/** Olive, through a sign-in session limited to P1. */
const OLIVE_SESSION_ON_P1 = 'static-olive-session-p1';

function harness(options: { readonly allowAll?: boolean; readonly authorizer?: false } = {}) {
  const admins = new Set(['alice']);
  const observers = new Set(['olive']);
  const reviewers = new Set(['alice', 'rita', 'sam']);
  const sitePeople = new Set(['sam']);
  const projects = new Map<string, { projectId: string; role: string }[]>([
    ['olive', [{ projectId: P1, role: 'viewer' }]],
    ['bob', [{ projectId: P1, role: 'editor' }]],
    ['sam', [{ projectId: P1, role: 'editor' }]],
    ['carol', [{ projectId: P1, role: 'viewer' }]],
    ['many', MANY_PROJECTS],
  ]);
  const teams = new Map<string, { teamId: string; role: 'member' | 'admin' }[]>([
    ['dave', [{ teamId: TEAM, role: 'member' }]],
  ]);
  const users = new Map<string, UserRecord>(
    PEOPLE.map((id) => [
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
  const key = (
    userId: string,
    n: number,
    record: Partial<ApiTokenRecord> = {},
  ): ApiTokenRecord => ({
    tokenId: `k-${userId}-${String(n).padStart(3, '0')}` as ApiTokenId,
    principal: { kind: 'user', userId },
    role: 'member',
    capabilities: [],
    createdAt: new Date(Date.UTC(2026, 9, 1)),
    ...record,
  });
  /**
   * Kim's key is live; Carol's is revoked; Eve's expired; Fay's expires
   * later. Pat's newest hundred are revoked, and the live one is older.
   */
  const keys: ApiTokenRecord[] = [
    key('eve', 1, { expiresAt: new Date(Date.UTC(2026, 9, 2)) }),
    key('fay', 1, { expiresAt: new Date(Date.UTC(2099, 0, 1)) }),
    key('pat', 0),
    ...Array.from({ length: 100 }, (_, i) =>
      key('pat', i + 1, {
        createdAt: new Date(Date.UTC(2026, 9, 2, 0, i)),
        revokedAt: new Date(Date.UTC(2026, 9, 3)),
      }),
    ),
    {
      tokenId: 'k-kim' as ApiTokenId,
      principal: { kind: 'user', userId: 'kim' },
      role: 'member',
      capabilities: [],
      createdAt: new Date(Date.UTC(2026, 9, 1)),
    },
    {
      tokenId: 'k-carol' as ApiTokenId,
      principal: { kind: 'user', userId: 'carol' },
      role: 'member',
      capabilities: [],
      createdAt: new Date(Date.UTC(2026, 9, 1)),
      revokedAt: new Date(Date.UTC(2026, 9, 2)),
    },
  ];
  /** Every key minted, every person created, every grant and membership written. */
  const minted: unknown[] = [];
  const created: IdentityCreateUserInput[] = [];
  const grantWrites: string[] = [];
  const membershipWrites: string[] = [];
  /** Every check the authorizer was asked: `<user> <action> <type>`. */
  const asked: string[] = [];

  const resolveToken: TokenResolver = async (bearer) => {
    if (bearer === OLIVE_SESSION_ON_P1) {
      return {
        tenantId,
        userId: 'olive' as UserId,
        sessionId: 'session-olive' as SessionId,
        tokenProjectId: P1,
        scopes: [],
        capabilities: [],
      };
    }
    const who = PEOPLE.find((p) => token(p) === bearer);
    if (who === undefined) return null;
    // Without an authorizer, a tenant admin is one whose sign-in says so.
    const scopes = admins.has(who) ? ['tenant-admin'] : [];
    return { tenantId, userId: who as UserId, scopes, capabilities: [] };
  };

  /**
   * Tenant `admin` for tenant admins, `read` for anyone but the observer,
   * `only_view` for the observer alone, `belong` for everyone, and every
   * other check passes. `allowAll`: every check passes.
   */
  const decide = (who: string, action: Action, resource: ResourceRef): boolean => {
    if (options.allowAll === true || resource.type !== 'tenant') return true;
    if (action === 'admin') return admins.has(who);
    if (action === 'read') return !observers.has(who);
    if (action === 'only_view') return observers.has(who);
    return action === 'belong';
  };
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (principal, action, resource) => {
      const who = principal.actor.id;
      asked.push(`${who} ${action} ${resource.type}`);
      const allowed = decide(who, action, resource);
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not granted',
        evidence: { action, relation: '', resource: resource.id, actorSubject: who },
      } satisfies Decision;
    },
    checkBatch: async () => [],
  };

  const tokenAdmin: TokenAdmin = {
    async mint(input) {
      minted.push(input);
      const record: ApiTokenRecord = {
        tokenId: `k-${minted.length}` as ApiTokenId,
        ...(input.principal !== undefined && { principal: input.principal }),
        role: input.role,
        capabilities: input.capabilities,
        createdAt: new Date(Date.UTC(2026, 9, 3)),
      };
      return { record, token: `kgi_ak_test_${minted.length}` };
    },
    // Newest first, strictly after `after`, as a store pages them.
    async list({ principal, limit, after }) {
      const order = (k: ApiTokenRecord) => `${k.createdAt.toISOString()} ${k.tokenId}`;
      const from = after !== undefined ? `${after.createdAt.toISOString()} ${after.tokenId}` : '~';
      return keys
        .filter((k) => JSON.stringify(k.principal) === JSON.stringify(principal))
        .sort((a, b) => order(b).localeCompare(order(a)))
        .filter((k) => order(k) < from)
        .slice(0, limit);
    },
    async get({ tokenId }) {
      return keys.find((k) => k.tokenId === tokenId);
    },
    async revoke() {
      return { kind: 'ok' };
    },
  };

  const identityDirectory: IdentityDirectoryBinding = {
    getUser: async ({ userId }) => users.get(userId as unknown as string) ?? null,
    listUsers: async () => ({ data: [...users.values()] }),
    listSessions: async () => ({ data: [] }),
    revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
    createUser: async (input) => {
      created.push(input);
      const user: UserRecord = {
        userId: `u-${created.length}` as UserId,
        tenantId,
        displayName: input.displayName,
        createdAt: '2026-10-03T00:00:00.000Z' as Timestamp,
      };
      return { kind: 'created', user };
    },
  };

  const grantsOf = (userId: string): PersonGrants | null =>
    users.has(userId)
      ? {
          userId,
          tenantAdmin: admins.has(userId),
          tenantMember: !observers.has(userId),
          tenantObserver: observers.has(userId),
          projects: (projects.get(userId) ?? []) as PersonGrants['projects'],
          teams: teams.get(userId) ?? [],
          ...(reviewers.has(userId) && { reviewer: { role: 'standard' as const } }),
          ...(sitePeople.has(userId) && { siteManaged: true as const }),
        }
      : null;
  /**
   * A site's person: the runtime's guard refuses every grant naming them,
   * writing nothing. An ungrant takes nothing from them, so it passes.
   */
  const siteManaged = {
    code: 'site-person-grants-managed',
    message: 'their site gives it',
  } as const;
  /** Grant and ungrant change what's held; one already held, or not held, is a no-op. */
  const held = (grant: PersonGrant) => (grant.kind === 'tenant-admin' ? admins : observers);
  const personGrants: PersonGrantsBinding = {
    async read({ userId }) {
      return grantsOf(userId);
    },
    async grant({ userId, grant }) {
      if (sitePeople.has(userId)) return { kind: 'err', error: siteManaged };
      grantWrites.push(`grant ${grant.kind} ${userId}`);
      held(grant).add(userId);
      return { kind: 'ok', value: grantsOf(userId) as PersonGrants };
    },
    async ungrant({ userId, grant }) {
      grantWrites.push(`ungrant ${grant.kind} ${userId}`);
      held(grant).delete(userId);
      return { kind: 'ok', value: grantsOf(userId) as PersonGrants };
    },
  };

  const myAccess: MyAccessBinding = {
    read: async ({ principal }) => {
      const who = principal.kind === 'user' ? principal.userId : '';
      return {
        tenantMember: !observers.has(who),
        tenantObserver: observers.has(who),
        projects: [],
        orgs: [],
        teams: [],
        capabilities: {},
      };
    },
  };

  const input = fullAppInput();
  /** The project and the team are there; their membership writes are recorded. */
  const found = <T extends object>(binding: T, record: Record<string, unknown>): T =>
    new Proxy(binding, {
      get: (target, key) =>
        key === 'get' ? async () => record : Reflect.get(target, key as keyof T),
    });
  const tenantHierarchyBinding: TenantHierarchyBinding = new Proxy(input.tenantHierarchyBinding, {
    get: (target, key) => {
      if (
        key === 'addProjectMember' ||
        key === 'updateProjectMemberRole' ||
        key === 'addTeamMember' ||
        key === 'updateTeamMemberRole'
      ) {
        return async (params: { userId: string; role: string }) => {
          membershipWrites.push(`${String(key)} ${params.userId} ${params.role}`);
          return { kind: 'ok', value: key.startsWith('update') ? { kind: 'ok' } : undefined };
        };
      }
      return Reflect.get(target, key);
    },
  });
  const kernelBinding = {
    ...input.kernelBinding,
    run: new Proxy(input.kernelBinding.run, {
      get: (target, key) =>
        key === 'getRun'
          ? async () => ({ runId: RUN, tenantId, projectId: P1 })
          : Reflect.get(target, key),
    }),
  };

  const { authz: _authz, sites: _sites, ...withoutAuthz } = input;
  const app = createApp({
    ...(options.authorizer === false ? withoutAuthz : input),
    resolveToken,
    tokenAdmin,
    identityDirectory,
    personGrants,
    myAccess,
    tenantHierarchyBinding,
    kernelBinding,
    projectBinding: found(input.projectBinding as object, {
      id: P1,
      tenantId,
      name: 'Support',
    }) as NonNullable<CreateAppInput['projectBinding']>,
    teamBinding: found(input.teamBinding as object, {
      id: TEAM,
      tenantId,
      name: 'Agents',
    }) as NonNullable<CreateAppInput['teamBinding']>,
    ...(options.authorizer !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });

  const call = async (
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who.startsWith('static-') ? who : token(who)}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as never) };
  };
  return { call, asked, minted, created, grantWrites, membershipWrites };
}

const error = (r: { body: Record<string, unknown> }) =>
  r.body.error as { code?: string; details?: Record<string, unknown> } | undefined;

describe("what's refused the observer: a key, a public run link, a provenance export", () => {
  const routes = [
    ['POST /v1/tokens', '/v1/tokens', {}],
    ['POST /v1/tokens/public', '/v1/tokens/public', { runIds: [RUN] }],
    ['POST /v1/provenance/{runId}/export', `/v1/provenance/${RUN}/export`, {}],
  ] as const;

  test.each(routes)(
    '%s: 403, `only_view`, having asked whether they read the tenant',
    async (_, path, body) => {
      const h = harness();
      const r = await h.call('olive', 'POST', path, body);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(error(r)?.code).toBe('permission-denied');
      expect(error(r)?.details?.action).toBe('only_view');
      expect(h.asked).toEqual(
        expect.arrayContaining(['olive only_view tenant', 'olive read tenant']),
      );
      expect(h.minted).toEqual([]);
    },
  );

  test.each(routes)(
    '%s: a member is asked only `only_view`, and not refused for it',
    async (_, path, body) => {
      const h = harness();
      const r = await h.call('bob', 'POST', path, body);
      expect(error(r)?.details?.action).not.toBe('only_view');
      expect(h.asked).toContain('bob only_view tenant');
      expect(h.asked).not.toContain('bob read tenant');
    },
  );

  test('an authorizer that allows every check refuses no one: the observer holds no `read`', async () => {
    const h = harness({ allowAll: true });
    const r = await h.call('olive', 'POST', '/v1/tokens', {});
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  test('a session limited to a project mints no key by its own limit, asked before the observer', async () => {
    const h = harness();
    const r = await h.call(OLIVE_SESSION_ON_P1, 'POST', '/v1/tokens', {});
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(error(r)?.code).toBe('limited-session-cannot-mint');
    expect(h.minted).toEqual([]);
  });

  test.each(routes.slice(1))(
    '%s: a session limited to a project is still refused, the key ceiling leaving `only_view` alone',
    async (_, path, body) => {
      const h = harness();
      const r = await h.call(OLIVE_SESSION_ON_P1, 'POST', path, body);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(error(r)?.details?.action).toBe('only_view');
    },
  );
});

describe('adding a person: `tenantRole`', () => {
  test("`observer` adds the tenant's observer", async () => {
    const h = harness();
    const r = await h.call('alice', 'POST', '/v1/identity/users', {
      displayName: 'Ana',
      tenantRole: 'observer',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.created).toEqual([expect.objectContaining({ tenantRole: 'observer' })]);
  });

  test('no role is a member: the directory is given none', async () => {
    const h = harness();
    const r = await h.call('alice', 'POST', '/v1/identity/users', { displayName: 'Ana' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).not.toHaveProperty('tenantRole');
  });

  test('another role is refused (400), with no one added', async () => {
    const h = harness();
    const r = await h.call('alice', 'POST', '/v1/identity/users', {
      displayName: 'Ana',
      tenantRole: 'admin',
    });
    expect(r.status).toBe(400);
    expect(error(r)?.code).toBe('bad-input');
    expect(h.created).toEqual([]);
  });

  test('without an authorizer, `observer` is refused (501 observer-not-served), with no one added', async () => {
    const h = harness({ authorizer: false });
    const r = await h.call('alice', 'POST', '/v1/identity/users', {
      displayName: 'Ana',
      tenantRole: 'observer',
    });
    expect(r.status).toBe(501);
    expect(error(r)?.code).toBe('observer-not-served');
    expect(h.created).toEqual([]);
    const member = await h.call('alice', 'POST', '/v1/identity/users', {
      displayName: 'Ana',
      tenantRole: 'member',
    });
    expect(member.status, JSON.stringify(member.body)).toBe(201);
  });
});

describe('making someone the observer, and a member again: the person grant `tenant-observer`', () => {
  const grant = (h: ReturnType<typeof harness>, userId: string, kind: string) =>
    h.call('alice', 'POST', `/v1/identity/users/${userId}/grant`, { kind });

  test('a member with nothing an observer lacks is made the observer; ungrant makes them a member', async () => {
    const h = harness();
    const made = await grant(h, 'carol', 'tenant-observer');
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body).toMatchObject({ tenantObserver: true, tenantMember: false });
    const back = await h.call('alice', 'POST', '/v1/identity/users/carol/ungrant', {
      kind: 'tenant-observer',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body).toMatchObject({ tenantObserver: false, tenantMember: true });
    expect(h.grantWrites).toEqual(['grant tenant-observer carol', 'ungrant tenant-observer carol']);
  });

  test('a revoked or an expired key is no live key; one that expires later is', async () => {
    const h = harness();
    // Carol's only key was revoked, and Eve's expired: they hold nothing else.
    for (const who of ['carol', 'eve']) {
      const r = await grant(h, who, 'tenant-observer');
      expect(r.status, `${who}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    const fay = await grant(h, 'fay', 'tenant-observer');
    expect(fay.status).toBe(409);
    expect(error(fay)).toMatchObject({ code: 'person-holds-keys', details: { userId: 'fay' } });
    expect(h.grantWrites).toEqual(['grant tenant-observer carol', 'grant tenant-observer eve']);
  });

  test('a live key on a later page of their keys is found', async () => {
    const h = harness();
    const r = await grant(h, 'pat', 'tenant-observer');
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(error(r)?.code).toBe('person-holds-keys');
    expect(h.grantWrites).toEqual([]);
  });

  test('a person a site signs in is left to the binding, which refuses every grant (403), whatever they hold', async () => {
    const h = harness();
    for (const kind of ['tenant-observer', 'tenant-admin']) {
      const r = await grant(h, 'sam', kind);
      expect(r.status, `${kind}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(error(r)?.code, kind).toBe('site-person-grants-managed');
    }
    expect(h.grantWrites).toEqual([]);
    // Their grants say so.
    const read = await h.call('alice', 'GET', '/v1/identity/users/sam/grants');
    expect(read.body).toMatchObject({ siteManaged: true, reviewer: { role: 'standard' } });
    const bob = await h.call('alice', 'GET', '/v1/identity/users/bob/grants');
    expect(bob.body).not.toHaveProperty('siteManaged');
    // An ungrant goes to the binding too, and its answer says so.
    const ungranted = await h.call('alice', 'POST', '/v1/identity/users/sam/ungrant', {
      kind: 'tenant-observer',
    });
    expect(ungranted.status, JSON.stringify(ungranted.body)).toBe(200);
    expect(ungranted.body).toMatchObject({ siteManaged: true });
  });

  test('without an authorizer, `tenant-observer` is refused (501 observer-not-served) before anything is read; ungrant and tenant admin go to the binding', async () => {
    const h = harness({ authorizer: false });
    const r = await grant(h, 'carol', 'tenant-observer');
    expect(r.status, JSON.stringify(r.body)).toBe(501);
    expect(error(r)?.code).toBe('observer-not-served');
    // Bob holds what an observer doesn't: no 409, since nothing was read.
    expect(error(await grant(h, 'bob', 'tenant-observer'))?.code).toBe('observer-not-served');
    expect(h.grantWrites).toEqual([]);
    const back = await h.call('alice', 'POST', '/v1/identity/users/olive/ungrant', {
      kind: 'tenant-observer',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await grant(h, 'carol', 'tenant-admin')).status).toBe(200);
    expect(h.grantWrites).toEqual(['ungrant tenant-observer olive', 'grant tenant-admin carol']);
  });

  test('the observer, made the observer again, is the binding no-op it always was', async () => {
    const h = harness();
    const r = await grant(h, 'olive', 'tenant-observer');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.grantWrites).toEqual(['grant tenant-observer olive']);
  });

  test.each([
    ['tenant-admin', 'olive', 'person-is-observer'],
    ['tenant-observer', 'alice', 'person-is-tenant-admin'],
    ['tenant-observer', 'rita', 'person-is-reviewer'],
    ['tenant-observer', 'bob', 'person-holds-project-role'],
    ['tenant-observer', 'dave', 'person-in-team'],
    ['tenant-observer', 'kim', 'person-holds-keys'],
  ])('%s for %s: 409 %s, naming them, with nothing written', async (kind, userId, code) => {
    const h = harness();
    const r = await grant(h, userId, kind);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(error(r)?.code).toBe(code);
    expect(error(r)?.details?.userId).toBe(userId);
    expect(h.grantWrites).toEqual([]);
  });

  test('the project roles above viewer are named; the team too', async () => {
    const h = harness();
    expect(error(await grant(h, 'bob', 'tenant-observer'))?.details).toMatchObject({
      projects: [{ projectId: P1, role: 'editor' }],
    });
    const dave = error(await grant(h, 'dave', 'tenant-observer'))?.details;
    expect(dave).toMatchObject({ teams: [{ teamId: TEAM, role: 'member' }] });
    expect(dave).not.toHaveProperty('truncated');
  });

  test('at most 20 projects are named, and `truncated` says there are more', async () => {
    const h = harness();
    const details = error(await grant(h, 'many', 'tenant-observer'))?.details;
    expect(details?.projects).toEqual(MANY_PROJECTS.slice(0, 20));
    expect(details?.truncated).toBe(true);
  });
});

describe("what the observer isn't given", () => {
  test('a key someone else makes for them: 409 person-is-observer, with none minted', async () => {
    const h = harness();
    const r = await h.call('alice', 'POST', '/v1/tokens', { for: { kind: 'user', id: 'olive' } });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(error(r)?.code).toBe('person-is-observer');
    expect(h.minted).toEqual([]);
    expect(
      (await h.call('alice', 'POST', '/v1/tokens', { for: { kind: 'user', id: 'carol' } })).status,
    ).toBe(201);
  });

  test('a place on the reviewer roster: 409 person-is-observer', async () => {
    const h = harness();
    const r = await h.call('alice', 'POST', '/v1/approvals/reviewers', {
      userId: 'olive',
      role: 'standard',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(error(r)?.code).toBe('person-is-observer');
    const carol = await h.call('alice', 'POST', '/v1/approvals/reviewers', {
      userId: 'carol',
      role: 'standard',
    });
    expect(error(carol)?.code).not.toBe('person-is-observer');
  });

  test.each(['editor', 'admin', 'owner'])(
    'a project role above viewer (%s): 409 person-is-observer, added or changed to',
    async (role) => {
      const h = harness();
      const added = await h.call('alice', 'POST', `/v1/projects/${P1}/memberships`, {
        userId: 'olive',
        role,
      });
      expect(added.status, JSON.stringify(added.body)).toBe(409);
      expect(error(added)?.code).toBe('person-is-observer');
      const changed = await h.call('alice', 'PATCH', `/v1/projects/${P1}/memberships/olive`, {
        role,
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(409);
      expect(error(changed)?.code).toBe('person-is-observer');
      expect(h.membershipWrites).toEqual([]);
    },
  );

  test('viewer is given them; a member is given any role', async () => {
    const h = harness();
    const added = await h.call('alice', 'POST', `/v1/projects/${P1}/memberships`, {
      userId: 'olive',
      role: 'viewer',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const changed = await h.call('alice', 'PATCH', `/v1/projects/${P1}/memberships/olive`, {
      role: 'viewer',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(204);
    const member = await h.call('alice', 'PATCH', `/v1/projects/${P1}/memberships/carol`, {
      role: 'editor',
    });
    expect(member.status, JSON.stringify(member.body)).toBe(204);
    expect(h.membershipWrites).toEqual([
      'addProjectMember olive viewer',
      'updateProjectMemberRole olive viewer',
      'updateProjectMemberRole carol editor',
    ]);
  });

  test('a team: 409 person-is-observer, added or changed in it; a member is added', async () => {
    const h = harness();
    const added = await h.call('alice', 'POST', `/v1/teams/${TEAM}/memberships`, {
      userId: 'olive',
      role: 'member',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(409);
    expect(error(added)?.code).toBe('person-is-observer');
    const changed = await h.call('alice', 'PATCH', `/v1/teams/${TEAM}/memberships/olive`, {
      role: 'admin',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(409);
    expect(error(changed)?.code).toBe('person-is-observer');
    expect(h.membershipWrites).toEqual([]);
    const carol = await h.call('alice', 'POST', `/v1/teams/${TEAM}/memberships`, {
      userId: 'carol',
      role: 'member',
    });
    expect(carol.status, JSON.stringify(carol.body)).toBe(201);
  });

  test('a project of their own: creating one takes `admin` on the tenant (403)', async () => {
    const h = harness();
    const r = await h.call('olive', 'POST', '/v1/projects', { name: 'Mine' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(h.asked).toContain('olive admin tenant');
  });
});

describe('what reports the observer', () => {
  test('`GET /v1/identity/me/permissions` carries `tenant.observer`', async () => {
    const h = harness();
    const olive = await h.call('olive', 'GET', '/v1/identity/me/permissions');
    expect(olive.status, JSON.stringify(olive.body)).toBe(200);
    expect(olive.body.tenant).toMatchObject({ observer: true, member: false });
    const bob = await h.call('bob', 'GET', '/v1/identity/me/permissions');
    expect(bob.body.tenant).toMatchObject({ observer: false, member: true });
  });

  test("a person's grants carry `tenantObserver`", async () => {
    const h = harness();
    const r = await h.call('alice', 'GET', '/v1/identity/users/olive/grants');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ tenantObserver: true, tenantMember: false });
  });
});
