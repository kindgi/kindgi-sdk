// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The projects a caller may act on, for a route that hands them to its
 * binding to apply inside the query (memory reads, the cost aggregate)
 * rather than filtering a page after it: the authorizer's list when it can
 * list (`listObjects`), else the tenant's projects checked one by one.
 */

import type { Context } from 'hono';

import { type Action, ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { OrgId, ProjectId, TenantId } from '@kindgi/types';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';

const PROJECT_PAGE = 200;

export type ProjectRow = { readonly id: ProjectId; readonly orgId?: OrgId };

/** The tenant's projects, every page; none without a project binding. */
export async function allProjects(
  c: Context<AppEnv>,
  projects: Pick<ProjectBinding, 'list'> | undefined,
): Promise<ProjectRow[]> {
  if (projects === undefined) return [];
  const tenantId = c.get('tenantId') as TenantId;
  const all: ProjectRow[] = [];
  let cursor: Parameters<ProjectBinding['list']>[1]['cursor'];
  for (;;) {
    const page = await projects.list(tenantId, {
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
 * The ids of the projects the caller may `action`: listed by the
 * authorizer, else the tenant's projects checked one by one. `undefined`
 * when neither can say (the authorizer can't list, and there's no project
 * binding to check against).
 */
export async function projectIdsCallerMay(
  c: Context<AppEnv>,
  authorizer: Authorizer,
  projects: Pick<ProjectBinding, 'list'> | undefined,
  action: Action,
): Promise<ProjectId[] | undefined> {
  const listed = await authorizer.listObjects?.(c, action, 'project');
  if (listed !== undefined) return listed.map((id) => id as ProjectId);
  if (projects === undefined) return undefined;
  const may = await authorizer.filterByCan(c, action, await allProjects(c, projects), (p) =>
    ref('project', p.id as unknown as string),
  );
  return may.map((p) => p.id);
}
