// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor, SuggestedChangeId } from '@kindgi/types';

import type { AgentPinScope } from '../generated/api.js';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  SuggestedChange,
  SuggestedChangeContent,
  SuggestedChangeObjective,
  SuggestedChangeStatus,
  SuggestedChangeTier,
} from '../types.js';
import { scopeQuery } from './agents.js';

/**
 * suggested changes (`/v1/suggested-changes`): new content for one data block
 * an agent version pins (settings values, or a prompt template), for one
 * pinned scope. A suggested change is evaluated on a test set (a comparison of the
 * candidate version), then pinned: the candidate version is pinned for
 * the scope, through the scope's gate. `status` is derived by the server.
 *
 * ```ts
 * const p = await client.suggestedChanges.create({
 *   agentId: 'acme.scorer',
 *   fromVersion: '1.4.0',
 *   scope: { kind: 'segment', projectId, path: [{ key: 'company', value: 'acme' }] },
 *   tier: 'settings-block',
 *   change: { blockId: 'acme.scoring-weights', content: { values: { recency: 0.4, fit: 0.6 } } },
 *   why: 'Recent filings matter more for this company',
 * });
 * await client.suggestedChanges.evaluate(p.id, { testSetId: 'acme.scoring-judged' });
 * // …once `status` is `evaluated`:
 * await client.suggestedChanges.pin(p.id);
 * ```
 */
export interface SuggestedChangesClient {
  /**
   * Newest first; only suggested changes of agents the caller can read.
   *
   * @wire `GET /v1/suggested-changes`
   */
  list(input?: SuggestedChangesListInput): Promise<ListPage<SuggestedChange>>;

  /** @wire `GET /v1/suggested-changes/{suggestedChangeId}` */
  get(id: SuggestedChangeId | string): Promise<SuggestedChange>;

  /**
   * A hand-written suggested change (a `draft`). The same change from the same
   * version for the same scope returns the suggested change made before.
   *
   * @wire `POST /v1/suggested-changes`
   */
  create(input: CreateSuggestedChangeInput): Promise<SuggestedChange>;

  /**
   * Compare the suggested change on a test set. The first evaluation publishes the
   * block version and derives the agent version (they serve no scope until
   * pinned); it needs a pinned version of the agent for the whole tenant.
   * Returns the suggested change, `evaluating`.
   *
   * @wire `POST /v1/suggested-changes/{suggestedChangeId}/evaluate`
   */
  evaluate(
    id: SuggestedChangeId | string,
    input: EvaluateSuggestedChangeInput,
  ): Promise<SuggestedChange>;

  /**
   * Rescore the latest evaluation, after people corrected the comparison's new
   * answers on its replay runs: a new comparison that scores the same
   * replays again, counting those corrections. It becomes the suggested change's
   * evaluation; the run rescored stays as it was. Returns the suggested change,
   * `evaluating`.
   *
   * @wire `POST /v1/suggested-changes/{suggestedChangeId}/rescore`
   */
  rescore(
    id: SuggestedChangeId | string,
    input?: { readonly idempotencyKey?: string },
  ): Promise<SuggestedChange>;

  /**
   * A pin of the candidate for the suggested change's scope, through its
   * gate: the suggested change, `pinned` or `in-review`. A gate refusal throws
   * (`gate-failed`, with the checks).
   *
   * @wire `POST /v1/suggested-changes/{suggestedChangeId}/pin`
   */
  pin(id: SuggestedChangeId | string, input?: SuggestedChangeReasonInput): Promise<SuggestedChange>;

  /** @wire `POST /v1/suggested-changes/{suggestedChangeId}/withdraw` */
  withdraw(id: SuggestedChangeId | string, input: WithdrawInput): Promise<SuggestedChange>;
}

export interface SuggestedChangesListInput {
  readonly limit?: number;
  readonly cursor?: Cursor | string;
  readonly agentId?: AgentId | string;
  readonly tier?: SuggestedChangeTier;
  /** Statuses are derived, so a page filtered by status can hold fewer rows than `limit`. */
  readonly status?: SuggestedChangeStatus;
  /** Only suggested changes for exactly this pinned scope. */
  readonly scope?: AgentPinScope;
}

export interface CreateSuggestedChangeInput {
  readonly agentId: AgentId | string;
  /** The agent version the change applies to. */
  readonly fromVersion: string;
  /** The pinned scope it's for. */
  readonly scope: AgentPinScope;
  readonly tier: SuggestedChangeTier;
  /** A block `fromVersion` pins, and its new content. */
  readonly change: { readonly blockId: string; readonly content: SuggestedChangeContent };
  /** What the change should improve, and why. */
  readonly why: string;
  readonly evidence?: { readonly fixes?: readonly string[] };
  readonly idempotencyKey?: string;
}

export interface EvaluateSuggestedChangeInput {
  /** The test set: a corrections test set. */
  readonly testSetId: string;
  /** Default `passRate`. */
  readonly objective?: SuggestedChangeObjective;
  readonly reads?: 'recorded' | 'live';
  readonly repetitions?: number;
  readonly k?: number;
  readonly groupWeights?: 'as-recorded' | 'experts-only';
  /** Only part of the test set: the hold-out part proves a candidate (a gate refuses the search part). */
  readonly sample?: {
    readonly part: 'search' | 'hold-out';
    readonly seed: string;
    readonly holdOutShare: number;
  };
  readonly idempotencyKey?: string;
}

export interface SuggestedChangeReasonInput {
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface WithdrawInput {
  readonly reason: string;
  readonly idempotencyKey?: string;
}

const seg = (id: SuggestedChangeId | string): string => encodeURIComponent(id as string);

export function makeSuggestedChangesClient(transport: Transport): SuggestedChangesClient {
  const post = (req: { path: string; body: object; idempotencyKey: string | undefined }) =>
    transport.request<SuggestedChange>({
      method: 'POST',
      path: req.path,
      body: req.body as Record<string, unknown>,
      ...(req.idempotencyKey !== undefined && { idempotencyKey: req.idempotencyKey }),
    });

  return {
    async list(input = {}) {
      const page = await transport.request<WirePage<SuggestedChange>>({
        method: 'GET',
        path: '/v1/suggested-changes',
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
      return transport.request<SuggestedChange>({
        method: 'GET',
        path: `/v1/suggested-changes/${seg(id)}`,
      });
    },

    async create(input) {
      const { idempotencyKey, ...body } = input;
      return transport.request<SuggestedChange>({
        method: 'POST',
        path: '/v1/suggested-changes',
        body: body as unknown as Record<string, unknown>,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
      });
    },

    async evaluate(id, input) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/suggested-changes/${seg(id)}/evaluate`, body, idempotencyKey });
    },

    async rescore(id, input = {}) {
      const { idempotencyKey } = input;
      return post({ path: `/v1/suggested-changes/${seg(id)}/rescore`, body: {}, idempotencyKey });
    },

    async pin(id, input = {}) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/suggested-changes/${seg(id)}/pin`, body, idempotencyKey });
    },

    async withdraw(id, input) {
      const { idempotencyKey, ...body } = input;
      return post({ path: `/v1/suggested-changes/${seg(id)}/withdraw`, body, idempotencyKey });
    },
  };
}
