// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantLimits } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  SystemAccessRecord,
  SystemTenantState,
  SystemUsagePage,
  SystemUsageQuery,
} from '../src/index.js';

/**
 * The control plane's system routes on a tenant and on usage:
 * `PUT /v1/system/tenants/:tenantId/production-allowed`, `…/limits`, and
 * `GET /v1/system/usage`. Each takes its own system scope; a tenant's key
 * never reaches them.
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
  kgi_sy_usage: ['system:usage:read'],
  kgi_sy_deployments: ['system:deployments'],
  kgi_sy_full: ['kindgi:system'],
};
const TENANT_ADMIN = 'kgi_ak_tenant_admin';

const PAGE: SystemUsagePage = {
  data: [
    {
      tenantId: active,
      kind: 'run.started',
      class: 'production',
      count: 3,
      quantity: 3,
      firstAt: '2026-11-01T08:00:00.000Z',
      lastAt: '2026-11-03T17:30:00.000Z',
    },
  ],
  watermark: '2026-11-04T00:00:00.000Z',
};

function makeApp() {
  const productionAllowed = new Map<string, boolean>();
  const limits = new Map<string, TenantLimits>();
  const asked: SystemUsageQuery[] = [];
  const audit: SystemAccessRecord[] = [];
  let usageAnswer: 'page' | 'cursor-unreadable' = 'page';
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
    systemUsage: {
      async read(query) {
        asked.push(query);
        return usageAnswer === 'page' ? { kind: 'ok', page: PAGE } : { kind: 'cursor-unreadable' };
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
    asked,
    audit,
    answerUsage: (a: typeof usageAnswer) => {
      usageAnswer = a;
    },
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

describe('GET /v1/system/usage', () => {
  const window = 'from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

  test('passes the query to the binding and answers its page', async () => {
    const t = makeApp();
    const r = await t.call(
      'kgi_sy_usage',
      'GET',
      `/v1/system/usage?${window}&groupBy=tenant,project,state&kind=project.production&state=on&class=production,staging&tenantId=${active.toUpperCase()}&limit=50&cursor=abc`,
    );
    expect(r).toEqual({ status: 200, body: PAGE });
    expect(t.asked).toEqual([
      {
        from: new Date('2026-11-01T00:00:00Z'),
        to: new Date('2026-12-01T00:00:00Z'),
        groupBy: ['tenant', 'project', 'state'],
        kinds: ['project.production'],
        classes: ['production', 'staging'],
        states: ['on'],
        tenantId: active,
        limit: 50,
        cursor: 'abc',
      },
    ]);
  });

  test('defaults: grouped by tenant and kind, 1000 groups a page, no filters', async () => {
    const t = makeApp();
    await t.call('kgi_sy_usage', 'GET', `/v1/system/usage?${window}`);
    expect(t.asked[0]).toEqual({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      groupBy: ['tenant', 'kind'],
      limit: 1000,
    });
  });

  test('a query it can’t read is 400, naming what', async () => {
    const t = makeApp();
    const bad = [
      '',
      'from=2026-11-01&to=2026-12-01',
      'from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z',
      'from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z',
      `${window}&groupBy=tenant,customer`,
      `${window}&groupBy=tenant,tenant`,
      `${window}&kind=run.anything`,
      `${window}&class=live`,
      `${window}&state=maybe`,
      `${window}&tenantId=acme`,
      `${window}&limit=0`,
      `${window}&limit=10001`,
    ];
    for (const q of bad) {
      const r = await t.call('kgi_sy_usage', 'GET', `/v1/system/usage?${q}`);
      expect([r.status, t.code(r)], q).toEqual([400, 'bad-input']);
    }
    expect(t.asked).toEqual([]);
  });

  test('a cursor the binding can’t read is 400', async () => {
    const t = makeApp();
    t.answerUsage('cursor-unreadable');
    const r = await t.call('kgi_sy_usage', 'GET', `/v1/system/usage?${window}&cursor=forged`);
    expect([r.status, t.code(r)]).toEqual([400, 'bad-input']);
  });

  test("another scope, or a tenant's key: refused before the query is read", async () => {
    const t = makeApp();
    const other = await t.call('kgi_sy_production', 'GET', '/v1/system/usage');
    expect([other.status, t.code(other)]).toEqual([403, 'system-scope-missing']);
    const tenantKey = await t.call(TENANT_ADMIN, 'GET', `/v1/system/usage?${window}`);
    expect([tenantKey.status, t.code(tenantKey)]).toEqual([403, 'system-principal-required']);
    expect(t.asked).toEqual([]);
  });

  test('the access record marks a read across every tenant', async () => {
    const t = makeApp();
    await t.call('kgi_sy_usage', 'GET', `/v1/system/usage?${window}`);
    expect(t.audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_usage',
      scope: 'system:usage:read',
      tenantId: '*',
    });
  });
});
