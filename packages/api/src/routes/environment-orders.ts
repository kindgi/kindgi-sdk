// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { type Context, Hono } from 'hono';

import type { AuditEventBinding } from '@kindgi/audit-events';
import { ref } from '@kindgi/authz';
import { emitAuditEvent } from '@kindgi/compliance';
import type { OrgId, ProjectId, TenantId } from '@kindgi/types';

import { callerIdentity, isTenantAdmin } from '../caller.js';
import type {
  EnvironmentOrder,
  EnvironmentOrderBinding,
  EnvironmentOrderCursor,
  EnvironmentOrderParent,
} from '../environment-orders-binding.js';
import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { UUID_RE } from './uuid-param.js';

/** The parent a page ended on, as the wire cursor: base64url JSON the route alone reads. */
function encodeCursor(cursor: EnvironmentOrderCursor): string {
  return Buffer.from(JSON.stringify({ orgId: cursor.orgId }), 'utf8').toString('base64url');
}

/**
 * Decode the wire `cursor`: a decoded parent, `undefined` for no cursor, or
 * `'bad'` for one this list never gave. Only `null` or a uuid org id is a
 * cursor this list mints, so anything else is `'bad'` — never a silent
 * restart, and never a non-uuid handed to the binding's keyset.
 */
function parseCursor(raw: string | undefined): EnvironmentOrderCursor | undefined | 'bad' {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return 'bad';
    const orgId = (parsed as { orgId?: unknown }).orgId;
    if (orgId === null) return { orgId: null };
    if (typeof orgId === 'string' && UUID_RE.test(orgId)) return { orgId };
    return 'bad';
  } catch {
    return 'bad';
  }
}

/**
 * `/v1/environment-orders`: the order a tenant runs a project through on
 * its way to live — "environments", to the people who set them. One
 * ordered list of projects per parent: the tenant, or one of its orgs.
 *
 *   - `GET  /`                 — every order the caller can read a project
 *                                in, paged.
 *   - `GET  /tenant`           — the tenant's own order (empty when unset).
 *   - `PUT  /tenant`           — set it (tenant admin). Body `{ projectIds }`.
 *   - `GET  /orgs/:orgId`      — an org's order.
 *   - `PUT  /orgs/:orgId`      — set it (tenant admin).
 *
 * A read names a project the caller can't see by its position alone — the
 * same project-read check `GET /v1/projects` filters its list with. Only a
 * tenant admin writes an order; an org admin or a project admin is refused,
 * even on an org's own order. A write replaces the whole order with the
 * projects given, in order; `[]` clears it, and a write that changes
 * nothing writes and records nothing. Removing a project from an order or
 * reordering leaves running deployments where they are; a project in no
 * order takes builds directly again.
 */
/** An order on the wire; a project the caller can't read is position-only. */
interface WireOrder {
  readonly parent: Record<string, unknown>;
  readonly entries: readonly { readonly position: number; readonly projectId?: string }[];
}

export function environmentOrdersRouter(deps: {
  readonly binding: EnvironmentOrderBinding;
  readonly auditEvents?: AuditEventBinding;
  readonly authorizer?: Authorizer;
}): Hono<AppEnv> {
  const { binding, auditEvents, authorizer } = deps;
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
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
    const page = await binding.list({
      tenantId,
      limit,
      ...(after !== undefined && { after }),
    });
    const visible: WireOrder[] = [];
    for (const order of page.orders) {
      const wire = await serializeOrderVisible(c, authorizer, order);
      // An order the caller can read no project in isn't listed.
      if (wire.entries.some((e) => e.projectId !== undefined)) visible.push(wire);
    }
    return c.json({
      data: visible,
      hasMore: page.nextAfter !== undefined,
      ...(page.nextAfter !== undefined && { nextCursor: encodeCursor(page.nextAfter) }),
    });
  });

  r.get('/tenant', (c) => getOrder(c, binding, authorizer, { kind: 'tenant' }));
  r.put('/tenant', (c) => setOrder(c, binding, auditEvents, authorizer, { kind: 'tenant' }));

  r.get('/orgs/:orgId', (c) => {
    const orgId = c.req.param('orgId') as OrgId;
    return getOrder(c, binding, authorizer, { kind: 'org', orgId });
  });
  r.put('/orgs/:orgId', (c) => {
    const orgId = c.req.param('orgId') as OrgId;
    return setOrder(c, binding, auditEvents, authorizer, { kind: 'org', orgId });
  });

  return r;
}

