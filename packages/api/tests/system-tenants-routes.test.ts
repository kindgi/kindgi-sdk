// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomUUID } from 'node:crypto';

import aws4 from 'aws4';
import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import {
  SYSTEM_TENANT_ID,
  createApp,
  imagePrefixesOverlap,
  parseImagePrefix,
} from '../src/index.js';
import type {
  ImagePrefix,
  RunHandlerBinding,
  SystemAccessRecord,
  SystemTenant,
  SystemTenantDirectory,
  SystemTenantsBinding,
} from '../src/index.js';
import { fullAppInput } from './support/full-app.js';

/**
 * `/v1/system/tenants`: the operator creates, reads, closes and suspends
 * tenants, sets their image prefix, and reads their admins' contacts, each
 * under its own system scope. `GET /v1/system/whoami` answers any system key.
 */

const HOST = 'us-central1-docker.pkg.dev';
const PROJECT = '0b7c4a2e-9d1f-4e3a-8b6c-5d4e3f2a1b0c';

function makeTenants() {
  const rows = new Map<string, SystemTenant & { admins: { userId: string; email: string }[] }>();
  const directory: SystemTenantDirectory = {
    async get(id) {
      const row = rows.get(id as unknown as string);
      return row === undefined ? null : { id: row.id, state: row.state };
    },
  };
  const strip = ({ admins: _admins, ...t }: SystemTenant & { admins: unknown }) =>
    t as SystemTenant;
  /** Another tenant's prefix overlaps this one, as the runtime's binding checks. */
  const taken = (self: TenantId | undefined, prefix: ImagePrefix) =>
    [...rows.values()].some((r) => {
      if (r.id === self || r.imagePrefix === undefined) return false;
      const other = parseImagePrefix(r.imagePrefix);
      return other.kind === 'ok' && imagePrefixesOverlap(other.value, prefix);
    });
  const update = (id: TenantId, patch: Partial<SystemTenant>): SystemTenant => {
    const row = rows.get(id as unknown as string);
    if (row === undefined) throw new Error('no such tenant');
    const next = { ...row, ...patch };
    rows.set(id as unknown as string, next);
    return strip(next);
  };
  const binding: SystemTenantsBinding = {
    async create(input) {
      const slug = input.slug ?? `t-${randomBytes(3).toString('hex')}`;
      if ([...rows.values()].some((r) => r.slug === slug)) return { kind: 'slug-taken' };
      if (input.imagePrefix !== undefined && taken(undefined, input.imagePrefix)) {
        return { kind: 'image-prefix-taken' };
      }
      const id = randomUUID() as TenantId;
      const tenant: SystemTenant = {
        id,
        name: input.name,
        slug,
        state: 'active',
        createdAt: new Date().toISOString(),
        test: input.test === true,
        productionAllowed: input.productionAllowed,
        ...(input.imagePrefix !== undefined && {
          imagePrefix: `${input.imagePrefix.host}/${input.imagePrefix.path}`,
        }),
      };
      const personId = randomUUID();
      rows.set(id as unknown as string, {
        ...tenant,
        admins:
          input.firstAdmin === undefined
            ? []
            : [{ userId: personId, email: input.firstAdmin.email }],
      });
      return input.firstAdmin !== undefined
        ? { kind: 'ok', tenant, firstAdmin: { personId } }
        : { kind: 'ok', tenant, adminKey: { tokenId: randomUUID(), token: 'kgi_ak_first' } };
    },
    async list({ limit }) {
      return { kind: 'ok', data: [...rows.values()].map(strip).reverse().slice(0, limit) };
    },
    async read(id) {
      const row = rows.get(id as unknown as string);
      return row === undefined ? null : strip(row);
    },
    async close(id) {
      const row = rows.get(id as unknown as string);
      return update(id, {
        state: 'closing',
        closingAt: row?.closingAt ?? new Date().toISOString(),
      });
    },
    async setSuspended(id, suspended, reason) {
      return suspended
        ? update(id, {
            state: 'suspended',
            suspendedAt: new Date().toISOString(),
            ...(reason !== undefined && { suspendedReason: reason }),
          })
        : update(id, { state: 'active' });
    },
    async setImagePrefix(id, prefix) {
      if (taken(id, prefix)) return { kind: 'image-prefix-taken' };
      return { kind: 'ok', tenant: update(id, { imagePrefix: `${prefix.host}/${prefix.path}` }) };
    },
    async setProjectSuspended(id, projectId, suspended, reason) {
      if (!rows.has(id as unknown as string) || projectId !== PROJECT) {
        return { kind: 'project-not-found' };
      }
      return {
        kind: 'ok',
        project: {
          projectId,
          suspended,
          ...(suspended && { suspendedAt: new Date().toISOString() }),
          ...(suspended && reason !== undefined && { suspendedReason: reason }),
        },
      };
    },
    async admins(id) {
      return rows.get(id as unknown as string)?.admins ?? [];
    },
  };
  return { binding, directory, rows };
}

