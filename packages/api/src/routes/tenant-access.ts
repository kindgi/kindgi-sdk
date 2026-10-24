// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';

import { isTenantAdmin } from '../caller.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { refused } from './denied.js';

/**
 * Who a tenant admin is on a runtime without an authorization store
 * (`isTenantAdmin`): ends each refusal there, so the caller knows what to
 * use instead.
 */
const WITHOUT_STORE_ADMIN =
  "This runtime has no authorization store, so a tenant admin is the deployment's API token, an admin key, or a console signed in with either.";

/**
 * Access to a tenant-wide resource (providers, policies, adapters, …):
 * reading it needs `read` on the tenant, anything else `admin`. The
 * authorization model gives a tenant no `write`, so a tenant-wide change
 * is an admin's. Without an authorizer, reading is anyone's, as a tenant
 * member reads it with one, and a change is still a tenant admin's.
 */
export function tenantResourceAccess(
  authorizer: Authorizer | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const reading = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (authorizer === undefined) {
      if (reading || (await isTenantAdmin(c, undefined))) return next();
      return withoutStoreRefusal(c, 'Only a tenant admin changes a tenant-wide setting.');
    }
    return authorizer.authorize(reading ? 'read' : 'admin', (ctx) =>
      ref('tenant', ctx.get('tenantId') as unknown as string),
    )(c, next);
  };
}

/**
 * Access to a tenant setting every call of which is an admin's (webhook
 * endpoints, compliance), with an authorizer or without one.
 */
export function tenantAdminAccess(authorizer: Authorizer | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (authorizer === undefined) {
      if (await isTenantAdmin(c, undefined)) return next();
      return withoutStoreRefusal(
        c,
        'Only a tenant admin reads or changes this tenant-wide setting.',
      );
    }
    return authorizer.authorize('admin', (ctx) =>
      ref('tenant', ctx.get('tenantId') as unknown as string),
    )(c, next);
  };
}

/** The 403 a change gets without a tenant admin on a runtime without a store: `permission-denied`, as with one. */
function withoutStoreRefusal(c: Context<AppEnv>, what: string): Response {
  return refused(c, undefined, {
    action: 'admin',
    resource: ref('tenant', c.get('tenantId') as unknown as string),
    message: `${what} ${WITHOUT_STORE_ADMIN}`,
    failing: 'actor',
  });
}
