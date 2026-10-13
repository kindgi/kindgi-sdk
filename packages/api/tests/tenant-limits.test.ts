// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import aws4 from 'aws4';
import { describe, expect, test } from 'vitest';

import type { TenantLimits } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { SYSTEM_TENANT_ID, createApp, createInMemoryRateLimitStore } from '../src/index.js';
import type { RateLimitStore, RunHandlerBinding, TenantLimitsOptions } from '../src/index.js';
import { fullAppInput } from './support/full-app.js';

/**
 * A tenant's own limit on API requests a minute (`createApp`'s
 * `tenantLimits`, from `TenantSummary.limits`): `429 rate-limit-exceeded`
 * past it, with `Retry-After`; on `/s3`, counted in the same minute, S3's
 * `503 SlowDown`. A tenant without one, and a system key, are never counted.
 * A frozen tenant's writes are refused before they're counted.
 */

const TOKEN = 'tenant-key';
const SYSTEM = 'kgi_sy_limits';
const S3_KEY = 'AKIAKINDGITEST000009';
const S3_SECRET = 'kindgi-test-secret-key-0000000000000009';

function makeApp(setup: {
  readonly limits: () => TenantLimits | undefined;
  readonly tenantLimits?: TenantLimitsOptions;
  readonly failRead?: () => boolean;
  /** The tenant's state, as the gate reads it: active unless set. */
  readonly state?: 'active' | 'suspended' | 'closing';
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
    systemTenantDirectory: {
      async get(id) {
        return { id, state: 'active' };
      },
    },
    tenantStates: { of: async () => setup.state ?? 'active' },
    systemTenantSettings: {
      async setProductionAllowed(_id, allowed) {
        return { productionAllowed: allowed };
      },
      async limits() {
        return setup.limits() ?? {};
      },
      async setLimits(_id, next) {
        return next;
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
          capabilities: ['system:tenants:limits'],
        };
      }
      return null;
    },
    runHandler: {} as RunHandlerBinding,
    tenantLimits: setup.tenantLimits ?? {},
    // The S3-compatible surface, with the tenant's own S3 key.
    ...(fullAppInput().blobStorage !== undefined && { blobStorage: fullAppInput().blobStorage }),
    s3Credentials: {
      async resolve(accessKeyId) {
        return accessKeyId === S3_KEY
          ? ({ accessKeyId, secretKey: S3_SECRET, tenantId, bucket: 'artifacts' } as never)
          : null;
      },
    },
  });
  const get = async (path = '/v1/tenant', token = TOKEN) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return {
      status: res.status,
      retryAfter: res.headers.get('retry-after'),
      body: (await res.json()) as Record<string, any>,
    };
  };
  const post = async (path: string, body: unknown) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** An S3 request signed with the tenant's S3 key (aws4, as S3 clients sign). */
  const s3 = async (method: string, path: string, body = '') => {
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
      retryAfter: res.headers.get('retry-after'),
      code: /<Code>([^<]+)<\/Code>/.exec(await res.text())?.[1],
    };
  };
  /** The control plane setting this tenant's limits, with its system key. */
  const setLimits = async (limits: TenantLimits) => {
    const res = await app.request(`/v1/system/tenants/${tenantId}/limits`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${SYSTEM}`, 'content-type': 'application/json' },
      body: JSON.stringify(limits),
    });
    return { status: res.status };
  };
  return { get, post, s3, setLimits };
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

  test('a system key acts in no tenant and is never counted, even on the limited tenant', async () => {
    const { setLimits } = makeApp({ limits: () => ({ apiRequestsPerMinute: 1 }) });
    for (let i = 0; i < 5; i += 1) {
      expect((await setLimits({ apiRequestsPerMinute: 1 })).status).toBe(200);
    }
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

  test("/s3 counts in the same minute: past it, S3's 503 SlowDown with Retry-After, and /v1 is past it too", async () => {
    const c = clock();
    const { get, s3 } = makeApp({
      limits: () => ({ apiRequestsPerMinute: 2 }),
      tenantLimits: { now: c.now, store: createInMemoryRateLimitStore(c.now) },
    });
    expect((await get()).status).toBe(200);
    const allowed = await s3('GET', '/s3/artifacts/report.txt');
    expect(allowed.status).not.toBe(503);
    const refused = await s3('PUT', '/s3/artifacts/report.txt', 'hello');
    expect(refused).toMatchObject({ status: 503, code: 'SlowDown' });
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
    expect((await get()).status).toBe(429);
    c.advance(60_000);
    expect((await s3('GET', '/s3/artifacts/report.txt')).status).not.toBe(503);
  });

  test("a frozen tenant's refused writes don't use its minute, on /v1 or /s3: the state gate answers first", async () => {
    const c = clock();
    const { get, post, s3 } = makeApp({
      limits: () => ({ apiRequestsPerMinute: 2 }),
      state: 'suspended',
      tenantLimits: { now: c.now, store: createInMemoryRateLimitStore(c.now) },
    });
    for (let i = 0; i < 5; i += 1) {
      const write = await post('/v1/projects', { name: 'Shop' });
      expect([write.status, write.body.error?.code]).toEqual([409, 'tenant-suspended']);
      expect(await s3('PUT', '/s3/artifacts/report.txt', 'hello')).toMatchObject({
        status: 403,
        code: 'AllAccessDisabled',
      });
    }
    // Its reads still have the whole minute: two, then the limit.
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);
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
