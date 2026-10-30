// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor } from '@kindgi/types';

import type { LiveScope } from '../generated/api.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { SuggestedChangeObjective } from '../types.js';

/**
 * Improve runs (`/v1/improve-runs`): the runtime looks for better values
 * and writes its best candidate as a suggested change
 * (`client.suggestedChanges`). Start one here and read it back. A finished
 * Improve run's `outcome` names the suggested change it wrote, or says it
 * found nothing better.
 */
export interface ImproveRunsClient {
  /**
   * Start an Improve run: the runtime looks for better values for the
   * version's tunable settings (`x-kindgi-tunable`) on the test set, within
   * the budget, and writes its best candidate as a suggested change. Answers at
   * once with the Improve run, `running` (`client.improveRuns.get`).
   *
   * @wire `POST /v1/improve-runs`
   */
  start(input: StartImproveRunInput): Promise<ImproveRun>;

  /**
   * What an Improve run {@link ImproveRunsClient.start} with this input would start is
   * estimated to cost, before you start it: `min(budget.maxCostUsd, the replay
   * count times the version's mean cost over its recent completed runs)`.
   * `estimatedCostUsd` is absent when the version has no cost history. It starts
   * nothing and takes no idempotency key.
   *
   * @wire `POST /v1/improve-runs/check`
   */
  check(input: CheckImproveRunInput): Promise<ImproveRunCheck>;

  /**
   * Newest first; only Improve runs of agents the caller can read.
   *
   * @wire `GET /v1/improve-runs`
   */
  list(input?: ImproveRunsListInput): Promise<ListPage<ImproveRun>>;

  /** @wire `GET /v1/improve-runs/{improveRunId}` */
  get(improveRunId: string): Promise<ImproveRun>;

  /**
   * Stop a running Improve run: it ends `cancelled`, writing no suggested change.
   *
   * @wire `POST /v1/improve-runs/{improveRunId}/cancel`
   */
  cancel(improveRunId: string, input?: { readonly idempotencyKey?: string }): Promise<ImproveRun>;
}

export interface StartImproveRunInput {
  readonly agentId: AgentId | string;
  /** Default: the version serving `scope`. */
  readonly fromVersion?: string;
  /**
   * The project the Improve run works in: the test sets it may use, and where
   * its test runs run. Default: the scope's project, else (a tenant or
   * org scope) the agent version's.
   */
  readonly projectId?: string;
  readonly scope: LiveScope;
  /** The test set to search and prove on. */
  readonly testSetId: string;
  /** `['settings']` (the default): tunable settings values; `['prompt']`: drafted templates (needs `model`). */
  readonly tiers?: readonly ('settings' | 'prompt')[];
  readonly objective?: SuggestedChangeObjective;
  /** Which corrections it learns from. Omit it for the default: everyone's (`as-recorded`) until the test set's project, its tenant, or the agent improved there has an expert group, then only corrections recorded under one (`experts-only`). */
  readonly groupWeights?: 'experts-only' | 'as-recorded';
  /** For a prompt Improve run: the tenant's provider and model that drafts the templates. */
  readonly model?: { readonly providerId: string; readonly model: string };
  /** For a prompt Improve run: how many templates it drafts (1–5, default 3). */
  readonly candidates?: number;
  /** Default: $5 and 30 candidates. */
  readonly budget?: { readonly maxCostUsd?: number; readonly maxCandidates?: number };
  readonly idempotencyKey?: string;
}

/** An Improve run — `@kindgi/api/openapi.json#ImproveRun`. */
export type ImproveRun = import('../generated/api.js').ImproveRun;

/** The input to {@link ImproveRunsClient.check}: the start input without an idempotency key (the check starts nothing). */
export type CheckImproveRunInput = Omit<StartImproveRunInput, 'idempotencyKey'>;

/** An Improve run's cost check — `@kindgi/api/openapi.json#ImproveRunCheck`. */
export type ImproveRunCheck = import('../generated/api.js').ImproveRunCheck;

export interface ImproveRunsListInput {
  readonly limit?: number;
  readonly cursor?: Cursor | string;
  readonly agentId?: AgentId | string;
}

export function makeImproveRunsClient(transport: Transport): ImproveRunsClient {
  return {
    async start(input) {
      const { idempotencyKey, ...body } = input;
      return transport.request<ImproveRun>({
        method: 'POST',
        path: '/v1/improve-runs',
        body: body as unknown as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },

    async check(input) {
      return transport.request<ImproveRunCheck>({
        method: 'POST',
        path: '/v1/improve-runs/check',
        body: input as unknown as Record<string, unknown>,
      });
    },

    async list(input = {}) {
      const page = await transport.request<WirePage<ImproveRun>>({
        method: 'GET',
        path: '/v1/improve-runs',
        query: {
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor as string }),
          ...(input.agentId !== undefined && { agentId: input.agentId as string }),
        },
      });
      return listPage(page);
    },

    async get(improveRunId) {
      return transport.request<ImproveRun>({
        method: 'GET',
        path: `/v1/improve-runs/${encodeURIComponent(improveRunId)}`,
      });
    },

    async cancel(improveRunId, input = {}) {
      return transport.request<ImproveRun>({
        method: 'POST',
        path: `/v1/improve-runs/${encodeURIComponent(improveRunId)}/cancel`,
        body: {},
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      });
    },
  };
}
