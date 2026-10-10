// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor, FixProposalId } from '@kindgi/types';

import type { LiveScope } from '../generated/api.js';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  FixProposal,
  FixProposalStatus,
  ProposalContent,
  ProposalObjective,
  ProposalTier,
} from '../types.js';
import { scopeQuery } from './agents.js';

/**
 * Improvement proposals (`/v1/proposals`): new content for one data block
 * an agent version pins (settings values, or a prompt template), for one
 * live scope. A proposal is evaluated on a test set (a comparison of the
 * candidate version), then requested: a promotion of the candidate for
 * the scope, through the scope's gate. `status` is derived by the server.
 *
 * ```ts
 * const p = await client.proposals.create({
 *   agentId: 'acme.scorer',
 *   fromVersion: '1.4.0',
 *   scope: { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] },
 *   tier: 'settings-block',
 *   change: { blockId: 'acme.scoring-weights', content: { values: { recency: 0.4, fit: 0.6 } } },
 *   hypothesis: 'Recent filings matter more for this company',
 * });
 * await client.proposals.evaluate(p.id, { suiteId: 'acme.scoring-judged' });
 * // …once `status` is `evaluated`:
 * await client.proposals.request(p.id);
 * ```
 */
export interface ProposalsClient {
  /**
   * Newest first; only proposals of agents the caller can read.
   *
   * @wire `GET /v1/proposals`
   */
  list(input?: ProposalsListInput): Promise<ListPage<FixProposal>>;

  /** @wire `GET /v1/proposals/{proposalId}` */
  get(id: FixProposalId | string): Promise<FixProposal>;

  /**
   * A hand-written proposal (a `draft`). The same change from the same
   * version for the same scope returns the proposal made before.
   *
   * @wire `POST /v1/proposals`
   */
  create(input: CreateProposalInput): Promise<FixProposal>;

  /**
   * Compare the proposal on a test set. The first evaluation publishes the
   * block version and derives the agent version (they serve no scope until
   * promoted); it needs a live version of the agent for the whole tenant.
   * Returns the proposal, `evaluating`.
   *
   * @wire `POST /v1/proposals/{proposalId}/evaluate`
   */
  evaluate(id: FixProposalId | string, input: EvaluateProposalInput): Promise<FixProposal>;

  /**
   * Rescore the latest evaluation, after people judged the comparison's new
   * answers on its replay runs: a new comparison that scores the same
   * replays again, counting those judgments. It becomes the proposal's
   * evaluation; the run rescored stays as it was. Returns the proposal,
   * `evaluating`.
   *
   * @wire `POST /v1/proposals/{proposalId}/rescore`
   */
  rescore(
    id: FixProposalId | string,
    input?: { readonly idempotencyKey?: string },
  ): Promise<FixProposal>;

  /**
   * A promotion of the candidate for the proposal's scope, through its
   * gate: the proposal, `promoted` or `in-review`. A gate refusal throws
   * (`gate-failed`, with the checks).
   *
   * @wire `POST /v1/proposals/{proposalId}/request`
   */
  request(id: FixProposalId | string, input?: ProposalReasonInput): Promise<FixProposal>;

  /**
   * The scope goes back to what served it before the proposal's promotion.
   *
   * @wire `POST /v1/proposals/{proposalId}/rollback`
   */
  rollback(id: FixProposalId | string, input?: ProposalReasonInput): Promise<FixProposal>;

  /** @wire `POST /v1/proposals/{proposalId}/withdraw` */
  withdraw(id: FixProposalId | string, input: WithdrawInput): Promise<FixProposal>;

  /**
   * Start an improvement pass: the runtime looks for better values for the
   * version's tunable settings (`x-kindgi-tunable`) on the test set, within
   * the budget, and writes its best candidate as a proposal. Answers at
   * once with the pass, `running` (`client.improvementPasses.get`).
   *
   * @wire `POST /v1/proposals/improve`
   */
  improve(input: ImproveInput): Promise<ImprovementPass>;
}

