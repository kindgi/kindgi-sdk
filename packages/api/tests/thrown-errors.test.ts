// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An exception a route throws reaches the client as a `500
 * internal-server-error` wire error, as JSON with its message and the
 * request id, not as Hono's plain-text "Internal Server Error". A GET or
 * HEAD the database was too busy to answer in time answers `503
 * database-busy` with `Retry-After` instead.
 */

import { randomUUID } from 'node:crypto';

import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import { TenantBudgetError } from '@kindgi/bounds';
import type { RunBinding } from '@kindgi/runtime';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'thrown-errors-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** The app with the run binding's reads, and its cancel, throwing `thrown`. */
function appWhoseRunCallsThrow(thrown: Error) {
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async () => {
      throw thrown;
    },
    listRuns: async () => {
      throw thrown;
    },
    cancelRun: async () => {
      throw thrown;
    },
  } as unknown as RunBinding;
  return createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
}

async function get(app: ReturnType<typeof appWhoseRunCallsThrow>, path: string, method = 'GET') {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'x-request-id': 'req-thrown-errors' },
  });
  return { res, text: await res.text() };
}

describe('a thrown exception on the wire', () => {
  test('a 500 internal-server-error, as JSON, with its message and the request id', async () => {
    const app = appWhoseRunCallsThrow(new Error('Listing runs failed: the database is gone'));
    for (const path of ['/v1/runs', `/v1/runs/${randomUUID()}`]) {
      const { res, text } = await get(app, path);
      expect(res.status, path).toBe(500);
      expect(res.headers.get('content-type'), path).toMatch(/^application\/json/);
      expect(JSON.parse(text), path).toEqual({
        error: {
          code: 'internal-server-error',
          message: 'Listing runs failed: the database is gone',
          requestId: expect.any(String),
        },
      });
    }
  });

  test('an exception without a message still says something', async () => {
    const { res, text } = await get(appWhoseRunCallsThrow(new Error('')), '/v1/runs');
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error).toMatchObject({
      code: 'internal-server-error',
      message: 'Unhandled server error',
    });
  });

  test("a failed query's SQL and values stay in the log, not the answer", async () => {
    const failed = new Error(
      'Failed query: select "id" from "people" where "email" = $1\nparams: alice@acme.example',
    );
    failed.name = 'DrizzleQueryError';
    const { res, text } = await get(appWhoseRunCallsThrow(failed), '/v1/runs');
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error).toMatchObject({
      code: 'internal-server-error',
      message: 'A database query failed.',
    });
    expect(text).not.toContain('alice@acme.example');
    expect(text).not.toContain('select');
  });

  test.each([
    ['template-render-time', 2_500, '3'],
    ['schema-compile-time', 0, '1'],
  ] as const)(
    'work a budget kept per tenant refused (%s): 429 rate-limit-exceeded, the budget, and Retry-After',
    async (limit, retryAfterMs, retryAfter) => {
      const refused = new TenantBudgetError('Over the budget', limit, 5_000, retryAfterMs);
      const { res, text } = await get(appWhoseRunCallsThrow(refused), '/v1/runs');
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe(retryAfter);
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'rate-limit-exceeded',
          message: 'Over the budget',
          requestId: expect.any(String),
          details: { limit, budgetMs: 5_000 },
        },
      });
    },
  );

  /** A storage failure marked busy, `depth` links down the thrown error's `cause` chain (0: the error itself). */
  function busyAt(depth: number): Error {
    const marked = {
      code: 'database-busy',
      message: 'Tenant-scoped query failed: canceling statement due to lock timeout',
      cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    };
    if (depth === 0) return Object.assign(new Error(marked.message), marked);
    let node: unknown = marked;
    for (let link = depth; link > 0; link--) {
      node = new Error(`Listing runs failed (${link})`, { cause: node });
    }
    return node as Error;
  }

  test.each([0, 1, 2, 15])(
    'a read the database was too busy for (marked %i deep): 503 database-busy, Retry-After, no setting named',
    async (depth) => {
      const { res, text } = await get(appWhoseRunCallsThrow(busyAt(depth)), '/v1/runs');
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('5');
      expect(JSON.parse(text)).toEqual({
        error: {
          code: 'database-busy',
          message: 'The database was too busy to answer in time. Try again after Retry-After.',
          requestId: expect.any(String),
        },
      });
      expect(text).not.toContain('lock timeout');
    },
  );

  test('a HEAD the database was too busy for answers the same 503', async () => {
    const { res, text } = await get(
      appWhoseRunCallsThrow(busyAt(2)),
      `/v1/runs/${randomUUID()}`,
      'HEAD',
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(text).toBe('');
  });

  test('a write the database was too busy for still answers 500: part of it may have committed', async () => {
    const { res, text } = await get(
      appWhoseRunCallsThrow(busyAt(2)),
      `/v1/runs/${randomUUID()}/cancel`,
      'POST',
    );
    expect(res.status).toBe(500);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(JSON.parse(text).error).toMatchObject({ code: 'internal-server-error' });
  });

  test('a busy mark past 16 links, or none on a cyclic chain, answers 500', async () => {
    const deep = await get(appWhoseRunCallsThrow(busyAt(16)), '/v1/runs');
    expect(deep.res.status).toBe(500);
    expect(deep.res.headers.get('Retry-After')).toBeNull();
    const first = new Error('Listing runs failed');
    const second = new Error('Tenant-scoped query failed', { cause: first });
    (first as { cause?: unknown }).cause = second;
    const cyclic = await get(appWhoseRunCallsThrow(first), '/v1/runs');
    expect(cyclic.res.status).toBe(500);
  });

  test('an exception that carries its own response answers with it', async () => {
    const thrown = new HTTPException(413, { message: 'Too big' });
    const { res, text } = await get(appWhoseRunCallsThrow(thrown), '/v1/runs');
    expect(res.status).toBe(413);
    expect(text).toBe('Too big');
  });
});
