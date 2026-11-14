// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A key that only reads (`readOnly` at mint): every request it makes but a
 * `GET` or a `HEAD` is refused before any route, apart from the reads that
 * are posts (`READ_ONLY_POSTS`); it mints and revokes no keys and opens no
 * console session; the authorizer holds it to `read`; and the answers say
 * so. In-memory doubles for the key store, the authorization check and
 * what a caller holds.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type ResourceRef,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import type { ApiTokenId, TenantId, UserId } from '@kindgi/types';
import { Hono } from 'hono';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ApiTokenRecord,
  MyAccessBinding,
  RunHandlerBinding,
  SessionStoreBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';
import { createAuthorizer } from '../src/middleware/authorize.js';
import { READ_ONLY_KEY_MESSAGE } from '../src/middleware/key-read-only.js';
import { tokenSignInRouter } from '../src/routes/token-sign-in.js';
import { tokensRouter } from '../src/routes/tokens.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000a1' as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';

/** Alice's keys, as the resolver maps them; the ones minted here come from the store. */
const STATIC = 'static-alice';
const FULL = 'kgi_ak_full';
const FULL_SCOPE = 'kgi_ak_full_scope';
const RO = 'kgi_ak_ro';
const RO_CAPS = 'kgi_ak_ro_caps';
const RO_SCOPE = 'kgi_ak_ro_scope';

type StoredKey = ApiTokenRecord & { secret: string };

function harness(
  options: {
    authz?: boolean;
    /** The store keeps `readOnly` (default); false: it drops the field, as an old store would. */
    keepsReadOnly?: boolean;
    revokeThrows?: boolean;
  } = {},
) {
  const keys = new Map<string, StoredKey>();
  const lines: string[] = [];
  const asked: string[] = [];

  const tokenAdmin: TokenAdmin = {
    async mint(input) {
      const tokenId = randomUUID() as ApiTokenId;
      const secret = `kgi_ak_test_${keys.size + 1}`;
      const record: StoredKey = {
        tokenId,
        secret,
        ...(input.principal !== undefined && { principal: input.principal }),
        role: input.role,
        capabilities: input.capabilities,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.readOnly === true && options.keepsReadOnly !== false && { readOnly: true }),
        ...(input.createdBy !== undefined && { createdBy: input.createdBy }),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, keys.size)),
      };
      keys.set(tokenId as unknown as string, record);
      return { record, token: secret };
    },
    async list({ limit }) {
      return [...keys.values()].slice(0, limit);
    },
    async get({ tokenId }) {
      return keys.get(tokenId as unknown as string);
    },
    async revoke({ tokenId }) {
      if (options.revokeThrows === true) throw new Error('the key store is down');
      const k = keys.get(tokenId as unknown as string);
      if (k === undefined) return { kind: 'not-found' };
      keys.set(tokenId as unknown as string, { ...k, revokedAt: new Date() });
      return { kind: 'ok' };
    },
  };

  const alice = { tenantId, userId: 'alice' as UserId, scopes: [] as string[], capabilities: [] };
  const id = (s: string) => s as unknown as ApiTokenId;
  const resolveToken: TokenResolver = async (token) => {
    switch (token) {
      case STATIC:
        return alice;
      case FULL:
        return { ...alice, tokenId: id('k-full'), tokenRole: 'admin' };
      case FULL_SCOPE:
        return {
          ...alice,
          tokenId: id('k-full-scope'),
          scopes: ['tenant-admin'],
          tokenRole: 'admin',
        };
      case RO:
        return { ...alice, tokenId: id('k-ro'), tokenRole: 'admin', tokenReadOnly: true };
      case RO_CAPS:
        return {
          ...alice,
          tokenId: id('k-ro-caps'),
          capabilities: ['env:write'],
          tokenReadOnly: true,
        };
      case RO_SCOPE:
        return {
          ...alice,
          tokenId: id('k-ro-scope'),
          scopes: ['tenant-admin'],
          tokenRole: 'admin',
          tokenReadOnly: true,
        };
    }
    const k = [...keys.values()].find((x) => x.secret === token);
    if (k === undefined || k.revokedAt !== undefined) return null;
    return {
      ...alice,
      tokenId: k.tokenId,
      capabilities: k.capabilities,
      tokenRole: k.role,
      ...(k.readOnly === true && { tokenReadOnly: true }),
    };
  };

  /** Alice holds every right; what the store was asked is kept. */
  const granted = (action: Action, resource: ResourceRef): Decision => ({
    allowed: true,
    reason: 'test: granted',
    evidence: { action, relation: '', resource: resource.id, actorSubject: 'alice' },
  });
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (_principal, action, resource) => {
      asked.push(`${action} ${resource.type}`);
      return granted(action, resource);
    },
    checkBatch: async (_principal, action, refs) => {
      for (const r of refs) asked.push(`${action} ${r.type}`);
      return refs.map((r) => granted(action, r));
    },
  };

  /** Alice is an admin of P1 and of its org. */
  const myAccess: MyAccessBinding = {
    read: async () => ({
      projects: [
        { projectId: P1, name: 'one', role: 'admin', via: [{ kind: 'direct', role: 'admin' }] },
      ],
      orgs: [{ orgId: 'o1', name: 'org one', role: 'admin' }],
      teams: [],
      capabilities: {},
    }),
  };

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    tokenAdmin,
    myAccess,
    // the agent routes, for the pin check: nothing past its body's check is asked
    agentRegistry: {} as never,
    agentPins: {} as never,
    logger: createLogger({ level: 'info', write: (l) => lines.push(l) }),
    ...(options.authz !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });

  const call = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; text: string }> => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // a HEAD's empty answer, or one that isn't JSON
    }
    return { status: res.status, body: parsed, text };
  };
  const error = (r: { body: Record<string, unknown> }) =>
    r.body.error as { code?: string; message?: string } | undefined;
  /** Mint as `as`, expecting success: the secret and the key's id. */
  const mint = async (as: string, body: Record<string, unknown> = {}) => {
    const r = await call(as, 'POST', '/v1/tokens', body);
    expect(r.status, r.text).toBe(201);
    return { token: r.body.token as string, tokenId: r.body.tokenId as string, body: r.body };
  };
  return { app, call, error, mint, keys, lines, asked, tokenAdmin };
}

