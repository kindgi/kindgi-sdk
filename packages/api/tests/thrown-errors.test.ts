// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An exception a route throws reaches the client as a `500
 * internal-server-error` wire error, as JSON with its message and the
 * request id, not as Hono's plain-text "Internal Server Error".
 */

import { randomUUID } from 'node:crypto';

import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import type { RunBinding } from '@kindgi/runtime';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'thrown-errors-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

/** The app with the run binding's reads throwing `thrown`. */
function appWhoseRunReadsThrow(thrown: Error) {
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
  });
}

async function get(app: ReturnType<typeof appWhoseRunReadsThrow>, path: string) {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${TOKEN}`, 'x-request-id': 'req-thrown-errors' },
  });
  return { res, text: await res.text() };
}

describe('a thrown exception on the wire', () => {
  test('a 500 internal-server-error, as JSON, with its message and the request id', async () => {
    const app = appWhoseRunReadsThrow(new Error('Listing runs failed: the database is gone'));
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

  test('an exception that carries its own response answers with it', async () => {
    const thrown = new HTTPException(413, { message: 'Too big' });
    const { res, text } = await get(appWhoseRunReadsThrow(thrown), '/v1/runs');
    expect(res.status).toBe(413);
    expect(text).toBe('Too big');
  });
});
