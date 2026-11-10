// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An API key with a ceiling (`sandbox`): what the mint takes, what the key
 * keeps of its principal's grants, type by type and action by action, and
 * the places that read a key's facts directly rather than asking the
 * authorizer (the keys routes, the trigger routes, the reviewer role, the
 * person-wide routes, whoami and my permissions). In-memory doubles for
 * the key store, the authorization check, the trigger registry and the
 * reviewer roster.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  ACTIONS,
  type Action,
  type AuthzCheckBinding,
  OBJECT_TYPES,
  type ObjectType,
  PROJECT_EDITOR_ACTIONS,
  type ResourceRef,
  type ReviewerRole,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { ApiTokenId, ProjectId, TenantId, UserId } from '@kindgi/types';
import { Hono } from 'hono';

import { createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  MyAccessBinding,
  ReviewerBinding,
  RunHandlerBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';
import { KEY_CEILING_KEEPS, ceilingKeeps, createAuthorizer } from '../src/middleware/authorize.js';
import { personWideRefusal } from '../src/middleware/key-project.js';
import { callerReviewerRole } from '../src/reviewer-role.js';
import { createInMemoryTriggerRegistry, createStubAppBindings } from '../src/testing/index.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000c1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000d1';
const P2 = '00000000-0000-4000-8000-0000000000d2';
const TRIGGER = '00000000-0000-4000-8000-0000000000e1';

/** Ada's own sign-in: a person with every grant, and on the reviewer roster as an admin. */
const ADA = 'static-ada';

const runHandler = {} as RunHandlerBinding;

type StoredKey = ApiTokenRecord & { secret: string };

function harness(
  options: {
    /** Run with an authorizer (the default), or without one. */
    readonly authz?: boolean;
    /** A key store that keeps a key's ceiling (the default), or drops it. */
    readonly keepCeiling?: boolean;
    /** A reviewer role every key's resolution carries. */
    readonly carriedReviewerRole?: ReviewerRole;
    /** A key store whose revoke finds no key, or throws. */
    readonly revokeFails?: 'not-found' | 'throws';
  } = {},
) {
  const keys = new Map<string, StoredKey>();
  const roleAsked: string[] = [];
  const logLines: string[] = [];

  const tokenAdmin: TokenAdmin = {
    async mint(input) {
      const tokenId = randomUUID() as ApiTokenId;
      const record: StoredKey = {
        tokenId,
        secret: `ceiling-test-${keys.size + 1}`,
        ...(input.principal !== undefined && { principal: input.principal }),
        role: input.role,
        capabilities: input.capabilities,
        ...(input.projectId !== undefined && { projectId: input.projectId }),
        ...(input.ceiling !== undefined &&
          options.keepCeiling !== false && { ceiling: input.ceiling }),
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, keys.size)),
      };
      keys.set(tokenId as unknown as string, record);
      return { record, token: record.secret };
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
    async revoke({ tokenId }) {
      if (options.revokeFails === 'not-found') return { kind: 'not-found' };
      if (options.revokeFails === 'throws') throw new TypeError('key store down');
      const k = keys.get(tokenId as unknown as string);
      if (k === undefined) return { kind: 'not-found' };
      keys.set(tokenId as unknown as string, { ...k, revokedAt: new Date() });
      return { kind: 'ok' };
    },
  };

  /** A key put in the store as it is, as a store that let it through would hold it. */
  const seed = (fields: Partial<ApiTokenRecord>): string => {
    const tokenId = randomUUID() as ApiTokenId;
    const secret = `ceiling-seed-${keys.size + 1}`;
    keys.set(
      tokenId as unknown as string,
      {
        tokenId,
        secret,
        principal: { kind: 'user', userId: 'ada' as UserId },
        role: 'member',
        capabilities: [],
        createdAt: new Date(Date.UTC(2026, 9, 1)),
        ...fields,
      } as StoredKey,
    );
    return secret;
  };

  const resolveToken: TokenResolver = async (token) => {
    if (token === ADA) {
      return { tenantId, userId: 'ada' as UserId, scopes: [], capabilities: [] };
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
      ...(k.projectId !== undefined && { tokenProjectId: k.projectId as unknown as string }),
      ...(k.ceiling !== undefined && { tokenCeiling: k.ceiling }),
      ...(options.carriedReviewerRole !== undefined && {
        reviewerRole: options.carriedReviewerRole,
      }),
    };
  };

  /** Every grant is held, and everything is in P1: only the key holds a caller back. */
  const authzCheckBinding = {
    check: async (_p: unknown, action: Action, resource: ResourceRef) => ({
      allowed: true,
      reason: 'test: granted',
      evidence: { action, relation: '', resource: resource.id, actorSubject: 'ada' },
    }),
    checkBatch: async (_p: unknown, _a: unknown, refs: readonly ResourceRef[]) =>
      refs.map(() => ({ allowed: true })),
    inProject: async (_p: unknown, _r: ResourceRef, projectId: string) => projectId === P1,
  } as unknown as AuthzCheckBinding;

  const myAccess: MyAccessBinding = {
    read: async () => ({
      projects: [
        { projectId: P1, name: 'one', role: 'owner', via: [{ kind: 'direct', role: 'owner' }] },
        { projectId: P2, name: 'two', role: 'owner', via: [{ kind: 'direct', role: 'owner' }] },
      ],
      orgs: [],
      teams: [],
      capabilities: {
        owner: {
          agent: ['read', 'write', 'delete', 'execute', 'publish'],
          run: ['read', 'cancel'],
        },
        editor: { agent: ['read', 'write', 'execute', 'publish'], run: ['read', 'cancel'] },
      },
    }),
  };

  const reviewerBinding: ReviewerBinding = {
    resolveReviewer: async ({ userId }) =>
      (userId as unknown as string) === 'ada' ? ('reviewer-ada' as never) : null,
    resolveReviewerRole: async ({ userId }) => {
      roleAsked.push(userId as unknown as string);
      return (userId as unknown as string) === 'ada' ? 'admin' : null;
    },
  };

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tokenAdmin,
    myAccess,
    reviewerBinding,
    logger: createLogger({ write: (line) => logLines.push(line) }),
    triggerRegistry: createInMemoryTriggerRegistry({ defaultProjectId: P1 as ProjectId }),
    ...(options.authz !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });

  const call = async (
    token: string,
    method: 'GET' | 'POST' | 'PATCH',
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
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  const message = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { message?: string } | undefined)?.message ?? '';
  /** Mint as Ada, expecting success: the secret and the key's id. */
  const mint = async (body: Record<string, unknown>) => {
    const r = await call(ADA, 'POST', '/v1/tokens', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { token: r.body.token as string, tokenId: r.body.tokenId as string, body: r.body };
  };
  return { call, code, message, mint, seed, keys, roleAsked, logLines };
}