/** System keys by their capabilities. */
const KEYS: Record<string, string[]> = {
  kgi_sy_full: ['kindgi:system'],
  /** Sign-up on the public surface: create only. */
  kgi_sy_web: ['system:tenants:create'],
  /** The worker: tenants, binding slots, and the card gate's switch. */
  kgi_sy_signup: ['system:tenants', 'system:tenants:image-prefix', 'system:tenants:production'],
  kgi_sy_support: ['system:suspend'],
  kgi_sy_notices: ['system:tenants:contacts'],
  /** The orchestrator: deployments only, none of the tenant scopes. */
  kgi_sy_orchestrator: ['system:deployments'],
};

function makeApp() {
  const tenants = makeTenants();
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    tenantStates: { of: async () => undefined },
    resolveToken: async (token) => {
      const caps = KEYS[token];
      return caps === undefined
        ? null
        : { tenantId: SYSTEM_TENANT_ID, system: { keyId: token }, capabilities: caps };
    },
    runHandler: {} as RunHandlerBinding,
    systemTenants: tenants.binding,
    systemTenantDirectory: tenants.directory,
    systemAccessAudit: {
      record: async (e) => void audit.push(e),
      begin: async (a) => {
        audit.push({ ...a, status: 0 });
        return String(audit.length - 1);
      },
      finish: async (id, outcome) => {
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
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
      body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
    };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  const create = async (body: Record<string, unknown>, token = 'kgi_sy_signup') => {
    const r = await call(token, 'POST', '/v1/system/tenants', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as { tenant: SystemTenant; firstAdmin?: { personId: string } };
  };
  return { call, code, create, audit, tenants };
}

const SIGNUP = {
  name: 'Acme Store',
  slug: 'acme-store',
  productionAllowed: false,
  imagePrefix: `${HOST}/acme-cell/s-7`,
  firstAdmin: { email: 'owner@acme.test', name: 'Ada Owner' },
};

describe('POST /v1/system/tenants', () => {
  test("sign-up's create: a first admin by email, production off, its image prefix, no key", async () => {
    const { create, audit } = makeApp();
    const created = await create(SIGNUP);
    expect(created.tenant).toMatchObject({
      name: 'Acme Store',
      slug: 'acme-store',
      state: 'active',
      productionAllowed: false,
      test: false,
      imagePrefix: `${HOST}/acme-cell/s-7`,
    });
    expect(typeof created.firstAdmin?.personId).toBe('string');
    expect(created).not.toHaveProperty('adminKey');
    expect(audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_signup',
      method: 'POST',
      status: 201,
      scope: 'system:tenants',
      tenantId: created.tenant.id,
    });
  });

  test('without firstAdmin it mints an admin key, which only the full capability may', async () => {
    const { call, code } = makeApp();
    const refused = await call('kgi_sy_signup', 'POST', '/v1/system/tenants', { name: 'Script' });
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('system-scope-missing');
    const full = await call('kgi_sy_full', 'POST', '/v1/system/tenants', { name: 'Script' });
    expect(full.status).toBe(201);
    expect(full.body.adminKey).toMatchObject({ token: 'kgi_ak_first' });
  });

  test('a test tenant takes the full capability', async () => {
    const { call, code } = makeApp();
    const body = { ...SIGNUP, slug: 'suite-a', test: true };
    const refused = await call('kgi_sy_signup', 'POST', '/v1/system/tenants', body);
    expect(code(refused)).toBe('system-scope-missing');
    const full = await call('kgi_sy_full', 'POST', '/v1/system/tenants', body);
    expect(full.status).toBe(201);
    expect((full.body.tenant as SystemTenant).test).toBe(true);
  });

  test('a slug taken is 409', async () => {
    const { call, code, create } = makeApp();
    await create(SIGNUP);
    const again = await call('kgi_sy_signup', 'POST', '/v1/system/tenants', SIGNUP);
    expect(again.status).toBe(409);
    expect(code(again)).toBe('tenant-slug-taken');
  });

  test.each<[string, Record<string, unknown>]>([
    ['no name', { firstAdmin: SIGNUP.firstAdmin }],
    ['a slug with capitals', { ...SIGNUP, slug: 'Acme' }],
    ['an image prefix with a trailing slash', { ...SIGNUP, imagePrefix: `${HOST}/acme-cell/s-7/` }],
    [
      'an image prefix with a digest',
      { ...SIGNUP, imagePrefix: `${HOST}/x@sha256:${'a'.repeat(64)}` },
    ],
    ['a first admin without an email', { ...SIGNUP, firstAdmin: { name: 'Ada' } }],
    ['productionAllowed not a boolean', { ...SIGNUP, productionAllowed: 'no' }],
    ['an unknown field', { ...SIGNUP, plan: 'pro' }],
  ])('refuses %s: 400', async (_why, body) => {
    const { call, code } = makeApp();
    const r = await call('kgi_sy_signup', 'POST', '/v1/system/tenants', body);
    expect(r.status).toBe(400);
    expect(code(r)).toBe('bad-input');
  });

  test('a key without system:tenants is refused', async () => {
    const { call, code } = makeApp();
    for (const token of ['kgi_sy_support', 'kgi_sy_notices', 'kgi_sy_orchestrator']) {
      const r = await call(token, 'POST', '/v1/system/tenants', SIGNUP);
      expect(r.status, token).toBe(403);
      expect(code(r), token).toBe('system-scope-missing');
    }
  });
});

describe('reading, closing, suspending, the image prefix and the admins', () => {
  test('list and read: what the operator sees, never content', async () => {
    const { call, create } = makeApp();
    const { tenant } = await create(SIGNUP);
    const list = await call('kgi_sy_signup', 'GET', '/v1/system/tenants');
    expect((list.body.data as SystemTenant[]).map((t) => t.id)).toEqual([tenant.id]);
    const one = await call('kgi_sy_signup', 'GET', `/v1/system/tenants/${tenant.id}`);
    expect(one.body).toMatchObject({ id: tenant.id, state: 'active' });
    expect((await call('kgi_sy_signup', 'GET', `/v1/system/tenants/${randomUUID()}`)).status).toBe(
      404,
    );
  });

  test('close is one-way and keeps its first time; a closing tenant refuses suspension and a new prefix', async () => {
    const { call, code, create } = makeApp();
    const { tenant } = await create(SIGNUP);
    const closed = await call('kgi_sy_signup', 'POST', `/v1/system/tenants/${tenant.id}/close`);
    expect(closed.body).toMatchObject({ state: 'closing' });
    const again = await call('kgi_sy_signup', 'POST', `/v1/system/tenants/${tenant.id}/close`);
    expect(again.body.closingAt).toBe(closed.body.closingAt);
    const suspend = await call(
      'kgi_sy_support',
      'PUT',
      `/v1/system/tenants/${tenant.id}/suspended`,
      {
        suspended: true,
      },
    );
    expect(suspend.status).toBe(409);
    expect(code(suspend)).toBe('tenant-closing');
    const prefix = await call(
      'kgi_sy_signup',
      'PUT',
      `/v1/system/tenants/${tenant.id}/image-prefix`,
      {
        prefix: `${HOST}/acme-cell/s-8`,
      },
    );
    expect(code(prefix)).toBe('tenant-closing');
  });

  test('suspension takes system:suspend, which sign-up does not hold; it is reversible', async () => {
    const { call, code, create } = makeApp();
    const { tenant } = await create(SIGNUP);
    const path = `/v1/system/tenants/${tenant.id}/suspended`;
    const bySignup = await call('kgi_sy_signup', 'PUT', path, { suspended: true });
    expect(bySignup.status).toBe(403);
    expect(code(bySignup)).toBe('system-scope-missing');
    const on = await call('kgi_sy_support', 'PUT', path, {
      suspended: true,
      reason: 'unpaid invoice',
    });
    expect(on.body).toMatchObject({ state: 'suspended', suspendedReason: 'unpaid invoice' });
    const off = await call('kgi_sy_support', 'PUT', path, { suspended: false });
    expect(off.body).toMatchObject({ state: 'active' });
  });

  test('the image prefix is set by the provisioning key, never the support key', async () => {
    const { call, code, create } = makeApp();
    const { tenant } = await create({ ...SIGNUP, imagePrefix: undefined });
    const path = `/v1/system/tenants/${tenant.id}/image-prefix`;
    expect(code(await call('kgi_sy_support', 'PUT', path, { prefix: `${HOST}/c/s-1` }))).toBe(
      'system-scope-missing',
    );
    const set = await call('kgi_sy_signup', 'PUT', path, { prefix: `${HOST}/c/s-1` });
    expect(set.body).toMatchObject({ imagePrefix: `${HOST}/c/s-1` });
    expect((await call('kgi_sy_signup', 'PUT', path, { prefix: 'c/s-1' })).status).toBe(400);
  });

  test('admins: their contacts under system:tenants:contacts only, and every read is recorded', async () => {
    const { call, code, create, audit } = makeApp();
    const { tenant } = await create(SIGNUP);
    const path = `/v1/system/tenants/${tenant.id}/admins`;
    expect(code(await call('kgi_sy_signup', 'GET', path))).toBe('system-scope-missing');
    const read = await call('kgi_sy_notices', 'GET', path);
    expect(read.body.data).toEqual([expect.objectContaining({ email: 'owner@acme.test' })]);
    expect(audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_notices',
      method: 'GET',
      status: 200,
      scope: 'system:tenants:contacts',
      tenantId: tenant.id,
    });
  });
});

