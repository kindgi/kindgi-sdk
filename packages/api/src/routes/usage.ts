// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { TENANT_USAGE_GROUP_KEYS, type UsageBinding } from '../usage.js';
import { refused } from './denied.js';
import { projectIdsCallerMay } from './readable-projects.js';
import { CURSOR_UNREADABLE, parseUsageQuery, usageBadInput } from './usage-query.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /v1/usage`: the caller's tenant's usage, aggregated, over the
 * projects they may read. The usage query (`usage-query.ts`; `groupBy`
 * from `project`, `agent`, `kind`, `class`, `state`, `day`, default
 * `project,kind`) and a `projectId` filter. It answers
 * `{ data, watermark, nextCursor? }`.
 *
 * Which projects (worked out as the cost aggregate works them out,
 * `cost.ts`, except for records with no project):
 * - a tenant admin, or a deployment without authorization: every project,
 *   and the tenant's records with none;
 * - anyone else, an admin's API key limited to a project included: the
 *   projects they may `read`, and no record without a project. A project
 *   they can't read is absent, never an error, so the answer doesn't say
 *   it exists;
 * - when those projects can't be listed here: one asked for with
 *   `projectId` is checked as itself; across projects, refused (403),
 *   never over-counted.
 */
export function usageRouter(options: {
  readonly usage: UsageBinding;
  readonly projects?: Pick<ProjectBinding, 'list'>;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { usage, projects, authorizer } = options;
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const query = parseUsageQuery((name) => c.req.query(name), TENANT_USAGE_GROUP_KEYS, [
      'project',
      'kind',
    ]);
    if (typeof query === 'string') return usageBadInput(c, query);
    const asked = c.req.query('projectId');
    if (asked !== undefined && !UUID_RE.test(asked)) {
      return usageBadInput(c, '`projectId` must be a project id');
    }
    const projectId = asked?.toLowerCase() as ProjectId | undefined;

    const projectIds = await projectsToRead(c, projectId);
    if (projectIds instanceof Response) return projectIds;
    const read = await usage.ofTenant(tenantId, {
      ...query,
      ...(projectIds !== undefined && { projectIds }),
    });
    if (read.kind === 'cursor-unreadable') return usageBadInput(c, CURSOR_UNREADABLE);
    return c.json(read.page);
  });

  return r;

  /**
   * The projects the read covers: `undefined` for all of them (and records
   * with none), else these ids, empty when the caller may read none asked
   * for; or the refusal.
   */
  async function projectsToRead(
    c: Context<AppEnv>,
    projectId: ProjectId | undefined,
  ): Promise<readonly ProjectId[] | undefined | Response> {
    const tenantId = c.get('tenantId') as TenantId;
    const all =
      authorizer === undefined ||
      (await authorizer.can(c, 'admin', ref('tenant', tenantId as unknown as string)));
    if (all) return projectId === undefined ? undefined : [projectId];
    if (projectId !== undefined) {
      // One project: checked as itself, absent when the caller can't read it.
      return (await authorizer.can(c, 'read', ref('project', projectId as unknown as string)))
        ? [projectId]
        : [];
    }
    const readable = await projectIdsCallerMay(c, authorizer, projects, 'read');
    if (readable !== undefined) return readable;
    return refused(c, authorizer, {
      action: 'read',
      resource: ref('tenant', tenantId as unknown as string),
      message:
        "The projects you may read can't be listed here, so usage across projects can't be limited to them: ask for one with projectId",
      failing: 'scope',
    });
  }
}
