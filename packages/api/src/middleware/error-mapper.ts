// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { TenantBudgetError } from '@kindgi/bounds';
import type { Logger } from '@kindgi/log';
import type { Context } from 'hono';

import { retryAfterSeconds, statusFor, toWireError } from '../errors.js';

/**
 * The app's error handler (`app.onError`). Any exception a route or
 * middleware throws becomes a `500 internal-server-error` wire error with
 * a fixed message and the request id — never the thrown error's own
 * message, which would leak internal detail (an upstream address, a
 * database driver's string) to the tenant whose request failed — on a
 * shared deployment, detail of the platform every tenant shares. The whole
 * error stays in the log. Domain errors returned via
 * `Result<T, E>` are handled per-route; this catches thrown exceptions
 * (framework bugs, DB failures without a Result wrap, etc.).
 *
 * It's an error handler, not a middleware: Hono catches a thrown
 * exception where it's thrown and hands it to the error handler, so a
 * middleware's `try { await next() }` never sees it.
 *
 * An exception that carries its own response (Hono's `HTTPException`,
 * `getResponse()`) answers with it, as Hono's default handler does.
 *
 * Work a budget kept per tenant refused (`TenantBudgetError`: a schema
 * compile past `schemaCompileBudgetMs`, a render past
 * `templateRenderBudgetMs`) is a limit, not a failure:
 * `429 rate-limit-exceeded` with the budget in `details.limit`
 * (`schema-compile-time`, `template-render-time`) and `details.budgetMs`,
 * and `Retry-After`.
 *
 * A read the database was too busy to answer in time is worth a retry: an
 * error with `code: 'database-busy'` anywhere on its `cause` chain (the
 * error itself first, 16 deep at most) answers `503 database-busy` with
 * `Retry-After` on a GET or HEAD (`databaseBusyAnswer`), whatever else it
 * is, an exception that carries its own response included. The bindings'
 * storage sets that code when a lock or statement timeout, or the wait for
 * a pooled connection, ended the query. Any other method answers the 500:
 * a write can have committed part of its work before the timeout, and
 * clients retry a 503 as an answer that nothing ran.
 *
 * The requestId embedded in the response body matches
 * `middleware/request-id.ts`, so a caller can correlate.
 *
 * No thrown error's message reaches the client in a 500. A failed database query's
 * carries its SQL and parameters (Drizzle's `Failed query: … params: …`, a
 * person's email or address); an infrastructure error's carries an internal
 * address (`connect ECONNREFUSED …`). The body says only a fixed message —
 * `A database query failed.` for a query, `Unhandled server error`
 * otherwise — and the log keeps the whole error under `err`.
 */
export function mapThrownError(cause: Error, c: Context): Response {
  const busy = databaseBusyAnswer(cause, c);
  if (busy !== undefined) return busy;
  if ('getResponse' in cause && typeof cause.getResponse === 'function') {
    const res = (cause as { getResponse(): Response }).getResponse();
    return c.newResponse(res.body, res);
  }
  const requestId = (c.get('requestId') as string | undefined) ?? 'req-unknown';
  if (cause instanceof TenantBudgetError) {
    c.header('Retry-After', String(retryAfterSeconds(cause.retryAfterMs)));
    c.status(statusFor('rate-limit-exceeded') as never);
    return c.json(
      toWireError(
        {
          code: 'rate-limit-exceeded',
          message: cause.message,
          limit: cause.limit,
          budgetMs: cause.budgetMs,
        },
        requestId,
      ),
    );
  }
  // A 500 is something an operator should look at: logged, with the error.
  (c.get('log') as Logger | undefined)?.error('unhandled error', { err: cause });
  const body = toWireError(
    {
      code: 'internal-server-error',
      message: isQueryError(cause) ? 'A database query failed.' : 'Unhandled server error',
    },
    requestId,
  );
  c.status(statusFor('internal-server-error') as never);
  return c.json(body);
}

/**
 * The answer to a GET or HEAD the database was too busy for: `503
 * database-busy` with `Retry-After` and a fixed message, when `err` has
 * `code: 'database-busy'` on it or down its `cause` chain, and the busy
 * warning logged with it. `undefined` for any other method or error, for
 * the caller to answer as it would.
 *
 * `err` is a thrown exception (`mapThrownError`) or a binding's Result
 * error, which a route asks this about before its own answer. So a read
 * answers the same whether its binding threw the storage failure or
 * returned it re-coded with the failure as its cause.
 */
export function databaseBusyAnswer(err: unknown, c: Context): Response | undefined {
  if (!READ_METHODS.has(c.req.method) || !isDatabaseBusy(err)) return undefined;
  (c.get('log') as Logger | undefined)?.warn('database busy', { err });
  c.header('Retry-After', String(DATABASE_BUSY_RETRY_AFTER_S));
  c.status(statusFor('database-busy') as never);
  return c.json(
    toWireError(
      {
        code: 'database-busy',
        message: 'The database was too busy to answer in time. Try again after Retry-After.',
      },
      (c.get('requestId') as string | undefined) ?? 'req-unknown',
    ),
  );
}

/** The methods whose retry repeats only reads: the ones a busy database answers 503. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The wait a `503 database-busy` gives, in seconds. */
const DATABASE_BUSY_RETRY_AFTER_S = 5;

/** How far down an error's `cause` chain the busy mark is looked for (a cycle ends there too). */
const MAX_CAUSE_DEPTH = 16;

/** `code: 'database-busy'` on the error or anywhere on its `cause` chain. */
function isDatabaseBusy(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof node !== 'object' || node === null) return false;
    if ((node as { code?: unknown }).code === 'database-busy') return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/** Drizzle's wrapper around a failed query, whose message is the SQL and its values. */
function isQueryError(cause: Error): boolean {
  return cause.name === 'DrizzleQueryError' || cause.message.startsWith('Failed query: ');
}
