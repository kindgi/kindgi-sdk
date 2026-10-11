// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  SystemAccessRecord,
  SystemTenant,
  SystemTenantDirectory,
  SystemTenantsBinding,
} from '../src/index.js';

/**
 * `/v1/system/tenants`: the operator creates, reads, closes and suspends
 * tenants, sets their image prefix, and reads their admins' contacts, each
 * under its own system scope. `GET /v1/system/whoami` answers any system key.
 */

const HOST = 'us-central1-docker.pkg.dev';

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
      const id = randomUUID() as TenantId;
      const tenant: SystemTenant = {
        id,
        name: input.name,
        slug,
        state: 'active',
        createdAt: new Date().toISOString(),
        test: input.test === true,
        productionAllowed: input.productionAllowed !== false,
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
      return update(id, { imagePrefix: `${prefix.host}/${prefix.path}` });
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
  kgi_sy_signup: ['system:tenants', 'system:tenants:production'],
  kgi_sy_support: ['system:suspend'],
  kgi_sy_notices: ['system:tenants:contacts'],
  kgi_sy_billing: ['system:usage:read'],
};

function makeApp() {
  const tenants = makeTenants();
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
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
    for (const token of ['kgi_sy_support', 'kgi_sy_notices', 'kgi_sy_billing']) {
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
  const me = await call('kgi_sy_billing', 'GET', '/v1/system/whoami');
  expect(me.status).toBe(200);
  expect(me.body).toEqual({ keyId: 'kgi_sy_billing', scopes: ['system:usage:read'] });
});
