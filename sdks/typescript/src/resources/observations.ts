// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor, Page, RunId, SupervisorId, Timestamp } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type { Observation, ObservationStatus } from '../types.js';

/**
 * Observations resource — records of supervisor evaluations of runs.
 *
 * Only `query` has an API route (`GET /v1/observations`). Observations
 * are recorded server-side; there is no route to record one
 * (`recordRun`) or to aggregate them (`patterns`).
 */
export interface ObservationsClient {
  /**
   * @deprecated No `POST /v1/observations` route — observations are
   *   recorded server-side. Throws `KindgiApiError` with
   *   `code: 'not-yet-wired'`.
   */
  recordRun(runId: RunId): Promise<void>;

  /**
   * Query observations across supervisors + agents.
   *
   * @wire `GET /v1/observations` — see `@kindgi/api/openapi.json#/paths/~1v1~1observations/get`.
   */
  query(filter?: ObservationFilter): Promise<Page<Observation>>;

  /**
   * @unwired No `/v1/observations/patterns` route.
   */
  patterns(input: PatternsInput): Promise<never>;
}

export interface ObservationFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly status?: ObservationStatus;
  readonly supervisorId?: SupervisorId;
  readonly agentId?: AgentId;
  readonly agentVersion?: string;
  readonly conversationId?: string;
  readonly since?: Timestamp;
  readonly until?: Timestamp;
}

export interface PatternsInput {
  readonly supervisorId: SupervisorId;
  readonly since?: Timestamp;
  readonly until?: Timestamp;
  readonly agent?: AgentId;
  readonly limit?: number;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export function makeObservationsClient(transport: Transport): ObservationsClient {
  return {
    async recordRun(_runId) {
      throw new KindgiApiError(
        notYetWired(
          'observations.recordRun',
          'no POST /v1/observations route on the API — supervisor runtime records observations server-internally',
        ),
      );
    },

    async query(filter) {
      const page = await transport.request<WirePage<Observation>>({
        method: 'GET',
        path: '/v1/observations',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.status !== undefined && { status: filter.status }),
          ...(filter?.supervisorId !== undefined && {
            supervisorId: filter.supervisorId as unknown as string,
          }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId as unknown as string }),
          ...(filter?.agentVersion !== undefined && { agentVersion: filter.agentVersion }),
          ...(filter?.conversationId !== undefined && {
            conversationId: filter.conversationId,
          }),
          ...(filter?.since !== undefined && { since: filter.since as unknown as string }),
          ...(filter?.until !== undefined && { until: filter.until as unknown as string }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },

    async patterns(_input) {
      throw new KindgiApiError(
        notYetWired(
          'observations.patterns',
          'no /v1/observations/patterns route on the API — aggregation surface unrouted',
        ),
      );
    },
  };
}
