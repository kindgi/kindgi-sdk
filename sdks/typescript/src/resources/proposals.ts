// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId } from '@kindgi/types';

import type { LiveScope } from '../generated/api.js';

import type { Transport } from '../transport.js';
import type { SuggestedChangeObjective } from '../types.js';

/**
 * Improve runs, started under `/v1/proposals/improve` for now: the runtime
 * looks for better values and writes its best candidate as a suggested
 * change (`client.suggestedChanges`).
 */
export interface ProposalsClient {
  /**
   * Start an improvement pass: the runtime looks for better values for the
   * version's tunable settings (`x-kindgi-tunable`) on the test set, within
   * the budget, and writes its best candidate as a suggested change. Answers at
   * once with the pass, `running` (`client.improvementPasses.get`).
   *
   * @wire `POST /v1/proposals/improve`
   */
  improve(input: ImproveInput): Promise<ImprovementPass>;

  /**
   * What a pass {@link ProposalsClient.improve} with this input would start is
   * estimated to cost, before you start it: `min(budget.maxCostUsd, the replay
   * count times the version's mean cost over its recent completed runs)`.
   * `estimatedCostUsd` is absent when the version has no cost history. It starts
   * nothing and takes no idempotency key.
   *
   * @wire `POST /v1/proposals/improve/estimate`
   */
  improveEstimate(input: ImproveEstimateInput): Promise<ImprovementPassEstimate>;
}

export interface ImproveInput {
  readonly agentId: AgentId | string;
  /** Default: the version serving `scope`. */
  readonly fromVersion?: string;
  /**
   * The project the pass works in: the test sets it may use, and where
   * its eval runs run. Default: the scope's project, else (a tenant or
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
  /** For a prompt pass: the tenant's provider and model that drafts the templates. */
  readonly model?: { readonly providerId: string; readonly model: string };
  /** For a prompt pass: how many templates it drafts (1–5, default 3). */
  readonly candidates?: number;
  /** Default: $5 and 30 candidates. */
  readonly budget?: { readonly maxCostUsd?: number; readonly maxCandidates?: number };
  readonly idempotencyKey?: string;
}

/** An improvement pass — `@kindgi/api/openapi.json#ImprovementPass`. */
export type ImprovementPass = import('../generated/api.js').ImprovementPass;

/** The input to {@link ProposalsClient.improveEstimate}: the start input without an idempotency key (the estimate starts nothing). */
export type ImproveEstimateInput = Omit<ImproveInput, 'idempotencyKey'>;

/** An improvement-pass cost estimate — `@kindgi/api/openapi.json#ImprovementPassEstimate`. */
export type ImprovementPassEstimate = import('../generated/api.js').ImprovementPassEstimate;

export function makeProposalsClient(transport: Transport): ProposalsClient {
  return {
    async improve(input) {
      const { idempotencyKey, ...body } = input;
      return transport.request<ImprovementPass>({
        method: 'POST',
        path: '/v1/proposals/improve',
        body: body as unknown as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },

    async improveEstimate(input) {
      return transport.request<ImprovementPassEstimate>({
        method: 'POST',
        path: '/v1/proposals/improve/estimate',
        body: input as unknown as Record<string, unknown>,
      });
    },
  };
}
