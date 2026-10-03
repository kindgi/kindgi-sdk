// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Page, Timestamp } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  Budgets,
  BudgetsRemaining,
  CostAggregateResult,
  CostGroupDimension,
  CostRecord,
  CostRecordFilter,
} from '../types.js';

/**
 * Cost resource — usage accounting.
 *
 * Two sub-namespaces: `.usage` (raw records + grouped aggregates via
 * `GET /v1/cost/records` + `GET /v1/cost/aggregate`, returning the
 * wire-native `CostRecord` / `CostAggregateResult`) and `.budgets`
 * (caps + enforcement policy — no API routes; every method throws
 * `not-yet-wired`).
 */
export interface CostClient {
  readonly usage: UsageClient;
  readonly budgets: BudgetsClient;
}

export interface UsageClient {
  /**
   * Paginated raw cost records. Filter by run, agent, conversation,
   * category, provider, and time window.
   *
   * @wire `GET /v1/cost/records` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1cost~1records/get`.
   */
  query(filter?: CostRecordFilter): Promise<Page<CostRecord>>;

  /**
   * Fetch a single cost record.
   *
   * @wire `GET /v1/cost/records/{recordId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1cost~1records~1{recordId}/get`.
   */
  get(recordId: string): Promise<CostRecord>;

  /**
   * Grouped aggregate — totals in USD, bucketed by requested dimensions
   * over the time window. Cheaper than paginating raw records for
   * dashboards.
   *
   * @wire `GET /v1/cost/aggregate` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1cost~1aggregate/get`.
   */
  summary(input: UsageSummaryInput): Promise<CostAggregateResult>;
}

export interface UsageSummaryInput {
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly groupBy?: readonly CostGroupDimension[];
  readonly category?: string;
  readonly providerId?: import('../types.js').ProviderId;
  readonly agentId?: import('@kindgi/types').AgentId;
  readonly runId?: import('@kindgi/types').RunId;
  readonly conversationId?: import('@kindgi/types').ThreadId;
}

export interface BudgetsClient {
  /**
   * @unwired The API has no `GET /v1/tenant/budgets` route.
   */
  get(): Promise<Budgets>;
  /**
   * @unwired The API has no `PUT /v1/tenant/budgets` route.
   */
  set(input: Budgets): Promise<void>;
  /**
   * @unwired The API has no `GET /v1/tenant/budgets/remaining` route.
   */
  getRemaining(): Promise<BudgetsRemaining>;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export function makeCostClient(transport: Transport): CostClient {
  return {
    usage: {
      async query(filter) {
        const page = await transport.request<WirePage<CostRecord>>({
          method: 'GET',
          path: '/v1/cost/records',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
            ...(filter?.runId !== undefined && { runId: filter.runId as unknown as string }),
            ...(filter?.agentId !== undefined && { agentId: filter.agentId as unknown as string }),
            ...(filter?.conversationId !== undefined && {
              conversationId: filter.conversationId as unknown as string,
            }),
            ...(filter?.category !== undefined && { category: filter.category }),
            ...(filter?.providerId !== undefined && {
              providerId: filter.providerId as unknown as string,
            }),
            ...(filter?.from !== undefined && { from: filter.from as unknown as string }),
            ...(filter?.to !== undefined && { to: filter.to as unknown as string }),
          },
        });
        return {
          items: page.data,
          ...(page.nextCursor !== undefined && {
            nextCursor: page.nextCursor as unknown as Cursor,
          }),
        };
      },

      async get(recordId) {
        return transport.request<CostRecord>({
          method: 'GET',
          path: `/v1/cost/records/${encodeURIComponent(recordId)}`,
        });
      },

      async summary(input) {
        return transport.request<CostAggregateResult>({
          method: 'GET',
          path: '/v1/cost/aggregate',
          query: {
            from: input.from as unknown as string,
            to: input.to as unknown as string,
            ...(input.groupBy !== undefined && { groupBy: input.groupBy.join(',') }),
            ...(input.category !== undefined && { category: input.category }),
            ...(input.providerId !== undefined && {
              providerId: input.providerId as unknown as string,
            }),
            ...(input.agentId !== undefined && { agentId: input.agentId as unknown as string }),
            ...(input.runId !== undefined && { runId: input.runId as unknown as string }),
            ...(input.conversationId !== undefined && {
              conversationId: input.conversationId as unknown as string,
            }),
          },
        });
      },
    },
    budgets: {
      async get() {
        throw new KindgiApiError(
          notYetWired(
            'cost.budgets.get',
            'no GET /v1/tenant/budgets route on the API — budget enforcement primitive not surfaced on the wire',
          ),
        );
      },
      async set(_input) {
        throw new KindgiApiError(
          notYetWired(
            'cost.budgets.set',
            'no PUT /v1/tenant/budgets route on the API — admin-scope budget writes not surfaced yet',
          ),
        );
      },
      async getRemaining() {
        throw new KindgiApiError(
          notYetWired(
            'cost.budgets.getRemaining',
            'no GET /v1/tenant/budgets/remaining route on the API — window-remaining computation not surfaced yet',
          ),
        );
      },
    },
  };
}
