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
 * The routes with a fixed word where a project id goes: `GET
 * /v1/projects/default`. A read of one (GET or HEAD, on exactly its path)
 * names no project in its path, so `refuseOtherProjectForKey` doesn't read
 * one there, and the route holds a limited caller itself
 * (`literalProjectRefusal`). Any other request, `/v1/projects/default/…` or
 * a write to `/v1/projects/default`, names the project `default`, as it
 * would any id. A test holds this list to the routes the app mounts.
 */
export const PROJECT_LITERAL_READS: readonly string[] = ['/v1/projects/default'];

/**
 * A key limited to a project (`projectId` at mint) is refused, `403
 * key-project-mismatch`, on a request that names another project in any
 * of the places a request names one:
 *
 * - the path: `/projects/<id>/…`, except a read of a route in
 *   `PROJECT_LITERAL_READS`;
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
      if (named !== keyProject) return otherProjectRefusal(c, authorizer, keyProject, named);
    }
    return next();
  };
}

/**
 * For a route in `PROJECT_LITERAL_READS`: the 403 a key or session limited
 * to a project gets when the project the route answers for (`answers`, or
 * `undefined` when there is none) isn't its own. It's
 * `refuseOtherProjectForKey`'s refusal, naming what the path names
 * (`literal`), store or not, so the answer never says which project that
 * is. `undefined` for any other caller, and for the key's own project.
 */
export function literalProjectRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  literal: string,
  answers: string | undefined,
): Response | undefined {
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined || answers === keyProject) return undefined;
  return otherProjectRefusal(c, authorizer, keyProject, literal);
}

/** The 403 for a limited caller on a request that names project `named`, recorded. */
function otherProjectRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  keyProject: string,
  named: string,
): Response {
  return refused(c, authorizer, {
    action: c.req.method === 'GET' || c.req.method === 'HEAD' ? 'read' : 'write',
    resource: ref('project', named),
    message: `${limitedCaller(c)} is limited to project ${keyProject}; the request names project ${named}`,
    failing: 'scope',
    code: 'key-project-mismatch',
    details: { keyProjectId: keyProject, projectId: named },
  });
}

/** What a refusal names as limited: the caller's session, or its API key. */
export function limitedCaller(c: { get(key: 'sessionId'): unknown }): string {
  return c.get('sessionId') !== undefined ? 'This session' : 'This API key';
}

/**
 * Nothing for a caller not limited to a project; else the refusal, 403
 * `permission-denied` and recorded, of a route that acts for the caller's
 * person in every project at once (their sessions, their second factor),
 * which a key or session limited to one project never reaches. `why`
 * ends the message: "its person's sessions reach beyond it".
 */
export function personWideRefusal(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  action: Action,
  resource: ResourceRef,
  why: string,
): Response | undefined {
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined) return undefined;
  return refused(c, authorizer, {
    action,
    resource,
    message: `${limitedCaller(c)} is limited to project ${keyProject}: ${why}`,
    failing: 'scope',
  });
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
 * one, the route asks the authorizer instead. `item` names what the
 * request names by its id (`'the trigger'`) when `resource` is that
 * item's project: the refusal then says the item is in that project,
 * not that the request names it.
 */
export function limitedCallerRefusal(
  c: Context<AppEnv>,
  action: Action,
  resource: ResourceRef,
  item?: string,
): Response | undefined {
  const keyProject = c.get('tokenProjectId');
  if (keyProject === undefined || isReadMethod(c.req.method)) return undefined;
  if (!beyondKeyProject(c, action, resource)) return undefined;
  const otherProject = resource.type === 'project';
  const where =
    item === undefined
      ? `the request names project ${resource.id}`
      : `${item} is in project ${resource.id}`;
  return refused(c, undefined, {
    action,
    resource,
    message: otherProject
      ? `${limitedCaller(c)} is limited to project ${keyProject}; ${where}`
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
  const inPath = readsLiteral(req) ? undefined : PROJECT_PATH_RE.exec(req.path)?.[1];
  if (inPath !== undefined) named.push(decodeURIComponent(inPath));
  const inQuery = req.query('projectId');
  if (inQuery !== undefined && inQuery !== '') named.push(inQuery);
  const scopeId = req.query('scopeId');
  if (req.query('scopeKind') === 'project' && scopeId !== undefined) named.push(scopeId);
  if (jsonBody) named.push(...(await projectsInBody(req)));
  return named;
}

/** Whether the request reads a route in `PROJECT_LITERAL_READS`: GET or HEAD, on exactly its path. */
function readsLiteral(req: RequestLike): boolean {
  return isReadMethod(req.method) && PROJECT_LITERAL_READS.includes(req.path);
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
