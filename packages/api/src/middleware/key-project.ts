// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { type Action, type ResourceRef, ref } from '@kindgi/authz';

import { isReadMethod } from '../read-method.js';
import { refused } from '../routes/denied.js';
import type { AppEnv } from '../types.js';
import { type Authorizer, type ResourceGetter, beyondKeyProject } from './authorize.js';
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
 * - a JSON write body: `projectId`, `scope.projectId`, `improve.projectId`
 *   (an Improve schedule's), or `scopeKind: 'project'` with `scopeId`, as
 *   the query names one (an MCP endpoint's register body). An upload's
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
 * A route's gate on `action` at the resource its getter names: the
 * authorizer's (`authorize`) with a store, else `holdLimitedCaller`. One
 * getter serves both, so both read the scope the same way.
 */
export function gate(authorizer: Authorizer | undefined): Authorizer['authorize'] {
  return authorizer !== undefined
    ? (action, getResource) => authorizer.authorize(action, getResource)
    : holdLimitedCaller;
}

/**
 * Without an authorization store, a key or session limited to a project
 * is refused, `403 key-project-mismatch`, a write that a store would
 * refuse it for that limit alone (`beyondKeyProject`): an `admin` action
 * on the tenant, an org or a team, or a write in another project. Reads
 * pass, and so does every other caller, as they do without a store today.
 */
export function holdLimitedCaller(
  action: Action,
  getResource: ResourceGetter,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('tokenProjectId') === undefined || isReadMethod(c.req.method)) return next();
    return limitedCallerRefusal(c, action, await getResource(c)) ?? next();
  };
}

/**
 * `holdLimitedCaller`'s answer for a resource a handler knows only once
 * it has read the request: the 403 to return, or `undefined` when the
 * caller's limit allows the write. For a runtime without a store; with
 * one, the route asks the authorizer instead.
 */
export function limitedCallerRefusal(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
): Response | undefined {
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined || isReadMethod(c.req.method)) return undefined;
  if (!beyondKeyProject(c, action, resource)) return undefined;
  const otherProject = resource.type === 'project';
  return refused(c, undefined, {
    action,
    resource,
    message: otherProject
      ? `${limitedCaller(c)} is limited to project ${keyProject}; the request names project ${resource.id}`
      : `${limitedCaller(c)} is limited to project ${keyProject}, and this request changes ${above(resource)}`,
    failing: 'scope',
    code: 'key-project-mismatch',
    details: { keyProjectId: keyProject, ...(otherProject && { projectId: resource.id }) },
  });
}

/** What a refusal names above the project. */
function above(resource: ResourceRef): string {
  return resource.type === 'tenant' ? 'the workspace' : `${resource.type} ${resource.id}`;
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

/**
 * `projectId`, `scope.projectId`, `improve.projectId`, and `scopeId`
 * beside `scopeKind: 'project'` in a JSON body; none when it isn't JSON.
 */
async function projectsInBody(req: RequestLike): Promise<string[]> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return [];
  }
  if (body === null || typeof body !== 'object') return [];
  const b = body as {
    readonly projectId?: unknown;
    readonly scope?: unknown;
    readonly improve?: unknown;
    readonly scopeKind?: unknown;
    readonly scopeId?: unknown;
  };
  const named: string[] = [];
  if (typeof b.projectId === 'string') named.push(b.projectId);
  for (const nested of [b.scope, b.improve]) {
    const inside = projectIdIn(nested);
    if (inside !== undefined) named.push(inside);
  }
  if (b.scopeKind === 'project' && typeof b.scopeId === 'string') named.push(b.scopeId);
  return named;
}

/** `value.projectId`, when `value` is an object with one. */
function projectIdIn(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const projectId = (value as { readonly projectId?: unknown }).projectId;
  return typeof projectId === 'string' ? projectId : undefined;
}
