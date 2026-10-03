// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

/**
 * Assigns a request id to every incoming request. Stored on the Hono
 * context as `c.get('requestId')`. Every error envelope embeds this so
 * a caller reporting a bug can hand us one string to grep the logs.
 *
 * If the client provided `X-Request-Id`, we honor it (matching a
 * caller-supplied id makes SDK retries observable in server logs).
 * Otherwise we mint a new UUID.
 *
 * The response header `X-Request-Id` mirrors the id back.
 */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const provided = c.req.header('x-request-id');
    const requestId =
      provided !== undefined && provided.length > 0 ? provided : `req-${randomUUID()}`;
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
  };
}
