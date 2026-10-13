// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { runAsTenant } from '@kindgi/bounds';

import type { AppEnv } from '../types.js';

/**
 * The tenant whose work a request is, for the compile budget. None for a
 * request no tenant was resolved for, or for a system principal's: it acts
 * in no tenant (its `tenantId` is `SYSTEM_TENANT_ID`), as `tenantStateGate`
 * reads it too. Such a request runs outside any scope.
 */
export function budgetTenantOf(c: Context<AppEnv>): string | undefined {
  if (c.get('systemPrincipal') !== undefined) return undefined;
  const tenantId = c.get('tenantId');
  return tenantId === undefined ? undefined : (tenantId as unknown as string);
}

/**
 * Runs the rest of an authenticated request as its tenant's work
 * (`runAsTenant`): a schema it compiles again, one the cache dropped,
 * counts against the tenant's compile budget. A publish route counts
 * every compile, in a scope of its own inside this one
 * (`publishCompilesMiddleware`). A request with no tenant
 * (`budgetTenantOf`) runs outside any scope.
 */
export function tenantScopeMiddleware(): MiddlewareHandler<AppEnv> {
  return (c, next) => {
    const tenantId = budgetTenantOf(c);
    if (tenantId === undefined) return next();
    return runAsTenant(tenantId, () => next());
  };
}
