// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A publish request is its tenant's work, every compile counted: the
 * scope `publishCompilesMiddleware` opens reaches the handler, through
 * its awaits, and ends with the request.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { currentTenant } from '@kindgi/bounds';
import type { TenantId } from '@kindgi/types';

import { publishCompilesMiddleware } from '../src/middleware/publish-compiles.js';
import type { AppEnv } from '../src/types.js';

function app() {
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    c.set('tenantId', c.req.header('x-tenant') as TenantId);
    await next();
  });
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

  test('a route without it opens no scope', async () => {
    const res = await app().request('/other', {
      method: 'POST',
      headers: { 'x-tenant': 'tenant-a' },
    });
    expect(await res.json()).toBeNull();
  });
});
