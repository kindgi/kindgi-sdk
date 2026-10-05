// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import { type Principal, ref } from '@kindgi/authz';
import type { OrgBinding, TenantHierarchyBinding } from '@kindgi/platform';
import type { Org, OrgPatch, OrgSpec } from '@kindgi/platform';
import type { Cursor, OrgId, TenantId, UserId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { slugConflictError } from './hierarchy-errors.js';
import { clampLimit } from './pagination.js';

/**
 * Orgs resource routes — part of the multi-tenant hierarchy.
 *
 * Five endpoints on `/v1/orgs`:
 *   - `GET    /`                — cursor-paginated list; optional
 *                                 `?limit=` / `?cursor=` / `?nameContains=`.
 *   - `POST   /`                — create; body `{ name, slug }`; 201 `{ id }`;
 *                                 409 `slug-conflict` when the tenant has
 *                                 an org with that slug.
 *   - `GET    /:orgId`          — 200 `Org`; 404 `org-not-found`.
 *   - `PATCH  /:orgId`          — partial update via `OrgPatch`; 204 on
 *                                 success; 404 `org-not-found`; 409
 *                                 `slug-conflict`.
 *   - `DELETE /:orgId`          — 204 idempotent (unknown is 204 per the
 *                                 binding's delete-is-a-no-op contract).
 *
 * Registry storage is caller-plugged via `OrgBinding` from
 * `@kindgi/platform`. Tenant isolation is a binding guardrail — the
 * route never sees a cross-tenant row because the binding filters at the
 * query layer.
 */
export function orgsRouter(
  binding: OrgBinding,
  tenantHierarchy: TenantHierarchyBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // ---------- Authorization middleware ----------
  // Full PEP surface:
  //   POST /            → admin on tenant
  //   PATCH /:orgId     → admin on the org
  //   DELETE /:orgId    → admin on the org
  //   GET /:orgId       → read on the org (per-resource check)
  //   GET /             → tenant-scoped fetch + filterByCan('read') strip
  if (authorizer !== undefined) {
    r.use('/', async (c, next) => {
      if (c.req.method !== 'POST') return next();
      const mw = authorizer.authorize('admin', (ctx) =>
        ref('tenant', ctx.get('tenantId') as unknown as string),
      );
      return mw(c, next);
    });
    r.use('/:orgId', async (c, next) => {
      const method = c.req.method;
      if (method !== 'PATCH' && method !== 'DELETE' && method !== 'GET') return next();
      const orgId = c.req.param('orgId');
      const action = method === 'GET' ? 'read' : method === 'DELETE' ? 'admin' : 'admin';
      const mw = authorizer.authorize(action, () => ref('org', orgId));
      return mw(c, next);
    });
  }

  // ---------- GET / (list, cursor-paginated + filtered) ----------
  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursorRaw = c.req.query('cursor');
    const nameContainsRaw = c.req.query('nameContains');
    const page = await binding.list(tenantId, {
      limit,
      ...(cursorRaw !== undefined && cursorRaw.length > 0 && { cursor: cursorRaw as Cursor }),
      ...(nameContainsRaw !== undefined &&
        nameContainsRaw.length > 0 && { nameContains: nameContainsRaw }),
    });
    // Authorization list-filter — strip orgs the caller can't read.
    const visible =
      authorizer !== undefined
        ? await authorizer.filterByCan(c, 'read', page.items, (o) =>
            ref('org', o.id as unknown as string),
          )
        : [...page.items];
    return c.json({
      data: visible.map(serializeOrg),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  // ---------- POST / (create) ----------
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
    const spec: OrgSpec = { name: b.name, slug: b.slug };
    // Create through the tenant-hierarchy binding only when authz is
    // configured — it enqueues FGA tuples that only matter when a PDP is
    // enforcing. Wiring without an authorizer (e.g. tests) falls back to
    // `binding.create`, so test doubles don't need a real database.
    if (authorizer !== undefined) {
      const principal = c.get('principal') as Principal | undefined;
      const creatorUserId =
        principal?.actor.kind === 'user'
          ? (principal.actor.id as UserId)
          : ('00000000-0000-0000-0000-000000000000' as UserId);
      const result = await tenantHierarchy.createOrg({ tenantId, creatorUserId, spec });
      if (result.kind === 'err') {
        const error =
          result.error.code === 'slug-conflict'
            ? slugConflictError('org', spec.slug)
            : { code: 'internal-server-error', message: result.error.message };
        c.status(statusFor(error.code) as never);
        return c.json(toWireError(error, requestId));
      }
      c.status(201);
      return c.json({ id: result.value.orgId as unknown as string });
    }
    const outcome = await binding.create(tenantId, spec);
    if (outcome.kind === 'slug-conflict') {
      const error = slugConflictError('org', outcome.slug);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    c.status(201);
    return c.json({ id: outcome.orgId as unknown as string });
  });

  // ---------- GET /:orgId ----------
  r.get('/:orgId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const orgId = c.req.param('orgId') as OrgId;

    const org = await binding.get(tenantId, orgId);
    if (org === undefined) {
      c.status(statusFor('org-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'org-not-found',
            message: `No org with id "${orgId as unknown as string}"`,
            orgId: orgId as unknown as string,
          },
          requestId,
        ),
      );
    }
    return c.json(serializeOrg(org));
  });

  // ---------- PATCH /:orgId ----------
  r.patch('/:orgId', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const orgId = c.req.param('orgId') as OrgId;

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
    const shaped: { -readonly [K in keyof OrgPatch]: OrgPatch[K] } = {};
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

    const outcome = await binding.update(tenantId, orgId, shaped);
    if (outcome.kind === 'org-not-found') {
      c.status(statusFor('org-not-found') as never);
      return c.json(
        toWireError(
          {
            code: 'org-not-found',
            message: `No org with id "${orgId as unknown as string}"`,
            orgId: orgId as unknown as string,
          },
          requestId,
        ),
      );
    }
    if (outcome.kind === 'slug-conflict') {
      const error = slugConflictError('org', outcome.slug);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    c.status(204);
    return c.body(null);
  });

  // ---------- DELETE /:orgId ----------
  r.delete('/:orgId', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const orgId = c.req.param('orgId') as OrgId;
    await binding.delete(tenantId, orgId);
    c.status(204);
    return c.body(null);
  });

  return r;
}

function serializeOrg(o: Org): Record<string, unknown> {
  return {
    id: o.id as unknown as string,
    tenantId: o.tenantId as unknown as string,
    name: o.name,
    slug: o.slug,
    createdAt: o.createdAt as unknown as string,
    updatedAt: o.updatedAt as unknown as string,
  };
}