test('GET /v1/system/whoami: any system key, its own id and scopes', async () => {
  const { call } = makeApp();
  const me = await call('kgi_sy_orchestrator', 'GET', '/v1/system/whoami');
  expect(me.status).toBe(200);
  expect(me.body).toEqual({ keyId: 'kgi_sy_orchestrator', scopes: ['system:deployments'] });
});

describe('least privilege on the public surface: a create-only key', () => {
  const WEB_BODY = { name: 'Acme Store', firstAdmin: SIGNUP.firstAdmin };

  test('creates with a first admin; production starts blocked when not asked', async () => {
    const { call } = makeApp();
    const r = await call('kgi_sy_web', 'POST', '/v1/system/tenants', WEB_BODY);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body.tenant as SystemTenant).productionAllowed).toBe(false);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['production', { productionAllowed: true }, 'system:tenants:production'],
    ['an image prefix', { imagePrefix: `${HOST}/acme-cell/s-7` }, 'system:tenants:image-prefix'],
    ['a test tenant', { test: true }, 'kindgi:system'],
  ])('asking for %s is refused naming the scope, never dropped', async (_what, extra, scope) => {
    const { call, code, tenants } = makeApp();
    const r = await call('kgi_sy_web', 'POST', '/v1/system/tenants', { ...WEB_BODY, ...extra });
    expect(r.status).toBe(403);
    expect(code(r)).toBe('system-scope-missing');
    expect((r.body.error as { details?: unknown }).details).toMatchObject({ scope });
    expect(tenants.rows.size).toBe(0);
  });

  test('it lists, reads and closes nothing', async () => {
    const { call, code, create } = makeApp();
    const { tenant } = await create(SIGNUP);
    for (const [method, path] of [
      ['GET', '/v1/system/tenants'],
      ['GET', `/v1/system/tenants/${tenant.id}`],
      ['POST', `/v1/system/tenants/${tenant.id}/close`],
    ] as const) {
      const r = await call('kgi_sy_web', method, path);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(code(r)).toBe('system-scope-missing');
    }
  });
});

