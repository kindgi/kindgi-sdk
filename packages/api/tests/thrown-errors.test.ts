// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An exception a route throws reaches the client as a `500
 * internal-server-error` wire error, as JSON with a fixed message and the
 * request id — never the thrown error's own text — not as Hono's
 * plain-text "Internal Server Error". The full error stays in the log. A
 * GET or HEAD the database was too busy to answer in time answers `503
 * database-busy` with `Retry-After` instead.
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

/** The app with the run binding's reads, and its cancel, throwing `thrown`, optionally logging to `logger`. */
function appWhoseRunCallsThrow(thrown: Error, logger?: Logger) {
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
    ...(logger !== undefined && { logger }),
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
  test("a 500: a fixed message and the request id, never the thrown error's own text", async () => {
    // The cause carries an internal address (an unreachable upstream): the
    // kind of detail that must not cross the border to a tenant.
    const logLines: string[] = [];
    const app = appWhoseRunCallsThrow(
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
    const { res, text } = await get(appWhoseRunCallsThrow(new Error('')), '/v1/runs');
    expect(res.status).toBe(500);
    expect(JSON.parse(text).error).toMatchObject({
      code: 'internal-server-error',
      message: 'Unhandled server error',
    });
  });

  test("a failed query's SQL and values stay out of the answer", async () => {
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

  test('one that carries its own response, with the busy mark down its cause: a read answers the 503, a write its own response', async () => {
    const coded = () => new HTTPException(502, { message: 'Signing failed', cause: busyAt(1) });
    const read = await get(appWhoseRunCallsThrow(coded()), '/v1/runs');
    expect(read.res.status).toBe(503);
    expect(read.res.headers.get('Retry-After')).toBe('5');
    expect(JSON.parse(read.text).error.code).toBe('database-busy');
    const write = await get(
      appWhoseRunCallsThrow(coded()),
      `/v1/runs/${randomUUID()}/cancel`,
      'POST',
    );
    expect(write.res.status).toBe(502);
    expect(write.text).toBe('Signing failed');
  });
});

describe("a failed query in the thrown error's log line", () => {
  interface LoggedError {
    name?: string;
    message?: string;
    code?: string;
    stack?: string;
    cause?: LoggedError;
  }

  /** The database driver's error: what the server answered, and its SQLSTATE. */
  function driverError(): Error {
    return Object.assign(new Error('relation "people" does not exist'), { code: '42P01' });
  }

  /** Drizzle's wrapper around a failed query, in its own shape: its message the SQL and the values. */
  function queryError(cause?: unknown): Error {
    return Object.assign(
      new Error(
        'Failed query: select "id" from "people" where "email" = $1\nparams: alice@acme.example',
      ),
      {
        query: 'select "id" from "people" where "email" = $1',
        params: ['alice@acme.example'],
        cause,
      },
    );
  }

  /** `inner`, `depth` errors down the thrown error's `cause` chain (0: the thrown error itself). */
  function wrappedAt(depth: number, inner: Error): Error {
    let node = inner;
    for (let link = depth; link > 0; link--) {
      node = new Error(`Listing runs failed (${link})`, { cause: node });
    }
    return node;
  }

  /** Throw `thrown` from a run read; the answer, and the `err` of each log line with `message`. */
  async function logged(thrown: Error, message: string, path = '/v1/runs') {
    const lines: string[] = [];
    const app = appWhoseRunCallsThrow(thrown, createLogger({ write: (line) => lines.push(line) }));
    const { res, text } = await get(app, path);
    const errs = lines
      .map((line) => JSON.parse(line) as { message?: string; err?: LoggedError })
      .filter((record) => record.message === message)
      .map((record) => record.err);
    return { res, text, errs, line: lines.join('\n') };
  }

  /** The stand-in a query error is logged as: the fixed text, over the frames of where it was made. */
  function expectStandIn(at: LoggedError | undefined) {
    expect(at?.name).toBe('Error');
    expect(at?.message).toBe('A database query failed.');
    expect(typeof at?.stack).toBe('string');
    expect(at?.stack).toMatch(/^Error: A database query failed\.\n {4}at /);
    expect(at?.stack).toContain('thrown-errors.test');
  }

  test.each([0, 1, 2, 3])(
    '%i deep: a stand-in in its place keeps where the query ran and what the server said, and no SQL or value is logged',
    async (depth) => {
      const driver = driverError();
      const failed = queryError(driver);
      const thrown = wrappedAt(depth, failed);
      const { res, text, errs, line } = await logged(thrown, 'unhandled error');
      expect(res.status).toBe(500);
      expect(text).not.toContain('alice@acme.example');
      expect(errs).toHaveLength(1);
      expect(line).not.toContain('Failed query');
      expect(line).not.toContain('params:');
      expect(line).not.toContain('alice@acme.example');
      // The errors above it keep their message and their own stack.
      let at = errs[0];
      for (let link = 1; link <= depth; link++) {
        expect(at?.message).toBe(`Listing runs failed (${link})`);
        expect(typeof at?.stack).toBe('string');
        expect(at?.stack).toContain(`Listing runs failed (${link})`);
        expect(at?.stack).toContain('thrown-errors.test');
        at = at?.cause;
      }
      expectStandIn(at);
      // The driver's error under it, unless that's past the three causes a line writes.
      if (depth < 3) {
        expect(at?.cause).toMatchObject({
          name: 'Error',
          message: 'relation "people" does not exist',
          code: '42P01',
        });
      } else {
        expect(at?.cause).toBeUndefined();
      }
      // The thrown errors themselves are unchanged.
      let node: unknown = thrown;
      for (let link = 0; link < depth; link++) node = (node as Error).cause;
      expect(node).toBe(failed);
      expect(failed.cause).toBe(driver);
      expect(failed.message).toContain('alice@acme.example');
    },
  );

  test('a failed query with no cause, or on a cycle of them, logs its stand-in', async () => {
    const cyclic = queryError();
    (cyclic as { cause?: unknown }).cause = queryError(cyclic);
    for (const failed of [queryError(), cyclic]) {
      const { errs, line } = await logged(wrappedAt(1, failed), 'unhandled error');
      expectStandIn(errs[0]?.cause);
      expect(line).not.toContain('alice@acme.example');
    }
  });

  test('a failed query whose cause is another: a stand-in for each, and the driver error under both', async () => {
    const { errs, line } = await logged(queryError(queryError(driverError())), 'unhandled error');
    expectStandIn(errs[0]);
    expectStandIn(errs[0]?.cause);
    expect(errs[0]?.cause?.cause).toMatchObject({ message: 'relation "people" does not exist' });
    expect(line).not.toContain('alice@acme.example');
  });

  test("a stack that doesn't start with the query's own message line keeps no frames", async () => {
    // The stack was written before the message lost its values line, so the
    // values sit after what the message says the first line is.
    const failed = queryError(driverError());
    expect(failed.stack).toContain('alice@acme.example');
    failed.message = 'Failed query: select "id" from "people" where "email" = $1';
    const { errs, line } = await logged(failed, 'unhandled error');
    expect(errs[0]).toMatchObject({ name: 'Error', message: 'A database query failed.' });
    expect(errs[0]?.stack).toBeUndefined();
    expect(line).not.toContain('alice@acme.example');
  });

  /** A Postgres server error as postgres.js surfaces one: a SQLSTATE `code`, a `severity`, the server's text. */
  function serverError(text: string, code: string, severity: string | null = 'ERROR'): Error {
    const err = Object.assign(new Error(text), {
      code,
      ...(severity !== null && { severity }),
    });
    err.name = 'PostgresError';
    return err;
  }

  test.each([
    [
      'an invalid uuid',
      'invalid input syntax for type uuid: "marker-not-a-uuid"',
      'marker-not-a-uuid',
    ],
    [
      'an invalid enum value',
      'invalid input value for enum run_status: "marker-status"',
      'marker-status',
    ],
  ])(
    '%s under a failed query: the line says what it means and its SQLSTATE, never the value',
    async (_, text, marker) => {
      const rejected = serverError(text, '22P02');
      const { errs, line } = await logged(wrappedAt(1, queryError(rejected)), 'unhandled error');
      expect(line).not.toContain(marker);
      const said = errs[0]?.cause?.cause;
      expect(said).toMatchObject({
        name: 'PostgresError',
        message: 'invalid input for its type (22P02)',
        code: '22P02',
      });
      expect(said?.stack).toMatch(/^PostgresError: invalid input for its type \(22P02\)\n {4}at /);
      // The driver's error itself is unchanged.
      expect(rejected.message).toBe(text);
    },
  );

  test.each([
    ['22001', 'a value too long for its column'],
    ['22003', 'a number out of range for its type'],
    ['22007', 'an invalid date or time'],
    ['22008', 'a date or time out of range'],
    ['22021', 'bytes invalid in the encoding'],
    ['22P02', 'invalid input for its type'],
    ['22P05', 'a character the database cannot store'],
    ['22023', 'a value the database rejected'],
  ])(
    'a data exception %s with no failed query over it says "%s" and its SQLSTATE',
    async (code, words) => {
      const marker = `marker-${code}`;
      const { errs, line } = await logged(
        wrappedAt(1, serverError(`the server's text: "${marker}"`, code)),
        'unhandled error',
      );
      expect(line).not.toContain(marker);
      expect(errs[0]?.cause).toMatchObject({
        name: 'PostgresError',
        message: `${words} (${code})`,
        code,
      });
    },
  );

  test("another SQLSTATE's text, or a class-22 code with no severity, is logged as it is", async () => {
    const unique = serverError(
      'duplicate key value violates unique constraint "people_email_key"',
      '23505',
    );
    const noSeverity = serverError('not the server: "kept"', '22P02', null);
    for (const err of [unique, noSeverity]) {
      const { errs } = await logged(wrappedAt(1, err), 'unhandled error');
      expect(errs[0]?.cause?.message).toBe(err.message);
    }
  });

  test('an error with no failed query among its causes is logged as it is', async () => {
    const thrown = wrappedAt(2, driverError());
    const { errs } = await logged(thrown, 'unhandled error');
    const direct: string[] = [];
    createLogger({ write: (line) => direct.push(line) }).error('unhandled error', { err: thrown });
    expect(errs[0]).toEqual((JSON.parse(direct[0] ?? '{}') as { err?: unknown }).err);
  });

  test("a read the database was too busy for: its warn line leaves a failed query's text out too", async () => {
    const thrown = Object.assign(new Error('Listing runs failed'), {
      code: 'database-busy',
      cause: queryError(driverError()),
    });
    const { res, errs, line } = await logged(thrown, 'database busy');
    expect(res.status).toBe(503);
    expect(errs[0]?.cause).toMatchObject({ message: 'A database query failed.' });
    expect(errs[0]?.cause?.cause).toMatchObject({
      message: 'relation "people" does not exist',
      code: '42P01',
    });
    expect(line).not.toContain('alice@acme.example');
  });
});

