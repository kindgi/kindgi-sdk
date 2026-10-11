// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantLimits } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp, createInMemoryRateLimitStore } from '../src/index.js';
import type { RateLimitStore, RunHandlerBinding, TenantLimitsOptions } from '../src/index.js';

/**
 * A tenant's own limit on API requests a minute (`createApp`'s
 * `tenantLimits`, from `TenantSummary.limits`): `429 rate-limit-exceeded`
 * past it, with `Retry-After`; a tenant without one, and a system key, are
 * never counted.
 */

const TOKEN = 'tenant-key';
const SYSTEM = 'kgi_sy_usage';

function makeApp(setup: {
  readonly limits: () => TenantLimits | undefined;
  readonly tenantLimits?: TenantLimitsOptions;
  readonly failRead?: () => boolean;
}) {
  const tenantId = randomUUID() as TenantId;
  const stubs = createStubAppBindings();
  const app = createApp({
    ...stubs,
    tenancy: 'multi',
    systemAccessAudit: {
      async record() {},
      async begin() {
        return '0';
      },
      async finish() {},
    },
    systemUsage: {
      async read() {
        return { kind: 'ok', page: { data: [], watermark: '2026-11-01T00:00:00.000Z' } };
      },
    },
    tenantHierarchyBinding: {
      ...stubs.tenantHierarchyBinding,
      getTenant: async (id: TenantId) => {
        if (setup.failRead?.() === true) throw new Error('the database is down');
        const limits = setup.limits();
        return {
          id,
          name: 'Acme',
          slug: 'acme',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          ...(limits !== undefined && { limits }),
        };
      },
    },
    resolveToken: async (token) => {
      if (token === TOKEN) {
        return { tenantId, userId: 'user-1' as UserId, scopes: ['tenant-admin'] };
      }
      if (token === SYSTEM) {
        return {
          tenantId: SYSTEM_TENANT_ID,
          system: { keyId: 'k-usage' },
          capabilities: ['system:usage:read'],
        };
      }
      return null;
    },
    runHandler: {} as RunHandlerBinding,
    tenantLimits: setup.tenantLimits ?? {},
  });
  const get = async (path = '/v1/tenant', token = TOKEN) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      body: (await res.json()) as Record<string, any>,
    };
  };
  return { get };
}

function clock(start = Date.parse('2026-11-02T09:00:00Z')) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("a tenant's API requests a minute", () => {
  test('past the limit: 429 rate-limit-exceeded, Retry-After, then through again next minute', async () => {
    const c = clock();
    const { get } = makeApp({
      limits: () => ({ apiRequestsPerMinute: 3 }),
      tenantLimits: { now: c.now, store: createInMemoryRateLimitStore(c.now) },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await get()).status);
    expect(statuses).toEqual([200, 200, 200]);
    const refused = await get();
    expect(refused.status).toBe(429);
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(refused.body.error).toMatchObject({
      code: 'rate-limit-exceeded',
      details: { limit: 'api-requests' },
    });
    expect(refused.body.error.message).toContain('API requests a minute');
    c.advance(60_000);
    expect((await get()).status).toBe(200);
  });

  test('a tenant without a limit is never limited', async () => {
    const { get } = makeApp({ limits: () => undefined });
    for (let i = 0; i < 20; i += 1) expect((await get()).status).toBe(200);
  });

  test('a system key acts in no tenant and is never counted', async () => {
    const { get } = makeApp({ limits: () => ({ apiRequestsPerMinute: 1 }) });
    const window = '/v1/system/usage?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z';
    for (let i = 0; i < 5; i += 1) expect((await get(window, SYSTEM)).status).toBe(200);
  });

  test('limits are read again once kept for cacheMs: a raised limit applies then', async () => {
    const c = clock();
    let limit = 1;
    const { get } = makeApp({
      limits: () => ({ apiRequestsPerMinute: limit }),
      tenantLimits: { now: c.now, cacheMs: 10_000, store: createInMemoryRateLimitStore(c.now) },
    });
    expect((await get()).status).toBe(200);
    limit = 5;
    expect((await get()).status).toBe(429);
    c.advance(10_000);
    expect((await get()).status).toBe(200);
  });

  test('a store that fails counts nothing and refuses no one; a failed read keeps the last limits', async () => {
    const failing: RateLimitStore = {
      async take() {
        throw new Error('the store is down');
      },
    };
    const broken = makeApp({
      limits: () => ({ apiRequestsPerMinute: 1 }),
      tenantLimits: { store: failing },
    });
    for (let i = 0; i < 3; i += 1) expect((await broken.get()).status).toBe(200);

    const c = clock();
    let down = false;
    const flaky = makeApp({
      limits: () => ({ apiRequestsPerMinute: 1 }),
      failRead: () => down,
      tenantLimits: { now: c.now, cacheMs: 1_000, store: createInMemoryRateLimitStore(c.now) },
    });
    expect((await flaky.get()).status).toBe(200);
    down = true;
    c.advance(1_000);
    // The read fails; the limit last read (1 a minute) still applies.
    expect((await flaky.get()).status).toBe(429);
  });
});
