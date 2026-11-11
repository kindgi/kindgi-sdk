// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { type Action, type Decision, type ResourceRef, denyPayload } from '@kindgi/authz';
import { runAsTenant } from '@kindgi/bounds';

import { toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import { refuseBadProjectId } from '../middleware/project-ref.js';
import {
  type SystemTenantDirectory,
  ownSystemScope,
  withSystemTenantContext,
} from '../middleware/system.js';
import type { AppEnv } from '../types.js';
import { type DeploymentsRouterBindings, deploymentRegistration } from './deployments.js';

const SCOPE = 'system:hosted-builds';

/**
 * A signed build registered into one project of a tenant, under
 * `/v1/system/tenants`, by a key holding `system:hosted-builds` itself:
 * `kindgi:system` doesn't stand in for it (`403 system-scope-missing`).
 *
 * - **`POST /:tenantId/deployments`** takes `POST /v1/deployments`'s body
 *   and answers as it does, through the same handler
 *   (`deploymentRegistration`): the tenant's deploy, under the project-only
 *   key scope (`AppEnv.deployKeyScope`). It goes only into the project the
 *   body names (`403 permission-denied` without `projectId`, `404
 *   project-not-found` for one the tenant doesn't have), records its
 *   secrets at that project, and counts its schemas against the tenant's
 *   compile budget.
 *
 * It acts through `withSystemTenantContext`: an unknown tenant is `404
 * tenant-not-found`, a suspended or closing one `409 tenant-suspended` or
 * `409 tenant-closing`.
 *
 * As the caller, the key reads and administers that one project and
 * nothing else (`projectOnlyCaller`). A check for anyone else the request
 * names, such as the person the build's `builtFrom` names, is the
 * runtime's own authorizer's: the key never answers for them.
 */
export function systemHostedBuildsRouter(options: {
  readonly directory: SystemTenantDirectory;
  readonly bindings: DeploymentsRouterBindings;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { directory, bindings, authorizer } = options;
  const projectRef = refuseBadProjectId(bindings.projectBinding);
  const r = new Hono<AppEnv>();

  r.post('/:tenantId/deployments', async (c) => {
    const own = ownSystemScope(c, SCOPE, "Registering a build into a tenant's project", authorizer);
    if (own instanceof Response) return own;
    return withSystemTenantContext(
      c,
      directory,
      c.req.param('tenantId'),
      {
        scope: SCOPE,
        refuse: ['suspended', 'closing'],
        ...(authorizer !== undefined && { authorizer }),
      },
      async (tenant) => {
        c.set('tenantId', tenant.id);
        c.set('deployKeyScope', 'project');
        // `POST /v1/deployments`'s project check, run here because the
        // tenant is the context's only from this point on.
        const badProject = await projectRef(c as Context<AppEnv>, async () => undefined);
        if (badProject instanceof Response) return badProject;
        const projectId = await namedProject(c);
        const caller =
          authorizer === undefined ? undefined : projectOnlyCaller(authorizer, projectId);
        const register = deploymentRegistration(bindings, caller);
        return runAsTenant(tenant.id, () => register(c), { compiles: 'all' });
      },
    );
  });

  return r;
}

/**
 * The authorizer a hosted build registers with. As the caller, the system
 * key reads and administers the one project the body names, and nothing
 * else: every other check, list or filter refuses, and so does each with
 * no project named. `canFor`, a check for someone the request names, and
 * `record` are `real`'s: the key never answers for anyone but itself.
 */
export function projectOnlyCaller(real: Authorizer, projectId: string | undefined): Authorizer {
  const reaches = (action: Action, resource: ResourceRef): boolean =>
    projectId !== undefined &&
    (action === 'read' || action === 'admin') &&
    resource.type === 'project' &&
    resource.id === projectId;
  const decide = (c: Context<AppEnv>, action: Action, resource: ResourceRef): Decision => {
    const allowed = reaches(action, resource);
    const decision: Decision = {
      allowed,
      ...(!allowed && { failing: 'scope' as const }),
      reason: allowed
        ? 'a hosted build reads and administers the project it names'
        : 'a hosted build reaches only the project it names',
      evidence: {
        action,
        relation: '',
        resource: `${resource.type}:${resource.id}`,
        actorSubject: '',
      },
    };
    if (!allowed) real.record?.(c, action, resource, decision);
    return decision;
  };
  return {
    authorize: (action, getResource) => async (c, next) => {
      const resource = await getResource(c);
      const decision = decide(c, action, resource);
      if (decision.allowed) return next();
      const deny = denyPayload(action, resource.type, resource.id, decision.reason);
      return c.json(
        toWireError(
          {
            code: deny.code,
            message: `Permission denied: ${deny.reason}`,
            action: deny.action,
            resource: deny.resource,
            reason: deny.reason,
          },
          c.get('requestId'),
        ),
        403,
      );
    },
    can: async (c, action, resource) => decide(c, action, resource).allowed,
    check: async (c, action, resource) => decide(c, action, resource),
    canFor: (c, principal, action, resource) => real.canFor(c, principal, action, resource),
    checkServedBy: async (c, action, resource) => decide(c, action, resource),
    filterByCan: async (c, action, items, refFn) =>
      items.filter((item) => decide(c, action, refFn(item)).allowed),
    checkMany: async (c, action, resources) => resources.map((one) => decide(c, action, one)),
    listObjects: async (_c, action, type) =>
      projectId !== undefined && reaches(action, { type, id: projectId }) ? [projectId] : [],
    record: (c, action, resource, decision) => real.record?.(c, action, resource, decision),
  };
}

/**
 * The project the body names, read before the handler reads the same body
 * (Hono parses it once). Anything else is `undefined`, and the handler
 * answers the body as `POST /v1/deployments` does.
 */
async function namedProject(c: Context<AppEnv>): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { projectId } = body as { readonly projectId?: unknown };
  return typeof projectId === 'string' ? projectId : undefined;
}
