// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';
import { Hono } from 'hono';

import type { ProjectRole } from '@kindgi/platform';
import type { Cursor, Result, TenantId } from '@kindgi/types';

import { callerRef, isTenantAdmin } from '../caller.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type {
  ServiceAccount,
  ServiceAccountBinding,
  ServiceAccountError,
  ServiceAccountGrant,
  ServiceAccountGrantTarget,
} from '../service-account-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

/** Lowercase letters, digits and hyphens, starting with a letter or digit. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DESCRIPTION_LENGTH = 500;
const PROJECT_ROLES: readonly ProjectRole[] = ['viewer', 'editor', 'owner', 'admin', 'member'];

/**
 * Service accounts (`/v1/service-accounts`), for tenant admins:
 *
 * - `POST /` creates one, with its first grants: `{name, description?, grants?}`;
 * - `GET /` lists them, oldest first (`?includeUnregistered=true` for all);
 * - `GET /:serviceAccountId` reads one, unregistered or not;
 * - `POST /:serviceAccountId/grant` adds a grant; `/ungrant` removes one;
 * - `POST /:serviceAccountId/unregister` tombstones it: grants gone, keys dead.
 *
 * Keys for an account are minted at `POST /v1/tokens` with `for`.
 */
export function serviceAccountsRouter(
  binding: ServiceAccountBinding,
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.use('/*', async (c, next) => {
    if (!(await isTenantAdmin(c, authorizer))) {
      return fail(c, {
        code: 'permission-denied',
        message: 'Only a tenant admin manages service accounts',
      });
    }
    await next();
    return;
  });

  r.post('/', async (c) => {
    const body = await readBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const parsed = parseCreateBody(body.value);
    if (parsed.kind === 'err') return fail(c, parsed.error);
    const createdBy = callerRef(c);
    const created = await binding.create({
      tenantId: tenantOf(c),
      ...parsed.value,
      ...(createdBy !== undefined && { createdBy }),
    });
    return respond(c, created, 201);
  });

  r.get('/', async (c) => {
    const cursor = c.req.query('cursor');
    const page = await binding.list({
      tenantId: tenantOf(c),
      limit: clampLimit(c.req.query('limit')),
      ...(cursor !== undefined && cursor !== '' && { cursor: cursor as Cursor }),
      ...(c.req.query('includeUnregistered') === 'true' && { includeUnregistered: true }),
    });
    return c.json({
      data: page.data.map(toWire),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as string }),
    });
  });

  r.get('/:serviceAccountId', async (c) => {
    const serviceAccountId = c.req.param('serviceAccountId');
    const account = await binding.get({ tenantId: tenantOf(c), serviceAccountId });
    if (account === null) return fail(c, notFound(serviceAccountId));
    return c.json(toWire(account));
  });

  r.post('/:serviceAccountId/grant', async (c) => {
    const body = await readBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const grant = parseGrant(body.value);
    if (grant.kind === 'err') return fail(c, grant.error);
    const serviceAccountId = c.req.param('serviceAccountId');
    return respond(
      c,
      await binding.grant({
        tenantId: tenantOf(c),
        serviceAccountId,
        grant: grant.value,
        ...byCaller(c),
      }),
    );
  });

  r.post('/:serviceAccountId/ungrant', async (c) => {
    const body = await readBody(c);
    if (body.kind === 'err') return fail(c, body.error);
    const grant = parseGrantTarget(body.value);
    if (grant.kind === 'err') return fail(c, grant.error);
    const serviceAccountId = c.req.param('serviceAccountId');
    return respond(
      c,
      await binding.ungrant({
        tenantId: tenantOf(c),
        serviceAccountId,
        grant: grant.value,
        ...byCaller(c),
      }),
    );
  });

  r.post('/:serviceAccountId/unregister', async (c) => {
    const serviceAccountId = c.req.param('serviceAccountId');
    return respond(
      c,
      await binding.unregister({ tenantId: tenantOf(c), serviceAccountId, ...byCaller(c) }),
    );
  });

  return r;
}

type WireError = { readonly code: string; readonly message: string };
type Parsed<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: WireError };

/** Who made the change, for the record. */
function byCaller(c: Context<AppEnv>): { by?: string } {
  const by = callerRef(c);
  return by !== undefined ? { by } : {};
}

