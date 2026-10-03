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

import { statusFor, toWireError } from '../errors.js';
import type { Observation, ObservationStatus, SupervisorBinding } from '../supervisor-binding.js';
import type { AppEnv } from '../types.js';
import { clampLimit } from './pagination.js';

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
 * Cursor is the ISO `observedAt` of the tail row — same convention as
 * `SupervisorBinding.queryObservations`.
 *
 * Persistence + query wiring is caller-plugged via `SupervisorBinding`
 * — the API package doesn't own the supervisor runtime.
 */
export function observationsRouter(binding: SupervisorBinding): Hono<AppEnv> {
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

    const cursor = c.req.query('cursor');
    if (cursor !== undefined && cursor.length > 0) {
      const parsed = new Date(cursor);
      if (Number.isNaN(parsed.getTime())) {
        c.status(statusFor('bad-input') as never);
        return c.json(
          toWireError({ code: 'bad-input', message: '`cursor` is malformed' }, requestId),
        );
      }
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
      ...(cursor !== undefined && cursor.length > 0 && { cursor: cursor as Cursor }),
    });
    if (outcome.kind === 'runtime-error') {
      c.status(statusFor(outcome.code) as never);
      return c.json(toWireError({ code: outcome.code, message: outcome.message }, requestId));
    }
    const { data, nextCursor } = outcome.page;
    return c.json({
      data: data.map(serializeObservation),
      hasMore: nextCursor !== undefined,
      ...(nextCursor !== undefined && { nextCursor: nextCursor as unknown as string }),
    });
  });

  return r;
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
