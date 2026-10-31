// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import type { ConnectionBinding } from '../connection-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

export interface ProjectRepoConnectionRouterOptions {
  readonly projects: ProjectBinding;
  /** Where a connection is checked. Without it, setting one answers 501. */
  readonly connections?: Pick<ConnectionBinding, 'get'>;
  readonly authorizer?: Authorizer;
}

/** The app entry a repo connection is made through. */
const GITHUB = 'github';

/**
 * A project's repo connection: the company-wide GitHub connection its
 * block changes' pull requests are opened through.
 *
 * - **`PUT /v1/projects/:projectId/repo-connection`**, body
 *   `{ connectionId }`: set it, replacing any before it. The connection
 *   must be the tenant's, not removed, made through the GitHub app entry,
 *   and owned by the company: `404 connection-not-found`, or
 *   `400 repo-connection-not-company-github`.
 * - **`DELETE /v1/projects/:projectId/repo-connection`**: clear it.
 * - **Who:** admins of the project (`admin` on it), both ways.
 * - **The answer:** `{ projectId, repoConnectionId }`, `null` once cleared.
 *   A repeat answers 200 unchanged.
 * - **No reference to the connection is kept:** one removed later leaves
 *   the id on the project, and a reader treats it as none.
 * - **501 `repo-connection-unsupported`** from a runtime whose project
 *   binding has no `setRepoConnection`, or, for a `PUT`, that has no
 *   connections.
 */
export function projectRepoConnectionRouter(
  options: ProjectRepoConnectionRouterOptions,
): Hono<AppEnv> {
  const { projects, connections, authorizer } = options;
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use('/:projectId/repo-connection', async (c, next) =>
      authorizer.authorize('admin', () => ref('project', c.req.param('projectId')))(c, next),
    );
  }

  r.put('/:projectId/repo-connection', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    const connectionId = await readConnectionId(c);
    if (typeof connectionId !== 'string') return refuse(c, requestId, connectionId);
    if (projects.setRepoConnection === undefined || connections === undefined) {
      return refuse(c, requestId, unsupported());
    }
    if ((await projects.get(tenantId, projectId)) === undefined) {
      return refuse(c, requestId, projectNotFound(projectId));
    }

    const connection = await connections.get({ tenantId, connectionId });
    if (connection === null || connection.removedAt !== undefined) {
      return refuse(c, requestId, {
        code: 'connection-not-found',
        message: `No connection with id "${connectionId}"`,
        connectionId,
      });
    }
    if (connection.app !== GITHUB || connection.owner.kind !== 'company') {
      return refuse(c, requestId, {
        code: 'repo-connection-not-company-github',
        message: `Connection "${connectionId}" isn't a company-wide GitHub connection: connect GitHub for the company, then use that connection`,
        connectionId,
        app: connection.app,
        owner: connection.owner.kind,
      });
    }

    const outcome = await projects.setRepoConnection(tenantId, projectId, connectionId);
    if (outcome.kind === 'project-not-found') {
      return refuse(c, requestId, projectNotFound(projectId));
    }
    return c.json({
      projectId: projectId as unknown as string,
      repoConnectionId: outcome.repoConnectionId,
    });
  });

  r.delete('/:projectId/repo-connection', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    if (projects.setRepoConnection === undefined) return refuse(c, requestId, unsupported());
    const outcome = await projects.setRepoConnection(tenantId, projectId, null);
    if (outcome.kind === 'project-not-found') {
      return refuse(c, requestId, projectNotFound(projectId));
    }
    return c.json({ projectId: projectId as unknown as string, repoConnectionId: null });
  });

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

/** The body's `connectionId`, or the refusal for a body that isn't `{ connectionId: string }`. */
async function readConnectionId(c: Context<AppEnv>): Promise<string | Refusal> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { code: 'bad-input', message: 'Request body must be valid JSON' };
  }
  const connectionId =
    body !== null && typeof body === 'object'
      ? (body as { readonly connectionId?: unknown }).connectionId
      : undefined;
  return typeof connectionId === 'string' && connectionId.length > 0
    ? connectionId
    : { code: 'bad-input', message: 'The body is `{ "connectionId": "<id>" }`' };
}

function unsupported(): Refusal {
  return {
    code: 'repo-connection-unsupported',
    message: "This runtime can't connect a project to a repo",
  };
}

function projectNotFound(projectId: ProjectId): Refusal {
  return {
    code: 'project-not-found',
    message: `No project with id "${projectId as unknown as string}"`,
    projectId: projectId as unknown as string,
  };
}
