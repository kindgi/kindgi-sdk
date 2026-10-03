// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

import { OPERATIONS } from '../openapi/operations.js';

/**
 * The routes a public run token may call: the operations registered with
 * `security: 'bearer-or-public-run'`. Deriving the list from the
 * operation registry keeps the middleware, the OpenAPI document and the
 * routes in step.
 */
export function publicRunRouteMatcher(): (method: string, path: string) => boolean {
  const routes = OPERATIONS.filter((op) => op.security === 'bearer-or-public-run').map((op) => ({
    method: op.method.toUpperCase(),
    pattern: new RegExp(
      `^${op.honoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z][A-Za-z0-9_]*/g, '[^/]+')}$`,
    ),
  }));
  return (method, path) =>
    routes.some((route) => route.method === method && route.pattern.test(path));
}

/**
 * CORS for the public-run-token routes only, so a browser on one of
 * `allowedOrigins` can call them with a public token. Every other route
 * gets no CORS headers: secret API tokens stay server-side. Registered
 * ahead of authentication, so preflights don't need a token.
 */
export function publicRunCorsMiddleware(allowedOrigins: readonly string[]): MiddlewareHandler {
  const matchesPath = publicRunRouteMatcher();
  const handler = cors({
    origin: [...allowedOrigins],
    allowMethods: ['GET'],
    allowHeaders: ['Authorization', 'Last-Event-ID'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  return async (c, next) => {
    // A preflight asks about the method it will use; match on that.
    const method =
      c.req.method === 'OPTIONS'
        ? (c.req.header('access-control-request-method') ?? '').toUpperCase()
        : c.req.method;
    if (!matchesPath(method, c.req.path)) return next();
    return handler(c, next);
  };
}
