// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Logger } from '@kindgi/log';
import type { Context } from 'hono';

import { statusFor, toWireError } from '../errors.js';

/**
 * The app's error handler (`app.onError`). Any exception a route or
 * middleware throws becomes a `500 internal-server-error` wire error, with
 * its message and the request id. Domain errors returned via
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
 * The requestId embedded in the response body matches
 * `middleware/request-id.ts`, so a caller can correlate.
 *
 * A failed database query's message carries its SQL and its parameters
 * (Drizzle's `Failed query: … params: …`), which can be a person's email or
 * address: the body says only that a query failed, and the log keeps the
 * whole error.
 */
export function mapThrownError(cause: Error, c: Context): Response {
  if ('getResponse' in cause && typeof cause.getResponse === 'function') {
    const res = (cause as { getResponse(): Response }).getResponse();
    return c.newResponse(res.body, res);
  }
  const requestId = (c.get('requestId') as string | undefined) ?? 'req-unknown';
  // A 500 is something an operator should look at: logged, with the error.
  (c.get('log') as Logger | undefined)?.error('unhandled error', { err: cause });
  const body = toWireError(
    {
      code: 'internal-server-error',
      message: isQueryError(cause)
        ? 'A database query failed.'
        : cause.message.length > 0
          ? cause.message
          : 'Unhandled server error',
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