describe('the image prefix: its own scope; moving it takes the full capability', () => {
  test('set by the slot-binding key; the same value again is fine; another one is full-only', async () => {
    const { call, code, create } = makeApp();
    const { tenant } = await create({ ...SIGNUP, imagePrefix: undefined });
    const path = `/v1/system/tenants/${tenant.id}/image-prefix`;
    expect((await call('kgi_sy_signup', 'PUT', path, { prefix: `${HOST}/c/s-1` })).status).toBe(
      200,
    );
    expect((await call('kgi_sy_signup', 'PUT', path, { prefix: `${HOST}/c/s-1` })).status).toBe(
      200,
    );
    const moving = await call('kgi_sy_signup', 'PUT', path, { prefix: `${HOST}/c/s-2` });
    expect(moving.status).toBe(403);
    expect((moving.body.error as { details?: unknown }).details).toMatchObject({
      scope: 'kindgi:system',
    });
    expect((await call('kgi_sy_full', 'PUT', path, { prefix: `${HOST}/c/s-2` })).status).toBe(200);
    expect(code(await call('kgi_sy_web', 'PUT', path, { prefix: `${HOST}/c/s-3` }))).toBe(
      'system-scope-missing',
    );
  });
});

describe('suspending one project', () => {
  test('under system:suspend; an unknown project is 404; a malformed id 400', async () => {
    const { call, code, create } = makeApp();
    const { tenant } = await create(SIGNUP);
    const path = `/v1/system/tenants/${tenant.id}/projects/${PROJECT}/suspended`;
    expect(code(await call('kgi_sy_signup', 'PUT', path, { suspended: true }))).toBe(
      'system-scope-missing',
    );
    const on = await call('kgi_sy_support', 'PUT', path, {
      suspended: true,
      reason: 'abuse report',
    });
    expect(on.body).toMatchObject({
      projectId: PROJECT,
      suspended: true,
      suspendedReason: 'abuse report',
    });
    const off = await call('kgi_sy_support', 'PUT', path, { suspended: false });
    expect(off.body).toMatchObject({ projectId: PROJECT, suspended: false });
    const other = `/v1/system/tenants/${tenant.id}/projects/${randomUUID()}/suspended`;
    expect(code(await call('kgi_sy_support', 'PUT', other, { suspended: true }))).toBe(
      'project-not-found',
    );
    const bad = `/v1/system/tenants/${tenant.id}/projects/not-a-project/suspended`;
    expect((await call('kgi_sy_support', 'PUT', bad, { suspended: true })).status).toBe(400);
  });
});

