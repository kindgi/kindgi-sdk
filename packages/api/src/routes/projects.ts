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
  ProjectPatch,
  ProjectRole,
  ProjectSpec,
} from '@kindgi/platform';
import type { Cursor, OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/**
 * Projects resource routes — part of the multi-tenant hierarchy.
 *
 * Ten endpoints on `/v1/projects`:
 *   - `GET    /`                         — cursor-paginated list;
 *                                          `?limit=` / `?cursor=` / `?orgId=` /
 *                                          `?nameContains=`.
 *   - `POST   /`                         — create; body `{ name, slug,
 *                                          orgId?, description?, isDefault? }`;
 *                                          201 `{ id }`.
 *   - `GET    /default`                  — returns the tenant's Default
 *                                          project or 404 `project-not-found`.
 *                                          MUST be mounted BEFORE `/:projectId`.
 *   - `GET    /:projectId`               — get; 200 or 404 `project-not-found`.
 *   - `PATCH  /:projectId`               — partial update; 204 or 404.
 *   - `DELETE /:projectId`               — 204 idempotent.
 *   - `GET    /:projectId/memberships`   — list; cursor-paginated.
 *   - `POST   /:projectId/memberships`   — add member; body `{ userId, role }`;
 *                                          201. Idempotent per binding contract.
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
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- GET /default (literal segment; must precede /:projectId) ----------
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
    r.use('/:projectId/memberships', async (c, next) => {
      const projectId = c.req.param('projectId');
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const mw = authorizer.authorize(action, () => ref('project', projectId));
      return mw(c, next);
    });
    r.use('/:projectId/memberships/:userId', async (c, next) => {
      const projectId = c.req.param('projectId');
      const action = c.req.method === 'GET' ? 'read' : 'admin';
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
        const code =
          result.error.code === 'slug-conflict'
            ? 'slug-conflict'
            : result.error.code === 'default-conflict'
              ? 'project-default-already-exists'
              : 'internal-server-error';
        c.status(statusFor(code) as never);
        return c.json(toWireError({ code, message: result.error.message }, requestId));
      }
      c.status(201);
      return c.json({ id: result.value.projectId as unknown as string });
    }
    // No authorizer configured — fall back to the raw binding create;
    // no FGA tuples written.
    const id = await binding.create(tenantId, spec);
    c.status(201);
    return c.json({ id: id as unknown as string });
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
    if (typeof b.userId !== 'string' || b.userId.length === 0) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`userId` is required and must be a non-empty string' },
          requestId,
        ),
      );
    }
    if (!isProjectRole(b.role)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`role` must be one of: viewer, editor, owner, admin, member',
          },
          requestId,
        ),
      );
    }
    try {
      // With an authorizer, add through the tenant-hierarchy binding — it
      // writes the FGA `<role>@project` tuple atomically so the granted
      // user's permissions land in FGA.
      if (authorizer !== undefined) {
        const res = await tenantHierarchy.addProjectMember({
          tenantId,
          projectId,
          userId: b.userId as unknown as UserId,
          role: b.role as ProjectRole,
        });
        if (res.kind === 'err') throw new Error(res.error.message);
      } else {
        await membershipBinding.add(tenantId, {
          projectId,
          userId: b.userId as unknown as UserId,
          role: b.role,
        });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith('project-not-found')) {
        // Racy — project was deleted between preliminary get and add.
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
      throw cause;
    }
    c.status(201);
    return c.json({
      projectId: projectId as unknown as string,
      userId: b.userId,
      role: b.role,
    });
  });

  // ---------- DELETE /:projectId/memberships/:userId ----------
  r.delete('/:projectId/memberships/:userId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    const userId = c.req.param('userId') as UserId;
    await membershipBinding.remove(tenantId, projectId, userId);
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
    if (!isProjectRole(b.role)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`role` must be one of: viewer, editor, owner, admin, member',
          },
          requestId,
        ),
      );
    }
    try {
      await membershipBinding.updateRole(tenantId, projectId, userId, b.role);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith('project-membership-not-found')) {
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
      if (message.startsWith('project-not-found')) {
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
      throw cause;
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
    try {
      await binding.update(tenantId, projectId, shaped);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith('project-not-found')) {
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
      throw cause;
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

function isProjectRole(x: unknown): x is 'viewer' | 'editor' | 'owner' | 'admin' | 'member' {
  return x === 'viewer' || x === 'editor' || x === 'owner' || x === 'admin' || x === 'member';
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
