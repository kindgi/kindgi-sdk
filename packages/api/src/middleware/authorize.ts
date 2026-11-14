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
//   canFor(c, who, action, resource)   → boolean, for someone the request names
//   check(c, action, resource)         → full Decision, for advanced cases
//   filterByCan(c, action, items, fn)  → the items the principal may act on
//   probe(c, action, resource)         → `can`'s answer, recorded nowhere,
//                                        for a hint the caller is shown
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
  CHECK_ONLY_ACTIONS,
  type Decision,
  OBJECT_ACTIONS,
  type ObjectType,
  type Principal,
  type ResourceRef,
  denyPayload,
  fgaSubject,
} from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import { toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import { beforeHandlerAnswer } from './error-mapper.js';

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
   * Whether `principal`, not the caller, may take `action` on `resource`:
   * for someone a request names, such as a trigger's owner. The store
   * decides alone (the caller's API key limits only the caller), with the
   * request's id as the correlation id, as the caller's own checks carry.
   * A store that fails throws: there is no answer to fall back to.
   */
  readonly canFor: (
    c: Context<AppEnv>,
    principal: Principal,
    action: Action,
    resource: ResourceRef,
  ) => Promise<boolean>;
  /**
   * Whether the caller may `action` on `resource`, decided as `can`
   * decides it (the API key's own limits first, then the binding), but
   * recorded nowhere: the binding's `probe`, else its `check`, which
   * records as before. Only for what a response shows the caller about
   * its own access (whoami's `tenantAdmin`, a list's `can`), through
   * `canForDisplay` (caller.ts). Never to decide what a request may do or
   * read: `can`, `authorize` and `filterByCan` decide that, and record.
   */
  readonly probe?: (c: Context<AppEnv>, action: Action, resource: ResourceRef) => Promise<boolean>;
  /**
   * `check`, for an item more than one project serves (`item-rights.ts`).
   * A caller whose API key is limited to a project reaches the item when
   * that project is one of `projects`, the item's projects. `check` asks
   * the store instead (`inProject`), which sees only the item's parent:
   * the project it was first published in.
   */
  readonly checkServedBy?: (
    c: Context<AppEnv>,
    action: Action,
    resource: ResourceRef,
    projects: readonly string[],
  ) => Promise<Decision>;
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
    /** Per item, its projects when more than one serves it (`checkServedBy`). */
    servedByFn?: (item: T) => readonly string[] | undefined,
  ) => Promise<T[]>;
  /**
   * Every decision for `resources`, in their order, in one batch to the
   * store, as `filterByCan` asks them: for a caller that needs each
   * answer, as a refusal naming the first one refused does.
   */
  readonly checkMany?: (
    c: Context<AppEnv>,
    action: Action,
    resources: readonly ResourceRef[],
  ) => Promise<readonly Decision[]>;
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

/**
 * What a key limited to a project reads of the orgs: its project's own,
 * looked up once per request (`orgOfKeyProject`), never stored with the
 * key, since a project can move to another org.
 */
export interface AuthorizerOptions {
  readonly projects?: Pick<ProjectBinding, 'get'>;
}

export function createAuthorizer(
  binding: AuthzCheckBinding,
  options: AuthorizerOptions = {},
): Authorizer {
  /**
   * The org of the project the caller's key is limited to, once per
   * request. None without a project binding, for a project in no org, for
   * one the binding doesn't find, or when the lookup fails, however it
   * fails: the key then reads no org.
   */
  const keyProjectOrgs = new WeakMap<Context<AppEnv>, Promise<string | undefined>>();
  function orgOfKeyProject(c: Context<AppEnv>, keyProject: string): Promise<string | undefined> {
    let org = keyProjectOrgs.get(c);
    if (org === undefined) {
      const projects = options.projects;
      org =
        projects === undefined
          ? Promise.resolve(undefined)
          : Promise.resolve()
              .then(() => projects.get(c.get('tenantId') as TenantId, keyProject as ProjectId))
              .then((p) => p?.orgId as string | undefined)
              .catch(() => undefined);
      keyProjectOrgs.set(c, org);
    }
    return org;
  }

  /**
   * What the caller's key rules out (`keyCeilingDeny`), and for a key
   * limited to a project, any org but its project's own.
   */
  async function keyRefusal(
    c: Context<AppEnv>,
    action: Action,
    resource: ResourceRef,
  ): Promise<Decision | undefined> {
    const ceiling = keyCeilingDeny(c, action, resource);
    if (ceiling !== undefined) return ceiling;
    const keyProject = c.get('tokenProjectId');
    if (keyProject === undefined || resource.type !== 'org') return undefined;
    return (await orgOfKeyProject(c, keyProject)) === resource.id
      ? undefined
      : keyDecision(action, resource, `${limitedOne(c)} is limited to project ${keyProject}`);
  }

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
   * rules out (`keyCeilingDeny`, `inKeyProject`). Decided only: `ownRefusal`
   * records it, `probe` doesn't.
   */
  async function refusalOf(
    c: Context<AppEnv>,
    principal: Principal,
    action: Action,
    resource: ResourceRef,
    servedBy?: readonly string[],
  ): Promise<Decision | undefined> {
    const keyProject = c.get('tokenProjectId');
    const inKey =
      servedBy === undefined
        ? await inKeyProject(c, principal, resource)
        : keyProject === undefined || servedBy.includes(keyProject);
    return (
      undefinedRelation(c, action, resource) ??
      (await keyRefusal(c, action, resource)) ??
      (inKey
        ? undefined
        : keyDecision(
            action,
            resource,
            `${limitedOne(c)} is limited to project ${c.get('tokenProjectId')}`,
          ))
    );
  }

  /**
   * `refusalOf`, recorded through the binding (`recordDecision`), as it
   * records its own decisions, so the audit holds every refusal whichever
   * check made it.
   */
  async function ownRefusal(
    c: Context<AppEnv>,
    principal: Principal,
    action: Action,
    resource: ResourceRef,
    servedBy?: readonly string[],
  ): Promise<Decision | undefined> {
    const refused = await refusalOf(c, principal, action, resource, servedBy);
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
    servedBy?: readonly string[],
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
    const refused = await ownRefusal(c, principal, action, resource, servedBy);
    if (refused !== undefined) return refused;
    return binding.check(principal, action, resource, contextOf(c));
  }

  /**
   * Each resource's decision, in order. What the model can't answer, or
   * the key itself rules out, never reaches the store; each is recorded,
   * as the store records its own. The rest go to the store in one batch.
   */
  async function decideMany(
    c: Context<AppEnv>,
    action: Action,
    resources: readonly ResourceRef[],
    servedBy?: readonly (readonly string[] | undefined)[],
  ): Promise<readonly Decision[]> {
    if (resources.length === 0) return [];
    const principal = c.get('principal') as Principal | undefined;
    if (principal === undefined) {
      return Promise.all(resources.map((r) => checkInternal(c, action, r)));
    }
    const refused = await Promise.all(
      resources.map((r, i) => ownRefusal(c, principal, action, r, servedBy?.[i])),
    );
    const open = resources.filter((_, i) => refused[i] === undefined);
    const decided =
      open.length === 0 ? [] : await binding.checkBatch(principal, action, open, contextOf(c));
    let next = 0;
    return resources.map((r, i) => {
      const own = refused[i];
      if (own !== undefined) return own;
      return (
        decided[next++] ?? {
          allowed: false,
          reason: 'the store returned no decision',
          evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
        }
      );
    });
  }

  return {
    check: (c, action, resource) => checkInternal(c, action, resource),
    checkServedBy: checkInternal,
    record(c, action, resource, decision) {
      const principal = c.get('principal') as Principal | undefined;
      if (principal !== undefined) recordFor(c, principal, action, resource, decision);
    },
    async can(c, action, resource) {
      const d = await checkInternal(c, action, resource);
      return d.allowed;
    },
    async canFor(c, principal, action, resource) {
      const d = await binding.check(principal, action, resource, contextOf(c));
      return d.allowed;
    },
    async probe(c, action, resource) {
      const principal = c.get('principal') as Principal | undefined;
      if (principal === undefined) return false;
      if ((await refusalOf(c, principal, action, resource)) !== undefined) return false;
      const decision =
        binding.probe !== undefined
          ? await binding.probe(principal, action, resource, contextOf(c))
          : await binding.check(principal, action, resource, contextOf(c));
      return decision.allowed;
    },
    authorize(action, getResource) {
      return async (c, next) => {
        let resource: ResourceRef;
        let decision: Decision;
        try {
          resource = await getResource(c);
          decision = await checkInternal(c, action, resource);
        } catch (err) {
          // The handler hasn't run (asked inside one, with `deniedBy`, it
          // hasn't written yet; one that asks after a write throws on this
          // answer): a store that couldn't be reached, or a database too
          // busy for the check's read or the resource getter's, answers 503
          // on any method, as nothing ran. Anything else, a getter's own
          // refusal included, is the error handler's.
          const answer = beforeHandlerAnswer(err, c);
          if (answer !== undefined) return answer;
          throw err;
        }
        if (!decision.allowed) {
          // In the error envelope every route answers in, so clients type it
          // (`permission-denied` is an auth error, forbidden); what was
          // denied, and why, is in `details`. The 403 is the answer's, not
          // set on the request: a handler that asks this itself (`deniedBy`)
          // may go on past the refusal, and answers with its own status.
          const deny = denyPayload(action, resource.type, resource.id, decision.reason);
          const requestId = c.get('requestId');
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
            403,
          );
        }
        return next();
      };
    },
    async filterByCan(c, action, items, refFn, servedByFn) {
      if (items.length === 0) return [];
      const decisions = await decideMany(
        c,
        action,
        items.map(refFn),
        servedByFn === undefined ? undefined : items.map(servedByFn),
      );
      return items.filter((_, i) => decisions[i]?.allowed === true);
    },
    checkMany: (c, action, resources) => decideMany(c, action, resources),
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
            (await keyRefusal(c, action, resource)) === undefined &&
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
 * resource's type (`OBJECT_ACTIONS`, with `CHECK_ONLY_ACTIONS`, kept equal
 * to the runtime's model by its tests). Any other pair is a bug in the route: the PDP rejects it
 * for everyone, the seed admin included, and only with authorization on,
 * so it's refused here, naming the pair, and logged at `error` through the
 * request's logger (subsystem `authz`).
 */
function undefinedRelation(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Decision | undefined {
  const type = resource.type as ObjectType;
  const defined = OBJECT_ACTIONS[type] as readonly Action[] | undefined;
  if (defined?.includes(action) === true) return undefined;
  // Defined by the model, but not reported (`CHECK_ONLY_ACTIONS`).
  if (CHECK_ONLY_ACTIONS[type]?.includes(action) === true) return undefined;
  const reason = `the authorization model has no \`${action}\` on \`${resource.type}\` (a check that can never pass: a bug in the route)`;
  c.get('log')
    .child({ subsystem: 'authz' })
    .error(
      reason,
      { action, resource: `${resource.type}:${resource.id}` },
      { inMessage: ['action'] },
    );
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

/**
 * Refs to the tenant that stand for the whole workspace, not for the root
 * its projects are read through: a row no project holds (an artifact, a
 * cost record, a provenance record, an approval, a deployment serving no
 * project) and a workspace setting (`tenantResourceAccess`). A key limited
 * to a project reads none of them (`keyCeilingDeny`). They're marked by
 * identity, so `ResourceRef` stays as the authz package defines it: a ref
 * rebuilt from its `type` and `id` loses the mark.
 */
const TENANT_WIDE = new WeakSet<ResourceRef>();

/** The tenant as the whole workspace (`TENANT_WIDE`), for a check on a row or setting no project holds. */
export function tenantWide(tenantId: string): ResourceRef {
  const resource: ResourceRef = { type: 'tenant', id: tenantId };
  TENANT_WIDE.add(resource);
  return resource;
}

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

/** What a refusal names as limited: the caller's session, or its API key. */
function limitedOne(c: Context<AppEnv>): string {
  return c.get('sessionId') !== undefined ? 'this session' : 'the API key';
}

/**
 * What an API key itself rules out, before the principal's grants are
 * asked: a key can do less than its principal, never more. A session
 * with a key's limits (`SessionCreateInput.projectId`, `role`) is held
 * the same way, and tighter above its project.
 *
 * - A `member` key takes no `admin` action on the tenant, even for a
 *   principal who is a tenant admin: a day-to-day key can't change keys,
 *   grants or policies. Below the tenant, its principal's roles hold: a
 *   project admin's member key administers that project.
 * - A key limited to a project acts on no other project, and takes no
 *   `admin` action on the tenant, an org or a team. It reads the tenant
 *   only as its project's root: no row or setting of the whole workspace
 *   (`tenantWide`), no team, and no org but its project's own
 *   (`keyRefusal`). Other resources must be in its project
 *   (`inKeyProject`).
 * - A session limited to a project takes no action at all on the tenant,
 *   an org or a team, reading included: its person's tenant membership
 *   reads the tenant's settings, which such a session must not reach.
 */
function keyCeilingDeny(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Decision | undefined {
  if (action === 'admin' && resource.type === 'tenant' && c.get('tokenRole') === 'member') {
    return keyDecision(
      action,
      resource,
      `a member ${c.get('sessionId') !== undefined ? 'session' : 'API key'} takes no admin action on the workspace`,
    );
  }
  return beyondKeyProject(c, action, resource) || readsAboveKeyProject(c, resource)
    ? keyDecision(
        action,
        resource,
        `${limitedOne(c)} is limited to project ${c.get('tokenProjectId')}`,
      )
    : undefined;
}

/**
 * Whether a key or session limited to a project reads above it, which an
 * authorization store refuses it: a team, or a row or setting of the
 * whole workspace (`tenantWide`). Without a store, nothing changes.
 */
function readsAboveKeyProject(c: Context<AppEnv>, resource: ResourceRef): boolean {
  if (c.get('tokenProjectId') === undefined) return false;
  return resource.type === 'team' || TENANT_WIDE.has(resource);
}

/**
 * Whether a key or session limited to a project is refused `action` on
 * `resource` for that limit alone, whatever its principal's grants:
 * another project, or above its own (the tenant, an org, a team) an
 * `admin` action for a key, any action for a session. With a store,
 * `keyCeilingDeny` refuses it; without one, `holdLimitedCaller` refuses
 * its writes.
 */
export function beyondKeyProject(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): boolean {
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined) return false;
  const otherProject = resource.type === 'project' && resource.id !== keyProject;
  const session = c.get('sessionId') !== undefined;
  const aboveIt =
    resource.type !== 'project' && STRUCTURAL.has(resource.type) && (action === 'admin' || session);
  return otherProject || aboveIt;
}
