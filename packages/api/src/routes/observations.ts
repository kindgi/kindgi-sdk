// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { Hono } from 'hono';

import type {
  AgentId,
  Cursor,
  RunId,
  Semver,
  SupervisorId,
  TenantId,
  Timestamp,
} from '@kindgi/types';

import { ref } from '@kindgi/authz';

import { statusFor, toWireError } from '../errors.js';
import type { Authorizer } from '../middleware/authorize.js';
import type {
  Observation,
  ObservationPosition,
  ObservationStatus,
  SupervisorBinding,
} from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit, decodeCursor, encodeCursor } from './pagination.js';

const OBSERVATION_STATUSES: ReadonlySet<ObservationStatus> = new Set([
  'succeeded',
  'guardrail-violation',
  'guardrail-warning',
  'tool-error',
  'model-error',
  'budget-exceeded',
  'aborted',
  'other',
]);

/**
 * Observations resource — supervisor readback of run outcomes.
 *
 * Any authenticated caller can list observations for their tenant.
 * Filtering is deliberately narrow: `agentId`, `status`,
 * `supervisorId`. Time-window + conversation filters can be added when
 * a caller needs them.
 *
 * The cursor continues after the page's last observation: its `observedAt`
 * as the binding stores it and its id (`next`), so observations at the same
 * instant aren't skipped. A binding without `next` gives a bare ISO time,
 * which the route passes on as it did; a bare time a client holds still
 * answers.
 *
 * Persistence + query wiring is caller-plugged via `SupervisorBinding`
 * — the API package doesn't own the supervisor runtime.
 */
export function observationsRouter(
  binding: SupervisorBinding,
  /** With one (T243 A): only observations of agents the caller may read. */
  authorizer?: Authorizer,
): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/', async (c) => {
    const requestId = c.get('requestId');
    const tenantId = c.get('tenantId') as TenantId;
    const limit = clampLimit(c.req.query('limit'));

    const statusRaw = c.req.query('status');
    if (
      statusRaw !== undefined &&
      statusRaw.length > 0 &&
      !OBSERVATION_STATUSES.has(statusRaw as ObservationStatus)
    ) {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: `Unknown \`status\` value: ${statusRaw}` },
          requestId,
        ),
      );
    }

    const position = pageCursor(c.req.query('cursor'));
    if (position === 'invalid') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
      );
    }

    const agentIdRaw = c.req.query('agentId');
    const agentVersionRaw = c.req.query('agentVersion');
    const supervisorIdRaw = c.req.query('supervisorId');
    const conversationIdRaw = c.req.query('conversationId');
    const sinceRaw = c.req.query('since');
    const untilRaw = c.req.query('until');

    const validIso = (raw: string | undefined): string | undefined | 'invalid' => {
      if (raw === undefined || raw.length === 0) return undefined;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return 'invalid';
      return d.toISOString();
    };
    const since = validIso(sinceRaw);
    if (since === 'invalid') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`since` must be an ISO date string' },
          requestId,
        ),
      );
    }
    const until = validIso(untilRaw);
    if (until === 'invalid') {
      c.status(statusFor('bad-input') as never);
      return c.json(
        toWireError(
          { code: 'bad-input', message: '`until` must be an ISO date string' },
          requestId,
        ),
      );
    }

    const outcome = await binding.queryObservations({
      tenantId,
      limit,
      ...(statusRaw !== undefined &&
        statusRaw.length > 0 && {
          status: statusRaw as ObservationStatus,
        }),
      ...(agentIdRaw !== undefined &&
        agentIdRaw.length > 0 && {
          agentId: agentIdRaw as AgentId,
        }),
      ...(agentVersionRaw !== undefined &&
        agentVersionRaw.length > 0 && {
          agentVersion: agentVersionRaw as unknown as Semver,
        }),
      ...(supervisorIdRaw !== undefined &&
        supervisorIdRaw.length > 0 && {
          supervisorId: supervisorIdRaw as SupervisorId,
        }),
      ...(conversationIdRaw !== undefined &&
        conversationIdRaw.length > 0 && {
          conversationId: conversationIdRaw as RunId,
        }),
      ...(since !== undefined && { since: since as unknown as Timestamp }),
      ...(until !== undefined && { until: until as unknown as Timestamp }),
      ...position,
    });
    if (outcome.kind === 'runtime-error') {
      c.status(statusFor(outcome.code) as never);
      return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
    }
    const { data, next } = outcome.page;
    // Continue at the binding's exact position when it gives one, else (a
    // binding from before) at its bare-time cursor.
    const nextCursor =
      next !== undefined
        ? encodeCursor({ createdAt: next.observedAt, id: next.id })
        : (outcome.page.nextCursor as unknown as string | undefined);
    const visible =
      authorizer === undefined
        ? data
        : await authorizer.filterByCan(c, 'read', data, (o) =>
            ref('agent', o.agentId as unknown as string),
          );
    return c.json({
      data: visible.map(serializeObservation),
      hasMore: nextCursor !== undefined,
      ...(nextCursor !== undefined && { nextCursor }),
    });
  });

  return r;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A request's cursor: where the last page ended (an observation's
 * `observedAt` as stored and its id, the binding's `next`), or a bare time
 * from before that, which still answers as it did.
 */
function pageCursor(
  raw: string | undefined,
): { readonly after?: ObservationPosition; readonly cursor?: Cursor } | 'invalid' {
  if (raw === undefined || raw.length === 0) return {};
  const decoded = decodeCursor(raw);
  if (decoded !== null) {
    return Number.isFinite(Date.parse(decoded.createdAt)) && UUID_RE.test(decoded.id)
      ? { after: { observedAt: decoded.createdAt, id: decoded.id } }
      : 'invalid';
  }
  return Number.isFinite(Date.parse(raw)) ? { cursor: raw as Cursor } : 'invalid';
}

function serializeObservation(o: Observation): Record<string, unknown> {
  return {
    id: o.id as unknown as string,
    tenantId: o.tenantId as unknown as string,
    supervisorId: o.supervisorId as unknown as string,
    agentId: o.agentId as unknown as string,
    agentVersion: o.agentVersion,
    conversationId: o.conversationId as unknown as string,
    turnNumber: o.turnNumber,
    status: o.status,
    ...(o.failureCode !== undefined && { failureCode: o.failureCode }),
    violations: o.violations,
    ...(o.failureDetail !== undefined && { failureDetail: o.failureDetail }),
    durationMs: o.durationMs,
    costUsd: o.costUsd,
    ...(o.provider !== undefined && { provider: o.provider }),
    ...(o.provenanceRef !== undefined && { provenanceRef: o.provenanceRef }),
    observedAt: o.observedAt as unknown as string,
  };
}
