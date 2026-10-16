// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An exception a route throws reaches the client as a `500
 * internal-server-error` wire error, as JSON with a fixed message and the
 * request id — never the thrown error's own text — not as Hono's
 * plain-text "Internal Server Error". The full error stays in the log.
 */

import { randomUUID } from 'node:crypto';

import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import { TenantBudgetError } from '@kindgi/bounds';
import { type Logger, createLogger } from '@kindgi/log';
import type { RunBinding } from '@kindgi/runtime';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'thrown-errors-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** The app with the run binding's reads throwing `thrown`, optionally logging to `logger`. */
function appWhoseRunReadsThrow(thrown: Error, logger?: Logger) {
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async () => {
      throw thrown;
    },
    listRuns: async () => {
      throw thrown;
    },
  } as unknown as RunBinding;
  return createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...(logger !== undefined && { logger }),
  });
}

async function get(app: ReturnType<typeof appWhoseRunReadsThrow>, path: string) {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${TOKEN}`, 'x-request-id': 'req-thrown-errors' },
  });
  return { res, text: await res.text() };
}

describe('a thrown exception on the wire', () => {
  test("a 500: a fixed message and the request id, never the thrown error's own text", async () => {
    // The cause carries an internal address (an unreachable upstream): the
    // kind of detail that must not cross the border to a tenant.
    const logLines: string[] = [];
    const app = appWhoseRunReadsThrow(
      new Error('connect ECONNREFUSED 10.1.2.3:8080'),
      createLogger({ write: (line) => logLines.push(line) }),
    );
    for (const path of ['/v1/runs', `/v1/runs/${randomUUID()}`]) {
      const { res, text } = await get(app, path);
      expect(res.status, path).toBe(500);
      expect(res.headers.get('content-type'), path).toMatch(/^application\/json/);
      const body = JSON.parse(text) as { error: Record<string, unknown> };
      expect(body, path).toEqual({
        error: {
          code: 'internal-server-error',
          message: 'Unhandled server error',
          requestId: 'req-thrown-errors',
        },
      });
      // Neither the thrown error's text nor the address it carried reaches the client.
      expect(text, path).not.toContain('ECONNREFUSED');
      expect(text, path).not.toContain('10.1.2.3');
      // The 500 is logged, under the same requestId the body carries.
      const unhandled = logLines
        .map((line) => JSON.parse(line) as { message?: string; requestId?: string })
        .find((r) => r.message === 'unhandled error' && r.requestId === body.error.requestId);
      expect(unhandled, path).toBeDefined();
    }
    // The detail an operator needs is kept — in the log, not the answer.
    expect(logLines.join('\n')).toContain('10.1.2.3');
  });

  test('an exception without a message still says something', async () => {
    const { res, text } = await get(appWhoseRunReadsThrow(new Error('')), '/v1/runs');
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
    const { res, text } = await get(appWhoseRunReadsThrow(failed), '/v1/runs');
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
      const { res, text } = await get(appWhoseRunReadsThrow(refused), '/v1/runs');
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

  test('an exception that carries its own response answers with it', async () => {
    const thrown = new HTTPException(413, { message: 'Too big' });
    const { res, text } = await get(appWhoseRunReadsThrow(thrown), '/v1/runs');
    expect(res.status).toBe(413);
    expect(text).toBe('Too big');
  });
});
