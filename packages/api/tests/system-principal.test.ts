// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { ApiTokenId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import {
  SYSTEM_TENANT_ID,
  createApp,
  systemPrincipalFence,
  withSystemTenantContext,
} from '../src/index.js';
import type {
  ApiTokenRecord,
  AppEnv,
  RunHandlerBinding,
  SystemAccessRecord,
  SystemKeyRecord,
  SystemKeysBinding,
  SystemTenantDirectory,
  TokenAdmin,
  TokenResolution,
} from '../src/index.js';

/**
 * The operator's system principal: a system key (`kgi_sy_…`) or, on a
 * runtime serving many tenants, the deployment's own token. It acts in no
 * tenant, reaches `/v1/system/*` (and the license) only, needs the scope
 * each system route takes, and every request it makes is recorded. A
 * tenant's key never gets there, whatever its capabilities.
 */

const tenantId = randomUUID() as TenantId;
const HOUR = 60 * 60 * 1000;

/** System keys in memory, resolving as system principals. */
function makeSystemKeys() {
  const keys = new Map<string, SystemKeyRecord & { readonly secret: string }>();
  const binding: SystemKeysBinding = {
    async mint(input) {
      const id = randomUUID();
      const secret = `kgi_sy_${id}_${randomBytes(16).toString('base64url')}`;
      const record = {
        id,
        scopes: input.scopes,
        createdAt: new Date(),
        mintedBy: input.mintedBy,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      };
      keys.set(id, { ...record, secret });
      return { record, token: secret };
    },
    async list() {
      return [...keys.values()].map(({ secret: _secret, ...r }) => r).reverse();
    },
    async revoke(id) {
      const k = keys.get(id);
      if (k === undefined) return null;
      const revoked = { ...k, revokedAt: k.revokedAt ?? new Date() };
      keys.set(id, revoked);
      const { secret: _secret, ...r } = revoked;
      return r;
    },
  };
  const resolve = (token: string): TokenResolution | null => {
    const k = [...keys.values()].find((x) => x.secret === token);
    if (k === undefined) return null;
    return {
      tenantId: SYSTEM_TENANT_ID,
      system: { keyId: k.id },
      capabilities: k.scopes,
      ...(k.expiresAt !== undefined && { expiresAt: k.expiresAt }),
      ...(k.revokedAt !== undefined && { revoked: true }),
    };
  };
  return { binding, resolve, keys };
}

/** Tenant keys in memory: they keep whatever capabilities they were minted with. */
function makeTenantKeys() {
  const records = new Map<string, ApiTokenRecord & { readonly secret: string }>();
  const admin: TokenAdmin = {
    async mint(input) {
      const tokenId = randomUUID() as ApiTokenId;
      const secret = `kgi_ak_test_${randomBytes(8).toString('hex')}`;
      const record: ApiTokenRecord = {
        tokenId,
        role: input.role,
        capabilities: input.capabilities,
        createdAt: new Date(),
        ...(input.principal !== undefined && { principal: input.principal }),
      };
      records.set(tokenId, { ...record, secret });
      return { record, token: secret };
    },
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async revoke() {
      return { kind: 'not-found' };
    },
  };
  /** A key made in single mode by the deployment's own token: it holds `kindgi:system`. */
  const legacy = 'kgi_ak_legacy_operator';
  const resolve = (token: string): TokenResolution | null => {
    if (token === legacy) {
      return {
        tenantId,
        tokenId: randomUUID() as ApiTokenId,
        tokenRole: 'admin',
        scopes: ['tenant-admin'],
        capabilities: ['kindgi:system'],
      };
    }
    const r = [...records.values()].find((x) => x.secret === token);
    return r === undefined
      ? null
      : { tenantId, tokenId: r.tokenId, tokenRole: r.role, capabilities: r.capabilities };
  };
  return { admin, resolve, legacy };
}

/** The single-mode boot token: a tenant admin of `tenantId`, with every capability. */
const SINGLE_BOOT = 'kgi_bt_single';
/** The multi-mode boot token: a system principal with the full capability. */
const MULTI_BOOT = 'kgi_bt_multi';