/** What a frozen tenant's refused write says: what still changes in it, and nothing else. */
const FROZEN_MESSAGES = {
  closing:
    'This workspace is closing: it can be read and exported until it is deleted, and nothing in it changes but deletes, revocations and erasures.',
  suspended:
    'This workspace is suspended: it can be read and exported, and nothing in it changes but deletes, revocations and erasures until it is restored.',
} as const;

describe('a closing or suspended tenant is frozen, whatever way it comes in', () => {
  /** A tenant principal resolving with nothing about its state, as a session does. */
  function tenantApp(state: 'active' | 'suspended' | 'closing' | 'unreadable') {
    const tenantId = randomUUID() as TenantId;
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => ({ tenantId, scopes: ['tenant-admin'], capabilities: [] }),
      runHandler: {} as RunHandlerBinding,
      tenantStates: {
        of: async () => {
          if (state === 'unreadable') throw new Error('the database is down');
          return state;
        },
      },
    });
    return (method: string, path: string) =>
      app.request(path, {
        method,
        headers: { authorization: 'Bearer kgi_sk_x', 'content-type': 'application/json' },
        ...(method !== 'GET' && method !== 'DELETE' && { body: '{}' }),
      });
  }
  const codeOf = async (res: Response) =>
    ((await res.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code;

  test.each(['closing', 'suspended'] as const)(
    '%s: a write is refused; reads, exports, erasure, unregistering and revoking pass',
    async (state) => {
      const send = tenantApp(state);
      const write = await send('POST', '/v1/tokens');
      expect(write.status).toBe(409);
      const { error } = (await write.json()) as { error: { code: string; message: string } };
      expect([error.code, error.message]).toEqual([`tenant-${state}`, FROZEN_MESSAGES[state]]);
      for (const [method, path] of [
        ['GET', '/v1/tenant'],
        ['DELETE', `/v1/env/${randomUUID()}`],
        ['POST', '/v1/memory/erasures'],
        ['POST', `/v1/memory/erasures/${randomUUID()}/resume`],
        ['POST', '/v1/memory/retrieve'],
        ['POST', `/v1/tokens/${randomUUID()}/revoke`],
        ['POST', `/v1/identity/users/${randomUUID()}/revoke-sessions`],
        ['POST', `/v1/agents/${randomUUID()}/unregister`],
        ['POST', '/v1/memory/erasures/replay'],
        ['POST', '/v1/retention/sweep'],
        ['POST', '/v1/retention/sweep/conversations'],
        ['POST', `/v1/provenance/${randomUUID()}/export`],
        ['POST', '/v1/auth/logout'],
        ['POST', '/v1/auth/refresh'],
        ['POST', '/v1/auth/token-sign-in'],
        ['POST', `/v1/auth/providers/${randomUUID()}/unregister`],
      ] as const) {
        const res = await send(method, path);
        expect(await codeOf(res), `${method} ${path}`).not.toMatch(/^tenant-(closing|suspended)$/);
      }
    },
  );

  test.each(['closing', 'suspended'] as const)(
    '%s: registering or changing a sign-in provider is a write, and so is any non-POST write to an allowed path',
    async (state) => {
      const send = tenantApp(state);
      for (const [method, path] of [
        ['POST', '/v1/auth/providers'],
        ['PATCH', `/v1/auth/providers/${randomUUID()}`],
        ['PUT', '/v1/memory/erasures'],
        ['PATCH', `/v1/agents/${randomUUID()}/unregister`],
      ] as const) {
        const res = await send(method, path);
        expect(res.status, `${method} ${path}`).toBe(409);
        expect(await codeOf(res), `${method} ${path}`).toBe(`tenant-${state}`);
      }
    },
  );

  test("a state that can't be read refuses the write, never lets it through; a read still passes", async () => {
    const send = tenantApp('unreadable');
    const write = await send('POST', '/v1/tokens');
    expect(write.status).toBe(503);
    expect(write.headers.get('retry-after')).toBe('5');
    expect(await codeOf(write)).toBe('tenant-state-unavailable');
    expect((await send('GET', '/v1/tenant')).status).not.toBe(503);
  });

  test('an active tenant writes as before', async () => {
    const res = await tenantApp('active')('POST', '/v1/tokens');
    expect(await codeOf(res)).not.toMatch(/^tenant-/);
  });

  /** The S3-compatible surface, signed with the tenant's own S3 key, as S3 clients sign. */
  function s3App(state: 'active' | 'suspended' | 'closing' | 'unreadable') {
    const tenantId = randomUUID() as TenantId;
    const S3_KEY = 'AKIAKINDGITEST000011';
    const S3_SECRET = 'kindgi-test-secret-key-0000000000000011';
    const blobStorage = fullAppInput().blobStorage;
    if (blobStorage === undefined) throw new Error('fullAppInput has no blob storage');
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken: async () => null,
      runHandler: {} as RunHandlerBinding,
      blobStorage,
      s3Credentials: {
        async resolve(accessKeyId) {
          return accessKeyId === S3_KEY
            ? ({ accessKeyId, secretKey: S3_SECRET, tenantId, bucket: 'artifacts' } as never)
            : null;
        },
      },
      tenantStates: {
        of: async () => {
          if (state === 'unreadable') throw new Error('the database is down');
          return state;
        },
      },
    });
    return async (method: string, path: string, body = '') => {
      const opts = {
        host: 'localhost',
        method,
        path,
        service: 's3',
        region: 'us-east-1',
        headers: { host: 'localhost' } as Record<string, string>,
        body,
      };
      new aws4.RequestSigner(opts, { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET }).sign();
      const res = await app.request(`http://localhost${path}`, {
        method,
        headers: Object.fromEntries(Object.entries(opts.headers).map(([k, v]) => [k, String(v)])),
        ...(body.length > 0 && { body, duplex: 'half' }),
      } as RequestInit);
      return {
        status: res.status,
        type: res.headers.get('content-type'),
        retryAfter: res.headers.get('retry-after'),
        code: /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1],
      };
    };
  }

  test.each(['closing', 'suspended'] as const)(
    "the S3 surface too, in S3's terms: a %s tenant reads and deletes its artifacts, never writes them",
    async (state) => {
      const send = s3App(state);
      const put = await send('PUT', '/s3/artifacts/report.txt', 'hello');
      expect(put).toMatchObject({ status: 403, code: 'AllAccessDisabled' });
      expect(put.type).toContain('application/xml');
      for (const method of ['GET', 'DELETE'] as const) {
        expect((await send(method, '/s3/artifacts/report.txt')).code, method).not.toBe(
          'AllAccessDisabled',
        );
      }
    },
  );

  test("on the S3 surface, a state that can't be read refuses the write with S3's 503", async () => {
    const put = await s3App('unreadable')('PUT', '/s3/artifacts/report.txt', 'hello');
    expect(put).toMatchObject({ status: 503, code: 'ServiceUnavailable', retryAfter: '5' });
  });

  test('on the S3 surface, an active tenant writes as before: the gate lets it through', async () => {
    // The stub store refuses every write, so the router's own error shows it got there.
    const put = await s3App('active')('PUT', '/s3/artifacts/report.txt', 'hello');
    expect(put.status).not.toBe(403);
    expect(put.code).not.toMatch(/^(AllAccessDisabled|ServiceUnavailable)$/);
  });
});

