// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type LogLevel, type Logger, formatTraceparent, traceFromHeader } from '@kindgi/log';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

import type { AppEnv } from '../types.js';

/** Paths a client or a probe reads all the time: their lines are `debug` even when they fail to read. */
const QUIET_PATHS: ReadonlySet<string> = new Set(['/health', '/ready', '/v1/openapi.json']);

const WRITES: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The access line's level, so `info` stays readable with a console open
 * (it polls every few seconds): a write, and every 4xx, at `info`; every
 * 5xx at `error`; a successful read (`GET`, `HEAD`: the polling), the
 * health and readiness probes, the spec and the console's files, and a
 * stream's opening, at `debug`.
 */
export function accessLevel(c: Context<AppEnv>): LogLevel {
  const status = c.res.status;
  if (status >= 500) return 'error';
  if (QUIET_PATHS.has(c.req.path) || !c.req.path.startsWith('/v1/')) return 'debug';
  if (WRITES.has(c.req.method) || status >= 400) return 'info';
  return 'debug';
}

/**
 * The request's trace context and logger, then its access line.
 *
 *   - **Trace:** an incoming `traceparent` (a load balancer's, an API
 *     gateway's, the caller's own app) is honoured: its trace id is kept
 *     and the request gets its own span, a child of the caller's. A
 *     missing or malformed one starts a fresh trace. `c.var.trace` holds
 *     it; the response answers `traceresponse` (W3C Trace Context Level
 *     2) next to `X-Request-Id`.
 *   - **Logger:** `c.var.log` is a child of the app's logger with the
 *     request's `requestId`, `traceId` and `spanId` (subsystem `http`);
 *     routes log through it, and authentication adds `tenantId`.
 *   - **Access line:** `METHOD route status ms`, with the route's
 *     pattern (`/v1/runs/:runId`, never the raw path, so ids don't
 *     multiply lines), at the level `accessLevel` gives.
 *
 * Mounted right after the request-id middleware.
 */
export function requestLogMiddleware(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    const trace = traceFromHeader(c.req.header('traceparent'));
    c.set('trace', trace);
    c.set(
      'log',
      logger.child({
        subsystem: 'http',
        requestId: c.get('requestId'),
        traceId: trace.traceId,
        spanId: trace.spanId,
      }),
    );
    try {
      await next();
    } finally {
      c.header('traceresponse', formatTraceparent(trace));
      const log = c.get('log');
      const level = accessLevel(c);
      if (log.isLevelEnabled(level)) {
        // The responding route's pattern; a request no route matched ends on a wildcard.
        const pattern = routePath(c, -1);
        const route = pattern.endsWith('*') ? c.req.path : pattern;
        const durationMs = Date.now() - started;
        const stream = (c.res.headers.get('content-type') ?? '').startsWith('text/event-stream');
        log[stream ? 'debug' : level](
          `${c.req.method} ${route} ${c.res.status} ${durationMs}ms${stream ? ' (stream opened)' : ''}`,
          {
            method: c.req.method,
            route,
            status: c.res.status,
            durationMs,
            ...(c.get('tenantId') !== undefined && { tenantId: c.get('tenantId') }),
          },
        );
      }
    }
  };
}