/** A request with a key that only reads, refused before any route asked the store. */
async function expectRefused(
  h: ReturnType<typeof harness>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  h.asked.length = 0;
  const r = await h.call(token, method, path, body);
  expect(r.status, `${method} ${path}: ${r.text}`).toBe(403);
  expect(h.error(r), `${method} ${path}`).toMatchObject({
    code: 'read-only-key',
    message: READ_ONLY_KEY_MESSAGE,
  });
  expect(h.asked, `${method} ${path}`).toEqual([]);
}

/** An answer without its request id, to compare two callers' answers. */
function answerOf(r: { status: number; body: Record<string, unknown> }) {
  const error = r.body.error as Record<string, unknown> | undefined;
  if (error === undefined) return { status: r.status, body: r.body };
  const { requestId: _requestId, ...rest } = error;
  return { status: r.status, error: rest };
}

describe('minting a key that only reads', () => {
  test('`readOnly: true` is kept, and the key reads say so', async () => {
    const h = harness();
    const key = await h.mint(STATIC, { label: 'sandbox', readOnly: true });
    expect(key.body.readOnly).toBe(true);
    const got = await h.call(STATIC, 'GET', `/v1/tokens/${key.tokenId}`);
    expect(got.status).toBe(200);
    expect(got.body.readOnly).toBe(true);
    const listed = await h.call(STATIC, 'GET', '/v1/tokens');
    expect(listed.status).toBe(200);
    const rows = listed.body.data as { tokenId: string; readOnly?: boolean }[];
    expect(rows.find((k) => k.tokenId === key.tokenId)?.readOnly).toBe(true);
  });

  test('a key minted without the field, or with `false`, is as before', async () => {
    const h = harness();
    for (const body of [{ label: 'plain' }, { label: 'false', readOnly: false }]) {
      const key = await h.mint(STATIC, body);
      expect('readOnly' in key.body).toBe(false);
      expect(h.keys.get(key.tokenId)?.readOnly).toBeUndefined();
      // and it writes: an unknown path is a 404, not a refusal
      const r = await h.call(key.token, 'POST', '/v1/no-such-route', {});
      expect(r.status).toBe(404);
    }
  });

  test('`readOnly: "yes"` is a 400, and no key is made', async () => {
    const h = harness();
    const r = await h.call(STATIC, 'POST', '/v1/tokens', { readOnly: 'yes' });
    expect(r.status).toBe(400);
    expect(h.error(r)?.message).toContain('`readOnly` must be a boolean');
    expect(h.keys.size).toBe(0);
  });

  test('a store that drops the field: 501, no secret, the key revoked, and its id logged', async () => {
    const h = harness({ keepsReadOnly: false });
    const r = await h.call(STATIC, 'POST', '/v1/tokens', { readOnly: true });
    expect(r.status).toBe(501);
    expect(h.error(r)).toMatchObject({
      code: 'read-only-unsupported',
      message:
        "This server can't keep a key's read-only limit, so no key was made. Ask whoever runs Kindgi to update it.",
    });
    const [made] = [...h.keys.values()];
    expect(made).toBeDefined();
    expect(r.text).not.toContain(made?.secret);
    expect(r.text).not.toContain('"token"');
    expect(made?.revokedAt).toBeInstanceOf(Date);
    // the key it made reaches nothing
    expect((await h.call(made?.secret as string, 'GET', '/v1/identity/whoami')).status).toBe(401);
    const logged = h.lines.filter((l) => l.includes("didn't keep readOnly"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(made?.tokenId as unknown as string);
    expect(logged[0]).toContain('revoked');
    expect(h.lines.join('\n')).not.toContain(made?.secret);
  });

  test('a revoke that fails there: still 501, no secret, and the id logged', async () => {
    const h = harness({ keepsReadOnly: false, revokeThrows: true });
    const r = await h.call(STATIC, 'POST', '/v1/tokens', { readOnly: true });
    expect(r.status).toBe(501);
    expect(h.error(r)?.code).toBe('read-only-unsupported');
    const [made] = [...h.keys.values()];
    expect(r.text).not.toContain(made?.secret);
    const logged = h.lines.filter((l) => l.includes("didn't keep readOnly"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(made?.tokenId as unknown as string);
    expect(logged[0]).toContain('its revoke failed');
    expect(h.lines.join('\n')).not.toContain(made?.secret);
  });
});

describe('the gate: a key that only reads gets reads only', () => {
  test('every other request is refused before any route, 403 read-only-key, in plain words', async () => {
    const h = harness();
    const cases: [string, string, unknown?][] = [
      ['POST', '/v1/deployments', {}], // a deploy
      ['POST', '/v1/agents', {}], // an agent version's publish
      ['POST', '/v1/agents/a1/pinned/pin', {}], // a pin
      ['POST', '/v1/deployments/d1/promotions', {}], // a promotion
      ['POST', '/v1/deployments/d1/secrets', {}], // a secrets sync
      ['PUT', '/v1/agents/a1/owner', {}],
      ['PATCH', '/v1/corrections/c1', {}],
      ['DELETE', '/v1/memory/facts/f1'],
      ['POST', '/v1/no-such-route', {}],
      // the rule is the method's: one no route knows is refused too
      ['PROPFIND', '/v1/agents'],
      ['OPTIONS', '/v1/agents'],
    ];
    for (const [method, path, body] of cases) await expectRefused(h, RO, method, path, body);
  });

  test('a key minted with `readOnly` is held by it, as a resolver that says so is', async () => {
    const h = harness();
    const key = await h.mint(STATIC, { readOnly: true });
    await expectRefused(h, key.token, 'POST', '/v1/deployments', {});
    expect((await h.call(key.token, 'GET', '/v1/identity/whoami')).status).toBe(200);
  });

  test('reads pass', async () => {
    const h = harness();
    expect((await h.call(RO, 'GET', '/v1/identity/whoami')).status).toBe(200);
    expect((await h.call(RO, 'HEAD', '/v1/identity/whoami')).status).toBe(200);
    expect((await h.call(RO, 'GET', '/v1/tokens')).status).toBe(200);
    expect((await h.call(RO, 'GET', '/v1/no-such-route')).status).toBe(404);
  });

  test('a full key on the same requests is untouched', async () => {
    const h = harness();
    for (const [method, path] of [
      ['POST', '/v1/no-such-route'],
      ['DELETE', '/v1/no-such-route'],
    ] as const) {
      const r = await h.call(FULL, method, path, method === 'POST' ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
    }
  });

  test('the pin check reaches its own handler, with the answer a full key gets', async () => {
    const h = harness();
    const path = '/v1/agents/a1/pinned/check';
    const full = await h.call(FULL, 'POST', path, {});
    h.asked.length = 0;
    const ro = await h.call(RO, 'POST', path, {});
    // the handler's own check of its body
    expect(ro.status, ro.text).toBe(400);
    expect(h.error(ro)?.message).toContain('`scope.kind` must be one of');
    expect(answerOf(ro)).toEqual(answerOf(full));
    // and it asks `read` of the agent, nothing more
    expect(h.asked).toEqual(['read agent']);
  });

  test("the pin check's look-alikes are refused: a trailing slash, an escaped slash, a doubled one", async () => {
    const h = harness();
    for (const path of [
      '/v1/agents/a1/pinned/check/',
      '/v1/agents/a%2Fb/pinned/check',
      '/v1/agents//pinned/check',
      '/v1//agents/a1/pinned/check',
      '/v1/agents/a1/pinned//check',
    ]) {
      await expectRefused(h, RO, 'POST', path, {});
    }
  });

  test('reads that are posts but ask more than `read`, or call out, stay refused', async () => {
    const h = harness();
    for (const path of [
      '/v1/deployments/check',
      '/v1/deployments/d1/promotions/check',
      '/v1/improve-runs/check',
      '/v1/memory/retrieve',
    ]) {
      await expectRefused(h, RO, 'POST', path, {});
    }
  });

  test("the routes that ask about another's rights (a trigger's owner) are refused at the gate", async () => {
    const h = harness();
    await expectRefused(h, RO, 'POST', '/v1/schedules', {});
    await expectRefused(h, RO, 'POST', '/v1/mail-triggers', {});
  });

  test('a read-only key with capabilities, and one with the tenant-admin scope, are refused a write', async () => {
    const h = harness();
    await expectRefused(h, RO_CAPS, 'POST', '/v1/deployments/d1/secrets', {});
    await expectRefused(h, RO_SCOPE, 'POST', '/v1/service-accounts', { name: 'ci' });
  });

  test('without an authorization store: a write is still refused, and the scope makes no tenant admin', async () => {
    const h = harness({ authz: false });
    await expectRefused(h, RO, 'POST', '/v1/deployments', {});
    await expectRefused(h, RO_SCOPE, 'POST', '/v1/service-accounts', { name: 'ci' });
    expect((await h.call(RO_SCOPE, 'GET', '/v1/identity/whoami')).body.tenantAdmin).toBe(false);
    expect((await h.call(FULL_SCOPE, 'GET', '/v1/identity/whoami')).body.tenantAdmin).toBe(true);
  });
});

describe('keys and sessions: a key that only reads makes neither', () => {
  test('its mint and revoke are refused, its own key included, and nothing changes', async () => {
    const h = harness();
    const other = await h.mint(STATIC, { label: 'other' });
    const own = await h.mint(STATIC, { label: 'own', readOnly: true });
    const before = h.keys.size;
    await expectRefused(h, own.token, 'POST', '/v1/tokens', { label: 'more' });
    await expectRefused(h, own.token, 'POST', `/v1/tokens/${other.tokenId}/revoke`);
    await expectRefused(h, own.token, 'POST', `/v1/tokens/${own.tokenId}/revoke`);
    expect(h.keys.size).toBe(before);
    expect(h.keys.get(other.tokenId)?.revokedAt).toBeUndefined();
    // its own record still says it only reads: no route changes the field
    const got = await h.call(own.token, 'GET', `/v1/tokens/${own.tokenId}`);
    expect(got.status).toBe(200);
    expect(got.body.readOnly).toBe(true);
    expect(got.body.revokedAt).toBeUndefined();
  });

  test('the keys routes refuse it themselves, without the gate', async () => {
    const h = harness();
    const other = await h.mint(STATIC, { label: 'other' });
    const before = h.keys.size;
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('requestId', 'req-1');
      c.set('log', createLogger({ level: 'info', write: () => {} }));
      c.set('tenantId', tenantId);
      c.set('userId', 'alice' as UserId);
      c.set('tokenId', 'k-ro' as never);
      c.set('tokenReadOnly', true);
      await next();
    });
    r.route('/tokens', tokensRouter(h.tokenAdmin));
    const post = (path: string, body?: unknown) =>
      r.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    for (const res of [
      await post('/tokens', { label: 'more' }),
      await post(`/tokens/${other.tokenId}/revoke`),
    ]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('read-only-key');
    }
    expect(h.keys.size).toBe(before);
    expect(h.keys.get(other.tokenId)?.revokedAt).toBeUndefined();
  });

  test('token sign-in is refused at the gate', async () => {
    const h = harness();
    await expectRefused(h, RO, 'POST', '/v1/auth/token-sign-in');
  });

  test('token sign-in refuses it itself, without the gate: the session would carry none of its limits', async () => {
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('requestId', 'req-1');
      c.set('log', createLogger({ level: 'info', write: () => {} }));
      c.set('tenantId', tenantId);
      c.set('userId', 'alice' as UserId);
      c.set('tokenId', 'k-ro' as never);
      c.set('tokenReadOnly', true);
      await next();
    });
    r.route(
      '/',
      tokenSignInRouter({
        enabled: true,
        sessionStore: {} as SessionStoreBinding,
        ttlMs: 60_000,
        cookieName: 'kgi_session',
      }),
    );
    const res = await r.request('/', { method: 'POST' });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe('token-sign-in-not-allowed');
    expect(error.message).toContain('reads only');
  });
});

describe('the authorizer holds a key that only reads to `read`', () => {
  const authorizer = createAuthorizer({
    check: async () => ({ allowed: true }),
    checkBatch: async (_p: unknown, _a: unknown, refs: readonly ResourceRef[]) =>
      refs.map(() => ({ allowed: true })),
  } as unknown as AuthzCheckBinding);
  function route(readOnly: boolean) {
    const r = new Hono<AppEnv>();
    r.use('*', async (c, next) => {
      c.set('principal' as never, userPrincipal('alice' as UserId, tenantId) as never);
      c.set('log', createLogger({ level: 'info', write: () => {} }));
      if (readOnly) c.set('tokenReadOnly', true);
      await next();
    });
    r.get('/decide', async (c) => {
      const agent = ref('agent', 'a1');
      const write = await authorizer.check(c, 'write', agent);
      return c.json({
        write,
        read: (await authorizer.check(c, 'read', agent)).allowed,
        canPublish: await authorizer.can(c, 'publish', agent),
        canRead: await authorizer.can(c, 'read', agent),
        canAdmin: await authorizer.can(c, 'admin', ref('tenant', tenantId as unknown as string)),
      });
    });
    r.post(
      '/act',
      authorizer.authorize('execute', () => ref('agent', 'a1')),
      (c) => c.json({ ok: true }),
    );
    return r;
  }

  test('check and can deny every action but `read`, as the key, and say why', async () => {
    const got = await (await route(true).request('/decide')).json();
    expect(got).toMatchObject({
      write: { allowed: false, failing: 'scope', reason: 'the API key can only read' },
      read: true,
      canPublish: false,
      canRead: true,
      canAdmin: false,
    });
  });

  test('authorize refuses it; any other key passes the same', async () => {
    expect((await route(true).request('/act', { method: 'POST' })).status).toBe(403);
    expect((await route(false).request('/act', { method: 'POST' })).status).toBe(200);
    const full = await (await route(false).request('/decide')).json();
    expect(full).toMatchObject({ write: { allowed: true }, canPublish: true, canAdmin: true });
  });
});

describe('the answers say what the key can do', () => {
  test('my permissions: a read-only key shows as a viewer and a member, and says it only reads', async () => {
    const h = harness();
    const ro = await h.call(RO, 'GET', '/v1/identity/me/permissions');
    expect(ro.status, ro.text).toBe(200);
    expect(ro.body).toMatchObject({
      tenant: { admin: false },
      key: { tokenId: 'k-ro', role: 'admin', readOnly: true },
      projects: [{ projectId: P1, role: 'viewer' }],
      orgs: [{ orgId: 'o1', role: 'member' }],
    });
    const full = await h.call(FULL, 'GET', '/v1/identity/me/permissions');
    expect(full.body).toMatchObject({
      key: { tokenId: 'k-full', readOnly: false },
      projects: [{ projectId: P1, role: 'admin' }],
      orgs: [{ orgId: 'o1', role: 'admin' }],
    });
    const plain = await h.call(STATIC, 'GET', '/v1/identity/me/permissions');
    expect('key' in plain.body).toBe(false);
  });

  test("whoami: `readOnly` beside a key's id, true or false; a token that isn't a key has none", async () => {
    const h = harness();
    const ro = await h.call(RO, 'GET', '/v1/identity/whoami');
    expect(ro.body).toMatchObject({ tokenId: 'k-ro', readOnly: true, tenantAdmin: false });
    const full = await h.call(FULL, 'GET', '/v1/identity/whoami');
    expect(full.body).toMatchObject({ tokenId: 'k-full', readOnly: false });
    const plain = await h.call(STATIC, 'GET', '/v1/identity/whoami');
    expect('readOnly' in plain.body).toBe(false);
    // the tenant-admin scope makes no tenant admin of a key that only reads
    expect((await h.call(RO_SCOPE, 'GET', '/v1/identity/whoami')).body.tenantAdmin).toBe(false);
  });
});
