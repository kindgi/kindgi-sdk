// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding, TenantHierarchyBinding } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

/**
 * The production gate: whether putting a project in production needs the
 * tenant to be allowed it. Off unless set, so a self-hosted runtime never
 * gates anything.
 */
export interface ProductionGateOptions {
  /**
   * Check the tenant's `productionAllowed` before a project goes into
   * production (`KINDGI_PRODUCTION_GATE=on`). Default: off.
   */
  readonly gate?: boolean;
  /**
   * Where a tenant that isn't allowed goes to be allowed, for example a
   * billing page (`KINDGI_PRODUCTION_NEXT_URL`). It's the refusal's
   * `details.next`, and `GET /v1/tenant`'s `productionNext`.
   */
  readonly next?: string;
}

export interface ProjectProductionRouterOptions {
  readonly projects: ProjectBinding;
  readonly tenantHierarchy: TenantHierarchyBinding;
  readonly authorizer?: Authorizer;
  readonly production?: ProductionGateOptions;
}

/**
 * `PUT /v1/projects/:projectId/production`, body `{ production: boolean }`:
 * put a project in production, or take it out. A run in a project in
 * production is a production run; a run anywhere else is staging.
 *
 * - **Who:** tenant admins only, both ways (`admin` on the tenant): it's a
 *   billing decision, not a project one.
 * - **The gate:** turning it on, with the gate on, is refused with
 *   `403 production-not-allowed` while the tenant's `productionAllowed` is
 *   `false`, with `details.next` when the runtime names where to go. A
 *   project already in production stays so, and a repeat answers 200.
 * - **Repeats answer 200 unchanged:** setting what's already set writes
 *   nothing, and keeps the first `productionSince`.
 * - **The answer:** `{ projectId, productionSince }`, `null` when it's out
 *   of production.
 * - **501 `production-unsupported`** from a runtime whose project binding
 *   has no `setProduction`.
 */
export function projectProductionRouter(options: ProjectProductionRouterOptions): Hono<AppEnv> {
  const { projects, tenantHierarchy, authorizer } = options;
  const gate = options.production?.gate === true;
  const next = options.production?.next;
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use(
      '/:projectId/production',
      authorizer.authorize('admin', (c) => ref('tenant', c.get('tenantId') as unknown as string)),
    );
  }

  r.put('/:projectId/production', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    const production =
      body !== null && typeof body === 'object'
        ? (body as { readonly production?: unknown }).production
        : undefined;
    if (typeof production !== 'boolean') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: 'The body is `{ "production": true }` or `false`' },
          requestId,
        ),
      );
    }

    if (projects.setProduction === undefined) {
      c.status(statusFor('production-unsupported') as never);
      return c.json(
        toWireError(
          {
            code: 'production-unsupported',
            message: "This runtime's projects can't be put in production",
          },
          requestId,
        ),
      );
    }

    const project = await projects.get(tenantId, projectId);
    if (project === undefined) return projectNotFound(c, projectId, requestId);

    // The gate guards going into production, not staying there: a project
    // already in production answers its repeat unchanged.
    if (production && gate && project.productionSince === undefined) {
      const tenant = await tenantHierarchy.getTenant(tenantId);
      if (tenant?.productionAllowed === false) {
        c.status(statusFor('production-not-allowed') as never);
        return c.json(
          toWireError(
            {
              code: 'production-not-allowed',
              message:
                next !== undefined
                  ? `This tenant can't put projects in production yet. To be allowed: ${next}. Building and testing stay free.`
                  : "This tenant can't put projects in production yet: ask whoever runs this Kindgi to allow it. Building and testing stay free.",
              projectId: projectId as unknown as string,
              ...(next !== undefined && { next }),
            },
            requestId,
          ),
        );
      }
    }

    const outcome = await projects.setProduction(tenantId, projectId, production);
    if (outcome.kind === 'project-not-found') return projectNotFound(c, projectId, requestId);
    return c.json({
      projectId: projectId as unknown as string,
      productionSince: outcome.productionSince as unknown as string | null,
    });
  });

  return r;
}

function projectNotFound(c: Context<AppEnv>, projectId: ProjectId, requestId: string) {
  c.status(statusFor('project-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'project-not-found',
        message: `No project with id "${projectId as unknown as string}"`,
        projectId: projectId as unknown as string,
      },
      requestId,
    ),
  );
}
