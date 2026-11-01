// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import { type Principal, ref } from '@kindgi/authz';
import type { OrgBinding, TenantHierarchyBinding } from '@kindgi/platform';
import type { Org, OrgPatch, OrgSpec } from '@kindgi/platform';
import type { Cursor, OrgId, TenantId, UserId } from '@kindgi/types';

import { NAME_MAX, boundedText, once, patchedField, slugText } from '../bounded-text.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import {
  orgDeleteSlugConflictError,
  orgHasEnvironmentOrderError,
  slugConflictError,
} from './hierarchy-errors.js';
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
    const name = boundedText(b.name, 'name', NAME_MAX);
    if (name.problem !== undefined) return badInput(c, requestId, name.problem);
    const slug = slugText(b.slug);
    if (slug.problem !== undefined) return badInput(c, requestId, slug.problem);
    const spec: OrgSpec = { name: name.value, slug: slug.value };
    // Create through the tenant-hierarchy binding only when authz is
    // configured — it enqueues FGA tuples that only matter when a PDP is
    // enforcing. Wiring without an authorizer (e.g. tests) falls back to
    // `binding.create`, so test doubles don't need a real database.
    if (authorizer !== undefined) {
      const principal = c.get('principal') as Principal | undefined;
      const creatorUserId =
        principal?.actor.kind === 'user' ? (principal.actor.id as UserId) : undefined;
      const result = await tenantHierarchy.createOrg({
        tenantId,
        ...(creatorUserId !== undefined && { creatorUserId }),
        spec,
      });
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
    // As create checks them; the org is read only when a sent value fails.
    const stored = once(() => binding.get(tenantId, orgId));
    const name = await patchedField(
      b.name,
      (raw) => boundedText(raw, 'name', NAME_MAX),
      async () => (await stored())?.name,
    );
    const slug = await patchedField(
      b.slug,
      (raw) => slugText(raw),
      async () => (await stored())?.slug,
    );
    if (name.kind === 'refused') return badInput(c, requestId, name.problem);
    if (slug.kind === 'refused') return badInput(c, requestId, slug.problem);
    if (name.kind === 'write') shaped.name = name.value;
    if (slug.kind === 'write') shaped.slug = slug.value;

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
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const orgId = c.req.param('orgId') as OrgId;
    const outcome = await binding.delete(tenantId, orgId);
    if (outcome.kind === 'slug-conflict') {
      const error = orgDeleteSlugConflictError(outcome.slugs);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
    if (outcome.kind === 'org-has-environment-order') {
      const error = orgHasEnvironmentOrderError(outcome.orderId);
      c.status(statusFor(error.code) as never);
      return c.json(toWireError(error, requestId));
    }
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

function badInput(c: Context<AppEnv>, requestId: string, message: string): Response {
  c.status(statusFor('bad-input') as never);
  return c.json(toWireError({ code: 'bad-input', message }, requestId));
}
