// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// authorize / can — Hono PEP for HTTP routes.
//
// createAuthorizer(binding) returns helpers curried against an
// `AuthzCheckBinding` (the PDP):
//
//   authorize(action, resourceGetter)  → Hono middleware, 403s on deny
//   can(c, action, resource)           → boolean, for conditional logic
//   check(c, action, resource)         → full Decision, for advanced cases
//   filterByCan(c, action, items, fn)  → the items the principal may act on
//
// Use `authorize` on any mutating route. Use `can` inside handlers when
// the decision affects response shape (e.g. filter results, include
// admin-only fields, etc.).
//

import type { Context, MiddlewareHandler } from 'hono';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type Principal,
  type ResourceRef,
  denyPayload,
} from '@kindgi/authz';

import { toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/**
 * Callback that produces the resource being acted upon from the Hono
 * context. Called at request time — can read path params, query, or
 * body (if already parsed).
 */
export type ResourceGetter = (c: Context<AppEnv>) => ResourceRef | Promise<ResourceRef>;

export interface Authorizer {
  readonly authorize: (action: Action, getResource: ResourceGetter) => MiddlewareHandler<AppEnv>;
  readonly can: (c: Context<AppEnv>, action: Action, resource: ResourceRef) => Promise<boolean>;
  readonly check: (c: Context<AppEnv>, action: Action, resource: ResourceRef) => Promise<Decision>;
  /**
   * List-filtering helper — takes items + a ref-extractor and returns
   * only those items where the principal has `action` on the derived
   * resource. Preserves input order. Empty in → empty out.
   *
   * Use in GET-list route handlers after fetching tenant-scoped rows;
   * strips rows the caller can't read so the response only includes
   * what they'd be allowed to touch.
   */
  readonly filterByCan: <T>(
    c: Context<AppEnv>,
    action: Action,
    items: readonly T[],
    refFn: (item: T) => ResourceRef,
  ) => Promise<T[]>;
}

export function createAuthorizer(binding: AuthzCheckBinding): Authorizer {
  async function checkInternal(
    c: Context<AppEnv>,
    action: Action,
    resource: ResourceRef,
  ): Promise<Decision> {
    const principal = c.get('principal') as Principal | undefined;
    if (principal === undefined) {
      return {
        allowed: false,
        failing: 'actor',
        reason: 'no principal on request (bearer/principal middleware did not run)',
        evidence: {
          action,
          relation: '',
          resource: `${resource.type}:${resource.id}`,
          actorSubject: '',
        },
      };
    }
    const ceiling = keyCeilingDeny(c, action, resource);
    if (ceiling !== undefined) return ceiling;
    const requestId = c.get('requestId');
    const ctx =
      typeof requestId === 'string' && requestId.length > 0
        ? { correlationId: requestId }
        : undefined;
    return binding.check(principal, action, resource, ctx);
  }

  return {
    check: checkInternal,
    async can(c, action, resource) {
      const d = await checkInternal(c, action, resource);
      return d.allowed;
    },
    authorize(action, getResource) {
      return async (c, next) => {
        const resource = await getResource(c);
        const decision = await checkInternal(c, action, resource);
        if (!decision.allowed) {
          // In the error envelope every route answers in, so clients type it
          // (`permission-denied` is an auth error, forbidden); what was
          // denied, and why, is in `details`.
          const deny = denyPayload(action, resource.type, resource.id, decision.reason);
          const requestId = c.get('requestId');
          c.status(403);
          return c.json(
            toWireError(
              {
                code: deny.code,
                message: `Permission denied: ${deny.reason}`,
                action: deny.action,
                resource: deny.resource,
                reason: deny.reason,
              },
              typeof requestId === 'string' ? requestId : '',
            ),
          );
        }
        return next();
      };
    },
    async filterByCan(c, action, items, refFn) {
      if (items.length === 0) return [];
      const principal = c.get('principal') as Principal | undefined;
      if (principal === undefined) return [];
      // What the key itself rules out never reaches the store.
      const open = items.filter((item) => keyCeilingDeny(c, action, refFn(item)) === undefined);
      if (open.length === 0) return [];
      const refs = open.map(refFn);
      const requestId = c.get('requestId');
      const ctx =
        typeof requestId === 'string' && requestId.length > 0
          ? { correlationId: requestId }
          : undefined;
      const decisions = await binding.checkBatch(principal, action, refs, ctx);
      const out: (typeof items)[number][] = [];
      for (let i = 0; i < open.length; i++) {
        if (decisions[i]?.allowed) out.push(open[i] as (typeof items)[number]);
      }
      return out;
    },
  };
}

/**
 * What an API key itself rules out, before the principal's grants are
 * asked: a key can do less than its principal, never more.
 *
 * - A `member` key takes no `admin` action, even for a principal who is an
 *   admin: a day-to-day key can't change keys, grants or policies.
 * - A key limited to a project acts on no other project, and takes no
 *   `admin` action on the tenant.
 */
function keyCeilingDeny(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Decision | undefined {
  const resourceKey = `${resource.type}:${resource.id}`;
  const deny = (reason: string): Decision => ({
    allowed: false,
    failing: 'scope',
    reason,
    evidence: { action, relation: '', resource: resourceKey, actorSubject: '' },
  });
  if (action === 'admin' && c.get('tokenRole') === 'member') {
    return deny('a member API key takes no admin action');
  }
  const keyProject = c.get('tokenProjectId');
  if (keyProject !== undefined) {
    if (resource.type === 'project' && resource.id !== keyProject) {
      return deny(`the API key is limited to project ${keyProject}`);
    }
    if (resource.type === 'tenant' && action === 'admin') {
      return deny(`the API key is limited to project ${keyProject}`);
    }
  }
  return undefined;
}
