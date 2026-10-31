// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor } from '@kindgi/types';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { SuggestedChangeObjective } from '../types.js';

/**
 * Improve runs (`/v1/improve-runs`): the runtime takes a project's
 * corrections, looks for better wording or settings values for an agent
 * there, and writes a change that does better as a suggested change
 * (`client.suggestedChanges`). Check one, start it and read it back. A
 * finished Improve run's `outcome` names the suggested change it wrote, or
 * says why it wrote none.
 */
export interface ImproveRunsClient {
  /**
   * Start an Improve run for an agent in a project: from the version the
   * project runs, it tries new wording (the prompt tier) or settings values
   * (the settings tier) on the project's test set, within the budget. Its
   * best change is proven on every case of the test set, and it's kept only
   * when it passes more cases than that version and fails none that passed.
   * Answers at once with the Improve run, `running`
   * (`client.improveRuns.get`).
   *
   * The readiness check ({@link ImproveRunsClient.check}) runs first: a
   * `409 improve-not-ready` lists every missing item in `fields.items`
   * ({@link ImproveReadinessItem}), and a `409 improve-run-running` names the
   * agent's running Improve run in the project (`fields.improveRunId`): one
   * runs at a time.
   *
   * @wire `POST /v1/improve-runs`
   */
  start(input: StartImproveRunInput): Promise<ImproveRun>;

  /**
   * Whether an Improve run {@link ImproveRunsClient.start} with this input would
   * start is ready, and what it's estimated to cost, before you start it.
   * `items` lists everything an Improve run needs, missing or not, each
   * missing one with its fix; `estimate.costUsd` is `min(budget.maxCostUsd,
   * the replay count times the version's mean cost over its recent completed
   * runs)`, absent when the version has no cost history; `month` is this UTC
   * month's spend against the agent and project's Improve schedule's cap,
   * when there's one. It starts nothing and takes no idempotency key.
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
  /**
   * The project the Improve run works in: it starts from the version the
   * project runs, learns from the project's corrections, and searches and
   * proves on the project's test set.
   */
  readonly projectId: string;
  /**
   * What it tries, the prompt tier first: `prompt` (a model drafts new
   * wording for the prompt block) and `settings` (values for the settings
   * Improve may tune). Default: every tier that's ready.
   */
  readonly tiers?: readonly ('settings' | 'prompt')[];
  readonly objective?: SuggestedChangeObjective;
  /** Which corrections it learns from. Omit it for the default: everyone's (`as-recorded`) until the tenant, the project, or the agent in the project has an expert group, then only corrections recorded under one (`experts-only`). */
  readonly groupWeights?: 'experts-only' | 'as-recorded';
  /** For the prompt tier: the tenant's provider and model that drafts the templates. Default: the model of the version's own model-settings block. */
  readonly model?: { readonly providerId: string; readonly model: string };
  /** For the prompt tier: how many templates it drafts (1–5). Default: the runtime's. */
  readonly candidates?: number;
  /** Default: $5 and 30 candidates. */
  readonly budget?: { readonly maxCostUsd?: number; readonly maxCandidates?: number };
  readonly idempotencyKey?: string;
}

/** An Improve run — `@kindgi/api/openapi.json#ImproveRun`. */
export type ImproveRun = import('../generated/api.js').ImproveRun;

/** The input to {@link ImproveRunsClient.check}: the start input without an idempotency key (the check starts nothing). */
export type CheckImproveRunInput = Omit<StartImproveRunInput, 'idempotencyKey'>;

/** An Improve run's readiness and cost estimate — `@kindgi/api/openapi.json#ImproveRunCheck`. */
export type ImproveRunCheck = import('../generated/api.js').ImproveRunCheck;

/**
 * One thing an Improve run needs, as {@link ImproveRunCheck}'s `items` and a
 * `409 improve-not-ready`'s `fields.items` list it — `@kindgi/api/openapi.json#ImproveReadinessItem`.
 */
export type ImproveReadinessItem = import('../generated/api.js').ImproveReadinessItem;

export interface ImproveRunsListInput {
  readonly limit?: number;
  readonly cursor?: Cursor | string;
  readonly agentId?: AgentId | string;
  /** Only the Improve runs in this project. */
  readonly projectId?: string;
  /** Only the Improve runs with this status. */
  readonly status?: ImproveRun['status'];
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
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          ...(input.status !== undefined && { status: input.status }),
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
