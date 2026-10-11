// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding, TenantHierarchyBinding, TenantSummary } from '@kindgi/platform';
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

    const production = await readProduction(c);
    if (typeof production !== 'boolean') return refuse(c, requestId, production);
    if (projects.setProduction === undefined) {
      return refuse(c, requestId, {
        code: 'production-unsupported',
        message: "This runtime's projects can't be put in production",
      });
    }

    const project = await projects.get(tenantId, projectId);
    if (project === undefined) return refuse(c, requestId, projectNotFound(projectId));

    // The gate guards going into production, not staying there: a project
    // already in production answers its repeat unchanged.
    if (production && gate && project.productionSince === undefined) {
      const closed = gateRefusal(await tenantHierarchy.getTenant(tenantId), tenantId, projectId);
      if (closed !== undefined) return refuse(c, requestId, closed);
    }

    const outcome = await projects.setProduction(tenantId, projectId, production);
    if (outcome.kind === 'project-not-found') {
      return refuse(c, requestId, projectNotFound(projectId));
    }
    return c.json({
      projectId: projectId as unknown as string,
      productionSince: outcome.productionSince as unknown as string | null,
    });
  });

  /**
   * Why the gate keeps the tenant out of production, or `undefined` when it
   * doesn't. No record for the caller's own tenant refuses rather than
   * reading as allowed: an absent `productionAllowed` is allowed, an absent
   * tenant isn't.
   */
  function gateRefusal(
    tenant: TenantSummary | null,
    tenantId: TenantId,
    projectId: ProjectId,
  ): Refusal | undefined {
    if (tenant === null) {
      return {
        code: 'tenant-not-found',
        message: `No tenant with id "${tenantId as unknown as string}"`,
        tenantId: tenantId as unknown as string,
      };
    }
    if (tenant.productionAllowed !== false) return undefined;
    return {
      code: 'production-not-allowed',
      message:
        next !== undefined
          ? `This tenant can't put projects in production yet. To be allowed: ${next}. Projects not in production keep working as staging.`
          : "This tenant can't put projects in production yet: ask whoever runs this Kindgi to allow it. Projects not in production keep working as staging.",
      projectId: projectId as unknown as string,
      ...(next !== undefined && { next }),
    };
  }

  return r;
}

/** A refusal: its code, message, and the details the wire error carries. */
type Refusal = { readonly code: string; readonly message: string } & Readonly<
  Record<string, unknown>
>;

function refuse(c: Context<AppEnv>, requestId: string, refusal: Refusal) {
  c.status(statusFor(refusal.code) as never);
  return c.json(toWireError(refusal, requestId));
}

/** The body's `production`, or the refusal for a body that isn't `{ production: boolean }`. */
async function readProduction(c: Context<AppEnv>): Promise<boolean | Refusal> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { code: 'bad-input', message: 'Request body must be valid JSON' };
  }
  const production =
    body !== null && typeof body === 'object'
      ? (body as { readonly production?: unknown }).production
      : undefined;
  return typeof production === 'boolean'
    ? production
    : { code: 'bad-input', message: 'The body is `{ "production": true }` or `false`' };
}

function projectNotFound(projectId: ProjectId): Refusal {
  return {
    code: 'project-not-found',
    message: `No project with id "${projectId as unknown as string}"`,
    projectId: projectId as unknown as string,
  };
}
