// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref } from '@kindgi/authz';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type {
  Project,
  ProjectBinding,
  ProjectMembership,
  ProjectMembershipBinding,
  ProjectMembershipUpdateRoleOutcome,
  ProjectPatch,
  ProjectRole,
  ProjectSpec,
} from '@kindgi/platform';
import type { Cursor, OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { IdentityDirectoryBinding } from '../identity-directory-binding.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import {
  membershipExistsError,
  membershipNotKeptInStepError,
  orgNotFoundError,
  projectDefaultAlreadyExistsError,
  slugConflictError,
} from './hierarchy-errors.js';
import { clampLimit } from './pagination.js';
import { parseAssignableProjectRole } from './project-roles.js';

/**
 * Projects resource routes — part of the multi-tenant hierarchy.
 *
 * Ten endpoints on `/v1/projects`:
 *   - `GET    /`                         — cursor-paginated list;
 *                                          `?limit=` / `?cursor=` / `?orgId=` /
 *                                          `?nameContains=`.
 *   - `POST   /`                         — create; body `{ name, slug,
 *                                          orgId?, description?, isDefault? }`;
 *                                          201 `{ id }`; 409 `slug-conflict`
 *                                          when its org (or, without an org,
 *                                          the tenant's projects without one)
 *                                          has a project with that slug, or
 *                                          `project-default-already-exists`
 *                                          for a second Default.
 *   - `GET    /default`                  — returns the tenant's Default
 *                                          project or 404 `project-not-found`;
 *                                          read on it, as `GET /:projectId`.
 *                                          MUST be mounted BEFORE `/:projectId`.
 *   - `GET    /:projectId`               — get; 200 or 404 `project-not-found`.
 *   - `PATCH  /:projectId`               — partial update; 204, 404
 *                                          `project-not-found` or 409
 *                                          `slug-conflict` (a new slug, or a
 *                                          move to an org that has it).
 *   - `DELETE /:projectId`               — 204 idempotent.
 *   - `GET    /:projectId/memberships`   — list; cursor-paginated.
 *   - `POST   /:projectId/memberships`   — add member; body `{ userId, role }`
 *                                          or `{ email, role }`; 201, or 404
 *                                          `identity-user-not-found` for
 *                                          someone not in the tenant.
 *                                          Idempotent per binding contract.
 *   - `DELETE /:projectId/memberships/:userId`
 *                                        — 204 idempotent.
 *   - `PATCH  /:projectId/memberships/:userId`
 *                                        — updateRole via `{ role }`; 204 or
 *                                          404 `project-membership-not-found`.
 */
