// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantLimits } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type { RunHandlerBinding, SystemAccessRecord, SystemTenantState } from '../src/index.js';

/**
 * The control plane's system routes on a tenant:
 * `PUT /v1/system/tenants/:tenantId/production-allowed` and `…/limits`.
 * Each takes its own system scope; a tenant's key never reaches them.
 */

const active = randomUUID() as TenantId;
const suspended = randomUUID() as TenantId;
const closing = randomUUID() as TenantId;
const purged = randomUUID() as TenantId;
const STATES = new Map<string, SystemTenantState>([
  [active, 'active'],
  [suspended, 'suspended'],
  [closing, 'closing'],
  [purged, 'purged'],
]);

const KEYS: Readonly<Record<string, readonly string[]>> = {
  kgi_sy_production: ['system:tenants:production'],
  kgi_sy_limits: ['system:tenants:limits'],
  kgi_sy_deployments: ['system:deployments'],
  kgi_sy_full: ['kindgi:system'],
};
const TENANT_ADMIN = 'kgi_ak_tenant_admin';

function makeApp() {
  const productionAllowed = new Map<string, boolean>();
  const limits = new Map<string, TenantLimits>();
  const audit: SystemAccessRecord[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    resolveToken: async (token) => {
      const scopes = KEYS[token];
      if (scopes !== undefined) {
        return {
          tenantId: SYSTEM_TENANT_ID,
          system: { keyId: token },
          capabilities: [...scopes],
        };
      }
      if (token === TENANT_ADMIN) {
        return {
          tenantId: active,
          userId: 'user-admin' as UserId,
          scopes: ['tenant-admin'],
          capabilities: ['secrets:write'],
        };
      }
      return null;
    },
    runHandler: {} as RunHandlerBinding,
    systemAccessAudit: {
      async record(entry) {
        audit.push(entry);
      },
      async begin(attempt) {
        audit.push({ ...attempt, status: 0 });
        return String(audit.length - 1);
      },
      async finish(id, outcome) {
        audit[Number(id)] = { ...(audit[Number(id)] as SystemAccessRecord), ...outcome };
      },
    },
    systemTenantDirectory: {
      async get(tenantId) {
        const state = STATES.get(tenantId);
        return state === undefined ? null : { id: tenantId, state };
      },
    },
    systemTenantSettings: {
      async setProductionAllowed(tenantId, allowed) {
        productionAllowed.set(tenantId, allowed);
        return { productionAllowed: allowed };
      },
      async setLimits(tenantId, next) {
        limits.set(tenantId, next);
        return next;
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
      ...(body !== undefined && {
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  return {
    call,
    code,
    productionAllowed,
    limits,
    audit,
  };
}

describe('PUT /v1/system/tenants/:tenantId/production-allowed', () => {
  const path = (t: string) => `/v1/system/tenants/${t}/production-allowed`;

  test('sets the switch both ways, and answers it', async () => {
    const t = makeApp();
    const off = await t.call('kgi_sy_production', 'PUT', path(active), { allowed: false });
    expect(off).toEqual({ status: 200, body: { tenantId: active, productionAllowed: false } });
    expect(t.productionAllowed.get(active)).toBe(false);
    const on = await t.call('kgi_sy_production', 'PUT', path(active), { allowed: true });
    expect(on.body).toEqual({ tenantId: active, productionAllowed: true });
  });

  test('the full system capability may too; a suspended tenant may be set', async () => {
    const t = makeApp();
    expect((await t.call('kgi_sy_full', 'PUT', path(active), { allowed: true })).status).toBe(200);
    expect(
      (await t.call('kgi_sy_production', 'PUT', path(suspended), { allowed: false })).status,
    ).toBe(200);
  });

  test("another scope, or a tenant's key: refused, and nothing is set", async () => {
    const t = makeApp();
    const limitsKey = await t.call('kgi_sy_limits', 'PUT', path(active), { allowed: false });
    expect([limitsKey.status, t.code(limitsKey)]).toEqual([403, 'system-scope-missing']);
    const tenantKey = await t.call(TENANT_ADMIN, 'PUT', path(active), { allowed: false });
    expect([tenantKey.status, t.code(tenantKey)]).toEqual([403, 'system-principal-required']);
    expect(t.productionAllowed.size).toBe(0);
  });

  test('an unknown, malformed or purged tenant is 404; a closing one 409', async () => {
    const t = makeApp();
    for (const id of [randomUUID(), 'not-a-tenant', purged]) {
      const r = await t.call('kgi_sy_production', 'PUT', path(id), { allowed: true });
      expect([r.status, t.code(r)], id).toEqual([404, 'tenant-not-found']);
    }
    const r = await t.call('kgi_sy_production', 'PUT', path(closing), { allowed: true });
    expect([r.status, t.code(r)]).toEqual([409, 'tenant-closing']);
    expect(t.productionAllowed.size).toBe(0);
  });

  test('a body that is not { allowed: boolean } is 400', async () => {
    const t = makeApp();
    for (const body of ['not json', {}, { allowed: 'yes' }, { allowed: true, also: 1 }, [true]]) {
      const r = await t.call('kgi_sy_production', 'PUT', path(active), body);
      expect([r.status, t.code(r)], JSON.stringify(body)).toEqual([400, 'bad-input']);
    }
  });

  test('the access record names the key, the scope and the tenant', async () => {
    const t = makeApp();
    await t.call('kgi_sy_production', 'PUT', path(active), { allowed: false });
    expect(t.audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_production',
      scope: 'system:tenants:production',
      tenantId: active,
    });
  });
});

describe('PUT /v1/system/tenants/:tenantId/limits', () => {
  const path = (t: string) => `/v1/system/tenants/${t}/limits`;

  test('replaces the limits with exactly the ones given', async () => {
    const t = makeApp();
    const first = { apiRequestsPerMinute: 600, runsAtOnce: 20, approvalsPending: 500 };
    expect(await t.call('kgi_sy_limits', 'PUT', path(active), first)).toEqual({
      status: 200,
      body: { tenantId: active, limits: first },
    });
    const second = { runsAtOnce: 10 };
    expect((await t.call('kgi_sy_limits', 'PUT', path(active), second)).body.limits).toEqual(
      second,
    );
    expect(t.limits.get(active)).toEqual(second);
    expect((await t.call('kgi_sy_limits', 'PUT', path(active), {})).body.limits).toEqual({});
  });

  test('an unknown limit, or one out of range, is 400 naming it', async () => {
    const t = makeApp();
    const unknown = await t.call('kgi_sy_limits', 'PUT', path(active), { runsPerDay: 5 });
    expect([unknown.status, t.code(unknown)]).toEqual([400, 'bad-input']);
    expect(String((unknown.body.error as { message: string }).message)).toContain('`runsPerDay`');
    for (const value of [0, -1, 1.5, 1_000_001, '5', null]) {
      const r = await t.call('kgi_sy_limits', 'PUT', path(active), { runsAtOnce: value });
      expect([r.status, t.code(r)], String(value)).toEqual([400, 'bad-input']);
    }
    expect(t.limits.size).toBe(0);
  });

  test('another scope, a tenant key, a closing tenant: refused', async () => {
    const t = makeApp();
    const prod = await t.call('kgi_sy_production', 'PUT', path(active), { runsAtOnce: 5 });
    expect([prod.status, t.code(prod)]).toEqual([403, 'system-scope-missing']);
    const tenantKey = await t.call(TENANT_ADMIN, 'PUT', path(active), { runsAtOnce: 5 });
    expect([tenantKey.status, t.code(tenantKey)]).toEqual([403, 'system-principal-required']);
    const r = await t.call('kgi_sy_limits', 'PUT', path(closing), { runsAtOnce: 5 });
    expect([r.status, t.code(r)]).toEqual([409, 'tenant-closing']);
    expect(t.limits.size).toBe(0);
  });
});