const SANDBOX = { ceiling: 'sandbox', projectId: P1 };

describe('minting a key with a ceiling', () => {
  test('takes a ceiling only on a member key limited to a project, with no capabilities', async () => {
    const h = harness();
    const refusals: [Record<string, unknown>, string][] = [
      [{ ceiling: 'admin', projectId: P1 }, '`ceiling` must be one of: sandbox'],
      [{ ceiling: 'sandbox' }, 'give its `projectId`'],
      [{ ...SANDBOX, role: 'admin' }, 'is a `member` key'],
      [{ ...SANDBOX, capabilities: ['env:write'] }, 'carries no capabilities'],
    ];
    for (const [body, words] of refusals) {
      const r = await h.call(ADA, 'POST', '/v1/tokens', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(h.message(r)).toContain(words);
    }
    expect(h.keys.size).toBe(0);

    const minted = await h.mint({ ...SANDBOX, role: 'member' });
    expect(minted.body).toMatchObject({ ceiling: 'sandbox', projectId: P1, role: 'member' });
    expect(minted.body.capabilities).toEqual([]);
  });

  test('the ceiling shows in the key list and on the key; a key without one shows none', async () => {
    const h = harness();
    const limited = await h.mint(SANDBOX);
    const plain = await h.mint({ projectId: P1 });

    const list = await h.call(ADA, 'GET', '/v1/tokens');
    expect(list.status).toBe(200);
    const rows = list.body.data as Record<string, unknown>[];
    expect(rows.find((k) => k.tokenId === limited.tokenId)?.ceiling).toBe('sandbox');
    expect(rows.find((k) => k.tokenId === plain.tokenId)).not.toHaveProperty('ceiling');

    const one = await h.call(ADA, 'GET', `/v1/tokens/${limited.tokenId}`);
    expect(one.status).toBe(200);
    expect(one.body.ceiling).toBe('sandbox');
  });

  test("a store that doesn't keep the ceiling: the new key is revoked, and its secret never shown", async () => {
    const h = harness({ keepCeiling: false });
    const r = await h.call(ADA, 'POST', '/v1/tokens', SANDBOX);
    expect(r.status).toBe(500);
    expect(h.code(r)).toBe('key-ceiling-not-kept');
    expect(r.body).not.toHaveProperty('token');
    const [stored] = [...h.keys.values()];
    expect(stored?.revokedAt).toBeDefined();
    expect((await h.call(stored?.secret ?? '', 'GET', '/v1/identity/whoami')).status).toBe(401);
    expect(h.logLines.filter((line) => line.includes('key-ceiling-not-kept'))).toEqual([]);
  });

  test.each([
    ['not-found', 'not-found'],
    ['throws', 'TypeError'],
  ] as const)(
    "the revoke after a ceiling the store didn't keep fails (%s): the same 500, and a warn line naming the key, never its secret",
    async (revokeFails, said) => {
      const h = harness({ keepCeiling: false, revokeFails });
      const r = await h.call(ADA, 'POST', '/v1/tokens', SANDBOX);
      expect(r.status).toBe(500);
      expect(h.code(r)).toBe('key-ceiling-not-kept');
      expect(r.body).not.toHaveProperty('token');
      const [stored] = [...h.keys.values()];
      const warned = h.logLines
        .map((line) => JSON.parse(line) as { level?: string; message?: string })
        .filter((record) => record.message?.startsWith('key-ceiling-not-kept') === true);
      expect(warned).toHaveLength(1);
      expect(warned[0]?.level).toBe('warn');
      expect(warned[0]?.message).toContain(String(stored?.tokenId));
      expect(warned[0]?.message).toContain(`(${said})`);
      for (const line of h.logLines) expect(line).not.toContain(stored?.secret ?? 'unset');
    },
  );
});

describe('a key with a ceiling manages no keys', () => {
  test('every keys route refuses it, and the keys of its person stay as they were', async () => {
    const h = harness();
    const limited = await h.mint(SANDBOX);
    const other = await h.mint({ projectId: P1 });

    const asked = [
      await h.call(limited.token, 'POST', '/v1/tokens', {}),
      await h.call(limited.token, 'POST', '/v1/tokens', SANDBOX),
      await h.call(limited.token, 'GET', '/v1/tokens'),
      await h.call(limited.token, 'GET', `/v1/tokens/${other.tokenId}`),
      await h.call(limited.token, 'POST', `/v1/tokens/${other.tokenId}/revoke`),
      await h.call(limited.token, 'POST', `/v1/tokens/${limited.tokenId}/revoke`),
    ];
    for (const r of asked) {
      expect(r.status).toBe(403);
      expect(h.code(r)).toBe('key-ceiling-refused');
    }
    expect(h.keys.size).toBe(2);
    expect([...h.keys.values()].every((k) => k.revokedAt === undefined)).toBe(true);

    // The same person's key without a ceiling lists them.
    expect((await h.call(other.token, 'GET', '/v1/tokens')).status).toBe(200);
  });
});

describe('a runtime without authorization holds no key to a ceiling', () => {
  test('the mint is refused, and so is every request from such a key', async () => {
    const h = harness({ authz: false });
    const mint = await h.call(ADA, 'POST', '/v1/tokens', SANDBOX);
    expect(mint.status).toBe(501);
    expect(h.code(mint)).toBe('key-ceiling-unsupported');
    expect(h.keys.size).toBe(0);

    const limited = h.seed({ projectId: P1 as ProjectId, ceiling: 'sandbox' });
    const plain = h.seed({ projectId: P1 as ProjectId });
    for (const path of ['/v1/identity/whoami', '/v1/tokens', '/v1/schedules']) {
      const r = await h.call(limited, 'GET', path);
      expect(r.status, path).toBe(501);
      expect(h.code(r)).toBe('key-ceiling-unsupported');
    }
    expect((await h.call(plain, 'GET', '/v1/identity/whoami')).status).toBe(200);
  });
});

describe('a key with a ceiling registers and changes no schedule or trigger', () => {
  const T = `/${TRIGGER}`;
  const writes: Record<string, [method: 'POST' | 'PATCH', path: string][]> = {
    '/v1/schedules': [
      ['POST', ''],
      ['PATCH', T],
      ['POST', `${T}/pause`],
      ['POST', `${T}/resume`],
      ['POST', `${T}/run-now`],
      ['POST', `${T}/owner`],
      ['POST', `${T}/unregister`],
    ],
    '/v1/event-triggers': [
      ['POST', ''],
      ['PATCH', T],
      ['POST', `${T}/pause`],
      ['POST', `${T}/resume`],
      ['POST', `${T}/unregister`],
    ],
    '/v1/mail-triggers': [
      ['POST', ''],
      ['PATCH', T],
      ['POST', `${T}/pause`],
      ['POST', `${T}/resume`],
      ['POST', `${T}/owner`],
      ['POST', `${T}/unregister`],
    ],
    '/v1/webhooks': [
      ['POST', ''],
      ['PATCH', T],
      ['POST', `${T}/pause`],
      ['POST', `${T}/resume`],
      ['POST', `${T}/owner`],
      ['POST', `${T}/unregister`],
    ],
  };

  test.each(Object.keys(writes))('%s: writes and run-now refused, reads not', async (base) => {
    const h = harness();
    const limited = await h.mint(SANDBOX);
    const plain = await h.mint({ projectId: P1 });
    for (const [method, path] of writes[base] ?? []) {
      const body = { projectId: P1 };
      const refused = await h.call(limited.token, method, `${base}${path}`, body);
      expect(refused.status, `${method} ${base}${path}`).toBe(403);
      expect(h.code(refused)).toBe('key-ceiling-refused');
      // A key limited to the same project, without a ceiling, gets past it.
      const passed = await h.call(plain.token, method, `${base}${path}`, body);
      expect(h.code(passed), `${method} ${base}${path}`).not.toBe('key-ceiling-refused');
    }
    expect((await h.call(limited.token, 'GET', base)).status).toBe(200);
  });
});

describe('what whoami and my permissions say of a key with a ceiling', () => {
  test('whoami shows the ceiling, and no reviewer role from the roster', async () => {
    const h = harness();
    const limited = await h.mint(SANDBOX);
    const plain = await h.mint({ projectId: P1 });

    const mine = await h.call(limited.token, 'GET', '/v1/identity/whoami');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ ceiling: 'sandbox', projectId: P1, role: 'member' });
    expect(mine.body).not.toHaveProperty('reviewerRole');
    expect(mine.body.tenantAdmin).toBe(false);
    // The roster isn't even asked for a key with a ceiling.
    expect(h.roleAsked).toEqual([]);

    const theirs = await h.call(plain.token, 'GET', '/v1/identity/whoami');
    expect(theirs.body).not.toHaveProperty('ceiling');
    expect(theirs.body.reviewerRole).toBe('admin');
  });

  test('a reviewer role the key carries is dropped for a key with a ceiling', async () => {
    const h = harness({ carriedReviewerRole: 'senior' });
    const limited = await h.mint(SANDBOX);
    const plain = await h.mint({ projectId: P1 });
    const mine = await h.call(limited.token, 'GET', '/v1/identity/whoami');
    expect(mine.body).not.toHaveProperty('reviewerRole');
    const theirs = await h.call(plain.token, 'GET', '/v1/identity/whoami');
    expect(theirs.body.reviewerRole).toBe('senior');
  });

  test('my permissions: an editor at most, only what the ceiling keeps, no reviewer, no capabilities', async () => {
    const h = harness();
    const limited = await h.mint(SANDBOX);
    const plain = await h.mint({ projectId: P1 });
    // A store that let capabilities through on a key with a ceiling.
    const leaky = h.seed({
      projectId: P1 as ProjectId,
      ceiling: 'sandbox',
      capabilities: ['env:write'],
    });

    const mine = await h.call(limited.token, 'GET', '/v1/identity/me/permissions');
    expect(mine.status).toBe(200);
    expect(mine.body.key).toMatchObject({ ceiling: 'sandbox', projectId: P1, role: 'member' });
    expect(mine.body.projects).toEqual([
      expect.objectContaining({ projectId: P1, role: 'editor' }),
    ]);
    const caps = mine.body.capabilities as Record<string, Record<string, string[]>>;
    expect([...(caps.owner?.agent ?? [])].sort()).toEqual(['execute', 'read', 'write']);
    expect([...(caps.editor?.agent ?? [])].sort()).toEqual(['execute', 'read', 'write']);
    expect([...(caps.owner?.run ?? [])].sort()).toEqual(['cancel', 'read']);
    expect(mine.body.tokenCapabilities).toEqual([]);
    expect(mine.body).not.toHaveProperty('reviewer');
    expect(mine.body.tenant).toMatchObject({ admin: false });

    const theirs = await h.call(plain.token, 'GET', '/v1/identity/me/permissions');
    expect(theirs.body.projects).toEqual([
      expect.objectContaining({ projectId: P1, role: 'owner' }),
    ]);
    const theirCaps = theirs.body.capabilities as Record<string, Record<string, string[]>>;
    expect(theirCaps.owner?.agent).toContain('publish');
    expect(theirs.body.reviewer).toMatchObject({ role: 'admin' });

    const leaked = await h.call(leaky, 'GET', '/v1/identity/me/permissions');
    expect(leaked.body.tokenCapabilities).toEqual([]);
  });

  test("the approvals' reviewer role: none for a key with a ceiling, whatever it carries or its person holds", async () => {
    const roleAsked: string[] = [];
    const binding: ReviewerBinding = {
      resolveReviewer: async () => 'reviewer-ada' as never,
      resolveReviewerRole: async ({ userId }) => {
        roleAsked.push(userId as unknown as string);
        return 'admin';
      },
    };
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('tenantId', tenantId as never);
      c.set('userId', 'ada' as never);
      c.set('reviewerRole', 'admin');
      c.set('tokenCeiling', 'sandbox');
      return c.json({ role: (await callerReviewerRole(c, binding)) ?? null });
    });
    expect(await (await r.request('/')).json()).toEqual({ role: null });
    expect(roleAsked).toEqual([]);
  });
});

