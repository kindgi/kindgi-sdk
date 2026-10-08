// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who can see and change which memory, for a caller of `/v1/memory`.
 *
 * Reads: the containers the caller may read (`MemoryReaders`), worked out
 * here from the principal and handed to the binding, which applies them
 * inside its query. A tenant admin (or a deployment without
 * authorization) reads everything; anyone else reads tenant-wide facts,
 * the projects and orgs they may read, their own user facts, and every
 * end user's and conversation's facts in the projects they may write (an
 * app's own credential acting for its users).
 *
 * Writes: what the fact's scope names decides the check.
 */

import type { Context } from 'hono';

import { type Principal, ref } from '@kindgi/authz';
import type { MemoryReaders, MemoryScope } from '@kindgi/memory';
import type { ProjectBinding } from '@kindgi/platform';
import type { OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

export interface MemoryAccessDeps {
  readonly authorizer?: Authorizer;
  /** The tenant's projects, to check one by one when the authorizer can't list them. */
  readonly projects?: Pick<ProjectBinding, 'list'>;
}

const PROJECT_PAGE = 200;

/** The caller's user id, when the caller is a Kindgi user. */
function callerUserId(c: Context<AppEnv>): UserId | undefined {
  const actor = (c.get('principal') as Principal | undefined)?.actor;
  return actor?.kind === 'user' ? (actor.id as UserId) : undefined;
}

/** `user:<id>` or `service:<id>`: who did it, for a record. */
export function callerRef(c: Context<AppEnv>): string {
  const actor = (c.get('principal') as Principal | undefined)?.actor;
  if (actor === undefined) return 'service:unknown';
  return `${actor.kind === 'user' ? 'user' : 'service'}:${actor.id}`;
}

/** Who asserts a fact the caller writes. */
export function callerAttribution(c: Context<AppEnv>): {
  readonly kind: 'user' | 'service';
  readonly id: string;
} {
  const actor = (c.get('principal') as Principal | undefined)?.actor;
  if (actor === undefined) return { kind: 'service', id: 'unknown' };
  return { kind: actor.kind === 'user' ? 'user' : 'service', id: actor.id };
}

async function isTenantAdmin(c: Context<AppEnv>, authorizer: Authorizer): Promise<boolean> {
  return authorizer.can(c, 'admin', ref('tenant', c.get('tenantId') as unknown as string));
}

type ProjectRow = { readonly id: ProjectId; readonly orgId?: OrgId };

/** The tenant's projects, every page. */
async function allProjects(c: Context<AppEnv>, deps: MemoryAccessDeps): Promise<ProjectRow[]> {
  if (deps.projects === undefined) return [];
  const tenantId = c.get('tenantId') as TenantId;
  const all: ProjectRow[] = [];
  let cursor: Parameters<ProjectBinding['list']>[1]['cursor'];
  for (;;) {
    const page = await deps.projects.list(tenantId, {
      limit: PROJECT_PAGE,
      ...(cursor !== undefined && { cursor }),
    });
    all.push(
      ...page.items.map((p) => ({ id: p.id, ...(p.orgId !== undefined && { orgId: p.orgId }) })),
    );
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return all;
}

/**
 * The projects the caller may `action`, and the orgs whose org-wide facts
 * it reads: listed by the authorizer (`read` on the org), else the
 * projects checked one by one and the orgs of those it may read.
 */
async function readerContainers(
  c: Context<AppEnv>,
  deps: MemoryAccessDeps & { readonly authorizer: Authorizer },
): Promise<{ readable: ProjectId[]; writable: ProjectId[]; orgs: OrgId[] }> {
  const { authorizer } = deps;
  const [readable, writable, orgs] = await Promise.all([
    authorizer.listObjects?.(c, 'read', 'project'),
    authorizer.listObjects?.(c, 'write', 'project'),
    authorizer.listObjects?.(c, 'read', 'org'),
  ]);
  if (readable !== undefined && writable !== undefined && orgs !== undefined) {
    return {
      readable: readable.map((id) => id as ProjectId),
      writable: writable.map((id) => id as ProjectId),
      orgs: orgs.map((id) => id as OrgId),
    };
  }
  const all = await allProjects(c, deps);
  const projectRef = (p: ProjectRow) => ref('project', p.id as unknown as string);
  const [canRead, canWrite] = await Promise.all([
    authorizer.filterByCan(c, 'read', all, projectRef),
    authorizer.filterByCan(c, 'write', all, projectRef),
  ]);
  return {
    readable: canRead.map((p) => p.id),
    writable: canWrite.map((p) => p.id),
    orgs: [...new Set(canRead.flatMap((p) => (p.orgId !== undefined ? [p.orgId] : [])))],
  };
}

/** What the caller may read. */
export async function memoryReadersFor(
  c: Context<AppEnv>,
  deps: MemoryAccessDeps,
): Promise<MemoryReaders> {
  const { authorizer } = deps;
  // Without authorization (a development deployment), the one credential reads it all.
  if (authorizer === undefined) return { all: true };
  if (await isTenantAdmin(c, authorizer)) return { all: true };
  const { readable, writable, orgs } = await readerContainers(c, { ...deps, authorizer });
  const user = callerUserId(c);
  return {
    projectIds: readable,
    orgIds: orgs,
    ...(user !== undefined && { userIds: [user] }),
    onBehalfOfProjectIds: writable,
  };
}

/**
 * Why the caller may not write a fact in `scope`, if they may not:
 *   - a tenant-wide fact needs `admin` on the tenant;
 *   - an org-wide fact, `admin` on the org;
 *   - a project's fact (an end user's or a conversation's included),
 *     `write` on the project;
 *   - a conversation's fact outside a project, `write` on the conversation;
 *   - a user's fact, being that user (or a tenant admin).
 */
export async function memoryWriteProblem(
  c: Context<AppEnv>,
  deps: MemoryAccessDeps,
  scope: MemoryScope,
): Promise<string | undefined> {
  const { authorizer } = deps;
  if (authorizer === undefined || (await isTenantAdmin(c, authorizer))) return undefined;
  if (scope.userId !== undefined && scope.userId !== callerUserId(c)) {
    return "Only that user (or a tenant admin) can write a user's memory.";
  }
  if (scope.projectId !== undefined) {
    return (await authorizer.can(c, 'write', ref('project', scope.projectId as unknown as string)))
      ? undefined
      : `Writing memory in project "${scope.projectId as unknown as string}" needs write on it.`;
  }
  if (scope.threadId !== undefined) {
    return (await authorizer.can(
      c,
      'write',
      ref('conversation', scope.threadId as unknown as string),
    ))
      ? undefined
      : `Writing a conversation's memory needs write on conversation "${scope.threadId as unknown as string}".`;
  }
  if (scope.orgId !== undefined) {
    return (await authorizer.can(c, 'admin', ref('org', scope.orgId as unknown as string)))
      ? undefined
      : `Writing org-wide memory needs admin on org "${scope.orgId as unknown as string}".`;
  }
  if (scope.userId !== undefined) return undefined;
  return 'Writing tenant-wide memory needs admin on the tenant.';
}
