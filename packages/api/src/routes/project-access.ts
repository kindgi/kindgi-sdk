// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { ref } from '@kindgi/authz';
import type { ProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type {
  ProjectAccessBinding,
  ProjectAccessHolder,
  ProjectAccessPath,
} from '../project-access-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/** A project role's rank: owner first. */
const RANK: Readonly<Record<string, number>> = { owner: 0, admin: 1, editor: 2, viewer: 3 };
const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
type AccessRole = (typeof ROLES)[number];

const rank = (role: AccessRole) => RANK[role] ?? ROLES.length;

/** Each path's kind, in the order a person's ways in are listed among equal roles. */
const KIND_ORDER: Readonly<Record<ProjectAccessPath['kind'], number>> = {
  direct: 0,
  team: 1,
  'org-admin': 2,
  'tenant-admin': 3,
};

/** The role a path gives on the project: an org's or the tenant's admins are its admins. */
function roleOf(path: ProjectAccessPath): AccessRole {
  if (path.kind === 'org-admin' || path.kind === 'tenant-admin') return 'admin';
  // `member`, retired, grants what `viewer` does.
  return path.role === 'member' ? 'viewer' : path.role;
}

const pathKey = (p: ProjectAccessPath) =>
  p.kind === 'team' ? p.teamId : p.kind === 'org-admin' ? p.orgId : '';

/** Where an entry sorts: its role (owner first), its name (unnamed last), then its id. */
type Position = readonly [number, string, string, string];

/**
 * `GET /v1/projects/:projectId/access`: everyone with access to the project
 * and how, for its editors and admins (`write`): a viewer sees the project,
 * not who else works in it. Emails show to the project's admins only.
 */
export function projectAccessRouter(deps: {
  readonly projects: ProjectBinding;
  readonly access?: ProjectAccessBinding;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { projects, access, authorizer } = deps;
  const r = new Hono<AppEnv>();
  if (authorizer !== undefined) {
    r.use('/:projectId/access', async (c, next) =>
      authorizer.authorize('write', () => ref('project', c.req.param('projectId')))(c, next),
    );
  }

  r.get('/:projectId/access', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const projectId = c.req.param('projectId') as ProjectId;
    if (access === undefined) {
      c.status(statusFor('project-access-unsupported') as never);
      return c.json(
        toWireError(
          {
            code: 'project-access-unsupported',
            message:
              "This runtime doesn't say who has access to a project: it runs without an authorization store",
          },
          c.get('requestId'),
        ),
      );
    }
    const after = parseCursor(c.req.query('cursor'));
    if (after === 'bad') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: "`cursor` isn't one this list gave" },
          c.get('requestId'),
        ),
      );
    }
    const project = await projects.get(tenantId, projectId);
    const holders = project === undefined ? null : await access.list({ tenantId, projectId });
    if (holders === null) return projectNotFound(c, projectId);

    const showEmails =
      authorizer === undefined ||
      (await authorizer.can(c, 'admin', ref('project', projectId as unknown as string)));
    const entries = holders
      .filter((h) => h.via.length > 0)
      .map((h) => entry(h, showEmails))
      .sort((a, b) => compare(a.position, b.position));
    const from = after === undefined ? 0 : entries.findIndex((e) => compare(e.position, after) > 0);
    const limit = clampLimit(c.req.query('limit'));
    const page = from < 0 ? [] : entries.slice(from, from + limit);
    const last = page[page.length - 1];
    const hasMore = from >= 0 && from + limit < entries.length;
    return c.json({
      data: page.map((e) => e.wire),
      hasMore,
      ...(hasMore && last !== undefined && { nextCursor: encode(last.position) }),
    });
  });
  return r;
}

function entry(
  h: ProjectAccessHolder,
  showEmails: boolean,
): { readonly position: Position; readonly wire: Record<string, unknown> } {
  const via = [...h.via].sort(
    (a, b) =>
      rank(roleOf(a)) - rank(roleOf(b)) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      pathKey(a).localeCompare(pathKey(b)),
  );
  const role = roleOf(via[0] as ProjectAccessPath);
  return {
    position: [
      rank(role),
      h.displayName === undefined ? '￿' : h.displayName.toLowerCase(),
      h.principal.kind,
      h.principal.id,
    ],
    wire: {
      principal: { kind: h.principal.kind, id: h.principal.id },
      ...(h.displayName !== undefined && { displayName: h.displayName }),
      ...(showEmails && h.primaryEmail !== undefined && { primaryEmail: h.primaryEmail }),
      role,
      via: via.map(wirePath),
    },
  };
}

function wirePath(p: ProjectAccessPath): Record<string, unknown> {
  switch (p.kind) {
    case 'direct':
      return {
        kind: 'direct',
        role: p.role,
        ...(p.joinedAt !== undefined && { joinedAt: p.joinedAt }),
      };
    case 'team':
      return {
        kind: 'team',
        teamId: p.teamId,
        ...(p.teamName !== undefined && { teamName: p.teamName }),
        role: p.role,
      };
    case 'org-admin':
      return {
        kind: 'org-admin',
        orgId: p.orgId,
        ...(p.orgName !== undefined && { orgName: p.orgName }),
      };
    case 'tenant-admin':
      return { kind: 'tenant-admin' };
  }
}

function compare(a: Position, b: Position): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number | string;
    const y = b[i] as number | string;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

const encode = (p: Position) => Buffer.from(JSON.stringify(p)).toString('base64url');

function parseCursor(raw: string | undefined): Position | undefined | 'bad' {
  if (raw === undefined || raw === '') return undefined;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(p) &&
      p.length === 4 &&
      typeof p[0] === 'number' &&
      p.slice(1).every((x) => typeof x === 'string')
    ) {
      return p as unknown as Position;
    }
  } catch {
    // not one this list gave
  }
  return 'bad';
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