describe('the authorizer holds a key with a ceiling to it, whatever its principal holds', () => {
  /** An authorizer whose store grants everything and places everything in P1. */
  const authorizer = createAuthorizer({
    check: async () => ({ allowed: true }),
    checkBatch: async (_p: unknown, _a: unknown, refs: readonly ResourceRef[]) =>
      refs.map(() => ({ allowed: true })),
    inProject: async (_p: unknown, _r: ResourceRef, projectId: string) => projectId === P1,
  } as unknown as AuthzCheckBinding);

  async function decide(
    keyProject: string | undefined,
    asks: readonly [Action, ObjectType, string][],
  ): Promise<{ allowed: boolean; failing?: string; reason?: string }[]> {
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('principal' as never, userPrincipal('ada' as UserId, tenantId) as never);
      c.set('tokenRole', 'member');
      c.set('tokenCeiling', 'sandbox');
      if (keyProject !== undefined) c.set('tokenProjectId', keyProject);
      const out: unknown[] = [];
      for (const [action, type, id] of asks) {
        out.push(await authorizer.check(c, action, ref(type, id)));
      }
      return c.json(out);
    });
    return (await (await r.request('/')).json()) as {
      allowed: boolean;
      failing?: string;
      reason?: string;
    }[];
  }

  test('in its project: what an editor holds, less what the ceiling refuses', async () => {
    const asks: [Action, ObjectType, string, boolean][] = [
      ['read', 'agent', 'a1', true],
      ['write', 'agent', 'a1', true],
      ['execute', 'agent', 'a1', true],
      ['cancel', 'run', 'r1', true],
      ['call', 'project', P1, true],
      ['read', 'trigger', 't1', true],
      ['read', 'tenant', tenantId as unknown as string, true],
      ['read', 'org', 'o1', true],
      ['publish', 'agent', 'a1', false],
      ['delete', 'agent', 'a1', false],
      ['pin', 'agent', 'a1', false],
      ['invoke', 'tool', 'tl1', false],
      ['write', 'trigger', 't1', false],
      ['fire', 'trigger', 't1', false],
      ['read', 'secret', 's1', false],
      ['read', 'env', 'e1', false],
      ['read', 'mcp_endpoint', 'm1', false],
      ['act_as', 'service_account', 'sa1', false],
      ['admin', 'project', P1, false],
      ['admin', 'tenant', tenantId as unknown as string, false],
      ['admin', 'team', 'tm1', false],
      ['read', 'project', P2, false],
    ];
    const got = await decide(
      P1,
      asks.map(([a, t, id]) => [a, t, id]),
    );
    for (const [i, [action, type, , allowed]] of asks.entries()) {
      expect(got[i]?.allowed, `${action} ${type}`).toBe(allowed);
    }
    const publish = got[asks.findIndex(([a]) => a === 'publish')];
    expect(publish).toMatchObject({ failing: 'scope' });
    expect(publish?.reason).toContain('sandbox ceiling');
  });

  test('with no project (a store that lost it): no action at all', async () => {
    const got = await decide(undefined, [
      ['read', 'agent', 'a1'],
      ['read', 'tenant', tenantId as unknown as string],
      ['read', 'project', P1],
    ]);
    expect(got.map((d) => d.allowed)).toEqual([false, false, false]);
  });

  test('a filtered list keeps only what the ceiling keeps', async () => {
    const r = new Hono<AppEnv>();
    r.get('/', async (c) => {
      c.set('principal' as never, userPrincipal('ada' as UserId, tenantId) as never);
      c.set('tokenCeiling', 'sandbox');
      c.set('tokenProjectId', P1);
      const ids = ['a1', 'a2'];
      return c.json({
        read: await authorizer.filterByCan(c, 'read', ids, (id) => ref('agent', id)),
        publish: await authorizer.filterByCan(c, 'publish', ids, (id) => ref('agent', id)),
      });
    });
    expect(await (await r.request('/')).json()).toEqual({ read: ['a1', 'a2'], publish: [] });
  });
});