export function projectsRouter(
  binding: ProjectBinding,
  membershipBinding: ProjectMembershipBinding,
  /**
   * Tenant-hierarchy binding. When `authorizer` is also set, POST /
   * routes through `tenantHierarchy.createProject` — writes FGA
   * parent/owner tuples atomically with the insert. Without an
   * authorizer, POST / falls back to `binding.create()` (no tuples).
   */
  tenantHierarchy: TenantHierarchyBinding,
  /**
   * Optional authorizer. When provided, routes are gated by
   * `authorize()` before the handler runs, and the list is filtered to
   * projects the caller can read.
   */
  authorizer?: Authorizer,
  /**
   * Optional. The tenant's people: a member added to a project must be
   * one of them, named by id or (when the directory looks people up by
   * email) by email. Without it, an id is taken as given.
   */
  directory?: IdentityDirectoryBinding,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /**
   * Change a member's role. With an authorizer, the row and its FGA tuple
   * change together through the tenant-hierarchy binding, or the change
   * is refused; without one, the membership binding alone.
   */
  async function updateMemberRole(
    tenantId: TenantId,
    projectId: ProjectId,
    userId: UserId,
    role: ProjectRole,
  ): Promise<
    | { readonly kind: 'done'; readonly outcome: ProjectMembershipUpdateRoleOutcome }
    | { readonly kind: 'refused'; readonly error: ReturnType<typeof membershipNotKeptInStepError> }
  > {
    if (authorizer === undefined) {
      return {
        kind: 'done',
        outcome: await membershipBinding.updateRole(tenantId, projectId, userId, role),
      };
    }
    if (tenantHierarchy.updateProjectMemberRole === undefined) {
      return { kind: 'refused', error: membershipNotKeptInStepError('updateProjectMemberRole') };
    }
    const res = await tenantHierarchy.updateProjectMemberRole({
      tenantId,
      projectId,
      userId,
      role,
    });
    if (res.kind === 'err') throw new Error(res.error.message, { cause: res.error });
    return { kind: 'done', outcome: res.value };
  }

  /**
   * The person a new member names, among the tenant's people still here:
   * by id, or by email when the directory looks people up by email.
   * Without a directory, an id is taken as given.
   */
  async function resolveMember(
    tenantId: TenantId,
    named: MemberName,
  ): Promise<
    | { readonly kind: 'found'; readonly userId: UserId }
    | { readonly kind: 'refused'; readonly error: Parameters<typeof toWireError>[0] }
  > {
    if ('userId' in named) {
      if (directory === undefined) return { kind: 'found', userId: named.userId };
      const user = await directory.getUser({ tenantId, userId: named.userId });
      if (user !== null && user.unregisteredAt === undefined) {
        return { kind: 'found', userId: user.userId };
      }
      return {
        kind: 'refused',
        error: {
          code: 'identity-user-not-found',
          message: `User "${named.userId as unknown as string}" is not a member of this tenant`,
          userId: named.userId as unknown as string,
        },
      };
    }
    if (directory?.findUserByEmail === undefined) {
      return {
        kind: 'refused',
        error: {
          code: 'bad-input',
          message: "This runtime doesn't look people up by email: name them by `userId`",
        },
      };
    }
    const user = await directory.findUserByEmail({ tenantId, email: named.email });
    if (user !== null && user.unregisteredAt === undefined) {
      return { kind: 'found', userId: user.userId };
    }
    return {
      kind: 'refused',
      error: {
        code: 'identity-user-not-found',
        message: `No one with email "${named.email}" is a member of this tenant`,
      },
    };
  }

  // ---------- GET /default (literal segment; must precede /:projectId) ----------
  // Read on the Default project, as `GET /:projectId` checks it: someone
  // with a role on another project only gets 403, not its settings.
  if (authorizer !== undefined) {
    r.use('/default', async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const proj = await binding.getDefault(c.get('tenantId') as TenantId);
      // None: the handler answers 404.
      if (proj === undefined) return next();
      const mw = authorizer.authorize('read', () => ref('project', proj.id as unknown as string));
      return mw(c, next);
    });
  }
  r.get('/default', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const proj = await binding.getDefault(tenantId);
    if (proj === undefined) {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: 'Tenant has no Default project',
          },
          requestId,
        ),
      );
    }
    return c.json(serializeProject(proj));
  });

  // ---------- GET / (list) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const orgIdRaw = c.req.query('orgId');
    const nameContainsRaw = c.req.query('nameContains');
    const page = await binding.list(tenantId, {
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(orgIdRaw !== undefined && orgIdRaw.length > 0 && { orgId: orgIdRaw as OrgId }),
      ...(nameContainsRaw !== undefined &&
        nameContainsRaw.length > 0 && { nameContains: nameContainsRaw }),
    });
    // Authorization list-filter — strip projects the caller can't read.
    const visible =
      authorizer !== undefined
        ? await authorizer.filterByCan(c, 'read', page.items, (p) =>
            ref('project', p.id as unknown as string),
          )
        : [...page.items];
    return c.json({
      data: visible.map(serializeProject),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- Authorization middleware ----------
  // Full PEP surface for projects + memberships:
  //   POST /                                     → admin on tenant
  //   GET /:projectId                            → read on project
  //   PATCH /:projectId                          → admin on project
  //   DELETE /:projectId                         → delete on project
  //   GET /:projectId/memberships[/:userId]      → read on project
  //   other /:projectId/memberships[/:userId]    → admin on project
  //   GET /                                       → list-filter by can_read
  if (authorizer !== undefined) {
    r.use('/', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const mw = authorizer.authorize('admin', (ctx) =>
        ref('tenant', ctx.get('tenantId') as unknown as string),
      );
      return mw(c, next);
    });
    r.use('/:projectId', async (c, next) => {
      const method = c.req.method;
      if (method !== 'GET' && method !== 'PATCH' && method !== 'DELETE') return next();
      const projectId = c.req.param('projectId');
      const action = method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : 'admin';
      const mw = authorizer.authorize(action, () => ref('project', projectId));
      return mw(c, next);
    });
    // Membership routes: reads require read, mutations admin on the project.
    // Who's in a project is for its editors and admins: a viewer reads
    // their own roles through their grants, not the other people here.
    r.use('/:projectId/memberships', async (c, next) => {
      const projectId = c.req.param('projectId');
      const action = c.req.method === 'GET' ? 'write' : 'admin';
      const mw = authorizer.authorize(action, () => ref('project', projectId));
      return mw(c, next);
    });
    r.use('/:projectId/memberships/:userId', async (c, next) => {
      const projectId = c.req.param('projectId');
      const action = c.req.method === 'GET' ? 'write' : 'admin';
      const mw = authorizer.authorize(action, () => ref('project', projectId));
      return mw(c, next);
    });
  }
  r.post('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const b = body as Record<string, unknown>;
    if (typeof b.name !== 'string' || b.name.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`name` is required and must be a non-empty string' },
          requestId,
        ),
      );
    }
    if (typeof b.slug !== 'string' || b.slug.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`slug` is required and must be a non-empty string' },
          requestId,
        ),
      );
    }
    if (b.description !== undefined && typeof b.description !== 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`description` must be a string when present' },
          requestId,
        ),
      );
    }
    if (b.orgId !== undefined && typeof b.orgId !== 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`orgId` must be a string when present' },
          requestId,
        ),
      );
    }
    if (b.isDefault !== undefined && typeof b.isDefault !== 'boolean') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`isDefault` must be a boolean when present' },
          requestId,
        ),
      );
    }
    const spec: ProjectSpec = {
      name: b.name,
      slug: b.slug,
      ...(b.description !== undefined && { description: b.description as string }),
      ...(b.orgId !== undefined && { orgId: b.orgId as unknown as OrgId }),
      ...(b.isDefault !== undefined && { isDefault: b.isDefault as boolean }),
    };
    // With an authorizer, create through the tenant-hierarchy binding —
    // it writes FGA tuples atomically. The tuples are what makes downstream
    // authz (member add, tenant-admin cascade to project) actually work.
    if (authorizer !== undefined) {
      const principal = c.get('principal') as Principal | undefined;
      const creatorUserId =
        principal?.actor.kind === 'user'
          ? (principal.actor.id as UserId)
          : ('00000000-0000-0000-0000-000000000000' as UserId);
      const result = await tenantHierarchy.createProject({ tenantId, creatorUserId, spec });
      if (result.kind === 'err') {
        const error =
          result.error.code === 'slug-conflict'
            ? slugConflictError('project', spec.slug)
            : result.error.code === 'org-not-found'
              ? orgNotFoundError(result.error.orgId as unknown as string)
              : result.error.code === 'default-conflict'
                ? projectDefaultAlreadyExistsError()
                : { code: 'internal-server-error', message: result.error.message };
        c.status(statusFor(error.code) as never);
        return c.json(toWireError(error, requestId));
      }
      c.status(201);
      return c.json({ id: result.value.projectId as unknown as string });
    }
    // No authorizer configured — fall back to the raw binding create;
    // no FGA tuples written.
    const outcome = await binding.create(tenantId, spec);
    if (outcome.kind !== 'ok') {
      const error =
        outcome.kind === 'slug-conflict'
          ? slugConflictError('project', outcome.slug)
          : outcome.kind === 'org-not-found'
            ? orgNotFoundError(outcome.orgId as unknown as string)
            : projectDefaultAlreadyExistsError();
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    c.status(201);
    return c.json({ id: outcome.projectId as unknown as string });
  });

  // ---------- GET /:projectId/memberships ----------
  // Mount BEFORE /:projectId so `memberships` is not swallowed by the
  // param.
  r.get('/:projectId/memberships', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    const project = await binding.get(tenantId, projectId);
    if (project === undefined) {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `No project with id "${projectId as unknown as string}"`,
            projectId: projectId as unknown as string,
          },
          requestId,
        ),
      );
    }
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const page = await membershipBinding.list(tenantId, projectId, {
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.items.map(serializeProjectMembership),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /:projectId/memberships ----------
  r.post('/:projectId/memberships', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    const project = await binding.get(tenantId, projectId);
    if (project === undefined) {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `No project with id "${projectId as unknown as string}"`,
            projectId: projectId as unknown as string,
          },
          requestId,
        ),
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const b = body as Record<string, unknown>;
    const named = parseMemberName(b);
    if (typeof named === 'string') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: named }, requestId));
    }
    const role = parseAssignableProjectRole(b.role, '`role`');
    if (role.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: role.message }, requestId));
    }
    const resolved = await resolveMember(tenantId, named);
    if (resolved.kind === 'refused') {
      c.status(statusFor(resolved.error.code) as never);
      return c.json(toWireError(resolved.error, requestId));
    }
    const userId = resolved.userId;
    // Racy — the project can be deleted between the preliminary get and the add.
    const exists = (role: string) => {
      c.status(statusFor('membership-exists') as never);
      return c.json(toWireError(membershipExistsError(role), requestId));
    };
    const projectGone = () => {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `No project with id "${projectId as unknown as string}"`,
            projectId: projectId as unknown as string,
          },
          requestId,
        ),
      );
    };
    // With an authorizer, add through the tenant-hierarchy binding — it
    // writes the FGA `<role>@project` tuple atomically so the granted
    // user's permissions land in FGA.
    if (authorizer !== undefined) {
      const res = await tenantHierarchy.addProjectMember({
        tenantId,
        projectId,
        userId,
        role: role.value,
      });
      if (res.kind === 'err') {
        if (res.error.code === 'project-not-found') return projectGone();
        if (res.error.code === 'membership-exists') return exists(res.error.role);
        throw new Error(res.error.message, { cause: res.error });
      }
    } else {
      const outcome = await membershipBinding.add(tenantId, {
        projectId,
        userId,
        role: role.value,
      });
      if (outcome.kind === 'project-not-found') return projectGone();
      if (outcome.kind === 'membership-exists') return exists(outcome.role);
    }
    c.status(201);
    return c.json({
      projectId: projectId as unknown as string,
      userId: userId as unknown as string,
      role: role.value,
    });
  });

  // ---------- DELETE /:projectId/memberships/:userId ----------
  r.delete('/:projectId/memberships/:userId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const userId = c.req.param('userId') as UserId;
    // With an authorizer, the row and its FGA tuple go together, or not
    // at all: removing the row alone would leave the permission in place.
    if (authorizer !== undefined) {
      if (tenantHierarchy.removeProjectMember === undefined) {
        const refusal = membershipNotKeptInStepError('removeProjectMember');
        c.status(statusFor(refusal.code) as never);
        return c.json(toWireError(refusal, c.get('requestId')));
      }
      const res = await tenantHierarchy.removeProjectMember({ tenantId, projectId, userId });
      if (res.kind === 'err') throw new Error(res.error.message, { cause: res.error });
    } else {
      await membershipBinding.remove(tenantId, projectId, userId);
    }
    c.status(204);
    return c.body(null);
  });

  // ---------- PATCH /:projectId/memberships/:userId ----------
  r.patch('/:projectId/memberships/:userId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const userId = c.req.param('userId') as UserId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const b = body as Record<string, unknown>;
    const role = parseAssignableProjectRole(b.role, '`role`');
    if (role.kind === 'err') {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message: role.message }, requestId));
    }
    const updated = await updateMemberRole(tenantId, projectId, userId, role.value);
    if (updated.kind === 'refused') {
      c.status(statusFor(updated.error.code) as never);
      return c.json(toWireError(updated.error, requestId));
    }
    const { outcome } = updated;
    if (outcome.kind === 'project-membership-not-found') {
      c.status(statusFor('project-membership-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-membership-not-found',
            message: `No membership for project "${projectId as unknown as string}" + user "${userId as unknown as string}"`,
            projectId: projectId as unknown as string,
            userId: userId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'project-not-found') {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `No project with id "${projectId as unknown as string}"`,
            projectId: projectId as unknown as string,
          },
          requestId,
        ),
      );
    }
    c.status(204);
    return c.body(null);
  });

  // ---------- GET /:projectId ----------
  r.get('/:projectId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    const project = await binding.get(tenantId, projectId);
    if (project === undefined) {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `No project with id "${projectId as unknown as string}"`,
            projectId: projectId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeProject(project));
  });

  // ---------- PATCH /:projectId ----------
  r.patch('/:projectId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be valid JSON' }, requestId),
      );
    }
    if (body === null || typeof body !== 'object') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: 'Request body must be an object' }, requestId),
      );
    }
    const b = body as Record<string, unknown>;
    const shaped: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`name` must be a string when present' },
            requestId,
          ),
        );
      }
      shaped.name = b.name;
    }
    if (b.slug !== undefined) {
      if (typeof b.slug !== 'string') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`slug` must be a string when present' },
            requestId,
          ),
        );
      }
      shaped.slug = b.slug;
    }
    if (b.description !== undefined) {
      if (typeof b.description !== 'string') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`description` must be a string when present' },
            requestId,
          ),
        );
      }
      shaped.description = b.description;
    }
    if ('orgId' in b) {
      const raw = b.orgId;
      if (raw === null) {
        shaped.orgId = null;
      } else if (typeof raw === 'string') {
        shaped.orgId = raw as unknown as OrgId;
      } else {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: '`orgId` must be a string or null when present' },
            requestId,
          ),
        );
      }
    }
    const outcome = await binding.update(tenantId, projectId, shaped);
    if (outcome.kind === 'project-not-found') {
      c.status(statusFor('project-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'project-not-found',
            message: `No project with id "${projectId as unknown as string}"`,
            projectId: projectId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'slug-conflict' || outcome.kind === 'org-not-found') {
      const error =
        outcome.kind === 'slug-conflict'
          ? slugConflictError('project', outcome.slug)
          : orgNotFoundError(outcome.orgId as unknown as string);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    c.status(204);
    return c.body(null);
  });

  // ---------- DELETE /:projectId ----------
  r.delete('/:projectId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    await binding.delete(tenantId, projectId);
    c.status(204);
    return c.body(null);
  });

  return r;
}

