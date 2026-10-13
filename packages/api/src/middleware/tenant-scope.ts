// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { runAsTenant } from '@kindgi/bounds';

import type { AppEnv } from '../types.js';

/**
 * Runs the rest of an authenticated request as its tenant's work
 * (`runAsTenant`): a schema it compiles again, one the cache dropped,
 * counts against the tenant's compile budget. A publish route counts
 * every compile, in a scope of its own inside this one
 * (`publishCompilesMiddleware`). A request no tenant was resolved for runs
 * outside any scope.
 */
export function tenantScopeMiddleware(): MiddlewareHandler<AppEnv> {
  return (c, next) => {
    const tenantId = c.get('tenantId');
    if (tenantId === undefined) return next();
    return runAsTenant(tenantId as unknown as string, () => next());
  };
}
