// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * No `/v1` answer is kept by a browser or a proxy: `Cache-Control:
 * no-store` on data and errors alike (a 410 is cacheable by default, and
 * one was kept through a reload for a flow since reinstated). Outside
 * `/v1`, the server's own caching stands.
 */

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { noStoreMiddleware } from '../src/middleware/no-store.js';
import type { AppEnv } from '../src/types.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'no-store-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function app() {
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    cost: {
      listRecords: async () => ({ data: [] }),
      getRecord: async () => null,
      aggregate: async () => {
        throw new Error('Could not aggregate cost: connection refused');
      },
    },
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('Cache-Control: no-store on every /v1 answer', () => {
  test.each([
    ['data', '/v1/cost/records', auth, 200],
    ['not found', `/v1/cost/records/${randomUUID()}`, auth, 404],
    ['a thrown error', '/v1/cost/aggregate?groupBy=model', auth, 500],
    ['no token', '/v1/cost/records', {}, 401],
    ['no such route', '/v1/no-such-route', auth, 404],
  ])('%s', async (_, path, headers, status) => {
    const res = await app().request(path, { headers });
    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('outside /v1, the server keeps its own caching', async () => {
    const res = await app().request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('the middleware', () => {
  const mounted = (route: (r: Hono<AppEnv>) => void) => {
    const r = new Hono<AppEnv>();
    r.use('*', noStoreMiddleware());
    route(r);
    return r;
  };

  test("a route's own header gives way to no-store (an event stream's no-cache)", async () => {
    const r = mounted((h) =>
      h.get('/stream', (c) => {
        c.header('Cache-Control', 'no-cache');
        return c.text('data: hi\n\n', 200, { 'content-type': 'text/event-stream' });
      }),
    );
    expect((await r.request('/stream')).headers.get('cache-control')).toBe('no-store');
  });

  test('a response whose headers are immutable is copied, and still says no-store', async () => {
    const r = mounted((h) => h.get('/moved', () => Response.redirect('https://example.com/', 302)));
    const res = await r.request('/moved');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