describe('a 500 whose cause carries a database error', () => {
  /** postgres.js's `PostgresError`: the server's fields on it, its message the server's text. */
  class PostgresError extends Error {
    constructor(fields: {
      readonly message: string;
      readonly code: string;
      readonly severity: string;
    }) {
      super(fields.message);
      this.name = 'PostgresError';
      Object.assign(this, fields);
    }
  }

  function serverError(code: string, text: string): Error {
    return new PostgresError({ message: text, code, severity: 'ERROR' });
  }

  /** An error postgres.js makes when a connection fails or ends: its code, also as `errno`, and the database's address. */
  function connectionError(code: string): Error {
    return Object.assign(new Error(`write ${code} db.internal:5432`), {
      code,
      errno: code,
      address: 'db.internal',
      port: 5432,
    });
  }

  /** A storage failure on a tenant's connection: its own message, the driver's error its cause. */
  function tenantScoped(cause: Error): Error {
    return new Error('Tenant-scoped query failed', { cause });
  }

  /** `inner`, `depth` errors down the thrown error's `cause` chain (0: the thrown error itself). */
  function at(depth: number, inner: Error): Error {
    let node = inner;
    for (let link = depth; link > 0; link--) {
      node = new Error(`Listing runs failed (${link})`, { cause: node });
    }
    return node;
  }

  /** Throw `thrown` from a run read (or, with POST, a cancel); the answer. */
  async function answer(thrown: Error, method = 'GET') {
    const path = method === 'GET' ? '/v1/runs' : `/v1/runs/${randomUUID()}/cancel`;
    const { res, text } = await get(appWhoseRunCallsThrow(thrown), path, method);
    return { res, text, error: (JSON.parse(text) as { error: Record<string, unknown> }).error };
  }

  const DATABASE = {
    code: 'internal-server-error',
    message: 'A database query failed.',
    requestId: 'req-thrown-errors',
  };
  const UNHANDLED = { ...DATABASE, message: 'Unhandled server error' };

  test.each([
    ['22P02', 'invalid input syntax for type uuid: "marker-not-a-uuid"', 'marker-not-a-uuid'],
    [
      '23505',
      'duplicate key value violates unique constraint "people_email_key"',
      'people_email_key',
    ],
  ])(
    'a Postgres server error (%s) thrown as it is: `A database query failed.`, never its text',
    async (code, text, marker) => {
      const said = await answer(serverError(code, text));
      expect(said.res.status).toBe(500);
      expect(said.error).toEqual(DATABASE);
      expect(said.text).not.toContain(marker);
    },
  );

  test("a failure on a tenant's connection, the driver's error its cause: `A database query failed.`", async () => {
    for (const cause of [
      serverError('22P02', 'invalid input syntax for type uuid: "x"'),
      connectionError('CONNECTION_CLOSED'),
    ]) {
      const said = await answer(tenantScoped(cause));
      expect(said.res.status).toBe(500);
      expect(said.error).toEqual(DATABASE);
    }
  });

  test.each(['CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED', 'CONNECTION_ENDED'])(
    'a connection postgres.js gave up on (%s), thrown or as a cause: `A database query failed.`, no address',
    async (code) => {
      for (const depth of [0, 1]) {
        const said = await answer(at(depth, connectionError(code)));
        expect(said.error, `${depth} deep`).toEqual(DATABASE);
        expect(said.text, `${depth} deep`).not.toContain('db.internal');
      }
    },
  );

  test('as far down as the busy mark is looked for: a failed query 3 deep, a server error 15 deep; 16 deep is past it', async () => {
    const failed = Object.assign(
      new Error(
        'Failed query: select "id" from "people" where "email" = $1\nparams: alice@acme.example',
      ),
      { name: 'DrizzleQueryError' },
    );
    const three = await answer(at(3, failed));
    expect(three.error).toEqual(DATABASE);
    expect(three.text).not.toContain('alice@acme.example');
    expect(
      (await answer(at(15, serverError('42P01', 'relation "people" does not exist')))).error,
    ).toEqual(DATABASE);
    expect(
      (await answer(at(16, serverError('42P01', 'relation "people" does not exist')))).error,
    ).toEqual(UNHANDLED);
  });

  test('a cycle of causes with no database error on it: `Unhandled server error`', async () => {
    const first = new Error('Listing runs failed');
    first.cause = new Error('Checking access failed', { cause: first });
    expect((await answer(first)).error).toEqual(UNHANDLED);
  });

  test("a `code` without what marks the driver's error: `Unhandled server error`", async () => {
    const cases: Array<[string, Error]> = [
      [
        'a SQLSTATE with no severity',
        Object.assign(new Error('not the server'), { code: '22P02' }),
      ],
      [
        'a severity beside a code that is no SQLSTATE',
        Object.assign(new Error('a queue'), { code: 'E_TIMEOUT', severity: 'ERROR' }),
      ],
      [
        'a postgres.js connection code without its errno',
        Object.assign(new Error('a message bus closed'), { code: 'CONNECTION_CLOSED' }),
      ],
    ];
    for (const [what, err] of cases) {
      for (const depth of [0, 1]) {
        expect((await answer(at(depth, err))).error, `${what}, ${depth} deep`).toEqual(UNHANDLED);
      }
    }
  });

  test("an HTTP client's refused connection (OpenFGA, a secrets store): `Unhandled server error`", async () => {
    const refused = () =>
      Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:8080'), {
        code: 'ECONNREFUSED',
        errno: -61,
        syscall: 'connect',
        address: '10.1.2.3',
        port: 8080,
      });
    for (const thrown of [refused(), new TypeError('fetch failed', { cause: refused() })]) {
      const said = await answer(thrown);
      expect(said.error).toEqual(UNHANDLED);
      expect(said.text).not.toContain('10.1.2.3');
    }
  });

  test.each([
    ['55P03', 'canceling statement due to lock timeout'],
    ['57014', 'canceling statement due to statement timeout'],
  ])(
    'busy (%s): a read still answers the 503, a write the 500 saying `A database query failed.`',
    async (code, text) => {
      const busy = () =>
        Object.assign(new Error(`Tenant-scoped query failed: ${text}`), {
          code: 'database-busy',
          cause: serverError(code, text),
        });
      const read = await answer(busy());
      expect(read.res.status).toBe(503);
      expect(read.res.headers.get('Retry-After')).toBe('5');
      expect(read.error.code).toBe('database-busy');
      const write = await answer(busy(), 'POST');
      expect(write.res.status).toBe(500);
      expect(write.res.headers.get('Retry-After')).toBeNull();
      expect(write.error).toEqual(DATABASE);
    },
  );
});
