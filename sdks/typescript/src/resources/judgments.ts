// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Page } from '@kindgi/types';

import type { ScopeRef } from '../scope-wire.js';
import { scopeToQuery } from '../scope-wire.js';
import type { Transport } from '../transport.js';
import type { CreateJudgmentInput, Judgment, JudgmentWithCopies, Verdict } from '../types.js';

/**
 * Judgments resource: yes or no, with an optional reason, about one item
 * of a finished run's output.
 *
 * Who judged comes from the token you call with, never from the input.
 * Judging again as the same caller for the same run, item key and
 * `participantId` supersedes the earlier judgment, which stays as history.
 */
export interface JudgmentsClient {
  /**
   * Judge an item of a finished run.
   *
   * @wire `POST /v1/judgments` — see `@kindgi/api/openapi.json#/paths/~1v1~1judgments/post`.
   */
  create(
    input: CreateJudgmentInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Judgment>;

  /**
   * Live judgments, newest first.
   *
   * @wire `GET /v1/judgments` — see `@kindgi/api/openapi.json#/paths/~1v1~1judgments/get`.
   */
  list(filter?: JudgmentFilter): Promise<Page<Judgment>>;

  /**
   * One judgment with the stored copies of what was judged.
   *
   * @wire `GET /v1/judgments/{judgmentId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judgments~1{judgmentId}/get`.
   */
  get(judgmentId: string): Promise<JudgmentWithCopies>;

  /**
   * Remove a judgment. Unknown ids fail with `404 judgment-not-found`.
   *
   * @wire `POST /v1/judgments/{judgmentId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1judgments~1{judgmentId}~1unregister/post`.
   */
  unregister(judgmentId: string, options?: { readonly idempotencyKey?: string }): Promise<void>;
}

export interface JudgmentFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly runId?: string;
  readonly agentId?: string;
  /** Needs `agentId`. */
  readonly agentVersion?: string;
  readonly flowId?: string;
  readonly verdict?: Verdict;
  readonly judgeClassId?: string;
  readonly participantId?: string;
  /** Narrow to a project (or org). */
  readonly scope?: ScopeRef;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export function makeJudgmentsClient(transport: Transport): JudgmentsClient {
  return {
    async create(input, options) {
      return transport.request<Judgment>({
        method: 'POST',
        path: '/v1/judgments',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<Judgment>>({
        method: 'GET',
        path: '/v1/judgments',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.runId !== undefined && { runId: filter.runId }),
          ...(filter?.agentId !== undefined && { agentId: filter.agentId }),
          ...(filter?.agentVersion !== undefined && { agentVersion: filter.agentVersion }),
          ...(filter?.flowId !== undefined && { flowId: filter.flowId }),
          ...(filter?.verdict !== undefined && { verdict: filter.verdict }),
          ...(filter?.judgeClassId !== undefined && { judgeClassId: filter.judgeClassId }),
          ...(filter?.participantId !== undefined && { participantId: filter.participantId }),
          ...(filter?.scope !== undefined && scopeToQuery(filter.scope)),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },

    async get(judgmentId) {
      return transport.request<JudgmentWithCopies>({
        method: 'GET',
        path: `/v1/judgments/${encodeURIComponent(judgmentId)}`,
      });
    },

    async unregister(judgmentId, options) {
      await transport.request<{ readonly judgmentId: string; readonly unregistered: true }>({
        method: 'POST',
        path: `/v1/judgments/${encodeURIComponent(judgmentId)}/unregister`,
        body: {},
        discardResponse: true,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
