// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  SystemAccessRecord,
  SystemUsageQuery,
  UsagePage,
} from '../src/index.js';

/**
 * `GET /v1/system/usage`, the control plane's read of usage across
 * tenants: it takes `system:usage:read`, and a tenant's key never reaches
 * it. The query reaches the binding parsed; the access record names a
 * read across every tenant, or the one tenant asked for.
 */

const tenant = randomUUID() as TenantId;

const KEYS: Readonly<Record<string, readonly string[]>> = {
  kgi_sy_usage: ['system:usage:read'],
  kgi_sy_production: ['system:tenants:production'],
  kgi_sy_full: ['kindgi:system'],
};
const TENANT_ADMIN = 'kgi_ak_tenant_admin';

const PAGE: UsagePage = {
  data: [
    {
      tenantId: tenant,
      kind: 'run.started',
      class: 'production',
      count: 3,
      quantity: 3,
      firstAt: '2026-11-01T08:00:00.000Z',
      lastAt: '2026-11-03T17:30:00.000Z',
    },
  ],
  watermark: '2026-11-04T00:00:00.000Z',
  nextCursor: 'next',
};

function makeApp() {
  const asked: SystemUsageQuery[] = [];
  const ofTenant: unknown[] = [];
  const audit: SystemAccessRecord[] = [];
  let answer: 'page' | 'cursor-unreadable' = 'page';
  const app = createApp({
    ...createStubAppBindings(),
    tenancy: 'multi',
    tenantStates: { of: async () => undefined },
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
          tenantId: tenant,
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
    usage: {
      async acrossTenants(query) {
        asked.push(query);
        return answer === 'page' ? { kind: 'ok', page: PAGE } : { kind: 'cursor-unreadable' };
      },
      async ofTenant(tenantId, query) {
        ofTenant.push({ tenantId, query });
        return { kind: 'ok', page: { data: [], watermark: PAGE.watermark } };
      },
    },
  });
  const call = async (token: string, path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const code = (r: { body: Record<string, unknown> }) =>
    (r.body.error as { code?: string } | undefined)?.code;
  return {
    call,
    code,
    asked,
    ofTenant,
    audit,
    answer: (a: typeof answer) => {
      answer = a;
    },
  };
}

const window = 'from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

describe('GET /v1/system/usage', () => {
  test('passes the query to the binding and answers its page', async () => {
    const t = makeApp();
    const r = await t.call(
      'kgi_sy_usage',
      `/v1/system/usage?${window}&groupBy=tenant,project,state&kind=project.production&state=on&class=production,staging&tenantId=${tenant.toUpperCase()}&limit=50&cursor=abc`,
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
        tenantId: tenant,
        limit: 50,
        cursor: 'abc',
      },
    ]);
    expect(t.ofTenant).toEqual([]);
  });

  test('defaults: grouped by tenant and kind, 1000 groups a page, no filters', async () => {
    const t = makeApp();
    await t.call('kgi_sy_usage', `/v1/system/usage?${window}`);
    expect(t.asked[0]).toEqual({
      from: new Date('2026-11-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      groupBy: ['tenant', 'kind'],
      limit: 1000,
    });
  });

  test('the full system capability may read it too', async () => {
    const t = makeApp();
    expect((await t.call('kgi_sy_full', `/v1/system/usage?${window}`)).status).toBe(200);
  });

  test('a window of exactly 92 days is read; one millisecond more is not', async () => {
    const t = makeApp();
    const ok = await t.call(
      'kgi_sy_usage',
      '/v1/system/usage?from=2026-01-01T00:00:00Z&to=2026-04-03T00:00:00Z',
    );
    expect(ok.status).toBe(200);
    const over = await t.call(
      'kgi_sy_usage',
      '/v1/system/usage?from=2026-01-01T00:00:00Z&to=2026-04-03T00:00:00.001Z',
    );
    expect([over.status, t.code(over)]).toEqual([400, 'bad-input']);
    expect(String((over.body.error as { message: string }).message)).toContain('92 days');
  });

  test("a query it can't read is 400, naming what", async () => {
    const t = makeApp();
    const bad: readonly [string, string][] = [
      ['', '`from` and `to` are required'],
      ['from=2026-11-01&to=2026-12-01', '`from` and `to` are required'],
      ['from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z', '`to` must be after `from`'],
      ['from=2026-11-01T00:00:00Z&to=2026-11-01T00:00:00Z', '`to` must be after `from`'],
      ['from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z', 'at most 92 days'],
      [`${window}&groupBy=tenant,customer`, '"customer"'],
      [`${window}&groupBy=tenant,tenant`, '`groupBy` names one twice'],
      [`${window}&kind=run.anything`, '`kind` takes'],
      [`${window}&class=live`, '`class` takes'],
      [`${window}&state=maybe`, '`state` takes'],
      [`${window}&tenantId=acme`, '`tenantId` must be a tenant id'],
      [`${window}&limit=0`, '`limit`'],
      [`${window}&limit=10001`, '`limit`'],
      [`${window}&limit=1.5`, '`limit`'],
    ];
    for (const [q, says] of bad) {
      const r = await t.call('kgi_sy_usage', `/v1/system/usage?${q}`);
      expect([r.status, t.code(r)], q).toEqual([400, 'bad-input']);
      expect(String((r.body.error as { message: string }).message), q).toContain(says);
    }
    expect(t.asked).toEqual([]);
  });

  test("a cursor the binding can't read is 400: start again", async () => {
    const t = makeApp();
    t.answer('cursor-unreadable');
    const r = await t.call('kgi_sy_usage', `/v1/system/usage?${window}&cursor=forged`);
    expect([r.status, t.code(r)]).toEqual([400, 'bad-input']);
    expect(String((r.body.error as { message: string }).message)).toContain('start again');
  });

  test("another scope, or a tenant's key: refused before the query is read", async () => {
    const t = makeApp();
    const other = await t.call('kgi_sy_production', '/v1/system/usage');
    expect([other.status, t.code(other)]).toEqual([403, 'system-scope-missing']);
    const tenantKey = await t.call(TENANT_ADMIN, `/v1/system/usage?${window}`);
    expect([tenantKey.status, t.code(tenantKey)]).toEqual([403, 'system-principal-required']);
    expect(t.asked).toEqual([]);
  });

  test('the access record marks a read across every tenant, or the one tenant named', async () => {
    const t = makeApp();
    await t.call('kgi_sy_usage', `/v1/system/usage?${window}`);
    expect(t.audit.at(-1)).toMatchObject({
      keyId: 'kgi_sy_usage',
      scope: 'system:usage:read',
      tenantId: '*',
    });
    await t.call('kgi_sy_usage', `/v1/system/usage?${window}&tenantId=${tenant}`);
    expect(t.audit.at(-1)).toMatchObject({ scope: 'system:usage:read', tenantId: tenant });
  });
});

describe('GET /v1/usage, for a system key', () => {
  test("it's a tenant route: a system key doesn't read any tenant's usage there", async () => {
    const t = makeApp();
    const r = await t.call('kgi_sy_full', `/v1/usage?${window}`);
    expect(r.status).toBe(403);
    expect(t.ofTenant).toEqual([]);
  });
});
