// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type {
  ProjectBinding,
  TeamBinding,
  TeamProjectGrant,
  TeamProjectGrantBinding,
  TeamProjectRole,
  TenantHierarchyBinding,
} from '@kindgi/platform';
import type { Cursor, ProjectId, TeamId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { membershipNotKeptInStepError } from './hierarchy-errors.js';
import { clampLimit } from './pagination.js';

/**
 * A team's role on a project. Every member of the team holds it there,
 * team admins included. A team never owns a project.
 *
 * - `GET    /projects/:projectId/team-grants`          project `write`
 * - `POST   /projects/:projectId/team-grants`          project `admin`, and
 *   `read` on the team: `{teamId, role}`; 201, 200 when the team holds that
 *   role already, 409 `team-grant-exists` when it holds another
 * - `PATCH  /projects/:projectId/team-grants/:teamId`  project `admin`: `{role}`
 * - `DELETE /projects/:projectId/team-grants/:teamId`  project `admin`
 * - `GET    /teams/:teamId/project-grants`             team `admin`
 *
 * Reading who has access is for a project's editors and admins, and a
 * team's admins, not its viewers or plain members (they see their own
 * roles through their grants).
 */
export interface TeamGrantsDeps {
  readonly grants: TeamProjectGrantBinding;
  readonly projects: ProjectBinding;
  readonly teams: TeamBinding;
  /** With an authorizer, writes go through it: the grant's row and tuple together. */
  readonly tenantHierarchy: TenantHierarchyBinding;
  readonly authorizer?: Authorizer;
}

const TEAM_PROJECT_ROLES: readonly TeamProjectRole[] = ['viewer', 'editor', 'admin'];

/** `role` as a team's role on a project, or why it isn't one. */
export function parseTeamProjectRole(role: unknown): TeamProjectRole | string {
  if (role === 'owner') return "A team can't own a project: give it `admin`";
  if (role === 'member')
    return "`member` isn't a project role: use `viewer`, which grants the same";
  if (!TEAM_PROJECT_ROLES.includes(role as TeamProjectRole)) {
    return `\`role\` must be one of: ${TEAM_PROJECT_ROLES.join(', ')}`;
  }
  return role as TeamProjectRole;
}

/** `/v1/projects/:projectId/team-grants`: the teams with a role on a project. */
export function projectTeamGrantsRouter(deps: TeamGrantsDeps): Hono<AppEnv> {
  const { grants, projects, teams, tenantHierarchy, authorizer } = deps;
  const r = new Hono<AppEnv>();

  if (authorizer !== undefined) {
    r.use('/:projectId/team-grants', async (c, next) => {
      const action = c.req.method === 'GET' ? 'write' : 'admin';
      return authorizer.authorize(action, () => ref('project', c.req.param('projectId')))(c, next);
    });
    r.use('/:projectId/team-grants/:teamId', async (c, next) =>
      authorizer.authorize('admin', () => ref('project', c.req.param('projectId')))(c, next),
    );
  }

  r.get('/:projectId/team-grants', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const project = await projects.get(tenantId, projectId);
    if (project === undefined) return projectNotFound(c, projectId);
    const cursor = c.req.query('cursor');
    const page = await grants.listForProject(tenantId, projectId, {
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const named = await Promise.all(
      page.items.map(async (g) => ({
        grant: g,
        teamName: (await teams.get(tenantId, g.teamId))?.name,
      })),
    );
    return c.json({
      data: named.map(({ grant, teamName }) => wire(grant, teamName, project.name)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.post('/:projectId/team-grants', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (body === undefined || body === null || typeof body !== 'object') {
      return badInput(c, 'The body must be `{ teamId, role }`');
    }
    if (typeof body.teamId !== 'string' || body.teamId.length === 0) {
      return badInput(c, '`teamId` must be a non-empty string');
    }
    const teamId = body.teamId as TeamId;
    const role = parseTeamProjectRole(body.role);
    if (!isRole(role)) return badInput(c, role);
    // You give your project only to a team you can see: an unknown team and
    // one you can't read answer alike.
    if (
      authorizer !== undefined &&
      !(await authorizer.can(c, 'read', ref('team', teamId as unknown as string)))
    ) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          {
            code: 'permission-denied',
            message: 'A project is given only to a team you can read',
          },
          c.get('requestId'),
        ),
      );
    }
    const project = await projects.get(tenantId, projectId);
    if (project === undefined) return projectNotFound(c, projectId);
    const team = await teams.get(tenantId, teamId);
    if (team === undefined) return teamNotFound(c, teamId);

    let created: boolean;
    let grant: TeamProjectGrant;
    if (authorizer !== undefined) {
      const add = tenantHierarchy.addTeamProjectGrant?.bind(tenantHierarchy);
      if (add === undefined) return notInStep(c, 'addTeamProjectGrant');
      const res = await add({ tenantId, projectId, teamId, role });
      if (res.kind === 'err') {
        if (res.error.code === 'project-not-found') return projectNotFound(c, projectId);
        if (res.error.code === 'team-not-found') return teamNotFound(c, teamId);
        throw new Error(res.error.message, { cause: res.error });
      }
      ({ created, grant } = res.value);
    } else {
      const held = await grants.get?.(tenantId, teamId, projectId);
      if (held !== undefined) {
        created = false;
        grant = held;
      } else {
        await grants.add(tenantId, { teamId, projectId, role });
        created = true;
        grant = (await grants.get?.(tenantId, teamId, projectId)) ?? { teamId, projectId, role };
      }
    }
    if (!created && grant.role !== role) {
      c.status(statusFor('team-grant-exists') as never);
      return c.json(
        toWireError(
          {
            code: 'team-grant-exists',
            message: `The team holds ${grant.role} on this project already: change its role to give it another`,
            role: grant.role,
          },
          c.get('requestId'),
        ),
      );
    }
    c.status(created ? 201 : 200);
    return c.json(wire(grant, team.name, project.name));
  });

  r.patch('/:projectId/team-grants/:teamId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const teamId = c.req.param('teamId') as TeamId;
    const body = (await c.req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const role = parseTeamProjectRole(body?.role);
    if (!isRole(role)) return badInput(c, role);
    if (authorizer !== undefined) {
      const update = tenantHierarchy.updateTeamProjectGrantRole?.bind(tenantHierarchy);
      if (update === undefined) return notInStep(c, 'updateTeamProjectGrantRole');
      const res = await update({ tenantId, projectId, teamId, role });
      if (res.kind === 'err') throw new Error(res.error.message, { cause: res.error });
      if (res.value.kind === 'project-not-found') return projectNotFound(c, projectId);
      if (res.value.kind === 'team-grant-not-found') return grantNotFound(c, teamId, projectId);
    } else {
      if ((await projects.get(tenantId, projectId)) === undefined) {
        return projectNotFound(c, projectId);
      }
      if ((await grants.get?.(tenantId, teamId, projectId)) === undefined) {
        return grantNotFound(c, teamId, projectId);
      }
      await grants.updateRole(tenantId, teamId, projectId, role);
    }
    c.status(204);
    return c.body(null);
  });

  r.delete('/:projectId/team-grants/:teamId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const teamId = c.req.param('teamId') as TeamId;
    if (authorizer !== undefined) {
      const remove = tenantHierarchy.removeTeamProjectGrant?.bind(tenantHierarchy);
      if (remove === undefined) return notInStep(c, 'removeTeamProjectGrant');
      const res = await remove({ tenantId, projectId, teamId });
      if (res.kind === 'err') throw new Error(res.error.message, { cause: res.error });
    } else {
      await grants.remove(tenantId, teamId, projectId);
    }
    c.status(204);
    return c.body(null);
  });

  return r;
}

/** `/v1/teams/:teamId/project-grants`: the projects a team holds a role on. */
export function teamProjectGrantsRouter(deps: TeamGrantsDeps): Hono<AppEnv> {
  const { grants, projects, teams, authorizer } = deps;
  const r = new Hono<AppEnv>();
  if (authorizer !== undefined) {
    r.use('/:teamId/project-grants', async (c, next) =>
      authorizer.authorize('admin', () => ref('team', c.req.param('teamId')))(c, next),
    );
  }
  r.get('/:teamId/project-grants', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;
    const team = await teams.get(tenantId, teamId);
    if (team === undefined) return teamNotFound(c, teamId);
    const cursor = c.req.query('cursor');
    const page = await grants.listForTeam(tenantId, teamId, {
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    const named = await Promise.all(
      page.items.map(async (g) => ({
        grant: g,
        projectName: (await projects.get(tenantId, g.projectId))?.name,
      })),
    );
    return c.json({
      data: named.map(({ grant, projectName }) => wire(grant, team.name, projectName)),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });
  return r;
}

const isRole = (role: TeamProjectRole | string): role is TeamProjectRole =>
  (TEAM_PROJECT_ROLES as readonly string[]).includes(role);

function wire(
  g: TeamProjectGrant,
  teamName: string | undefined,
  projectName: string | undefined,
): Record<string, unknown> {
  return {
    teamId: g.teamId as unknown as string,
    projectId: g.projectId as unknown as string,
    role: g.role,
    ...(g.grantedAt !== undefined && { grantedAt: g.grantedAt as unknown as string }),
    ...(teamName !== undefined && { teamName }),
    ...(projectName !== undefined && { projectName }),
  };
}

function badInput(c: Context<AppEnv>, message: string) {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, c.get('requestId')));
}

function notInStep(c: Context<AppEnv>, method: string) {
  c.status(statusFor('authz-membership-unsupported') as never);
  return c.json(toWireError(membershipNotKeptInStepError(method), c.get('requestId')));
}

function projectNotFound(c: Context<AppEnv>, projectId: ProjectId) {
  c.status(statusFor('project-not-found') as never);
  const id = projectId as unknown as string;
  return c.json(
    toWireError(
      { code: 'project-not-found', message: `No project with id "${id}"`, projectId: id },
      c.get('requestId'),
    ),
  );
}

function teamNotFound(c: Context<AppEnv>, teamId: TeamId) {
  c.status(statusFor('team-not-found') as never);
  const id = teamId as unknown as string;
  return c.json(
    toWireError(
      { code: 'team-not-found', message: `No team with id "${id}"`, teamId: id },
      c.get('requestId'),
    ),
  );
}

function grantNotFound(c: Context<AppEnv>, teamId: TeamId, projectId: ProjectId) {
  c.status(statusFor('team-grant-not-found') as never);
  return c.json(
    toWireError(
      {
        code: 'team-grant-not-found',
        message: `Team "${teamId as unknown as string}" has no role on project "${projectId as unknown as string}"`,
      },
      c.get('requestId'),
    ),
  );
}
