// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';

import { refused } from '../routes/denied.js';
import type { AppEnv } from '../types.js';
import type { Authorizer } from './authorize.js';

const PROJECT_PATH_RE = /\/projects\/([^/]+)/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/**
 * A key limited to a project (`projectId` at mint) is refused, `403
 * key-project-mismatch`, on a request that names another project in any
 * of the places a request names one:
 *
 * - the path: `/projects/<id>/…`;
 * - the query: `?projectId=<id>`, or `?scopeKind=project&scopeId=<id>`;
 * - a JSON write body: `projectId`, or `scope.projectId`.
 *
 * Requests from any other caller pass untouched. What the key may do in
 * its own project is the authorizer's to decide, under the principal's
 * grants. The refusal is recorded with `authorizer`, as every refusal the
 * API decides itself is.
 */
export function refuseOtherProjectForKey(authorizer?: Authorizer): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const keyProject = c.get('tokenProjectId');
    if (keyProject === undefined) return next();
    for (const named of await projectsNamed(c.req)) {
      if (named !== keyProject) {
        return refused(c, authorizer, {
          action: c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'write',
          resource: ref('project', named),
          message: `This API key is limited to project ${keyProject}; the request names project ${named}`,
          failing: 'scope',
          code: 'key-project-mismatch',
          details: { keyProjectId: keyProject, projectId: named },
        });
      }
    }
    return next();
  };
}

type RequestLike = {
  readonly path: string;
  readonly method: string;
  query(name: string): string | undefined;
  json(): Promise<unknown>;
};

/** Every project id the request names, in path, query and body. */
async function projectsNamed(req: RequestLike): Promise<string[]> {
  const named: string[] = [];
  const inPath = PROJECT_PATH_RE.exec(req.path)?.[1];
  if (inPath !== undefined) named.push(decodeURIComponent(inPath));
  const inQuery = req.query('projectId');
  if (inQuery !== undefined && inQuery !== '') named.push(inQuery);
  const scopeId = req.query('scopeId');
  if (req.query('scopeKind') === 'project' && scopeId !== undefined) named.push(scopeId);
  if (WRITE_METHODS.has(req.method)) named.push(...(await projectsInBody(req)));
  return named;
}

/** `projectId` and `scope.projectId` in a JSON body; none when it isn't JSON. */
async function projectsInBody(req: RequestLike): Promise<string[]> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return [];
  }
  if (body === null || typeof body !== 'object') return [];
  const b = body as { readonly projectId?: unknown; readonly scope?: unknown };
  const named: string[] = [];
  if (typeof b.projectId === 'string') named.push(b.projectId);
  const scope = b.scope as { readonly projectId?: unknown } | null | undefined;
  if (scope !== null && typeof scope === 'object' && typeof scope.projectId === 'string') {
    named.push(scope.projectId);
  }
  return named;
}
