// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor, SupervisorId, Timestamp } from '@kindgi/types';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { Observation, ObservationStatus } from '../types.js';

/**
 * Observations resource — records of supervisor evaluations of runs.
 *
 * The runtime records observations itself, so the API's one route here
 * reads them (`GET /v1/observations`).
 */
export interface ObservationsClient {
  /**
   * Query observations across supervisors + agents.
   *
   * @wire `GET /v1/observations` — see `@kindgi/api/openapi.json#/paths/~1v1~1observations/get`.
   */
  query(filter?: ObservationFilter): Promise<ListPage<Observation>>;
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

export function makeObservationsClient(transport: Transport): ObservationsClient {
  return {
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
      return listPage(page);
    },
  };
}
