// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { ApiTokenId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { callerIdentity } from '../src/caller.js';
import { isSystemKeysPath } from '../src/system.js';

import {
  OPERATIONS,
  SYSTEM_SCOPES,
  SYSTEM_TENANT_ID,
  createApp,
  systemKeysMintedFrom,
  systemPrincipalFence,
  withSystemTenantContext,
} from '../src/index.js';
import type {
  ApiTokenRecord,
  AppEnv,
  CreateAppInput,
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
/** An access record that keeps nothing. */
const NO_AUDIT = {
  record: async () => undefined,
  begin: async () => 'a',
  finish: async () => undefined,
};
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
      const alsoRevoked = systemKeysMintedFrom([...keys.values()], id);
      for (const each of [id, ...alsoRevoked]) {
        const key = keys.get(each);
        if (key !== undefined) keys.set(each, { ...key, revokedAt: key.revokedAt ?? new Date() });
      }
      const { secret: _secret, ...r } = keys.get(id) as SystemKeyRecord & { secret: string };
      return { key: r, alsoRevoked };
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

/**
 * The single-mode boot token: a tenant admin of `tenantId`, with every
 * capability, and the system principal `boot` on `/v1/system/keys`.
 */
const SINGLE_BOOT = 'kgi_bt_single';
/** The multi-mode boot token: a system principal with the full capability. */
const MULTI_BOOT = 'kgi_bt_multi';

/** `unset` passes no `tenancy`, as a runtime serving one tenant does. */
function makeApp(tenancy: 'single' | 'multi' | 'unset' = 'multi') {
  const system = makeSystemKeys();
  const tenant = makeTenantKeys();
  const audit: SystemAccessRecord[] = [];
  /** Make the access record fail: before acting, or after. */
  const failing = { begin: false, finish: false };
  const app = createApp({
    ...createStubAppBindings(),
    ...(tenancy !== 'unset' && { tenancy }),
    tenantStates: { of: async () => undefined },
    resolveToken: async (token) => {
      if (token === SINGLE_BOOT) {
        return {
          tenantId,
          userId: 'user-seed' as UserId,
          scopes: ['tenant-admin'],
          capabilities: ['secrets:write', 'kindgi:system'],
          systemKeysOperator: { keyId: 'boot' },
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
      async begin(attempt) {
        if (failing.begin) throw new Error('the access record is down');
        audit.push({ ...attempt, status: 0 });
        return String(audit.length - 1);
      },
      async finish(id, outcome) {
        if (failing.finish) throw new Error('the process stopped');
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
    license: {
      status: () => ({ mode: 'licensed', name: 'Acme', use: 'production' }),
      usage: async ({ since, until }) => ({
        since: since.toISOString(),
        until: until.toISOString(),
        runtimeVersion: '0.0.0',
        runs: 3,
        people: 2,
      }),
    },
    runtime: { version: '0.0.0', hosting: 'hosted', development: false },
  });
  const call = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> => {
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
      headers: Object.fromEntries(res.headers.entries()),
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
  return { app, call, code, audit, failing, mintSystemKey, tenant, system };
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
      // Which runtime answers is a tenant's read too, though it asks no right.
      ['GET', '/v1/runtime'],
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
      'GET /v1/runtime',
    ]);
  });

  test("the multi-mode boot token is fenced in the same way: it's no tenant's admin", async () => {
    const { call, code } = makeApp();
    const r = await call(MULTI_BOOT, 'GET', '/v1/tenant');
    expect(r.status).toBe(403);
    expect(code(r)).toBe('system-key-on-tenant-route');
    // The refusal names every route a system key reaches.
    expect((r.body.error as { message: string }).message).toContain(
      'it reaches /v1/system/*, GET /v1/license and GET /v1/license/usage only, not GET /v1/tenant',
    );
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
    // Any other scope is refused at the fence: the allowed list names its scope.
    const other = await mintSystemKey(['system:tenants']);
    const refused = await call(other.token, 'GET', '/v1/license');
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('system-scope-missing');
    expect((refused.body.error as { details?: unknown }).details).toMatchObject({
      scope: 'system:license',
    });
    // The full capability reads it, and its record names the scope it used.
    const full = await call(MULTI_BOOT, 'GET', '/v1/license');
    expect(full.status).toBe(200);
    expect(audit.at(-1)).toMatchObject({
      keyId: 'boot',
      path: '/v1/license',
      scope: 'kindgi:system',
    });
  });

  test("a system key holding system:license reads the deployment's use too", async () => {
    const { call, code, audit, mintSystemKey } = makeApp();
    const usage = '/v1/license/usage?since=2026-10-05T12:00:00Z';
    const renewer = await mintSystemKey(['system:license']);
    const r = await call(renewer.token, 'GET', usage);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ runs: 3, people: 2 });
    expect(audit.at(-1)).toMatchObject({
      keyId: renewer.id,
      method: 'GET',
      path: '/v1/license/usage',
      status: 200,
      scope: 'system:license',
    });
    // Any other scope is refused at the fence, as for the license.
    const other = await mintSystemKey(['system:tenants']);
    const refused = await call(other.token, 'GET', usage);
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('system-scope-missing');
    expect((refused.body.error as { details?: unknown }).details).toMatchObject({
      scope: 'system:license',
    });
  });

  test("a tenant's requests pass untouched and aren't on the system access record", async () => {
    const { call, audit } = makeApp('single');
    const r = await call(SINGLE_BOOT, 'GET', '/v1/tenant');
    expect(r.status).not.toBe(403);
    expect(audit).toEqual([]);
  });
});