async function getOrder(
  c: Context<AppEnv>,
  binding: EnvironmentOrderBinding,
  authorizer: Authorizer | undefined,
  parent: EnvironmentOrderParent,
): Promise<Response> {
  const tenantId = c.get('tenantId') as TenantId;
  const order = await binding.get({ tenantId, parent });
  const wire = await serializeOrderVisible(c, authorizer, order);
  // Follow the list's rule: an order the caller can read no project in
  // reads as empty. A single read never reveals an order the list hides —
  // not its member count by position, nor that it exists at all (an order
  // the caller can't see reads the same as none).
  const readsNone =
    order.entries.length > 0 && !wire.entries.some((e) => e.projectId !== undefined);
  return c.json(readsNone ? { parent: wire.parent, entries: [] } : wire);
}

async function setOrder(
  c: Context<AppEnv>,
  binding: EnvironmentOrderBinding,
  auditEvents: AuditEventBinding | undefined,
  authorizer: Authorizer | undefined,
  parent: EnvironmentOrderParent,
): Promise<Response> {
  const requestId = c.get('requestId');
  const tenantId = c.get('tenantId') as TenantId;

  // Only a tenant admin sets an order (when authorization is configured).
  if (authorizer !== undefined && !(await isTenantAdmin(c, authorizer))) {
    c.status(statusFor('permission-denied') as never);
    return c.json(
      toWireError(
        { code: 'permission-denied', message: 'Only a tenant admin sets an environment order' },
        requestId,
      ),
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.status(statusFor('bad-input') as never);
    return c.json(toWireError({ code: 'bad-input', message: 'Body must be JSON' }, requestId));
  }
  const parsed = parseProjectIds((body as { projectIds?: unknown } | null)?.projectIds);
  if (typeof parsed === 'string') {
    c.status(statusFor('bad-input') as never);
    return c.json(toWireError({ code: 'bad-input', message: parsed }, requestId));
  }

  const outcome = await binding.set({ tenantId, parent, projectIds: parsed });
  if (outcome.kind === 'bad-input') {
    c.status(statusFor('bad-input') as never);
    return c.json(toWireError({ code: 'bad-input', message: outcome.message }, requestId));
  }
  if (outcome.kind === 'project-in-another-order') {
    c.status(statusFor('project-in-another-order') as never);
    return c.json(
      toWireError(
        {
          code: 'project-in-another-order',
          message: outcome.message,
          projectId: outcome.projectId as unknown as string,
        },
        requestId,
      ),
    );
  }
  if (outcome.kind === 'ok') {
    // A signed, exportable record of the set, with the order before and after.
    await emitAuditEvent({
      auditEvents,
      tenantId,
      kind: 'environment-order-set',
      actor: callerIdentity(c),
      outcome: 'succeeded',
      correlationId: requestId,
      doc: {
        parent: parentToDoc(parent),
        before: outcome.before.map((id) => id as unknown as string),
        after: outcome.after.map((id) => id as unknown as string),
      },
      log: c.get('log').child({ subsystem: 'audit' }),
    });
  }
  // `ok` and `no-op` both return the order as it now stands. The caller is a
  // tenant admin, who reads every project; serialize it whole.
  return c.json(serializeOrder(outcome.order));
}

/** Serialize an order whole — every project by id (for the writing admin). */
function serializeOrder(order: EnvironmentOrder): WireOrder {
  return {
    parent: parentToDoc(order.parent),
    entries: order.entries.map((e) => ({
      position: e.position,
      projectId: e.projectId as unknown as string,
    })),
  };
}

async function serializeOrderVisible(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
  order: EnvironmentOrder,
): Promise<WireOrder> {
  const readable =
    authorizer === undefined
      ? order.entries
      : await authorizer.filterByCan(c, 'read', order.entries, (e) =>
          ref('project', e.projectId as unknown as string),
        );
  const readablePositions = new Set(readable.map((e) => e.position));
  return {
    parent: parentToDoc(order.parent),
    entries: order.entries.map((e) =>
      readablePositions.has(e.position)
        ? { position: e.position, projectId: e.projectId as unknown as string }
        : { position: e.position },
    ),
  };
}

function parentToDoc(parent: EnvironmentOrderParent): Record<string, unknown> {
  return parent.kind === 'tenant'
    ? { kind: 'tenant' }
    : { kind: 'org', orgId: parent.orgId as unknown as string };
}

/**
 * Validate the request's `projectIds`: an array of non-empty strings, with
 * no project named twice, and not a single project (an order needs two or
 * more environments; `[]` clears it). The runtime checks the rest — that
 * each project is live in the tenant under this parent, and in no other
 * order — in its write transaction.
 */
function parseProjectIds(raw: unknown): readonly ProjectId[] | string {
  if (!Array.isArray(raw)) return '`projectIds` must be an array of project ids';
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0) {
      return '`projectIds` must be an array of non-empty project ids';
    }
  }
  const ids = raw as string[];
  if (ids.length === 1) {
    return 'an order needs two or more environments; send [] to clear it';
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return `an environment order can't list a project twice: "${id}" appears more than once`;
    }
    seen.add(id);
  }
  return ids as unknown as readonly ProjectId[];
}