describe('a check that holds a key by its project holds a ceiling key without one', () => {
  test("a route for its person in every project refuses it, with the ceiling's name", async () => {
    const r = new Hono<AppEnv>();
    r.get('/:who', (c) => {
      c.set('tenantId', tenantId as never);
      c.set('userId', 'ada' as never);
      if (c.req.param('who') === 'ceiling') c.set('tokenCeiling', 'sandbox');
      const refusal = personWideRefusal(
        c,
        undefined,
        'write',
        ref('user', 'ada'),
        "its person's sessions reach beyond it",
      );
      return refusal ?? c.json({ ok: true });
    });
    const ceiling = await r.request('/ceiling');
    expect(ceiling.status).toBe(403);
    const { error } = (await ceiling.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('permission-denied');
    expect(error.message).toBe(
      "This API key has the sandbox ceiling: its person's sessions reach beyond it",
    );
    expect((await r.request('/plain')).status).toBe(200);
  });
});

describe('the sandbox ceiling, type by type and action by action', () => {
  /** What a key with the `sandbox` ceiling keeps, by name, in `ACTIONS` order. */
  const KEPT: Record<ObjectType, readonly Action[]> = {
    tenant: ['read'],
    org: ['read'],
    team: ['read'],
    project: ['read', 'write', 'execute', 'call'],
    user: [],
    service_account: [],
    agent: ['read', 'write', 'execute'],
    flow: ['read', 'write', 'execute'],
    tool: ['read', 'write'],
    guardrail: ['read', 'write'],
    test_set: ['read', 'write', 'execute'],
    trigger: ['read'],
    conversation: ['read', 'write'],
    secret: [],
    env: [],
    mcp_endpoint: [],
    run: ['read', 'cancel'],
  };
  /** The actions it never keeps, on any type. */
  const REFUSED: readonly Action[] = [
    'delete',
    'admin',
    'invoke',
    'publish',
    'rotate',
    'fire',
    'pin',
    'act_as',
  ];

  test('the whole table: every type, every action', () => {
    const got = Object.fromEntries(
      OBJECT_TYPES.map((type) => [type, ACTIONS.filter((action) => ceilingKeeps(action, type))]),
    );
    expect(got).toEqual(KEPT);
  });

  test('every action is kept or refused, never both', () => {
    expect([...KEY_CEILING_KEEPS, ...REFUSED].sort()).toEqual([...ACTIONS].sort());
    expect(KEY_CEILING_KEEPS.filter((a) => REFUSED.includes(a))).toEqual([]);
  });

  test('below the project, never more than a plain editor holds', () => {
    expect(Object.keys(PROJECT_EDITOR_ACTIONS).sort()).toEqual([...OBJECT_TYPES].sort());
    for (const type of OBJECT_TYPES) {
      if (['tenant', 'org', 'team'].includes(type)) continue;
      for (const action of KEPT[type]) {
        expect(PROJECT_EDITOR_ACTIONS[type], `${action} ${type}`).toContain(action);
      }
    }
  });
});
