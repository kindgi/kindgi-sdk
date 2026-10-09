// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AgentId, Cursor } from '@kindgi/types';

import type { ImprovementPass } from '../generated/api.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';

/**
 * Improvement passes (`/v1/improvement-passes`): started with
 * `client.proposals.improve`, read back here. A finished pass's `outcome`
 * names the proposal it wrote, or says it found nothing better.
 */
export interface ImprovementPassesClient {
  /**
   * Newest first; only passes of agents the caller can read.
   *
   * @wire `GET /v1/improvement-passes`
   */
  list(input?: ImprovementPassesListInput): Promise<ListPage<ImprovementPass>>;

  /** @wire `GET /v1/improvement-passes/{passId}` */
  get(passId: string): Promise<ImprovementPass>;

  /**
   * Stop a running pass: it ends `cancelled`, writing no proposal.
   *
   * @wire `POST /v1/improvement-passes/{passId}/cancel`
   */
  cancel(passId: string, input?: { readonly idempotencyKey?: string }): Promise<ImprovementPass>;
}

export interface ImprovementPassesListInput {
  readonly limit?: number;
  readonly cursor?: Cursor | string;
  readonly agentId?: AgentId | string;
}

export function makeImprovementPassesClient(transport: Transport): ImprovementPassesClient {
  return {
    async list(input = {}) {
      const page = await transport.request<WirePage<ImprovementPass>>({
        method: 'GET',
        path: '/v1/improvement-passes',
        query: {
          ...(input.limit !== undefined && { limit: input.limit }),
          ...(input.cursor !== undefined && { cursor: input.cursor as string }),
          ...(input.agentId !== undefined && { agentId: input.agentId as string }),
        },
      });
      return listPage(page);
    },

    async get(passId) {
      return transport.request<ImprovementPass>({
        method: 'GET',
        path: `/v1/improvement-passes/${encodeURIComponent(passId)}`,
      });
    },

    async cancel(passId, input = {}) {
      return transport.request<ImprovementPass>({
        method: 'POST',
        path: `/v1/improvement-passes/${encodeURIComponent(passId)}/cancel`,
        body: {},
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      });
    },
  };
}
