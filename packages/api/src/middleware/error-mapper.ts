// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { statusFor, toWireError } from '../errors.js';

/**
 * Top-level catch-all. Any uncaught exception is translated to a
 * `500 internal-server-error` wire error. Domain errors returned via
 * `Result<T, E>` are handled per-route — this middleware only catches
 * thrown exceptions (framework bugs, DB failures without Result wrap,
 * etc.).
 *
 * The requestId embedded in the response body matches
 * `middleware/request-id.ts`, so a caller can correlate.
 */
export function errorMapperMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
      return;
    } catch (cause) {
      const requestId = (c.get('requestId') as string | undefined) ?? 'req-unknown';
      const message = cause instanceof Error ? cause.message : String(cause);
      const body = toWireError(
        {
          code: 'internal-server-error',
          message: message.length > 0 ? message : 'Unhandled server error',
        },
        requestId,
      );
      c.status(statusFor('internal-server-error') as never);
      return c.json(body);
    }
  };
}