describe('system routes need a system principal, then the scope', () => {
  test.each(['multi', 'single'] as const)(
    "%s: a tenant's key is refused on every system route, whatever capabilities it holds",
    async (tenancy) => {
      const { call, code, tenant } = makeApp(tenancy);
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
    },
  );

  test("the single-mode boot token is a tenant's principal outside /v1/system/keys", async () => {
    const { call, code, audit } = makeApp('single');
    for (const path of ['/v1/system/whoami', '/v1/system/tenants', '/v1/system/keysmith']) {
      const r = await call(SINGLE_BOOT, 'GET', path);
      expect(r.status, path).toBe(403);
      expect(code(r), path).toBe('system-principal-required');
    }
    expect(audit).toEqual([]);
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
    const malformed = await call(MULTI_BOOT, 'POST', '/v1/system/keys/not-a-key/revoke');
    expect(malformed.status).toBe(400);
    expect(code(malformed)).toBe('bad-input');
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
    if (fence) {
      app.use(
        '*',
        systemPrincipalFence({
          // A key holding system:tenants is served by a runtime serving many tenants alone.
          tenancy: 'multi',
          audit: {
            record: async (e) => void audit.push(e),
            begin: async (attempt) => {
              audit.push({ ...attempt, status: 0 });
              return String(audit.length - 1);
            },
            finish: async (id, outcome) => {
              audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
            },
          },
        }),
      );
    }
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

describe("the operator's powers stay fenced in both ways", () => {
  /** A bare app: a caller set by hand, then the fence, then two routes. */
  function bare(
    caller: { system?: boolean; keyId?: string; capabilities: string[] },
    tenancy?: 'single' | 'multi',
  ) {
    const app = new Hono<AppEnv>();
    const warnings: unknown[] = [];
    app.use('*', async (c, next) => {
      c.set('requestId', 'req-1');
      c.set('log', {
        warn: (_message: string, fields: unknown) => void warnings.push(fields),
        error: () => undefined,
      } as never);
      c.set('tokenId', 'key-legacy' as ApiTokenId);
      if (caller.system === true) c.set('systemPrincipal', { keyId: caller.keyId ?? 'k-1' });
      c.set('capabilities', caller.capabilities);
      await next();
    });
    app.use(
      '*',
      systemPrincipalFence({ ...(tenancy !== undefined && { tenancy }), audit: NO_AUDIT }),
    );
    app.get('/v1/caps', (c) => c.json({ capabilities: c.get('capabilities') }));
    // A system route someone forgot to gate: the fence alone keeps tenants out.
    app.get('/v1/system/ungated', (c) => c.json({ reached: true }));
    app.get('/v1/system/who', (c) => c.json({ identity: callerIdentity(c) }));
    app.get('/v1/system/keys', (c) => c.json({ reached: true }));
    return { app, warnings };
  }

  test('the fence serves one tenant unless told it serves many', async () => {
    const caller = { system: true, capabilities: ['system:tenants'] };
    const unset = await bare(caller).app.request('/v1/system/who');
    expect(unset.status).toBe(403);
    expect(((await unset.json()) as { error: { code: string } }).error.code).toBe(
      'system-key-scope-not-served',
    );
    expect((await bare(caller, 'multi').app.request('/v1/system/who')).status).toBe(200);
  });

  test("serving one tenant, the deployment's own token is a system principal on /v1/system/keys alone", async () => {
    // As a runtime serving many resolves it: the fence holds the rule on
    // its own, whatever the bearer makes of the token.
    const boot = { system: true, keyId: 'boot', capabilities: ['kindgi:system'] };
    expect((await bare(boot).app.request('/v1/system/keys')).status).toBe(200);
    for (const path of ['/v1/system/who', '/v1/system/ungated', '/v1/caps']) {
      const res = await bare(boot).app.request(path);
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe(
        'system-principal-required',
      );
    }
    expect((await bare(boot, 'multi').app.request('/v1/system/who')).status).toBe(200);
  });

  test("multi mode: a tenant's key loses kindgi:system and system:*, with a warning naming the key", async () => {
    const { app, warnings } = bare(
      { capabilities: ['kindgi:system', 'system:tenants', 'env:write'] },
      'multi',
    );
    const res = await app.request('/v1/caps');
    expect(await res.json()).toEqual({ capabilities: ['env:write'] });
    expect(warnings).toEqual([
      expect.objectContaining({
        event: 'system-capability-dropped',
        tokenId: 'key-legacy',
        dropped: ['kindgi:system', 'system:tenants'],
      }),
    ]);
  });

  test('single mode: a tenant key keeps kindgi:system, as today', async () => {
    const { app, warnings } = bare({ capabilities: ['kindgi:system', 'env:write'] }, 'single');
    expect(await (await app.request('/v1/caps')).json()).toEqual({
      capabilities: ['kindgi:system', 'env:write'],
    });
    expect(warnings).toEqual([]);
  });

  test("a system route without a gate is still closed to a tenant's key", async () => {
    for (const tenancy of ['single', 'multi'] as const) {
      const { app } = bare({ capabilities: ['kindgi:system'] }, tenancy);
      const res = await app.request('/v1/system/ungated');
      expect(res.status, tenancy).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'system-principal-required',
      );
    }
  });

  test('a system key is its own actor: the idempotency cache and audits name it, not a person', async () => {
    const { app } = bare({ system: true, capabilities: ['system:tenants'] }, 'multi');
    expect(await (await app.request('/v1/system/who')).json()).toEqual({
      identity: 'system-key:k-1',
    });
  });

  test("multi mode, end to end: a pre-upgrade tenant key with kindgi:system doesn't read the operator's license view", async () => {
    const multi = makeApp('multi');
    const refused = await multi.call(multi.tenant.legacy, 'GET', '/v1/license');
    expect(refused.status).toBe(403);
    expect(multi.code(refused)).toBe('license-operator-only');
    const single = makeApp('single');
    const operator = await single.call(single.tenant.legacy, 'GET', '/v1/license');
    expect(operator.status).toBe(200);
    expect(operator.body).toMatchObject({ name: 'Acme' });
  });

  test('a runtime serving many tenants needs the access record', () => {
    expect(() =>
      createApp({
        ...createStubAppBindings(),
        tenancy: 'multi',
        tenantStates: { of: async () => undefined },
        resolveToken: async () => null,
        runHandler: {} as RunHandlerBinding,
      } as CreateAppInput),
    ).toThrow(/needs systemAccessAudit/);
  });
});

describe('every /v1/system/* operation, from OPERATIONS: a principal first, then a scope', () => {
  const systemOps = OPERATIONS.filter((op) => op.openapiPath.startsWith('/v1/system/'));
  /** System routes any system principal may call, with no scope: a key's own identity. */
  const NO_SCOPE: ReadonlySet<string> = new Set(['systemKeys.whoami']);
  const TENANT_KEY = 'kgi_ak_sweep_tenant';
  const ZERO_SCOPE = 'kgi_sy_sweep_zero';

  async function sweepApp() {
    const { fullAppInput } = await import('./support/full-app.js');
    return createApp({
      ...fullAppInput(),
      tenancy: 'multi',
      systemAccessAudit: NO_AUDIT,
      resolveToken: async (token) => {
        if (token === TENANT_KEY) {
          return { tenantId, scopes: ['tenant-admin'], capabilities: ['kindgi:system'] };
        }
        if (token === ZERO_SCOPE) {
          return { tenantId: SYSTEM_TENANT_ID, system: { keyId: 'zero' }, capabilities: [] };
        }
        return null;
      },
    });
  }

  test('there are system operations to sweep', () => {
    expect(systemOps.length).toBeGreaterThan(0);
  });

  test.each([
    [TENANT_KEY, 'system-principal-required'],
    [ZERO_SCOPE, 'system-scope-missing'],
  ])('%s gets %s on every one', async (token, expected) => {
    const app = await sweepApp();
    const wrong: string[] = [];
    for (const op of systemOps) {
      const method = op.method.toUpperCase();
      const res = await app.request(op.honoPath.replace(/:[A-Za-z]+/g, randomUUID()), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method !== 'GET' && { 'content-type': 'application/json' }),
        },
        ...(method !== 'GET' && { body: '{}' }),
      });
      const code = ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error
        ?.code;
      if (expected === 'system-scope-missing' && NO_SCOPE.has(op.operationId)) {
        if (res.status !== 200)
          wrong.push(`${method} ${op.openapiPath}: ${res.status} (no scope needed)`);
        continue;
      }
      if (res.status !== 403 || code !== expected) {
        wrong.push(`${method} ${op.openapiPath}: ${res.status} ${code}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("serving one tenant: a system key is the license renewal's, minted by the deployment's own token", () => {
  const USAGE = '/v1/license/usage?since=2026-10-05T12:00:00Z';

  test("the deployment's own token mints, lists and revokes a key holding system:license, each on the access record", async () => {
    const { call, code, audit, system } = makeApp('single');
    const minted = await call(SINGLE_BOOT, 'POST', '/v1/system/keys', {
      scopes: ['system:license'],
      label: 'license renewal',
    });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const key = minted.body as { id: string; token: string };
    expect(key.token).toMatch(/^kgi_sy_/);
    expect(system.keys.get(key.id)).toMatchObject({
      scopes: ['system:license'],
      mintedBy: 'boot',
    });
    const listed = await call(SINGLE_BOOT, 'GET', '/v1/system/keys');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body.data as { id: string }[]).map((k) => k.id)).toEqual([key.id]);
    const revoked = await call(SINGLE_BOOT, 'POST', `/v1/system/keys/${key.id}/revoke`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(system.keys.get(key.id)?.revokedAt).toBeInstanceOf(Date);
    expect(audit.map((a) => [a.keyId, a.method, a.path, a.status])).toEqual([
      ['boot', 'POST', '/v1/system/keys', 201],
      ['boot', 'GET', '/v1/system/keys', 200],
      ['boot', 'POST', `/v1/system/keys/${key.id}/revoke`, 200],
    ]);
    // Revoked, it reads nothing.
    const after = await call(key.token, 'GET', '/v1/license');
    expect(after.status).toBe(401);
    expect(code(after)).not.toBe(undefined);
  });

  test.each(['single', 'unset'] as const)(
    'it mints system:license alone (tenancy %s): any other scope, or the full capability, is refused, and nothing is minted',
    async (tenancy) => {
      const { call, code, system } = makeApp(tenancy);
      const others = SYSTEM_SCOPES.filter((scope) => scope !== 'system:license');
      expect(others.length).toBeGreaterThan(0);
      for (const scopes of [
        ...others.map((scope) => [scope]),
        ['system:license', 'system:tenants'],
        ['kindgi:system'],
      ]) {
        const r = await call(SINGLE_BOOT, 'POST', '/v1/system/keys', {
          scopes,
          expiresAt: new Date(Date.now() + HOUR).toISOString(),
        });
        expect(r.status, scopes.join(', ')).toBe(400);
        expect(code(r), scopes.join(', ')).toBe('bad-input');
        expect((r.body.error as { message: string }).message, scopes.join(', ')).toContain(
          'a system key holds system:license alone',
        );
      }
      expect(system.keys.size).toBe(0);
    },
  );

  test('a key holding system:license reads the license and the use, on the access record', async () => {
    const { call, audit } = makeApp('single');
    const key = (await call(SINGLE_BOOT, 'POST', '/v1/system/keys', { scopes: ['system:license'] }))
      .body as { id: string; token: string };
    const license = await call(key.token, 'GET', '/v1/license');
    expect(license.status, JSON.stringify(license.body)).toBe(200);
    expect(license.body).toMatchObject({ mode: 'licensed', name: 'Acme' });
    const usage = await call(key.token, 'GET', USAGE);
    expect(usage.status, JSON.stringify(usage.body)).toBe(200);
    expect(usage.body).toMatchObject({ runs: 3, people: 2 });
    expect(audit.filter((a) => a.keyId === key.id)).toMatchObject([
      { method: 'GET', path: '/v1/license', status: 200, scope: 'system:license' },
      { method: 'GET', path: '/v1/license/usage', status: 200, scope: 'system:license' },
    ]);
  });

  test("a key holding system:license reaches no tenant's route and no other system route", async () => {
    const { call, code, audit } = makeApp('single');
    const key = (await call(SINGLE_BOOT, 'POST', '/v1/system/keys', { scopes: ['system:license'] }))
      .body as { id: string; token: string };
    for (const [method, path, expected] of [
      ['GET', '/v1/runs', 'system-key-on-tenant-route'],
      ['GET', '/v1/identity/users', 'system-key-on-tenant-route'],
      ['GET', '/v1/tokens', 'system-key-on-tenant-route'],
      ['POST', '/v1/tokens', 'system-key-on-tenant-route'],
      ['GET', '/v1/system/keys', 'system-scope-missing'],
      ['POST', '/v1/system/keys', 'system-scope-missing'],
      ['GET', '/v1/system/whoami', 'system-scope-missing'],
      ['GET', '/v1/system/tenants', 'system-scope-missing'],
    ] as const) {
      const r = await call(key.token, method, path, method === 'POST' ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r), `${method} ${path}`).toBe(expected);
    }
    expect(audit.filter((a) => a.keyId === key.id && a.status === 403)).toHaveLength(8);
  });

  test.each([
    ['another scope', ['system:tenants']],
    ['system:license and another scope', ['system:license', 'system:tenants']],
    ['the full capability', ['kindgi:system']],
    ['no scope', []],
  ])(
    'a system key holding %s (minted while the runtime served many tenants, say) is refused on every route, and recorded',
    async (_what, scopes) => {
      const { call, code, audit, system } = makeApp('single');
      const { record, token } = await system.binding.mint({ scopes, mintedBy: 'boot' });
      const routes = [
        ['GET', '/v1/license'],
        ['GET', USAGE],
        ['GET', '/v1/system/keys'],
        ['POST', '/v1/system/keys'],
        ['GET', '/v1/system/whoami'],
        ['GET', '/v1/tenant'],
        ['GET', '/v1/runs'],
      ] as const;
      for (const [method, path] of routes) {
        const r = await call(
          token,
          method,
          path,
          method === 'POST' ? { scopes: ['system:license'] } : undefined,
        );
        expect(r.status, `${method} ${path}`).toBe(403);
        expect(code(r), `${method} ${path}`).toBe('system-key-scope-not-served');
        expect((r.body.error as { details?: unknown }).details, `${method} ${path}`).toMatchObject({
          scopes,
          served: ['system:license'],
        });
      }
      expect(audit.filter((a) => a.keyId === record.id && a.status === 403)).toHaveLength(
        routes.length,
      );
      expect(system.keys.size).toBe(1);
    },
  );

  test('a runtime serving many tenants serves the same key as it always has', async () => {
    const { call, mintSystemKey } = makeApp('multi');
    const tenants = await mintSystemKey(['system:tenants']);
    expect((await call(tenants.token, 'GET', '/v1/system/whoami')).status).toBe(200);
  });

  test('isSystemKeysPath: /v1/system/keys and under it, nothing else', () => {
    expect(isSystemKeysPath('/v1/system/keys')).toBe(true);
    expect(isSystemKeysPath('/v1/system/keys/')).toBe(true);
    expect(isSystemKeysPath(`/v1/system/keys/${randomUUID()}/revoke`)).toBe(true);
    for (const path of ['/v1/system/keysmith', '/v1/system', '/v1/system/whoami', '/v1/keys']) {
      expect(isSystemKeysPath(path), path).toBe(false);
    }
  });
});

describe('serving one tenant, every operation in OPERATIONS', () => {
  const LICENSE_KEY = 'kgi_sy_sweep_license';
  const FULL_KEY = 'kgi_sy_sweep_full';
  const BOOT = 'kgi_bt_sweep_single';
  const LICENSE_OPS: ReadonlySet<string> = new Set(['license.get', 'license.usage']);
  const bearerOps = OPERATIONS.filter((op) => op.security !== 'public');

  async function sweepApp() {
    const { fullAppInput } = await import('./support/full-app.js');
    return createApp({
      ...fullAppInput(),
      tenancy: 'single',
      systemAccessAudit: NO_AUDIT,
      resolveToken: async (token) => {
        if (token === LICENSE_KEY) {
          return {
            tenantId: SYSTEM_TENANT_ID,
            system: { keyId: 'license' },
            capabilities: ['system:license'],
          };
        }
        if (token === FULL_KEY) {
          return {
            tenantId: SYSTEM_TENANT_ID,
            system: { keyId: 'full' },
            capabilities: ['kindgi:system'],
          };
        }
        if (token === BOOT) {
          return {
            tenantId,
            scopes: ['tenant-admin'],
            capabilities: ['kindgi:system'],
            systemKeysOperator: { keyId: 'boot' },
          };
        }
        return null;
      },
    });
  }

  async function send(
    app: Awaited<ReturnType<typeof sweepApp>>,
    token: string,
    op: (typeof OPERATIONS)[number],
  ) {
    const method = op.method.toUpperCase();
    const path = op.honoPath.replace(/:[A-Za-z]+/g, randomUUID());
    const withBody = method !== 'GET' && method !== 'HEAD';
    const res = await app.request(
      op.operationId === 'license.usage' ? `${path}?since=2026-10-05T12:00:00Z` : path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(withBody && { 'content-type': 'application/json' }),
        },
        ...(withBody && { body: '{}' }),
      },
    );
    const code = ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error
      ?.code;
    return {
      label: `${method} ${op.openapiPath}`,
      status: res.status,
      code,
      head: method === 'HEAD',
    };
  }
  /** A 403 with that code. A HEAD answer has no body to name its code. */
  const refusedWith = (
    r: { status: number; code: string | undefined; head: boolean },
    expected: string,
  ) => r.status === 403 && (r.head || r.code === expected);

  test('a key holding system:license gets a yes from GET /v1/license and /usage alone', async () => {
    const app = await sweepApp();
    const wrong: string[] = [];
    for (const op of bearerOps) {
      const r = await send(app, LICENSE_KEY, op);
      if (LICENSE_OPS.has(op.operationId)) {
        if (r.status !== 200) wrong.push(`${r.label}: ${r.status} ${r.code} (its yes)`);
        continue;
      }
      const expected = op.openapiPath.startsWith('/v1/system/')
        ? 'system-scope-missing'
        : 'system-key-on-tenant-route';
      if (!refusedWith(r, expected)) wrong.push(`${r.label}: ${r.status} ${r.code}`);
    }
    expect(wrong).toEqual([]);
  });

  test('a key holding anything else is refused on every one', async () => {
    const app = await sweepApp();
    const wrong: string[] = [];
    for (const op of bearerOps) {
      const r = await send(app, FULL_KEY, op);
      if (!refusedWith(r, 'system-key-scope-not-served')) {
        wrong.push(`${r.label}: ${r.status} ${r.code}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the deployment's own token reaches /v1/system/keys and no other system route", async () => {
    const app = await sweepApp();
    const wrong: string[] = [];
    for (const op of bearerOps.filter((o) => o.openapiPath.startsWith('/v1/system/'))) {
      const r = await send(app, BOOT, op);
      if (op.operationId.startsWith('systemKeys.') && op.operationId !== 'systemKeys.whoami') {
        // Past the fence, at the route: an empty mint body, a list, a key that isn't there.
        if (r.status === 403 || r.status === 401) {
          wrong.push(`${r.label}: ${r.status} ${r.code} (its yes)`);
        }
        continue;
      }
      if (!refusedWith(r, 'system-principal-required'))
        wrong.push(`${r.label}: ${r.status} ${r.code}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('revoking a system key revokes what it minted', () => {
  test('a full key and every key minted from it, however deep, stop together', async () => {
    const { call, mintSystemKey } = makeApp();
    const full = await mintSystemKey(['kindgi:system']);
    const inHour = new Date(Date.now() + HOUR).toISOString();
    const mint = async (token: string, body: Record<string, unknown>) => {
      const r = await call(token, 'POST', '/v1/system/keys', body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as { id: string; token: string };
    };
    const scoped = await mint(full.token, { scopes: ['system:license'] });
    const fullChild = await mint(full.token, { scopes: ['kindgi:system'], expiresAt: inHour });
    const grandchild = await mint(fullChild.token, {
      scopes: ['system:license'],
      expiresAt: inHour,
    });
    const unrelated = await mintSystemKey(['system:license']);

    const revoked = await call(MULTI_BOOT, 'POST', `/v1/system/keys/${full.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect([...(revoked.body.alsoRevoked as string[])].sort()).toEqual(
      [scoped.id, fullChild.id, grandchild.id].sort(),
    );
    for (const key of [full, scoped, fullChild, grandchild]) {
      expect((await call(key.token, 'GET', '/v1/license')).status, key.id).toBe(401);
    }
    expect((await call(unrelated.token, 'GET', '/v1/license')).status).toBe(200);
  });

  test('systemKeysMintedFrom walks the chain, and a cycle ends it', () => {
    const keys = [
      { id: 'a', mintedBy: 'boot' },
      { id: 'b', mintedBy: 'a' },
      { id: 'c', mintedBy: 'b' },
      { id: 'd', mintedBy: 'boot' },
      { id: 'x', mintedBy: 'y' },
      { id: 'y', mintedBy: 'x' },
    ];
    expect(systemKeysMintedFrom(keys, 'a')).toEqual(['b', 'c']);
    expect(systemKeysMintedFrom(keys, 'd')).toEqual([]);
    expect([...systemKeysMintedFrom(keys, 'x')]).toEqual(['y']);
  });
});

describe('a full key minted by a system key must expire', () => {
  test('refused without expiresAt; allowed with it; the deployment token needs none', async () => {
    const { call, code, mintSystemKey } = makeApp();
    const full = await mintSystemKey(['kindgi:system']);
    const refused = await call(full.token, 'POST', '/v1/system/keys', {
      scopes: ['kindgi:system'],
    });
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('system-key-expiry-required');
    const withExpiry = await call(full.token, 'POST', '/v1/system/keys', {
      scopes: ['kindgi:system'],
      expiresAt: new Date(Date.now() + 6 * HOUR).toISOString(),
    });
    expect(withExpiry.status).toBe(201);
    // A scoped key needs no expiry; the deployment's own token mints a full one without.
    expect(
      (await call(full.token, 'POST', '/v1/system/keys', { scopes: ['system:license'] })).status,
    ).toBe(201);
    expect(
      (await call(MULTI_BOOT, 'POST', '/v1/system/keys', { scopes: ['kindgi:system'] })).status,
    ).toBe(201);
  });
});

describe('a state-changing system request is on record before it acts', () => {
  test('when the record cannot be written, nothing is done: 503', async () => {
    const { call, code, failing, system } = makeApp();
    failing.begin = true;
    const r = await call(MULTI_BOOT, 'POST', '/v1/system/keys', { scopes: ['system:license'] });
    expect(r.status).toBe(503);
    expect(code(r)).toBe('access-record-unavailable');
    expect(r.headers['retry-after']).toBe('5');
    expect(system.keys.size).toBe(0);
    // A read doesn't wait on it.
    failing.begin = false;
    expect((await call(MULTI_BOOT, 'GET', '/v1/system/keys')).status).toBe(200);
  });

  test('when it stops after acting, the attempt stays on record, never silence', async () => {
    const { call, audit, failing } = makeApp();
    failing.finish = true;
    const r = await call(MULTI_BOOT, 'POST', '/v1/system/keys', { scopes: ['system:license'] });
    expect(r.status).toBe(201);
    expect(audit).toEqual([
      expect.objectContaining({
        keyId: 'boot',
        method: 'POST',
        path: '/v1/system/keys',
        status: 0,
      }),
    ]);
  });

  test('the attempt gets its outcome: status, scope', async () => {
    const { call, audit } = makeApp();
    await call(MULTI_BOOT, 'POST', '/v1/system/keys', { scopes: ['system:license'] });
    expect(audit).toEqual([
      expect.objectContaining({ method: 'POST', status: 201, scope: 'kindgi:system' }),
    ]);
  });
});
