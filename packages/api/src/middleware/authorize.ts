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
  type AuthzCheckContext,
  type Decision,
  OBJECT_ACTIONS,
  type ObjectType,
  type Principal,
  type ResourceRef,
  denyPayload,
  fgaSubject,
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
  /**
   * The ids of every object of `type` the caller may `action`
   * (`AuthzCheckBinding.listObjects`), within its API key's limits as
   * `filterByCan` holds them: a key limited to a project lists no project
   * but its own, and other types as a check decides them (it still reads
   * the orgs its user reads); `undefined` when the binding can't list, so
   * the caller falls back to `filterByCan`.
   */
  readonly listObjects?: (
    c: Context<AppEnv>,
    action: Action,
    type: ResourceRef['type'],
  ) => Promise<readonly string[] | undefined>;
  /**
   * Records a refusal a route decided itself, on a check the
   * authorization model doesn't make (a reviewer role, an API key's
   * capability), where the binding records its own decisions
   * (`recordDecision`): so the audit holds every refusal. `refused`
   * (routes/denied.ts) records and answers the 403.
   */
  readonly record?: (
    c: Context<AppEnv>,
    action: Action,
    resource: ResourceRef,
    decision: Decision,
  ) => void;
}

export function createAuthorizer(binding: AuthzCheckBinding): Authorizer {
  /**
   * Whether a resource is inside the project the caller's API key is
   * limited to (always, for a caller with no such key). The tenant, orgs,
   * teams and projects are held by `keyCeilingDeny`; anything else must
   * belong to the key's project, as the store says (`inProject`). Without
   * that answer, the key reaches no other resource.
   */
  async function inKeyProject(
    c: Context<AppEnv>,
    principal: Principal,
    resource: ResourceRef,
  ): Promise<boolean> {
    const keyProject = c.get('tokenProjectId');
    if (keyProject === undefined || STRUCTURAL.has(resource.type)) return true;
    if (binding.inProject === undefined) return false;
    return binding.inProject(principal, resource, keyProject);
  }

  /** The request's id, as the binding's correlation context. */
  function contextOf(c: Context<AppEnv>): AuthzCheckContext | undefined {
    const requestId = c.get('requestId');
    return typeof requestId === 'string' && requestId.length > 0
      ? { correlationId: requestId }
      : undefined;
  }

  /**
   * A refusal this layer decides without asking the binding: a check the
   * model can't answer (`undefinedRelation`), or what the caller's API key
   * rules out (`keyCeilingDeny`, `inKeyProject`). Each is recorded through
   * the binding (`recordDecision`), as it records its own decisions, so the
   * audit holds every refusal whichever check made it.
   */
  async function ownRefusal(
    c: Context<AppEnv>,
    principal: Principal,
    action: Action,
    resource: ResourceRef,
  ): Promise<Decision | undefined> {
    const refused =
      undefinedRelation(action, resource) ??
      keyCeilingDeny(c, action, resource) ??
      ((await inKeyProject(c, principal, resource))
        ? undefined
        : keyDecision(
            action,
            resource,
            `the API key is limited to project ${c.get('tokenProjectId')}`,
          ));
    if (refused !== undefined) recordFor(c, principal, action, resource, refused);
    return refused;
  }

  /**
   * A decision made here, recorded through the binding with the actor in
   * its evidence (as the binding's own decisions carry it); recording
   * never fails the request.
   */
  function recordFor(
    c: Context<AppEnv>,
    principal: Principal,
    action: Action,
    resource: ResourceRef,
    decision: Decision,
  ): void {
    const recorded: Decision =
      decision.evidence.actorSubject === ''
        ? {
            ...decision,
            evidence: { ...decision.evidence, actorSubject: fgaSubject(principal.actor) },
          }
        : decision;
    try {
      binding.recordDecision?.(principal, action, resource, recorded, contextOf(c));
    } catch {
      // Recording never fails the request.
    }
  }

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
    const refused = await ownRefusal(c, principal, action, resource);
    if (refused !== undefined) return refused;
    return binding.check(principal, action, resource, contextOf(c));
  }

  return {
    check: checkInternal,
    record(c, action, resource, decision) {
      const principal = c.get('principal') as Principal | undefined;
      if (principal !== undefined) recordFor(c, principal, action, resource, decision);
    },
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
      // What the model can't answer, or the key itself rules out, never
      // reaches the store; each is recorded, as the store records its own.
      const refused = await Promise.all(
        items.map((item) => ownRefusal(c, principal, action, refFn(item))),
      );
      const open = items.filter((_, i) => refused[i] === undefined);
      if (open.length === 0) return [];
      const refs = open.map(refFn);
      const decisions = await binding.checkBatch(principal, action, refs, contextOf(c));
      const out: (typeof items)[number][] = [];
      for (let i = 0; i < open.length; i++) {
        if (decisions[i]?.allowed) out.push(open[i] as (typeof items)[number]);
      }
      return out;
    },
    async listObjects(c, action, type) {
      if (binding.listObjects === undefined) return undefined;
      const principal = c.get('principal') as Principal | undefined;
      if (principal === undefined) return [];
      const ids = await binding.listObjects(principal, action, type, contextOf(c));
      // The key's own limits, as `filterByCan` holds them: the store lists
      // what the user may do, and a key limited to a project lists no other
      // project (other types as a check decides them).
      const withinKey = await Promise.all(
        ids.map(async (id) => {
          const resource: ResourceRef = { type, id };
          return (
            keyCeilingDeny(c, action, resource) === undefined &&
            (await inKeyProject(c, principal, resource))
          );
        }),
      );
      return ids.filter((_, i) => withinKey[i]);
    },
  };
}