describe("no two tenants' image prefixes overlap", () => {
  test.each<[string, string]>([
    ['the same repository', `${HOST}/acme-cell/s-7`],
    ['a parent over it', `${HOST}/acme-cell`],
    ['a child inside it', `${HOST}/acme-cell/s-7/agents`],
  ])('%s is refused at create and by PUT', async (_why, prefix) => {
    const { call, code, create } = makeApp();
    await create(SIGNUP);
    const other = await call('kgi_sy_signup', 'POST', '/v1/system/tenants', {
      ...SIGNUP,
      slug: 'beta-store',
      imagePrefix: prefix,
    });
    expect(other.status).toBe(409);
    expect(code(other)).toBe('image-prefix-taken');
    const { tenant: beta } = await create({
      ...SIGNUP,
      slug: 'beta-store',
      imagePrefix: undefined,
    });
    const put = await call('kgi_sy_signup', 'PUT', `/v1/system/tenants/${beta.id}/image-prefix`, {
      prefix,
    });
    expect(code(put)).toBe('image-prefix-taken');
  });

  test("a sibling repository is fine: s-7 and s-70 don't overlap", async () => {
    const { create } = makeApp();
    await create(SIGNUP);
    await create({ ...SIGNUP, slug: 'beta-store', imagePrefix: `${HOST}/acme-cell/s-70` });
  });

  test('imagePrefixesOverlap: equal, parent and child overlap; another host does not', () => {
    const p = (s: string) => {
      const r = parseImagePrefix(s);
      if (r.kind === 'err') throw new Error(r.error.reason);
      return r.value;
    };
    expect(imagePrefixesOverlap(p(`${HOST}/a/s-1`), p(`${HOST}/a/s-1`))).toBe(true);
    expect(imagePrefixesOverlap(p(`${HOST}/a`), p(`${HOST}/a/s-1`))).toBe(true);
    expect(imagePrefixesOverlap(p(`${HOST}/a/s-1`), p(`${HOST}/a`))).toBe(true);
    expect(imagePrefixesOverlap(p(`${HOST}/a/s-1`), p(`${HOST}/a/s-10`))).toBe(false);
    expect(imagePrefixesOverlap(p(`${HOST}/a/s-1`), p('europe-docker.pkg.dev/a/s-1'))).toBe(false);
  });
});

test('the list says whether there is more', async () => {
  const { call, create } = makeApp();
  await create(SIGNUP);
  const list = await call('kgi_sy_signup', 'GET', '/v1/system/tenants');
  expect(list.body).toMatchObject({ hasMore: false });
});
