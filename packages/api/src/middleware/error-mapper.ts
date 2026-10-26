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
 * otherwise — and the log keeps the error under `err`, but never a failed
 * query's SQL or values, or a value the server quotes as rejected: on the
 * error or down its `cause` chain, the line says `A database query
 * failed.` in a query error's place, and what a data exception means in
 * place of its text (see `loggable`).
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
  (c.get('log') as Logger | undefined)?.error('unhandled error', { err: loggable(cause) });
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

/**
 * The answer to a GET or HEAD the database was too busy for: `503
 * database-busy` with `Retry-After` and a fixed message, when `err` has
 * `code: 'database-busy'` on it or down its `cause` chain, and the busy
 * warning logged with it (a failed query's text left out, as in the 500's
 * line). `undefined` for any other method or error, for the caller to
 * answer as it would.
 *
 * `err` is a thrown exception (`mapThrownError`) or a binding's Result
 * error, which a route asks this about before its own answer. So a read
 * answers the same whether its binding threw the storage failure or
 * returned it re-coded with the failure as its cause.
 */
export function databaseBusyAnswer(err: unknown, c: Context): Response | undefined {
  if (!READ_METHODS.has(c.req.method) || !isDatabaseBusy(err)) return undefined;
  (c.get('log') as Logger | undefined)?.warn('database busy', { err: loggable(err) });
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

/** A failed query's fixed text: a 500's body, and the log line's message in a query error's place. */
const QUERY_FAILED = 'A database query failed.';

/** How far down an error's `cause` chain a log line writes it (`@kindgi/log`: the error and three causes). */
const LOGGED_CAUSE_DEPTH = 3;

/**
 * What a data exception (SQLSTATE class 22) means, in words: its own text
 * can quote the value the server rejected (`invalid input syntax for type
 * uuid: "…"`, `invalid input value for enum …: "…"`). The runtime's
 * storage describes one in the same words.
 */
const DATA_EXCEPTIONS: Readonly<Record<string, string>> = {
  '22001': 'a value too long for its column',
  '22003': 'a number out of range for its type',
  '22007': 'an invalid date or time',
  '22008': 'a date or time out of range',
  '22021': 'bytes invalid in the encoding',
  '22P02': 'invalid input for its type',
  '22P05': 'a character the database cannot store',
};

/** Any other data exception, in words. */
const DATA_EXCEPTION = 'a value the database rejected';

/** A SQLSTATE of class 22, data exception. */
const DATA_EXCEPTION_RE = /^22[0-9A-Z]{3}$/;

/**
 * `err` as this handler logs it, as a middleware that answers a storage
 * failure itself logs it (`idempotencyMiddleware`), and as the auth
 * middleware logs a session touch that failed. A log line writes an
 * error's message and stack, and its causes', down to
 * `LOGGED_CAUSE_DEPTH`. Two messages there
 * can carry a request's values:
 * - a query error's is its SQL and the values bound to it, a person's
 *   email or address among them. It's logged as a stand-in that says
 *   `A database query failed.` and keeps the query error's name, code and
 *   stack frames (where the query ran), and its cause, the database
 *   driver's error;
 * - a data exception's, the server's answer to a value it couldn't take,
 *   can quote that value. It's logged saying what it means and its
 *   SQLSTATE (`invalid input for its type (22P02)`), with its name, code
 *   and stack frames.
 * The errors above one are copies with the new chain as their cause.
 * With neither there, `err` is logged as it is. The thrown errors aren't
 * changed.
 */
export function loggable(err: unknown, depth = 0): unknown {
  const said = saidInstead(err);
  // A plain object's cause isn't written (`@kindgi/log`), nor one past the depth.
  if (said === undefined && !isError(err)) return err;
  const cause = depth < LOGGED_CAUSE_DEPTH ? fieldOf(err, 'cause') : undefined;
  const logged = cause === undefined ? undefined : loggable(cause, depth + 1);
  if (said === undefined && logged === cause) return err;
  return copyOf(err as object, logged, said);
}

/** What the log line says in place of `err`'s own message, when that can carry a request's values. */
function saidInstead(err: unknown): string | undefined {
  if (isQueryError(err)) return QUERY_FAILED;
  const code = fieldOf(err, 'code');
  // A Postgres server error: a SQLSTATE and the severity every one carries.
  if (
    typeof code !== 'string' ||
    !DATA_EXCEPTION_RE.test(code) ||
    typeof fieldOf(err, 'severity') !== 'string'
  ) {
    return undefined;
  }
  return `${DATA_EXCEPTIONS[code] ?? DATA_EXCEPTION} (${code})`;
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
 * writes of an error: its name, message, code and stack. With `said`, the
 * copy says that instead, over its stack's frames only.
 */
function copyOf(err: object, cause: unknown, said: string | undefined): Error {
  const name = fieldOf(err, 'name');
  const named = typeof name === 'string' ? name : 'Error';
  const fields =
    said === undefined
      ? {
          name,
          message: fieldOf(err, 'message'),
          code: fieldOf(err, 'code'),
          stack: fieldOf(err, 'stack'),
        }
      : {
          name: named,
          message: said,
          code: fieldOf(err, 'code'),
          stack: framesOf(err, named, said),
        };
  const copy = new Error(undefined, cause === undefined ? undefined : { cause });
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(copy, key, { value, writable: true, configurable: true });
  }
  return copy;
}

/**
 * `err`'s stack under the line `<name>: <said>`: the frames after the
 * first line V8 writes (`<name>: <message>`). None when the stack doesn't
 * start with that line, or anything after it isn't a frame, since the
 * message being left out is in that line.
 */
function framesOf(err: object, name: string, said: string): string | undefined {
  const stack = fieldOf(err, 'stack');
  const message = fieldOf(err, 'message');
  if (typeof stack !== 'string' || typeof message !== 'string') return undefined;
  const head = `${name}: ${message}`;
  if (!stack.startsWith(head)) return undefined;
  const frames = stack.slice(head.length);
  if (!/^(\n {4}at [^\n]*)+$/.test(frames)) return undefined;
  return `${name}: ${said}${frames}`;
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
