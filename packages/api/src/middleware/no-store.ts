// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types.js';

/**
 * `Cache-Control: no-store` on every `/v1` response, data and errors alike.
 * An answer is one tenant's data at one moment: a browser or a proxy that
 * kept it would show it again (a `410` for a flow since reinstated, kept
 * through a reload, as 410 is cacheable by default) or to someone else.
 * Set after the route answers, so a route's own header (an event stream's
 * `no-cache`) gives way to the stricter one. Outside `/v1` (the console's
 * assets, the docs), caching stays the server's to set.
 */
export function noStoreMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    try {
      c.res.headers.set('Cache-Control', 'no-store');
    } catch {
      // A response whose headers can't change (one passed through as fetched): a copy can.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set('Cache-Control', 'no-store');
    }
  };
}