/**
 * A check must name a relation the authorization model defines for the
 * resource's type (`OBJECT_ACTIONS`, kept equal to the runtime's model by
 * its tests). Any other pair is a bug in the route: the PDP rejects it
 * for everyone, the seed admin included, and only with authorization on,
 * so it's refused here, naming the pair, and logged.
 */
function undefinedRelation(action: Action, resource: ResourceRef): Decision | undefined {
  const defined = OBJECT_ACTIONS[resource.type as ObjectType] as readonly Action[] | undefined;
  if (defined?.includes(action) === true) return undefined;
  const reason = `the authorization model has no \`${action}\` on \`${resource.type}\` (a check that can never pass: a bug in the route)`;
  console.error(`[authz] ${reason}`);
  return {
    allowed: false,
    failing: 'invalid-action',
    reason,
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

/** Types a key's project limit is checked on directly, not through `inProject`. */
const STRUCTURAL: ReadonlySet<string> = new Set(['tenant', 'org', 'team', 'project']);

function keyDecision(action: Action, resource: ResourceRef, reason: string): Decision {
  return {
    allowed: false,
    failing: 'scope',
    reason,
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

/**
 * What an API key itself rules out, before the principal's grants are
 * asked: a key can do less than its principal, never more.
 *
 * - A `member` key takes no `admin` action on the tenant, even for a
 *   principal who is a tenant admin: a day-to-day key can't change keys,
 *   grants or policies. Below the tenant, its principal's roles hold: a
 *   project admin's member key administers that project.
 * - A key limited to a project acts on no other project, and takes no
 *   `admin` action on the tenant, an org or a team. Other resources must
 *   be in its project (`inKeyProject`).
 */
function keyCeilingDeny(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Decision | undefined {
  if (action === 'admin' && resource.type === 'tenant' && c.get('tokenRole') === 'member') {
    return keyDecision(action, resource, 'a member API key takes no admin action on the tenant');
  }
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined) return undefined;
  const otherProject = resource.type === 'project' && resource.id !== keyProject;
  const aboveIt =
    resource.type !== 'project' && STRUCTURAL.has(resource.type) && action === 'admin';
  return otherProject || aboveIt
    ? keyDecision(action, resource, `the API key is limited to project ${keyProject}`)
    : undefined;
}
