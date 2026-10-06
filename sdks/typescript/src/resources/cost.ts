// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Timestamp } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import { scopeToQuery } from '../scope-wire.js';
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
   * Paginated raw cost records: one per model call, with its model,
   * usage and what the vendor said about it. Filter by run (or a run
   * tree), scope, agent, conversation, category, provider, model and
   * time window.
   *
   * @wire `GET /v1/cost/records` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1cost~1records/get`.
   */
  query(filter?: CostRecordFilter): Promise<ListPage<CostRecord>>;

  /**
   * Fetch a single cost record.
   *
   * @wire `GET /v1/cost/records/{recordId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1cost~1records~1{recordId}/get`.
   */
  get(recordId: string, options?: { readonly includeRawUsage?: boolean }): Promise<CostRecord>;

  /**
   * Grouped aggregate — totals in USD and tokens, bucketed by requested
   * dimensions over the time window. Cheaper than paginating raw records
   * for dashboards. With `scope: { kind: 'org', orgId }`, one call sums
   * an org's spend across its projects.
   *
   * @wire `GET /v1/cost/aggregate` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1cost~1aggregate/get`.
   */
  summary(input: UsageSummaryInput): Promise<CostAggregateResult>;
}

export interface UsageSummaryInput
  extends Omit<CostRecordFilter, 'from' | 'to' | 'limit' | 'cursor' | 'includeRawUsage'> {
  readonly from: Timestamp;
  /** Exclusive. */
  readonly to: Timestamp;
  readonly groupBy?: readonly CostGroupDimension[];
  /**
   * The most groups to return: the most expensive ones, highest first.
   * 1 to 10000; the server's default is 1000. When there were more, the
   * result's `truncated` is `true` and `totalGroups` says how many; the
   * totals still cover every record.
   */
  readonly limit?: number;
}

/** The query parameters a cost filter sends. */
function filterQuery(
  filter: Omit<CostRecordFilter, 'limit' | 'cursor'>,
): Record<string, string | number | boolean> {
  const scope = filter.scope !== undefined ? scopeToQuery(filter.scope) : undefined;
  return {
    ...(filter.runId !== undefined && { runId: filter.runId as unknown as string }),
    ...(filter.includeDescendants === true && { includeDescendants: 'true' }),
    ...(filter.rootRunId !== undefined && { rootRunId: filter.rootRunId as unknown as string }),
    ...(filter.agentId !== undefined && { agentId: filter.agentId as unknown as string }),
    ...(filter.conversationId !== undefined && {
      conversationId: filter.conversationId as unknown as string,
    }),
    ...(filter.category !== undefined && { category: filter.category }),
    ...(filter.providerId !== undefined && {
      providerId: filter.providerId as unknown as string,
    }),
    ...(filter.model !== undefined && { model: filter.model }),
    ...(filter.servedModel !== undefined && { servedModel: filter.servedModel }),
    ...(scope !== undefined && { scopeKind: scope.scopeKind }),
    ...(scope?.scopeId !== undefined && { scopeId: scope.scopeId }),
    ...(filter.from !== undefined && { from: filter.from as unknown as string }),
    ...(filter.to !== undefined && { to: filter.to as unknown as string }),
    ...(filter.includeRawUsage === true && { include: 'rawUsage' }),
  };
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
            ...filterQuery(filter ?? {}),
          },
        });
        return listPage(page);
      },

      async get(recordId, options) {
        return transport.request<CostRecord>({
          method: 'GET',
          path: `/v1/cost/records/${encodeURIComponent(recordId)}`,
          ...(options?.includeRawUsage === true && { query: { include: 'rawUsage' } }),
        });
      },

      async summary(input) {
        const { from, to, groupBy, limit, ...filter } = input;
        return transport.request<CostAggregateResult>({
          method: 'GET',
          path: '/v1/cost/aggregate',
          query: {
            ...filterQuery(filter),
            from: from as unknown as string,
            to: to as unknown as string,
            ...(groupBy !== undefined && { groupBy: groupBy.join(',') }),
            ...(limit !== undefined && { limit }),
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
