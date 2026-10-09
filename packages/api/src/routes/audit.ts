// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// GET /v1/audit/authz — authorization-decision query surface.
//
// Reads audit events via `AuditEventBinding`, filtered to
// `kind='authz-decision'`.
//
// PEP: admin@tenant. Audit is sensitive by definition — only tenant
// admins see it. Authorization checks (`check()`) in the API and the
// runtime emit authz-decision audit events; this route pages through
// the results with filters.
//
// Filter shape:
//   ?actorSubject=user:xxx
//   ?onBehalfOf=agent:yyy
//   ?action=read|write|admin|...
//   ?resource=agent:zzz
//   ?outcome=allowed|denied
//   ?from=<iso>&to=<iso>
//   ?runId=<id>
//   ?limit=<n>&cursor=<opaque>
//   ?order=asc|desc   (asc, oldest first, by default)
//

import { Hono } from 'hono';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import { ref } from '@kindgi/authz';
import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';
import { parseTimeInput } from './time-input.js';

/**
 * Wire projection for the `/v1/audit/authz` route. Denormalizes the
 * kind-specific `payload.doc` fields (action, resource, reason,
 * failing, evidence, latencyMs) onto the top level so clients can
 * render without decoding the versioned envelope.
 */
interface WireAuthzDecision {
  readonly id: string;
  readonly tenantId: string;
  readonly timestamp: string;
  readonly actorSubject: string;
  readonly onBehalfSubject?: string;
  readonly action: string;
  readonly resource: string;
  readonly outcome: 'allowed' | 'denied';
  readonly reason: string;
  readonly failing?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  readonly runId?: string;
  readonly latencyMs?: number;
}

export function auditRouter(binding: AuditEventBinding, authorizer?: Authorizer): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // PEP — admin@tenant on every route.
  if (authorizer !== undefined) {
    r.use('*', async (c, next) => {
      const tenantId = c.get('tenantId') as TenantId;
      const mw = authorizer.authorize('admin', () => ref('tenant', tenantId as unknown as string));
      return mw(c, next);
    });
  }

  r.get('/authz', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const cursor = c.req.query('cursor');
    const actor = c.req.query('actorSubject');
    const onBehalf = c.req.query('onBehalfOf');
    const action = c.req.query('action');
    const resource = c.req.query('resource');
    const outcomeRaw = c.req.query('outcome');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const runId = c.req.query('runId');
    const orderRaw = c.req.query('order');

    if (orderRaw !== undefined && orderRaw !== 'asc' && orderRaw !== 'desc') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`order` must be "asc" or "desc"' }, requestId),
      );
    }

    let outcome: 'allowed' | 'denied' | undefined;
    if (outcomeRaw === 'allowed' || outcomeRaw === 'denied') outcome = outcomeRaw;
    else if (outcomeRaw !== undefined) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`outcome` must be "allowed" or "denied"' },
          requestId,
        ),
      );
    }

    if (from !== undefined && parseTimeInput(from) === null) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`from` must be an ISO timestamp' }, requestId),
      );
    }
    if (to !== undefined && parseTimeInput(to) === null) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`to` must be an ISO timestamp' }, requestId),
      );
    }

    // Every filter goes into the binding query — including `onBehalfOf`
    // and the `payload.doc` fields `action` / `resource` — so the binding
    // pages over matching events only: pages are full while matches
    // remain, and `nextCursor` resumes exactly after the last one.
    const docFilter: Record<string, string> = {
      ...(action !== undefined && action.length > 0 && { action }),
      ...(resource !== undefined && resource.length > 0 && { resource }),
    };
    const page = await binding.query({
      tenantId,
      filter: {
        kind: 'authz-decision',
        ...(actor !== undefined && actor.length > 0 && { actor }),
        ...(onBehalf !== undefined && onBehalf.length > 0 && { onBehalfOf: onBehalf }),
        ...(Object.keys(docFilter).length > 0 && { payloadDoc: docFilter }),
        ...(runId !== undefined && runId.length > 0 && { runId }),
        ...(outcome !== undefined && { outcome }),
        ...(from !== undefined && from.length > 0 && { from }),
        ...(to !== undefined && to.length > 0 && { to }),
      },
      ...(cursor !== undefined && cursor.length > 0 && { cursor }),
      ...(orderRaw !== undefined && { order: orderRaw }),
      limit,
    });

    if (page.kind === 'err') {
      if (page.error.code === 'invalid-cursor') {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError(
            { code: 'bad-input', message: `Malformed cursor: ${page.error.message}` },
            requestId,
          ),
        );
      }
      c.status(statusFor('persistence-error') as never);
      return c.json(
        toWireError(
          { code: 'persistence-error', message: `Audit query failed: ${page.error.message}` },
          requestId,
        ),
      );
    }

    // Re-check the same three filters on the returned page. A binding
    // that implements them (the contract) makes this a no-op; one that
    // predates `onBehalfOf` / `payloadDoc` still can't return
    // non-matching events (its pages are then short).
    const data = page.value.data
      .filter((event) => {
        if (onBehalf !== undefined && onBehalf.length > 0) {
          if (event.onBehalfOf !== onBehalf) return false;
        }
        if (action !== undefined && action.length > 0) {
          const doc = extractDoc(event.payload);
          if (doc?.action !== action) return false;
        }
        if (resource !== undefined && resource.length > 0) {
          const doc = extractDoc(event.payload);
          if (doc?.resource !== resource) return false;
        }
        return true;
      })
      .map(rowToWire);

    return c.json({
      data,
      hasMore: page.value.nextCursor !== undefined,
      ...(page.value.nextCursor !== undefined && { nextCursor: page.value.nextCursor }),
    });
  });

  return r;
}

function extractDoc(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  const inner = payload.doc;
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
    return inner as Readonly<Record<string, unknown>>;
  }
  return undefined;
}

function rowToWire(event: AuditEvent): WireAuthzDecision {
  const doc = extractDoc(event.payload) ?? {};
  const out: {
    -readonly [K in keyof WireAuthzDecision]: WireAuthzDecision[K];
  } = {
    id: event.id,
    tenantId: event.tenantId as unknown as string,
    timestamp: event.timestamp as unknown as string,
    actorSubject: event.actor,
    action: typeof doc.action === 'string' ? doc.action : '',
    resource: typeof doc.resource === 'string' ? doc.resource : '',
    outcome: event.outcome === 'denied' ? 'denied' : 'allowed',
    reason: typeof doc.reason === 'string' ? doc.reason : '',
  };
  if (event.onBehalfOf !== undefined) out.onBehalfSubject = event.onBehalfOf;
  if (typeof doc.failing === 'string') out.failing = doc.failing;
  if (doc.evidence !== undefined && typeof doc.evidence === 'object' && doc.evidence !== null) {
    out.evidence = doc.evidence as Readonly<Record<string, unknown>>;
  }
  if (event.correlationId !== undefined) out.correlationId = event.correlationId;
  if (event.runId !== undefined) out.runId = event.runId;
  if (typeof doc.latencyMs === 'number') out.latencyMs = doc.latencyMs;
  return out as WireAuthzDecision;
}
