// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import type { ApiTokenId, ProjectId, SessionId, TenantId, Timestamp, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp, encodeSessionToken } from '../src/index.js';
import type {
  ApiTokenRecord,
  ApiTokenRole,
  IdentityProviderBinding,
  RunHandlerBinding,
  Session,
  SessionCreateInput,
  SessionStoreBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';

/**
 * A caller with limits (a key or a session limited to a project, or with
 * the `member` role) lists, reads and revokes only its owner's keys within
 * those limits: the keys no wider than itself, every key it can mint among
 * them. One of the owner's keys beyond them is refused, 403, naming only
 * the caller's limit; someone else's still reads as missing. The same with
 * and without an authorization store, and for a caller without limits
 * nothing changes.
 */

const tenantId = randomUUID() as TenantId;
const P1 = randomUUID();
const P2 = randomUUID();
const EXPIRES = '2099-01-01T00:00:00.000Z' as Timestamp;

const noProviders: IdentityProviderBinding = {
  list: async () => ({ data: [] }),
  get: async () => null,
  register: async ({ config }) => ({ kind: 'ok', providerId: config.providerId }),
  unregister: async () => ({ unregistered: false }),
};

type StoredKey = ApiTokenRecord & { readonly secret: string };

/** Jane's keys, and one of Bob's, as the store keeps them. Nobody is a tenant admin. */
const JANES = {
  full: { role: 'admin' },
  member: { role: 'member' },
  p1: { role: 'member', projectId: P1 },
  p1Admin: { role: 'admin', projectId: P1 },
  p2: { role: 'member', projectId: P2 },
} as const satisfies Record<string, { role: ApiTokenRole; projectId?: string }>;
type JanesKey = keyof typeof JANES;

function makeApp(store: boolean) {
  const keys = new Map<string, StoredKey>();
  const seed = (userId: string, role: ApiTokenRole, projectId?: string): StoredKey => {
    const tokenId = randomUUID() as ApiTokenId;
    const key: StoredKey = {
      tokenId,
      secret: `kgi_ak_test_${keys.size + 1}`,
      principal: { kind: 'user', userId },
      role,
      capabilities: [],
      ...(projectId !== undefined && { projectId: projectId as ProjectId }),
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, keys.size)),
    };
    keys.set(tokenId, key);
    return key;
  };
  const janes = Object.fromEntries(
    Object.entries(JANES).map(([name, k]) => [
      name,
      seed('jane', k.role, 'projectId' in k ? k.projectId : undefined),
    ]),
  ) as Record<JanesKey, StoredKey>;
  const bobs = seed('bob', 'member', P1);

  /** Each read of the store's list, so a test sees how many a page took. */
  const listReads: number[] = [];
  const tokenAdmin: TokenAdmin = {
    async mint() {
      throw new Error('not minted here');
    },
    async list({ limit, principal, after }) {
      listReads.push(limit);
      return [...keys.values()]
        .filter((k) => principal === undefined || JSON.stringify(k.principal) === JSON.stringify(principal))
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() || b.tokenId.localeCompare(a.tokenId),
        )
        .filter(
          (k) =>
            after === undefined ||
            k.createdAt.getTime() < after.createdAt.getTime() ||
            (k.createdAt.getTime() === after.createdAt.getTime() && k.tokenId < after.tokenId),
        )
        .slice(0, limit);
    },
    async get({ tokenId }) {
      return keys.get(tokenId);
    },
    async revoke({ tokenId }) {
      const k = keys.get(tokenId);
      if (k === undefined) return { kind: 'not-found' };
      keys.set(tokenId, { ...k, revokedAt: new Date() });
      return { kind: 'ok' };
    },
  };

  const resolveToken: TokenResolver = async (token) => {
    const k = [...keys.values()].find((x) => x.secret === token);
    if (k === undefined || k.revokedAt !== undefined || k.principal?.kind !== 'user') return null;
    return {
      tenantId,
      userId: k.principal.userId as UserId,
      tokenId: k.tokenId,
      tokenRole: k.role,
      ...(k.projectId !== undefined && { tokenProjectId: k.projectId as unknown as string }),
      scopes: [],
      capabilities: [],
    };
  };

  const rows = new Map<string, Session>();
  const sessionStore: SessionStoreBinding = {
    async create(input: SessionCreateInput) {
      const id = randomUUID() as unknown as SessionId;
      rows.set(id, {
        id,
        tenantId: input.tenantId,
        userId: input.userId,
        providerId: input.providerId,
        expiresAt: input.expiresAt,
        scopes: input.scopes,
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.role !== undefined && { role: input.role }),
        createdAt: new Date().toISOString() as Timestamp,
      });
      return { sessionId: id, expiresAt: input.expiresAt };
    },
    get: async ({ sessionId }) => rows.get(sessionId) ?? null,
    list: async () => ({ data: [] }),
    revoke: async () => ({ revoked: true }),
    revokeAllForUser: async () => ({ revokedCount: 0 }),
  };

  // Everything is granted but `admin` on the tenant: nobody is a tenant
  // admin, so what's refused below is the caller's own limit.
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (principal, action, resource) => {
      const allowed = !(action === 'admin' && resource.type === 'tenant');
      return {
        allowed,
        reason: allowed ? 'test: granted' : 'test: not a tenant admin',
        evidence: { action, relation: '', resource: resource.id, actorSubject: principal.actor.id },
      } satisfies Decision;
    },
    checkBatch: async () => [],
  };

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as unknown as RunHandlerBinding,
    sessionStore,
    identityProvider: noProviders,
    tokenAdmin,
    ...(store && { authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding } }),
  });

  const session = async (limits: Pick<SessionCreateInput, 'projectId' | 'role'>) =>
    encodeSessionToken(
      (
        await sessionStore.create({
          tenantId,
          userId: 'jane' as UserId,
          providerId: 'oidc-acme',
          expiresAt: EXPIRES,
          scopes: [],
          ...limits,
        })
      ).sessionId,
    );

  const call = async (token: string, method: 'GET' | 'POST', path: string) => {
    const res = await app.request(path, { method, headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as {
      data?: { tokenId: string }[];
      hasMore?: boolean;
      nextCursor?: string;
      error?: { code: string; message: string; details?: Record<string, unknown> };
    };
    return { status: res.status, body };
  };
  const nameOf = (tokenId: string): string =>
    tokenId === bobs.tokenId
      ? 'bobs'
      : (Object.entries(janes).find(([, k]) => k.tokenId === tokenId)?.[0] ?? tokenId);
  /** Every key the caller lists, page by page, by name. */
  const listed = async (token: string, limit = 50): Promise<string[]> => {
    const names: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await call(
        token,
        'GET',
        `/v1/tokens?limit=${limit}${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      names.push(...(page.body.data ?? []).map((k) => nameOf(k.tokenId)));
      if (page.body.hasMore !== true) return names.sort();
      cursor = page.body.nextCursor;
    }
  };
  return { call, session, janes, bobs, keys, listed, listReads };
}

/** Who calls: one of Jane's keys, or a session of hers with these limits. */
type Caller =
  | { readonly key: JanesKey }
  | { readonly session: Pick<SessionCreateInput, 'projectId' | 'role'> };

const CASES: readonly {
  readonly name: string;
  readonly caller: Caller;
  readonly sees: readonly JanesKey[];
  /** Each of Jane's other keys, and the code its get or revoke is refused with. */
  readonly refused: Partial<Record<JanesKey, 'key-project-mismatch' | 'permission-denied'>>;
}[] = [
  {
    name: 'a member key limited to a project',
    caller: { key: 'p1' },
    sees: ['p1'],
    refused: {
      full: 'key-project-mismatch',
      member: 'key-project-mismatch',
      p1Admin: 'permission-denied',
      p2: 'key-project-mismatch',
    },
  },
  {
    name: 'an admin key limited to a project',
    caller: { key: 'p1Admin' },
    sees: ['p1', 'p1Admin'],
    refused: { full: 'key-project-mismatch', member: 'key-project-mismatch', p2: 'key-project-mismatch' },
  },
  {
    name: 'a member key',
    caller: { key: 'member' },
    sees: ['member', 'p1', 'p2'],
    refused: { full: 'permission-denied', p1Admin: 'permission-denied' },
  },
  {
    name: 'a session limited to a project and the member role',
    caller: { session: { projectId: P1 as ProjectId, role: 'member' } },
    sees: ['p1'],
    refused: {
      full: 'key-project-mismatch',
      member: 'key-project-mismatch',
      p1Admin: 'permission-denied',
      p2: 'key-project-mismatch',
    },
  },
  {
    name: 'a session limited to a project',
    caller: { session: { projectId: P1 as ProjectId } },
    sees: ['p1', 'p1Admin'],
    refused: { full: 'key-project-mismatch', member: 'key-project-mismatch', p2: 'key-project-mismatch' },
  },
  {
    name: 'a session with the member role',
    caller: { session: { role: 'member' } },
    sees: ['member', 'p1', 'p2'],
    refused: { full: 'permission-denied', p1Admin: 'permission-denied' },
  },
];

const ALL_JANES = Object.keys(JANES).sort() as JanesKey[];

describe.each([
  { store: true, label: 'with an authorization store' },
  { store: false, label: 'without one' },
])("a limited caller and its owner's keys, $label", ({ store }) => {
  const tokenOf = async (h: ReturnType<typeof makeApp>, caller: Caller): Promise<string> =>
    'key' in caller ? h.janes[caller.key].secret : h.session(caller.session);

  test.each(CASES)('$name lists only the keys within its limits', async ({ caller, sees }) => {
    const h = makeApp(store);
    expect(await h.listed(await tokenOf(h, caller))).toEqual([...sees].sort());
    // A page of one at a time reads on past the keys it can't see.
    expect(await h.listed(await tokenOf(h, caller), 1)).toEqual([...sees].sort());
  });

  test.each(CASES)(
    '$name reads its own keys; one beyond its limits is refused, naming only its own limit',
    async ({ caller, sees, refused }) => {
      const h = makeApp(store);
      const token = await tokenOf(h, caller);
      for (const name of sees) {
        expect((await h.call(token, 'GET', `/v1/tokens/${h.janes[name].tokenId}`)).status).toBe(200);
      }
      for (const [name, code] of Object.entries(refused)) {
        const key = h.janes[name as JanesKey];
        const r = await h.call(token, 'GET', `/v1/tokens/${key.tokenId}`);
        expect(r.status).toBe(403);
        expect(r.body.error?.code).toBe(code);
        // A refusal's own details, about the tenant and the caller's limit.
        expect(r.body.error?.details).toEqual({
          action: 'read',
          resource: `tenant:${tenantId}`,
          reason: r.body.error?.message,
          ...(code === 'key-project-mismatch' && { keyProjectId: P1 }),
        });
        // Nothing of the key's own: not its id, nor a project other than the caller's.
        expect(JSON.stringify(r.body)).not.toContain(key.tokenId);
        if (key.projectId !== undefined && key.projectId !== (P1 as ProjectId)) {
          expect(JSON.stringify(r.body)).not.toContain(key.projectId);
        }
      }
      expect((await h.call(token, 'GET', `/v1/tokens/${h.bobs.tokenId}`)).status).toBe(404);
    },
  );

  test.each(CASES)(
    "$name revokes no key beyond its limits, and no one else's; its own it does",
    async ({ caller, refused }) => {
      const h = makeApp(store);
      const token = await tokenOf(h, caller);
      for (const [name, code] of Object.entries(refused)) {
        const key = h.janes[name as JanesKey];
        const r = await h.call(token, 'POST', `/v1/tokens/${key.tokenId}/revoke`);
        expect(r.status).toBe(403);
        expect(r.body.error?.code).toBe(code);
        // Refused as an admin action, where a read is refused as `read`.
        expect(r.body.error?.details).toEqual({
          action: 'admin',
          resource: `tenant:${tenantId}`,
          reason: r.body.error?.message,
          ...(code === 'key-project-mismatch' && { keyProjectId: P1 }),
        });
        expect(h.keys.get(key.tokenId)?.revokedAt).toBeUndefined();
      }
      const other = await h.call(token, 'POST', `/v1/tokens/${h.bobs.tokenId}/revoke`);
      expect(other.status).toBe(404);
      expect(h.keys.get(h.bobs.tokenId)?.revokedAt).toBeUndefined();
      // The narrowest key, within every caller's limits, it revokes.
      const own = await h.call(token, 'POST', `/v1/tokens/${h.janes.p1.tokenId}/revoke`);
      expect(own.status).toBe(200);
      expect(h.keys.get(h.janes.p1.tokenId)?.revokedAt).toBeDefined();
    },
  );

  test('a key limited to a project revokes itself', async () => {
    const h = makeApp(store);
    const self = h.janes.p1;
    expect((await h.call(self.secret, 'POST', `/v1/tokens/${self.tokenId}/revoke`)).status).toBe(200);
    expect(h.keys.get(self.tokenId)?.revokedAt).toBeDefined();
  });

  test('a caller without limits is unchanged: every key of its owner, in one read of the store', async () => {
    const h = makeApp(store);
    const unlimited = [h.janes.full.secret, await h.session({})];
    for (const token of unlimited) {
      h.listReads.length = 0;
      expect(await h.listed(token)).toEqual(ALL_JANES);
      expect(h.listReads).toHaveLength(1);
      for (const name of ALL_JANES) {
        expect((await h.call(token, 'GET', `/v1/tokens/${h.janes[name].tokenId}`)).status).toBe(200);
      }
      expect((await h.call(token, 'GET', `/v1/tokens/${h.bobs.tokenId}`)).status).toBe(404);
    }
  });
});
