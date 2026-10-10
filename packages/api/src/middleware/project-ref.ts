// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import type { ProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import { UUID_RE } from '../routes/uuid-param.js';
import type { AppEnv } from '../types.js';

/**
 * The write routes whose body names a project (`projectId`), and refuse
 * one they can't use before it reaches a binding (T247): before, an
 * unknown project failed the runtime's insert as a 500 that named a
 * table and a foreign key, and one that wasn't a UUID failed deeper still.
 *
 * `POST /v1/conversations` isn't here: it checks its own `projectId` and
 * answers `400 bad-input` for an unknown one, documented and shipped, so
 * it keeps that until 0.2 unifies on `404 project-not-found` (T223).
 * `projectRefRoutes.test.ts` holds this list to the OpenAPI spec.
 */
export const PROJECT_REF_ROUTES: readonly string[] = [
  '/runs',
  '/tokens',
  '/agents',
  '/agents/:agentId/versions',
  '/flows',
  '/tools',
  '/guardrails',
  '/eval-suites',
  '/eval-suites/:suiteId/versions/from-judgments',
  '/eval-suites/:suiteId/runs',
  '/eval-runs/:runId/rescore',
  '/blocks',
  '/schedules',
  '/webhooks',
  '/service-accounts/:serviceAccountId/grant',
  '/service-accounts/:serviceAccountId/ungrant',
];

/**
 * A `POST` whose JSON body has a `projectId` that isn't a project id (a
 * UUID) is `400 bad-input`; one that names no project of the caller's
 * tenant is `404 project-not-found` (with `projectBinding`; without one,
 * only the shape is checked). Anything else, a body that isn't JSON
 * included, goes on to the route, which reads the body again (Hono keeps
 * it).
 */
export function refuseBadProjectId(
  projectBinding: ProjectBinding | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'POST') return next();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return next();
    }
    if (body === null || typeof body !== 'object' || !('projectId' in body)) return next();
    const projectId = (body as { readonly projectId: unknown }).projectId;
    if (projectId === undefined) return next();
    if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`projectId` must be a project id (a UUID)' },
          c.get('requestId'),
        ),
      );
    }
    if (projectBinding !== undefined) {
      const tenantId = c.get('tenantId') as TenantId;
      const project = await projectBinding.get(tenantId, projectId as ProjectId);
      if (project === undefined) {
        c.status(statusFor('project-not-found') as never);
        return c.json(
          toWireError(
            {
              code: 'project-not-found',
              message: `No project with id "${projectId}" in this tenant`,
              projectId,
            },
            c.get('requestId'),
          ),
        );
      }
    }
    return next();
  };
}
