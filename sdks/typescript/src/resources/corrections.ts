// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { ScopeRef } from '../scope-wire.js';
import { scopeToQuery } from '../scope-wire.js';
import type { Transport } from '../transport.js';
import type { Correction, CorrectionWithCopies, CreateCorrectionInput, Verdict } from '../types.js';

/**
 * Corrections resource: yes or no, with an optional reason, about one item
 * of a finished run's output.
 *
 * Who corrected comes from the token you call with, never from the input.
 * Correcting again as the same caller for the same run, item key and
 * `participantId` supersedes the earlier correction, which stays as history.
 */
export interface CorrectionsClient {
  /**
   * Correct an item of a finished run.
   *
   * @wire `POST /v1/corrections` — see `@kindgi/api/openapi.json#/paths/~1v1~1corrections/post`.
   */
  create(
    input: CreateCorrectionInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Correction>;

  /**
   * Live corrections, newest first.
   *
   * @wire `GET /v1/corrections` — see `@kindgi/api/openapi.json#/paths/~1v1~1corrections/get`.
   */
  list(filter?: CorrectionFilter): Promise<ListPage<Correction>>;

  /**
   * One correction with the stored copies of what was corrected.
   *
   * @wire `GET /v1/corrections/{correctionId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrections~1{correctionId}/get`.
   */
  get(correctionId: string): Promise<CorrectionWithCopies>;

  /**
   * Remove a correction. Unknown ids fail with `404 correction-not-found`.
   *
   * @wire `POST /v1/corrections/{correctionId}/remove` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrections~1{correctionId}~1remove/post`.
   */
  remove(correctionId: string, options?: { readonly idempotencyKey?: string }): Promise<void>;
}

export interface CorrectionFilter {
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

export function makeCorrectionsClient(transport: Transport): CorrectionsClient {
  return {
    async create(input, options) {
      return transport.request<Correction>({
        method: 'POST',
        path: '/v1/corrections',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<Correction>>({
        method: 'GET',
        path: '/v1/corrections',
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
      return listPage(page);
    },

    async get(correctionId) {
      return transport.request<CorrectionWithCopies>({
        method: 'GET',
        path: `/v1/corrections/${encodeURIComponent(correctionId)}`,
      });
    },

    async remove(correctionId, options) {
      await transport.request<{ readonly correctionId: string; readonly unregistered: true }>({
        method: 'POST',
        path: `/v1/corrections/${encodeURIComponent(correctionId)}/remove`,
        body: {},
        discardResponse: true,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