export interface ImproveInput {
  readonly agentId: AgentId | string;
  /** Default: the version serving `scope`. */
  readonly fromVersion?: string;
  readonly scope: LiveScope;
  /** The test set to search and prove on. */
  readonly suiteId: string;
  /** `['settings']` (the default): tunable settings values; `['prompt']`: drafted templates (needs `model`). */
  readonly tiers?: readonly ('settings' | 'prompt')[];
  readonly objective?: ProposalObjective;
  /** Which judgments it learns from. Default `restricted-only`: trusted ones. */
  readonly classWeights?: 'restricted-only' | 'as-recorded';
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

export interface ProposalsListInput {
  readonly limit?: number;
  readonly cursor?: Cursor | string;
  readonly agentId?: AgentId | string;
  readonly tier?: ProposalTier;
  /** Statuses are derived, so a page filtered by status can hold fewer rows than `limit`. */
  readonly status?: FixProposalStatus;
  /** Only proposals for exactly this live scope. */
  readonly scope?: LiveScope;
}

export interface CreateProposalInput {
  readonly agentId: AgentId | string;
  /** The agent version the change applies to. */
  readonly fromVersion: string;
  /** The live scope it's for. */
  readonly scope: LiveScope;
  readonly tier: ProposalTier;
  /** A block `fromVersion` pins, and its new content. */
  readonly change: { readonly blockId: string; readonly content: ProposalContent };
  /** What the change should improve, and why. */
  readonly hypothesis: string;
  readonly evidence?: { readonly judgmentIds?: readonly string[] };
  readonly idempotencyKey?: string;
}

export interface EvaluateProposalInput {
  /** The test set: a judged eval suite. */
  readonly suiteId: string;
  /** Default `weightedYesShare`. */
  readonly objective?: ProposalObjective;
  readonly reads?: 'recorded' | 'live';
  readonly repetitions?: number;
  readonly k?: number;
  readonly classWeights?: 'as-recorded' | 'restricted-only';
  /** Only part of the test set: the hold-out part proves a candidate (a gate refuses the search part). */
  readonly sample?: {
    readonly part: 'search' | 'hold-out';
    readonly seed: string;
    readonly holdOutShare: number;
  };
  readonly idempotencyKey?: string;
}

export interface ProposalReasonInput {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface WithdrawInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

const seg = (id: FixProposalId | string): string => encodeURIComponent(id as string);

export function makeProposalsClient(transport: Transport): ProposalsClient {
  const post = (req: { path: string; body: object; idempotencyKey: string | undefined }) =>
    transport.request<FixProposal>({
      method: 'POST',
      path: req.path,
      body: req.body as Record<string, unknown>,
      ...(req.idempotencyKey !== undefined && { idempotencyKey: req.idempotencyKey }),
    });

  return {
    async list(input = {}) {
      const page = await transport.request<WirePage<FixProposal>>({
        method: 'GET',
        path: '/v1/proposals',
        query: {
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor as string }),
          ...(input.agentId !== undefined && { agentId: input.agentId as string }),
          ...(input.tier !== undefined && { tier: input.tier }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.scope !== undefined && scopeQuery(input.scope)),
        },
      });
      return listPage(page);
    },

    async get(id) {
      return transport.request<FixProposal>({ method: 'GET', path: `/v1/proposals/${seg(id)}` });
    },

    async create(input) {
      const { idempotencyKey, ...body } = input;
      return transport.request<FixProposal>({
        method: 'POST',
        path: '/v1/proposals',
        body: body as unknown as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },

    async evaluate(id, input) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/proposals/${seg(id)}/evaluate`, body, idempotencyKey });
    },

    async rescore(id, input = {}) {
      const { idempotencyKey } = input;
      return post({ path: `/v1/proposals/${seg(id)}/rescore`, body: {}, idempotencyKey });
    },

    async request(id, input = {}) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/proposals/${seg(id)}/request`, body, idempotencyKey });
    },

    async rollback(id, input = {}) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/proposals/${seg(id)}/rollback`, body, idempotencyKey });
    },

    async withdraw(id, input) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/proposals/${seg(id)}/withdraw`, body, idempotencyKey });
    },

    async improve(input) {
      const { idempotencyKey, ...body } = input;
      return transport.request<ImprovementPass>({
        method: 'POST',
        path: '/v1/proposals/improve',
        body: body as unknown as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },
  };
}
