// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref } from '@kindgi/authz';
import type { TenantHierarchyBinding } from '@kindgi/platform';
import type {
  Team,
  TeamBinding,
  TeamMembership,
  TeamMembershipBinding,
  TeamPatch,
  TeamRole,
  TeamSpec,
} from '@kindgi/platform';
import type { Cursor, OrgId, TeamId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { slugConflictError } from './hierarchy-errors.js';
import { clampLimit } from './pagination.js';

/**
 * Teams resource routes — part of the multi-tenant hierarchy.
 *
 * Nine endpoints on `/v1/teams`:
 *   - `GET    /`                        — cursor-paginated list;
 *                                         `?limit=` / `?cursor=` / `?orgId=` /
 *                                         `?nameContains=`.
 *   - `POST   /`                        — create; body `{ name, slug,
 *                                         description?, orgId? }`; 201 `{ id }`;
 *                                         409 `slug-conflict` when the tenant
 *                                         has a team with that slug.
 *   - `GET    /:teamId`                 — get; 200 or 404 `team-not-found`.
 *   - `PATCH  /:teamId`                 — partial update; 204, 404
 *                                         `team-not-found` or 409
 *                                         `slug-conflict`.
 *   - `DELETE /:teamId`                 — 204 idempotent.
 *   - `GET    /:teamId/memberships`     — list; cursor-paginated.
 *   - `POST   /:teamId/memberships`     — add member; body `{ userId, role }`;
 *                                         201. Idempotent — adding an existing
 *                                         member with a differing role is a
 *                                         no-op per the binding contract.
 *   - `DELETE /:teamId/memberships/:userId`
 *                                       — 204 idempotent.
 *   - `PATCH  /:teamId/memberships/:userId`
 *                                       — updateRole via `{ role }`; 204 or
 *                                         404 `team-membership-not-found`.
 */
export function teamsRouter(
  binding: TeamBinding,
  membershipBinding: TeamMembershipBinding,
  tenantHierarchy: TenantHierarchyBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- Authorization middleware ----------
  // Full PEP surface:
  //   POST /                                    → admin on tenant
  //   GET  /:teamId                              → read on team
  //   PATCH /:teamId, DELETE /:teamId           → admin on team
  //   *    /:teamId/memberships                  → GET: read; else admin
  //   *    /:teamId/memberships/:userId          → same
  //   GET  /                                     → list-filter by can_read
  //
  // Note: POST / checks `admin on tenant` even when the body carries an
  // orgId — a strictly stronger gate than `admin on org:$spec.orgId`
  // (tenant admins can do anything an org admin can).
  if (authorizer !== undefined) {
    r.use('/', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const mw = authorizer.authorize('admin', (ctx) =>
        ref('tenant', ctx.get('tenantId') as unknown as string),
      );
      return mw(c, next);
    });
    r.use('/:teamId', async (c, next) => {
      const method = c.req.method;
      if (method !== 'GET' && method !== 'PATCH' && method !== 'DELETE') return next();
      const teamId = c.req.param('teamId');
      const action = method === 'GET' ? 'read' : 'admin';
      const mw = authorizer.authorize(action, () => ref('team', teamId));
      return mw(c, next);
    });
    r.use('/:teamId/memberships', async (c, next) => {
      const teamId = c.req.param('teamId');
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const mw = authorizer.authorize(action, () => ref('team', teamId));
      return mw(c, next);
    });
    r.use('/:teamId/memberships/:userId', async (c, next) => {
      const teamId = c.req.param('teamId');
      const action = c.req.method === 'GET' ? 'read' : 'admin';
      const mw = authorizer.authorize(action, () => ref('team', teamId));
      return mw(c, next);
    });
  }

  // ---------- GET / ----------
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
    // Authorization list-filter — strip teams the caller can't read.
    const visible =
      authorizer !== undefined
        ? await authorizer.filterByCan(c, 'read', page.items, (t) =>
            ref('team', t.id as unknown as string),
          )
        : [...page.items];
    return c.json({
      data: visible.map(serializeTeam),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST / ----------
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
    const spec: TeamSpec = {
      name: b.name,
      slug: b.slug,
      ...(b.description !== undefined && { description: b.description as string }),
      ...(b.orgId !== undefined && { orgId: b.orgId as unknown as OrgId }),
    };
    if (authorizer !== undefined) {
      const principal = c.get('principal') as Principal | undefined;
      const creatorUserId =
        principal?.actor.kind === 'user'
          ? (principal.actor.id as UserId)
          : ('00000000-0000-0000-0000-000000000000' as UserId);
      const result = await tenantHierarchy.createTeam({ tenantId, creatorUserId, spec });
      if (result.kind === 'err') {
        const error =
          result.error.code === 'slug-conflict'
            ? slugConflictError('team', spec.slug)
            : { code: 'internal-server-error', message: result.error.message };
        c.status(statusFor(error.code) as never);
        return c.json(toWireError(error, requestId));
      }
      c.status(201);
      return c.json({ id: result.value.teamId as unknown as string });
    }
    const outcome = await binding.create(tenantId, spec);
    if (outcome.kind === 'slug-conflict') {
      const error = slugConflictError('team', outcome.slug);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    c.status(201);
    return c.json({ id: outcome.teamId as unknown as string });
  });

  // ---------- GET /:teamId/memberships ----------
  // Mount BEFORE /:teamId so the `memberships` segment is not consumed by
  // the `:teamId` param on the parent route table.
  r.get('/:teamId/memberships', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;

    // Preliminary get flips unknown teamId to a 404 so an empty list from
    // the membership binding is unambiguous.
    const team = await binding.get(tenantId, teamId);
    if (team === undefined) {
      c.status(statusFor('team-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-not-found',
            message: `No team with id "${teamId as unknown as string}"`,
            teamId: teamId as unknown as string,
          },
          requestId,
        ),
      );
    }
    const limit = clampLimit(c.req.query('limit'));
    const cursorRaw = c.req.query('cursor');
    const page = await membershipBinding.list(tenantId, teamId, {
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
    });
    return c.json({
      data: page.items.map(serializeTeamMembership),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST /:teamId/memberships ----------
  r.post('/:teamId/memberships', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;

    const team = await binding.get(tenantId, teamId);
    if (team === undefined) {
      c.status(statusFor('team-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-not-found',
            message: `No team with id "${teamId as unknown as string}"`,
            teamId: teamId as unknown as string,
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
    if (!isTeamRole(b.role)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`role` must be one of: member, admin',
          },
          requestId,
        ),
      );
    }
    // Racy — the team can be deleted between the preliminary get and the add.
    const teamGone = () => {
      c.status(statusFor('team-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-not-found',
            message: `No team with id "${teamId as unknown as string}"`,
            teamId: teamId as unknown as string,
          },
          requestId,
        ),
      );
    };
    if (authorizer !== undefined) {
      const res = await tenantHierarchy.addTeamMember({
        tenantId,
        teamId,
        userId: b.userId as unknown as UserId,
        role: b.role as TeamRole,
      });
      if (res.kind === 'err') {
        if (res.error.code === 'team-not-found') return teamGone();
        throw new Error(res.error.message, { cause: res.error });
      }
    } else {
      const outcome = await membershipBinding.add(tenantId, {
        teamId,
        userId: b.userId as unknown as UserId,
        role: b.role,
      });
      if (outcome.kind === 'team-not-found') return teamGone();
    }
    c.status(201);
    return c.json({
      teamId: teamId as unknown as string,
      userId: b.userId,
      role: b.role,
    });
  });

  // ---------- DELETE /:teamId/memberships/:userId ----------
  r.delete('/:teamId/memberships/:userId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;
    const userId = c.req.param('userId') as UserId;
    await membershipBinding.remove(tenantId, teamId, userId);
    c.status(204);
    return c.body(null);
  });

  // ---------- PATCH /:teamId/memberships/:userId ----------
  r.patch('/:teamId/memberships/:userId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;
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
    if (!isTeamRole(b.role)) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          {
            code: 'bad-input',
            message: '`role` must be one of: member, admin',
          },
          requestId,
        ),
      );
    }
    const outcome = await membershipBinding.updateRole(tenantId, teamId, userId, b.role);
    if (outcome.kind === 'team-membership-not-found') {
      c.status(statusFor('team-membership-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-membership-not-found',
            message: `No membership for team "${teamId as unknown as string}" + user "${userId as unknown as string}"`,
            teamId: teamId as unknown as string,
            userId: userId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'team-not-found') {
      c.status(statusFor('team-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-not-found',
            message: `No team with id "${teamId as unknown as string}"`,
            teamId: teamId as unknown as string,
          },
          requestId,
        ),
      );
    }
    c.status(204);
    return c.body(null);
  });

  // ---------- GET /:teamId ----------
  r.get('/:teamId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;

    const team = await binding.get(tenantId, teamId);
    if (team === undefined) {
      c.status(statusFor('team-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-not-found',
            message: `No team with id "${teamId as unknown as string}"`,
            teamId: teamId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeTeam(team));
  });

  // ---------- PATCH /:teamId ----------
  r.patch('/:teamId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;

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
    const shaped: { -readonly [K in keyof TeamPatch]: TeamPatch[K] } = {};
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
    const outcome = await binding.update(tenantId, teamId, shaped);
    if (outcome.kind === 'team-not-found') {
      c.status(statusFor('team-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'team-not-found',
            message: `No team with id "${teamId as unknown as string}"`,
            teamId: teamId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'slug-conflict') {
      const error = slugConflictError('team', outcome.slug);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    c.status(204);
    return c.body(null);
  });

  // ---------- DELETE /:teamId ----------
  r.delete('/:teamId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const teamId = c.req.param('teamId') as TeamId;
    await binding.delete(tenantId, teamId);
    c.status(204);
    return c.body(null);
  });

  return r;
}

function isTeamRole(x: unknown): x is 'member' | 'admin' {
  return x === 'member' || x === 'admin';
}

function serializeTeam(t: Team): Record<string, unknown> {
  return {
    id: t.id as unknown as string,
    tenantId: t.tenantId as unknown as string,
    ...(t.orgId !== undefined && { orgId: t.orgId as unknown as string }),
    name: t.name,
    slug: t.slug,
    ...(t.description !== undefined && { description: t.description }),
    createdAt: t.createdAt as unknown as string,
    updatedAt: t.updatedAt as unknown as string,
  };
}

function serializeTeamMembership(m: TeamMembership): Record<string, unknown> {
  return {
    teamId: m.teamId as unknown as string,
    userId: m.userId as unknown as string,
    role: m.role,
    joinedAt: m.joinedAt as unknown as string,
  };
}