/** Who a new member is: exactly one of `userId` and `email`. */
type MemberName = { readonly userId: UserId } | { readonly email: string };

/** A new member's `userId` or `email` (exactly one), or why not. */
function parseMemberName(b: Record<string, unknown>): MemberName | string {
  const hasId = b.userId !== undefined;
  const hasEmail = b.email !== undefined;
  if (hasId === hasEmail) return 'Give exactly one of `userId` and `email`';
  if (hasId) {
    if (typeof b.userId !== 'string' || b.userId.length === 0) {
      return '`userId` must be a non-empty string';
    }
    return { userId: b.userId as UserId };
  }
  if (typeof b.email !== 'string' || b.email.trim().length === 0) {
    return '`email` must be a non-empty string';
  }
  return { email: b.email.trim() };
}

function serializeProject(p: Project): Record<string, unknown> {
  return {
    id: p.id as unknown as string,
    tenantId: p.tenantId as unknown as string,
    ...(p.orgId !== undefined && { orgId: p.orgId as unknown as string }),
    name: p.name,
    slug: p.slug,
    isDefault: p.isDefault,
    ...(p.description !== undefined && { description: p.description }),
    createdAt: p.createdAt as unknown as string,
    updatedAt: p.updatedAt as unknown as string,
  };
}

function serializeProjectMembership(m: ProjectMembership): Record<string, unknown> {
  return {
    projectId: m.projectId as unknown as string,
    userId: m.userId as unknown as string,
    role: m.role,
    joinedAt: m.joinedAt as unknown as string,
  };
}
