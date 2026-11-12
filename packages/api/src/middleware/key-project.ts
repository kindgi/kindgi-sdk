// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { type Action, type ResourceRef, ref } from '@kindgi/authz';

import { refused } from '../routes/denied.js';
import type { AppEnv } from '../types.js';
import type { Authorizer } from './authorize.js';
import { type OwnBodyLimit, mayBeJsonObject, takesUpload } from './request-body.js';

const PROJECT_PATH_RE = /\/projects\/([^/]+)/;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/**
 * A key limited to a project (`projectId` at mint) is refused, `403
 * key-project-mismatch`, on a request that names another project in any
 * of the places a request names one:
 *
 * - the path: `/projects/<id>/…`;
 * - the query: `?projectId=<id>`, or `?scopeKind=project&scopeId=<id>`;
 * - a JSON write body: `projectId`, or `scope.projectId`. An upload's
 *   body (a route in `ownLimits`) isn't JSON, and isn't read here: the
 *   upload route checks the project its form names.
 *
 * A session limited to a project (`SessionCreateInput.projectId`) is held
 * the same way. Requests from any other caller pass untouched. What the key may do in
 * its own project is the authorizer's to decide, under the principal's
 * grants. The refusal is recorded with `authorizer`, as every refusal the
 * API decides itself is.
 */
export function refuseOtherProjectForKey(
  authorizer?: Authorizer,
  ownLimits: readonly OwnBodyLimit[] = [],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const keyProject = c.get('tokenProjectId');
    if (keyProject === undefined) return next();
    const jsonBody =
      WRITE_METHODS.has(c.req.method) &&
      !takesUpload(c, ownLimits) &&
      mayBeJsonObject(c.get('requestBody'));
    for (const named of await projectsNamed(c.req, jsonBody)) {
      if (named !== keyProject) {
        return refused(c, authorizer, {
          action: c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'write',
          resource: ref('project', named),
          message: `${limitedCaller(c)} is limited to project ${keyProject}; the request names project ${named}`,
          failing: 'scope',
          code: 'key-project-mismatch',
          details: { keyProjectId: keyProject, projectId: named },
        });
      }
    }
    return next();
  };
}

/** What a refusal names as limited: the caller's session, or its API key. */
export function limitedCaller(c: { get(key: 'sessionId'): unknown }): string {
  return c.get('sessionId') !== undefined ? 'This session' : 'This API key';
}

/**
 * Nothing for a caller not limited to a project nor held to a ceiling;
 * else the refusal, 403 `permission-denied` and recorded, of a route that
 * acts for the caller's person in every project at once (their sessions,
 * their second factor), which a key or session limited to one project
 * never reaches, nor a key with a ceiling (it always has a project; one
 * that came without is refused all the same). `why` ends the message:
 * "its person's sessions reach beyond it".
 */
export function personWideRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  action: Action,
  resource: ResourceRef,
  why: string,
): Response | undefined {
  const keyProject = c.get('tokenProjectId');
  const ceiling = c.get('tokenCeiling');
  if (keyProject === undefined && ceiling === undefined) return undefined;
  return refused(c, authorizer, {
    action,
    resource,
    message:
      keyProject !== undefined
        ? `${limitedCaller(c)} is limited to project ${keyProject}: ${why}`
        : `${limitedCaller(c)} has the ${ceiling} ceiling: ${why}`,
    failing: 'scope',
  });
}

type RequestLike = {
  readonly path: string;
  readonly method: string;
  query(name: string): string | undefined;
  json(): Promise<unknown>;
};

/** Every project id the request names, in path, query and (when `jsonBody`) body. */
async function projectsNamed(req: RequestLike, jsonBody: boolean): Promise<string[]> {
  const named: string[] = [];
  const inPath = PROJECT_PATH_RE.exec(req.path)?.[1];
  if (inPath !== undefined) named.push(decodeURIComponent(inPath));
  const inQuery = req.query('projectId');
  if (inQuery !== undefined && inQuery !== '') named.push(inQuery);
  const scopeId = req.query('scopeId');
  if (req.query('scopeKind') === 'project' && scopeId !== undefined) named.push(scopeId);
  if (jsonBody) named.push(...(await projectsInBody(req)));
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
