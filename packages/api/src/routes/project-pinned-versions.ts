// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/projects/:projectId/pinned-versions`: every agent's pins that
 * cover a project (the tenant's, the project's org's, the project's own and
 * its segments'), ordered by agent id, then scope, a page at a time. It's
 * what a reader of the project needs to know which versions its runs can
 * take, in one read instead of one per agent.
 *
 * A caller sees a pin only with all three of: `read` on the project (the
 * guard below, before the cursor, the limit or the 501); `read` on the
 * pin's agent, as the agents list asks it; and the pin's version, as
 * `GET /v1/agents/:agentId/pinned-versions` shows it (`seenPins`). So it shows
 * no pin that route doesn't already show its caller, and only the scopes
 * that cover this project. The filter runs on the page the binding read, so
 * a page can come back short, or empty, with `hasMore: true`: page on the
 * cursor, not the count.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { Cursor, ProjectId, TenantId } from '@kindgi/types';

import type { AgentPinnedVersionBinding } from '../agent-pin-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { ItemRights } from '../item-rights.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { seenPins, serializeAgentPinnedVersion } from './agent-pins.js';
import { deniedBy } from './denied.js';
import { refuseUnissuedCursor } from './issued-cursor.js';
import { clampLimit } from './pagination.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectPinnedVersionsRouter(deps: {
  readonly agentPinned: AgentPinnedVersionBinding;
  readonly projects: ProjectBinding;
  readonly authorizer?: Authorizer;
  /** Rights on an agent more than one project serves (`item-rights.ts`); absent → the agent's own. */
  readonly itemRights?: ItemRights;
}): Hono<AppEnv> {
  const { agentPinned, projects, authorizer, itemRights } = deps;
  const r = new Hono<AppEnv>();

  // The project first, as the expert queue routes guard theirs: nothing else is
  // read or refused for a caller who can't read it.
  r.use('/:projectId/pinned-versions', async (c, next) => {
    const projectId = c.req.param('projectId') as string;
    if (!UUID.test(projectId)) {
      return fail(c, 'bad-input', `"${projectId}" isn't a project id`);
    }
    const refused = await deniedBy(authorizer, c, 'read', ref('project', projectId));
    if (refused !== undefined) return refused;
    if ((await projects.get(c.get('tenantId') as TenantId, projectId as ProjectId)) === undefined) {
      return fail(c, 'project-not-found', `No project with id "${projectId}"`, { projectId });
    }
    await next();
    return undefined;
  });

  r.get('/:projectId/pinned-versions', async (c) => {
    if (agentPinned.listCovering === undefined) {
      return fail(
        c,
        'pinned-versions-not-supported',
        "This deployment can't list a project's pinned versions.",
      );
    }
    const cursor = c.req.query('cursor');
    const unissued = refuseUnissuedCursor(c, agentPinned, 'covering', cursor);
    if (unissued !== undefined) return unissued;
    const page = await agentPinned.listCovering({
      tenantId: c.get('tenantId') as TenantId,
      projectId: c.req.param('projectId') as ProjectId,
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    // The pin's agent, as the agents list asks it, but each pin at its own
    // version: no `versions`, which would show a row at the agent's newest.
    const readable =
      authorizer === undefined
        ? page.data
        : itemRights === undefined
          ? await authorizer.filterByCan(c, 'read', page.data, (p) => ref('agent', p.agentId))
          : await itemRights.filterItems(c, 'agent', page.data, {
              idOf: (p) => p.agentId,
              todayRef: (p) => ref('agent', p.agentId),
            });
    const pins = await seenPins(itemRights, c, readable);
    return c.json({
      data: pins.map(serializeAgentPinnedVersion),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  return r;
}

function fail(
  c: Context<AppEnv>,
  code: 'bad-input' | 'project-not-found' | 'pinned-versions-not-supported',
  message: string,
  extra: Record<string, unknown> = {},
) {
  c.status(statusFor(code) as never);
  return c.json(toWireError({ code, message, ...extra }, c.get('requestId')));
}
