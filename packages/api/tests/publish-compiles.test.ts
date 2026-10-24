// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A request is its tenant's work: the scope `tenantScopeMiddleware` opens
 * (a recompile counted) and, inside it, the one `publishCompilesMiddleware`
 * opens (every compile counted) reach the handler, through its awaits, and
 * end with the request. A system principal's request acts in no tenant,
 * so it opens neither.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { currentTenant } from '@kindgi/bounds';
import type { TenantId } from '@kindgi/types';

import { publishCompilesMiddleware } from '../src/middleware/publish-compiles.js';
import { tenantScopeMiddleware } from '../src/middleware/tenant-scope.js';
import { SYSTEM_TENANT_ID } from '../src/system.js';
import type { AppEnv } from '../src/types.js';

function app() {
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    const tenant = c.req.header('x-tenant');
    if (tenant !== undefined) c.set('tenantId', tenant as TenantId);
    if (c.req.header('x-system') !== undefined) {
      c.set('tenantId', SYSTEM_TENANT_ID);
      c.set('systemPrincipal', { keyId: 'boot' });
    }
    await next();
  });
  r.use('*', tenantScopeMiddleware());
  const scope = async () => {
    await sleep(1);
    return currentTenant() ?? null;
  };
  r.post('/publish', publishCompilesMiddleware(), async (c) => c.json(await scope()));
  r.post('/other', async (c) => c.json(await scope()));
  return r;
}

describe('publishCompilesMiddleware', () => {
  test("the handler runs as the request's tenant, every compile counted", async () => {
    const r = app();
    const [a, b] = await Promise.all(
      ['tenant-a', 'tenant-b'].map(async (tenant) =>
        (await r.request('/publish', { method: 'POST', headers: { 'x-tenant': tenant } })).json(),
      ),
    );
    expect(a).toEqual({ tenantId: 'tenant-a', compiles: 'all' });
    expect(b).toEqual({ tenantId: 'tenant-b', compiles: 'all' });
    expect(currentTenant()).toBeUndefined();
  });

  test("a system principal's publish runs outside any scope", async () => {
    const res = await app().request('/publish', { method: 'POST', headers: { 'x-system': '1' } });
    expect(await res.json()).toBeNull();
  });
});

describe('tenantScopeMiddleware', () => {
  test("any other route runs as the request's tenant, a recompile counted", async () => {
    const res = await app().request('/other', {
      method: 'POST',
      headers: { 'x-tenant': 'tenant-a' },
    });
    expect(await res.json()).toEqual({ tenantId: 'tenant-a', compiles: 'recompiles' });
    expect(currentTenant()).toBeUndefined();
  });

  test('a request with no tenant opens no scope', async () => {
    const res = await app().request('/other', { method: 'POST' });
    expect(await res.json()).toBeNull();
  });

  test("a system principal's request opens no scope", async () => {
    const res = await app().request('/other', { method: 'POST', headers: { 'x-system': '1' } });
    expect(await res.json()).toBeNull();
  });
});
