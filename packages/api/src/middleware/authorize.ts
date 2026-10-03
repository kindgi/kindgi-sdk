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
          const body = denyPayload(action, resource.type, resource.id, decision.reason);
          c.status(403);
          return c.json(body);
        }
        return next();
      };
    },
    async filterByCan(c, action, items, refFn) {
      if (items.length === 0) return [];
      const principal = c.get('principal') as Principal | undefined;
      if (principal === undefined) return [];
      const refs = items.map(refFn);
      const requestId = c.get('requestId');
      const ctx =
        typeof requestId === 'string' && requestId.length > 0
          ? { correlationId: requestId }
          : undefined;
      const decisions = await binding.checkBatch(principal, action, refs, ctx);
      const out: (typeof items)[number][] = [];
      for (let i = 0; i < items.length; i++) {
        if (decisions[i]?.allowed) out.push(items[i] as (typeof items)[number]);
      }
      return out;
    },
  };
}
