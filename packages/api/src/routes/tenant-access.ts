// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

/**
 * Access to a tenant-wide resource (providers, policies, adapters, …):
 * reading it needs `read` on the tenant, anything else `admin`. The
 * authorization model gives a tenant no `write`, so a tenant-wide change
 * is an admin's. Without an authorizer, nothing is checked (as before).
 *
 * `reads: 'belong'` is for a resource whose reads each route checks
 * further on what it reads (a deployment, in the project it serves): the
 * tenant asks only that the caller is in it, its observer included.
 */
export function tenantResourceAccess(
  authorizer: Authorizer | undefined,
  options: { readonly reads?: 'read' | 'belong' } = {},
): MiddlewareHandler<AppEnv> {
  const reads = options.reads ?? 'read';
  return async (c, next) => {
    if (authorizer === undefined) return next();
    const reading = c.req.method === 'GET' || c.req.method === 'HEAD';
    return authorizer.authorize(reading ? reads : 'admin', (ctx) =>
      ref('tenant', ctx.get('tenantId') as unknown as string),
    )(c, next);
  };
}

/** Access to a tenant setting every call of which is an admin's (webhook endpoints, compliance). */
export function tenantAdminAccess(authorizer: Authorizer | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (authorizer === undefined) return next();
    return authorizer.authorize('admin', (ctx) =>
      ref('tenant', ctx.get('tenantId') as unknown as string),
    )(c, next);
  };
}
