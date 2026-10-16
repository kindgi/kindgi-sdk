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
 * database driver's string) to the client, across tenants on a shared
 * deployment. The whole error stays in the log. Domain errors returned via
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
 * The requestId embedded in the response body matches
 * `middleware/request-id.ts`, so a caller can correlate.
 *
 * No thrown error's message reaches the client. A failed database query's
 * carries its SQL and parameters (Drizzle's `Failed query: … params: …`, a
 * person's email or address); an infrastructure error's carries an internal
 * address (`connect ECONNREFUSED …`). The body says only a fixed message —
 * `A database query failed.` for a query, `Unhandled server error`
 * otherwise — and the log keeps the whole error under `err`.
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

/** Drizzle's wrapper around a failed query, whose message is the SQL and its values. */
function isQueryError(cause: Error): boolean {
  return cause.name === 'DrizzleQueryError' || cause.message.startsWith('Failed query: ');
}
