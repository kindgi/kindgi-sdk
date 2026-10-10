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

import { isTenantAdmin } from '../caller.js';
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

/**
 * The sign-in kinds `/v1/audit/sign-ins` lists: who signed in and out, how,
 * from where, and what was refused (a deployment writes each kind it has).
 */
export const SIGN_IN_EVENT_KINDS = [
  'signed-in',
  'signed-out',
  'sign-in-refused',
  'sign-in-link-sent',
  'sign-in-link-capped',
  'sessions-revoked',
  'sessions-ended',
] as const;
type SignInEventKind = (typeof SIGN_IN_EVENT_KINDS)[number];

/** Wire projection for `/v1/audit/sign-ins`: the event, flattened. */
interface WireSignInEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly kind: SignInEventKind;
  readonly outcome: string;
  /** The person the event is about: its subject, else its actor, else the person a link was for. */
  readonly userId?: string;
  /** How: `api-token`, `email-link`, `google`, `microsoft`, `github`, or a workspace provider's id. */
  readonly method?: string;
  readonly clientAddress?: string;
  /** Why a sign-in was refused, or which limit held. */
  readonly reason?: string;
  readonly sessionId?: string;
  /** Who acted, when it isn't `userId`: the admin who ended this person's sessions. */
  readonly byUserId?: string;
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

  // ---------- GET /sign-ins ----------
  // Who signed in, when, how and from where (and what was refused): a
  // tenant admin's to read, with or without authorization on.
  r.get('/sign-ins', async (c) => {
    const requestId = c.get('requestId');
    if (!(await isTenantAdmin(c, authorizer))) {
      c.status(statusFor('permission-denied') as never);
      return c.json(
        toWireError(
          { code: 'permission-denied', message: 'Only a tenant admin reads the sign-in history' },
          requestId,
        ),
      );
    }
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));
    const cursor = c.req.query('cursor');
    const userId = c.req.query('userId');
    const kind = c.req.query('kind');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const orderRaw = c.req.query('order');
    const bad = (message: string) => {
      c.status(statusFor('bad-input') as never);
      return c.json(toWireError({ code: 'bad-input', message }, requestId));
    };
    if (orderRaw !== undefined && orderRaw !== 'asc' && orderRaw !== 'desc') {
      return bad('`order` must be "asc" or "desc"');
    }
    if (kind !== undefined && !(SIGN_IN_EVENT_KINDS as readonly string[]).includes(kind)) {
      return bad(`\`kind\` must be one of: ${SIGN_IN_EVENT_KINDS.join(', ')}`);
    }
    if (from !== undefined && Number.isNaN(new Date(from).getTime())) {
      return bad('`from` must be an ISO timestamp');
    }
    if (to !== undefined && Number.isNaN(new Date(to).getTime())) {
      return bad('`to` must be an ISO timestamp');
    }
    const page = await binding.query({
      tenantId,
      filter: {
        ...(kind !== undefined ? { kind } : { kinds: SIGN_IN_EVENT_KINDS }),
        // A person's history: the events about them (their sign-ins and
        // sign-outs, and their sessions an admin ended), with a binding that
        // filters by subject; else, as before, the events they're the actor of.
        ...(userId !== undefined &&
          userId.length > 0 &&
          (binding.filtersBySubject === true
            ? { subject: `user:${userId}` }
            : { actor: `user:${userId}` })),
        ...(from !== undefined && from.length > 0 && { from }),
        ...(to !== undefined && to.length > 0 && { to }),
      },
      ...(cursor !== undefined && cursor.length > 0 && { cursor }),
      ...(orderRaw !== undefined && { order: orderRaw }),
      limit,
    });
    if (page.kind === 'err') {
      if (page.error.code === 'invalid-cursor') {
        return bad(`Malformed cursor: ${page.error.message}`);
      }
      c.status(statusFor('persistence-error') as never);
      return c.json(
        toWireError(
          { code: 'persistence-error', message: `Audit query failed: ${page.error.message}` },
          requestId,
        ),
      );
    }
    // A binding that predates `kinds` still can't return other kinds here.
    return c.json({
      data: page.value.data
        .filter((event) => (SIGN_IN_EVENT_KINDS as readonly string[]).includes(event.kind))
        .map(signInToWire),
      hasMore: page.value.nextCursor !== undefined,
      ...(page.value.nextCursor !== undefined && { nextCursor: page.value.nextCursor }),
    });
  });

  return r;
}

function signInToWire(event: AuditEvent): WireSignInEvent {
  const doc = extractDoc(event.payload) ?? {};
  const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  // `user:system` is an anonymous request (a refusal, a link anyone may ask
  // for): the person, if any, is the one the event is about (`subject`, or
  // `personId` from before it). An admin who ended someone's sessions is
  // the actor, and that person the subject.
  const userOf = (principal: string | undefined) =>
    principal?.startsWith('user:') === true && principal !== 'user:system'
      ? principal.slice(5)
      : undefined;
  const actor = userOf(event.actor);
  const subject = userOf(event.subject);
  const userId = subject ?? actor ?? str(doc.personId);
  const byUserId =
    subject !== undefined && actor !== undefined && actor !== subject ? actor : undefined;
  const method = str(doc.method) ?? str(doc.providerId);
  const clientAddress = str(doc.clientAddress);
  const reason = str(doc.reason) ?? str(doc.limit);
  const sessionId = str(doc.sessionId);
  return {
    id: event.id,
    timestamp: event.timestamp as unknown as string,
    kind: event.kind as SignInEventKind,
    outcome: event.outcome ?? 'succeeded',
    ...(userId !== undefined && { userId }),
    ...(method !== undefined && { method }),
    ...(clientAddress !== undefined && { clientAddress }),
    ...(reason !== undefined && { reason }),
    ...(sessionId !== undefined && { sessionId }),
    ...(byUserId !== undefined && { byUserId }),
  };
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