function tenantOf(c: Context<AppEnv>): TenantId {
  return c.get('tenantId') as TenantId;
}

function fail(c: Context<AppEnv>, error: WireError): Response {
  c.status(statusFor(error.code) as never);
  return c.json(toWireError(error, c.get('requestId')));
}

function notFound(serviceAccountId: string): WireError {
  return {
    code: 'service-account-not-found',
    message: `No service account with id "${serviceAccountId}" in this tenant`,
  };
}

function respond(
  c: Context<AppEnv>,
  result: Result<ServiceAccount, ServiceAccountError>,
  status: 200 | 201 = 200,
): Response {
  if (result.kind === 'err') return fail(c, result.error);
  c.status(status);
  return c.json(toWire(result.value));
}

function toWire(a: ServiceAccount): Record<string, unknown> {
  return {
    serviceAccountId: a.serviceAccountId,
    name: a.name,
    ...(a.description !== undefined && { description: a.description }),
    grants: a.grants,
    ...(a.createdBy !== undefined && { createdBy: a.createdBy }),
    createdAt: a.createdAt,
    ...(a.unregisteredAt !== undefined && { unregisteredAt: a.unregisteredAt }),
  };
}

async function readBody(c: Context<AppEnv>): Promise<Parsed<Record<string, unknown>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badInput('Request body must be a JSON object');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return badInput('Request body must be a JSON object');
  }
  return { kind: 'ok', value: body as Record<string, unknown> };
}

function badInput(message: string): { kind: 'err'; error: WireError } {
  return { kind: 'err', error: { code: 'bad-input', message } };
}

function parseCreateBody(b: Record<string, unknown>): Parsed<{
  name: string;
  description?: string;
  grants: readonly ServiceAccountGrant[];
}> {
  if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) {
    return badInput(
      '`name` must be 1-63 lowercase letters, digits or hyphens, starting with a letter or digit',
    );
  }
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' || b.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    return badInput(
      `\`description\` must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  if (b.grants !== undefined && !Array.isArray(b.grants)) {
    return badInput('`grants` must be an array of grants');
  }
  const grants: ServiceAccountGrant[] = [];
  for (const raw of (b.grants as unknown[] | undefined) ?? []) {
    const grant = parseGrant(raw);
    if (grant.kind === 'err') return grant;
    grants.push(grant.value);
  }
  return {
    kind: 'ok',
    value: {
      name: b.name,
      ...(typeof b.description === 'string' && { description: b.description }),
      grants,
    },
  };
}

/** `{kind: 'tenant-admin'}`, `{kind: 'tenant-member'}` or `{kind: 'project', projectId, role}`. */
function parseGrant(raw: unknown): Parsed<ServiceAccountGrant> {
  const target = parseGrantTarget(raw);
  if (target.kind === 'err') return target;
  if (target.value.kind !== 'project') return { kind: 'ok', value: target.value };
  const role = (raw as { role?: unknown }).role;
  if (typeof role !== 'string' || !PROJECT_ROLES.includes(role as ProjectRole)) {
    return badInput(`A project grant's \`role\` must be one of: ${PROJECT_ROLES.join(', ')}`);
  }
  return { kind: 'ok', value: { ...target.value, role: role as ProjectRole } };
}

/** `{kind: 'tenant-admin'}`, `{kind: 'tenant-member'}` or `{kind: 'project', projectId}`. */
function parseGrantTarget(raw: unknown): Parsed<ServiceAccountGrantTarget> {
  const g = (raw ?? {}) as { kind?: unknown; projectId?: unknown };
  if (g.kind === 'tenant-admin') return { kind: 'ok', value: { kind: 'tenant-admin' } };
  if (g.kind === 'tenant-member') return { kind: 'ok', value: { kind: 'tenant-member' } };
  if (g.kind === 'project') {
    if (typeof g.projectId !== 'string' || g.projectId === '') {
      return badInput('A project grant needs `projectId`');
    }
    return { kind: 'ok', value: { kind: 'project', projectId: g.projectId } };
  }
  return badInput("A grant's `kind` must be 'tenant-admin', 'tenant-member' or 'project'");
}