function makeApp(tenancy: 'single' | 'multi' = 'multi') {
  const system = makeSystemKeys();
  const tenant = makeTenantKeys();
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenancy,
    resolveToken: async (token) => {
      if (token === SINGLE_BOOT) {
        return {
          tenantId,
          userId: 'user-seed' as UserId,
          scopes: ['tenant-admin'],
          capabilities: ['secrets:write', 'kindgi:system'],
        };
      }
      if (token === MULTI_BOOT) {
        return {
          tenantId: SYSTEM_TENANT_ID,
          system: { keyId: 'boot' },
          capabilities: ['kindgi:system'],
        };
      }
      return system.resolve(token) ?? tenant.resolve(token);
    },
    runHandler: {} as RunHandlerBinding,
    tokenAdmin: tenant.admin,
    systemKeys: system.binding,
    systemAccessAudit: {
      async record(entry) {
        audit.push(entry);
      },
    },
    license: { status: () => ({ mode: 'licensed', name: 'Acme', use: 'production' }) },
  });
  const call = async (
    token: string,
    method: string,
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
  const mintSystemKey = async (scopes: string[], extra: Record<string, unknown> = {}) => {
    const r = await call(MULTI_BOOT, 'POST', '/v1/system/keys', { scopes, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { id: string; token: string };
  };
  return { app, call, code, audit, mintSystemKey, tenant };
}

describe('the fence: a system principal reaches /v1/system/* and the license only', () => {
  test('a system key on a tenant route is refused before the route runs, and recorded', async () => {
    const { call, code, audit, mintSystemKey } = makeApp();
    const key = await mintSystemKey(['system:tenants']);
    for (const [method, path] of [
      ['GET', '/v1/tenant'],
      ['GET', '/v1/tokens'],
      ['POST', '/v1/tokens'],
      ['GET', '/v1/identity/whoami'],
    ] as const) {
      const r = await call(key.token, method, path, method === 'POST' ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe('system-key-on-tenant-route');
    }
    const refusals = audit.filter((a) => a.keyId === key.id && a.status === 403);
    expect(refusals.map((a) => `${a.method} ${a.path}`)).toEqual([
      'GET /v1/tenant',
      'GET /v1/tokens',
      'POST /v1/tokens',
      'GET /v1/identity/whoami',
    ]);
  });

  test("the multi-mode boot token is fenced in the same way: it's no tenant's admin", async () => {
    const { call, code } = makeApp();
    const r = await call(MULTI_BOOT, 'GET', '/v1/tenant');
    expect(r.status).toBe(403);
    expect(code(r)).toBe('system-key-on-tenant-route');
  });

  test('a system key holding system:license reads the license as the operator does', async () => {
    const { call, code, audit, mintSystemKey } = makeApp();
    const renewer = await mintSystemKey(['system:license']);
    const r = await call(renewer.token, 'GET', '/v1/license');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ mode: 'licensed', name: 'Acme', use: 'production' });
    expect(audit.at(-1)).toMatchObject({
      keyId: renewer.id,
      method: 'GET',
      path: '/v1/license',
      status: 200,
      scope: 'system:license',
    });
    // Any other scope doesn't read it.
    const other = await mintSystemKey(['system:tenants']);
    const refused = await call(other.token, 'GET', '/v1/license');
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('license-operator-only');
  });

  test("a tenant's requests pass untouched and aren't on the system access record", async () => {
    const { call, audit } = makeApp('single');
    const r = await call(SINGLE_BOOT, 'GET', '/v1/tenant');
    expect(r.status).not.toBe(403);
    expect(audit).toEqual([]);
  });
});

describe('system routes need a system principal, then the scope', () => {
  test("a tenant's key is refused on every system route, whatever capabilities it holds", async () => {
    const { call, code, tenant } = makeApp();
    for (const [method, path] of [
      ['POST', '/v1/system/keys'],
      ['GET', '/v1/system/keys'],
      ['POST', `/v1/system/keys/${randomUUID()}/revoke`],
    ] as const) {
      const r = await call(
        tenant.legacy,
        method,
        path,
        method === 'POST' ? { scopes: ['kindgi:system'] } : undefined,
      );
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe('system-principal-required');
    }
  });

  test("the single-mode boot token is a tenant's principal: it doesn't reach system routes", async () => {
    const { call, code } = makeApp('single');
    const r = await call(SINGLE_BOOT, 'GET', '/v1/system/keys');
    expect(r.status).toBe(403);
    expect(code(r)).toBe('system-principal-required');
  });

  test('a scoped system key mints, lists and revokes no key', async () => {
    const { call, code, mintSystemKey } = makeApp();
    const scoped = await mintSystemKey(['system:tenants', 'system:tenants:production']);
    for (const [method, path] of [
      ['POST', '/v1/system/keys'],
      ['GET', '/v1/system/keys'],
      ['POST', `/v1/system/keys/${scoped.id}/revoke`],
    ] as const) {
      const r = await call(
        scoped.token,
        method,
        path,
        method === 'POST' ? { scopes: ['system:tenants'] } : undefined,
      );
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe('system-scope-missing');
      expect((r.body.error as { details?: unknown }).details).toMatchObject({
        scope: 'kindgi:system',
      });
    }
  });
});

describe('/v1/system/keys', () => {
  test('mints a key once, shows its secret once, and lists it without one', async () => {
    const { call, audit } = makeApp();
    const minted = await call(MULTI_BOOT, 'POST', '/v1/system/keys', {
      scopes: ['system:deployments'],
      label: 'orchestrator',
    });
    expect(minted.status).toBe(201);
    expect(minted.body).toMatchObject({
      scopes: ['system:deployments'],
      label: 'orchestrator',
      mintedBy: 'boot',
    });
    expect(String(minted.body.token)).toMatch(/^kgi_sy_/);
    const listed = await call(MULTI_BOOT, 'GET', '/v1/system/keys');
    expect(listed.status).toBe(200);
    const data = listed.body.data as Record<string, unknown>[];
    expect(data.map((k) => k.id)).toEqual([minted.body.id]);
    expect(JSON.stringify(listed.body)).not.toContain(String(minted.body.token));
    expect(audit.find((a) => a.method === 'POST' && a.path === '/v1/system/keys')).toMatchObject({
      keyId: 'boot',
      status: 201,
      scope: 'kindgi:system',
    });
  });

  test('a revoked key stops resolving; an unknown id is 404', async () => {
    const { call, code, mintSystemKey } = makeApp();
    const key = await mintSystemKey(['system:license']);
    expect((await call(key.token, 'GET', '/v1/license')).status).toBe(200);
    const revoked = await call(MULTI_BOOT, 'POST', `/v1/system/keys/${key.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(typeof revoked.body.revokedAt).toBe('string');
    expect((await call(key.token, 'GET', '/v1/license')).status).toBe(401);
    const missing = await call(MULTI_BOOT, 'POST', `/v1/system/keys/${randomUUID()}/revoke`);
    expect(missing.status).toBe(404);
    expect(code(missing)).toBe('system-key-not-found');
  });

  test("a key can't outlive the full system key minting it", async () => {
    const { call, code, mintSystemKey } = makeApp();
    const in6h = new Date(Date.now() + 6 * HOUR).toISOString();
    const suite = await mintSystemKey(['kindgi:system'], { expiresAt: in6h });
    for (const body of [
      { scopes: ['system:tenants'] },
      { scopes: ['system:tenants'], expiresAt: new Date(Date.now() + 7 * HOUR).toISOString() },
    ]) {
      const r = await call(suite.token, 'POST', '/v1/system/keys', body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(code(r)).toBe('token-expiry-exceeds-minter');
    }
    const ok = await call(suite.token, 'POST', '/v1/system/keys', {
      scopes: ['system:tenants'],
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(ok.status).toBe(201);
    expect(ok.body.mintedBy).toBe(suite.id);
  });

  test.each<[Record<string, unknown>, string]>([
    [{}, 'no scopes'],
    [{ scopes: [] }, 'no scopes'],
    [{ scopes: ['runs:read'] }, 'not a system scope'],
    [{ scopes: ['system:tenants', 'system:tenants'] }, 'a scope twice'],
    [{ scopes: ['kindgi:system', 'system:tenants'] }, 'the full capability beside a scope'],
    [{ scopes: ['system:tenants'], expiresAt: '2001-01-01T00:00:00Z' }, 'a past expiry'],
    [{ scopes: ['system:tenants'], label: '' }, 'an empty label'],
  ])('refuses %j (%s)', async (body, _why) => {
    const { call, code } = makeApp();
    const r = await call(MULTI_BOOT, 'POST', '/v1/system/keys', body);
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
  });
});

describe("a tenant's key never carries the operator's powers", () => {
  test('a system scope is never minted into a tenant key, in either mode', async () => {
    for (const tenancy of ['single', 'multi'] as const) {
      const { call, code } = makeApp(tenancy);
      const minter = tenancy === 'single' ? SINGLE_BOOT : makeApp('multi').tenant.legacy;
      const r = await call(minter, 'POST', '/v1/tokens', { capabilities: ['system:tenants'] });
      expect(r.status, tenancy).toBe(403);
      expect(code(r), tenancy).toBe('capability-not-mintable');
    }
  });

  test('kindgi:system: refused in multi mode, as today in single mode', async () => {
    const multi = makeApp('multi');
    const refused = await multi.call(multi.tenant.legacy, 'POST', '/v1/tokens', {
      capabilities: ['kindgi:system'],
    });
    expect(refused.status).toBe(403);
    expect(multi.code(refused)).toBe('capability-not-mintable');
    const single = makeApp('single');
    const minted = await single.call(SINGLE_BOOT, 'POST', '/v1/tokens', {
      capabilities: ['kindgi:system'],
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  });
});

describe('withSystemTenantContext', () => {
  const live = randomUUID() as TenantId;
  const closing = randomUUID() as TenantId;
  const purged = randomUUID() as TenantId;
  const directory: SystemTenantDirectory = {
    async get(id) {
      if (id === live) return { id, state: 'active' };
      if (id === closing) return { id, state: 'closing' };
      if (id === purged) return { id, state: 'purged' };
      return null;
    },
  };

  function harness(
    capabilities: string[],
    { path = '/v1/system/tenants/:tenantId/thing', fence = true } = {},
  ) {
    const audit: SystemAccessRecord[] = [];
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'req-1');
      c.set('systemPrincipal', { keyId: 'k-1' });
      c.set('capabilities', capabilities);
      await next();
    });
    if (fence) app.use('*', systemPrincipalFence({ record: async (e) => void audit.push(e) }));
    app.put(path, (c) =>
      withSystemTenantContext(
        c,
        directory,
        c.req.param('tenantId') ?? '',
        { scope: 'system:tenants', refuse: ['closing'] },
        async (tenant) => c.json({ acted: tenant.id, state: tenant.state }),
      ),
    );
    return { app, audit };
  }

  test('acts in a live tenant, and marks it on the access record', async () => {
    const { app, audit } = harness(['system:tenants']);
    const res = await app.request(`/v1/system/tenants/${live}/thing`, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acted: live, state: 'active' });
    expect(audit).toEqual([
      expect.objectContaining({
        keyId: 'k-1',
        tenantId: live,
        scope: 'system:tenants',
        status: 200,
      }),
    ]);
  });

  test.each([
    ['an unknown tenant', () => randomUUID(), 404, 'tenant-not-found'],
    ['a purged tenant', () => purged, 404, 'tenant-not-found'],
    ['a malformed id', () => 'not-a-uuid', 404, 'tenant-not-found'],
    ['a closing tenant, refused by the route', () => closing, 409, 'tenant-closing'],
  ])('refuses %s', async (_why, id, status, errorCode) => {
    const { app } = harness(['system:tenants']);
    const res = await app.request(`/v1/system/tenants/${id()}/thing`, { method: 'PUT' });
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(errorCode);
  });

  test('checks the scope again', async () => {
    const { app } = harness(['system:deployments']);
    const res = await app.request(`/v1/system/tenants/${live}/thing`, { method: 'PUT' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'system-scope-missing',
    );
  });

  test('throws outside /v1/system/*: no other route switches tenant', async () => {
    // Without the fence, which would refuse first: the helper itself refuses to run there.
    const { app } = harness(['system:tenants'], {
      path: '/v1/tenants/:tenantId/thing',
      fence: false,
    });
    const res = await app.request(`/v1/tenants/${live}/thing`, { method: 'PUT' });
    expect(res.status).toBe(500);
  });
});
