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
 * `Retry-After` on a GET or HEAD. The bindings' storage sets that code
 * when a lock or statement timeout, or the wait for a pooled connection,
 * ended the query. Any other method answers the 500: a write can have
 * committed part of its work before the timeout, and clients retry a 503
 * as an answer that nothing ran.
 *
 * The requestId embedded in the response body matches
 * `middleware/request-id.ts`, so a caller can correlate.
 *
 * No thrown error's message reaches the client in a 500. A failed database query's
 * carries its SQL and parameters (Drizzle's `Failed query: … params: …`, a
 * person's email or address); an infrastructure error's carries an internal
 * address (`connect ECONNREFUSED …`). The body says only a fixed message —
 * `A database query failed.` for a query, `Unhandled server error`
 * otherwise — and the log keeps the error under `err`, but never a failed
 * query's SQL or values: on the error or down its `cause` chain, the line
 * has the database driver's error in the query error's place (see
 * `withoutQueryText`).
 */
export function mapThrownError(cause: Error, c: Context): Response {
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
  if (isDatabaseBusy(cause) && READ_METHODS.has(c.req.method)) {
    (c.get('log') as Logger | undefined)?.warn('database busy', { err: withoutQueryText(cause) });
    c.header('Retry-After', String(DATABASE_BUSY_RETRY_AFTER_S));
    c.status(statusFor('database-busy') as never);
    return c.json(
      toWireError(
        {
          code: 'database-busy',
          message: 'The database was too busy to answer in time. Try again after Retry-After.',
        },
        requestId,
      ),
    );
  }
  // A 500 is something an operator should look at: logged, with the error.
  (c.get('log') as Logger | undefined)?.error('unhandled error', { err: withoutQueryText(cause) });
  const body = toWireError(
    {
      code: 'internal-server-error',
      message: isQueryError(cause) ? QUERY_FAILED : 'Unhandled server error',
    },
    requestId,
  );
  c.status(statusFor('internal-server-error') as never);
  return c.json(body);
}

/** The methods whose retry repeats only reads: the ones a busy database answers 503. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The wait a `503 database-busy` gives, in seconds. */
const DATABASE_BUSY_RETRY_AFTER_S = 5;

/** How far down an error's `cause` chain the busy mark is looked for (a cycle ends there too). */
const MAX_CAUSE_DEPTH = 16;

/** `code: 'database-busy'` on the error or anywhere on its `cause` chain. */
function isDatabaseBusy(err: Error): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof node !== 'object' || node === null) return false;
    if ((node as { code?: unknown }).code === 'database-busy') return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/** A failed query's fixed text: a 500's body, and the log in a query error's place when it has no cause. */
const QUERY_FAILED = 'A database query failed.';

/** How far down an error's `cause` chain a log line writes it (`@kindgi/log`: the error and three causes). */
const LOGGED_CAUSE_DEPTH = 3;

/**
 * `err` as this handler logs it. A query error's message is its SQL and the
 * values bound to it, a person's email or address among them, and the log
 * line writes an error's message and its causes' down to
 * `LOGGED_CAUSE_DEPTH`. So when a query error sits there, the line gets a
 * copy of the chain down to it with the query error replaced by its own
 * `cause`: the database driver's error, which says what the server
 * answered and has the stack of the code that ran the query, but neither
 * the SQL nor the values. One with no cause is replaced by an error saying
 * `A database query failed.` Otherwise `err` is logged as it is. The
 * thrown errors aren't changed.
 */
function withoutQueryText(err: unknown, depth = 0): unknown {
  let node = err;
  for (let hop = 0; isQueryError(node); hop++) {
    const cause = fieldOf(node, 'cause');
    node = cause === undefined || hop === MAX_CAUSE_DEPTH ? queryFailed() : cause;
  }
  // A plain object's cause isn't written (`@kindgi/log`), nor one past the depth.
  if (depth === LOGGED_CAUSE_DEPTH || !isError(node)) return node;
  const cause = fieldOf(node, 'cause');
  if (cause === undefined) return node;
  const logged = withoutQueryText(cause, depth + 1);
  return logged === cause ? node : withCause(node, logged);
}

/** Drizzle's wrapper around a failed query, whose message is the SQL and its values. */
function isQueryError(err: unknown): boolean {
  const message = fieldOf(err, 'message');
  return (
    fieldOf(err, 'name') === 'DrizzleQueryError' ||
    (typeof message === 'string' && message.startsWith('Failed query: '))
  );
}

/**
 * A copy of `err` with `cause` as its cause, holding what a log line
 * writes of an error: its name, message, code and stack.
 */
function withCause(err: Error, cause: unknown): Error {
  const copy = new Error(undefined, { cause });
  for (const key of ['name', 'message', 'code', 'stack'] as const) {
    Object.defineProperty(copy, key, {
      value: fieldOf(err, key),
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/** A query error's stand-in when it has no cause: the fixed text, and no stack (its own would point here). */
function queryFailed(): Error {
  const stand = new Error(QUERY_FAILED);
  Object.defineProperty(stand, 'stack', { value: undefined, writable: true, configurable: true });
  return stand;
}

/** `err[key]`: `undefined` for a non-object, or where reading it throws (a getter, a revoked proxy). */
function fieldOf(err: unknown, key: string): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  try {
    return (err as Readonly<Record<string, unknown>>)[key];
  } catch {
    return undefined;
  }
}

/** `err instanceof Error`, and false where asking throws (a revoked proxy). */
function isError(err: unknown): err is Error {
  try {
    return err instanceof Error;
  } catch {
    return false;
  }
}
