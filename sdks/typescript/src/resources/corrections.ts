// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import { KindgiApiError, fromWire } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { ScopeRef } from '../scope-wire.js';
import { scopeToQuery } from '../scope-wire.js';
import { type QueryValue, type Transport, buildUrl, unwrapErrorEnvelope } from '../transport.js';
import type {
  ChangeCorrectionInput,
  Correction,
  CorrectionCounts,
  CorrectionSortedTo,
  CorrectionStatus,
  CorrectionWithCopies,
  CreateCorrectionInput,
} from '../types.js';

/**
 * Corrections resource: whether a finished run's decisions and answer were
 * right, and what was right instead. Each one is sorted when it's saved
 * (to Improve, to the agent's owner, or left open), and moves through its
 * statuses until it's fixed.
 *
 * Who corrected comes from the token you call with, never from the input.
 * Correcting again as the same caller for the same run and `participantId`
 * supersedes the earlier correction, which stays as history.
 */
export interface CorrectionsClient {
  /**
   * Correct a finished run.
   *
   * @wire `POST /v1/corrections` — see `@kindgi/api/openapi.json#/paths/~1v1~1corrections/post`.
   */
  create(
    input: CreateCorrectionInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Correction>;

  /**
   * Corrections, newest first: removed ones only when `status` asks for `removed`.
   *
   * @wire `GET /v1/corrections` — see `@kindgi/api/openapi.json#/paths/~1v1~1corrections/get`.
   */
  list(filter?: CorrectionFilter): Promise<ListPage<Correction>>;

  /**
   * Every correction of an agent the filters match, streamed as CSV (the
   * default: a header row, then one correction per line) or JSON lines (one
   * correction per line, as `list` returns it). Each comes only when you may
   * read its project, and the server records the export. The run's own text
   * isn't in it, only the run's id.
   *
   * @wire `GET /v1/corrections/export` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrections~1export/get`.
   */
  export(filter: CorrectionExportFilter): Promise<ReadableStream<Uint8Array>>;

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

  /**
   * Re-sort a correction or change its status. A change its status doesn't
   * allow fails with `409 correction-status-change-not-allowed`.
   *
   * @wire `PATCH /v1/corrections/{correctionId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrections~1{correctionId}/patch`.
   */
  change(
    correctionId: string,
    input: ChangeCorrectionInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Correction>;

  /**
   * How many of a project's corrections (or one agent's in it) are in each status.
   *
   * @wire `GET /v1/corrections/counts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1corrections~1counts/get`.
   */
  counts(input: {
    readonly projectId: string;
    readonly agentId?: string;
  }): Promise<CorrectionCounts>;
}

export interface CorrectionFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly runId?: string;
  readonly agentId?: string;
  /** Needs `agentId`. */
  readonly agentVersion?: string;
  readonly flowId?: string;
  /** One or several; `not-fixed` is short for `open`, `being-fixed` and `with-owner`. */
  readonly status?: CorrectionStatus | 'not-fixed' | readonly (CorrectionStatus | 'not-fixed')[];
  /** One or several; `none` for unsorted ones. */
  readonly sortedTo?: CorrectionSortedTo | 'none' | readonly (CorrectionSortedTo | 'none')[];
  /** `experts`, `end-users` or `all` (the default). */
  readonly from?: 'experts' | 'end-users' | 'all';
  /** `me`: only your own corrections. */
  readonly madeBy?: 'me';
  /** Made at or after this time (ISO 8601). */
  readonly since?: string;
  /** Made before this time (ISO 8601). */
  readonly until?: string;
  readonly correctorGroupId?: string;
  readonly participantId?: string;
  /** Narrow to a project (or org). */
  readonly scope?: ScopeRef;
}

/** What `export` takes: the list's filters, with the agent, and no page. */
export interface CorrectionExportFilter
  extends Omit<CorrectionFilter, 'limit' | 'cursor' | 'agentId'> {
  /** The agent whose corrections are exported. */
  readonly agentId: string;
  /** `csv` (the default) or `jsonl`. */
  readonly format?: 'csv' | 'jsonl';
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
          ...filterQuery(filter ?? {}),
        },
      });
      return listPage(page);
    },

    async export(filter) {
      // The body is handed on as it arrives, so this isn't the JSON transport.
      const url = buildUrl(transport.apiUrl, '/v1/corrections/export', {
        ...filterQuery(filter),
        ...(filter.format !== undefined && { format: filter.format }),
      });
      const res = await transport.fetchImpl(url, {
        method: 'GET',
        headers: {
          ...transport.authHeaders(),
          Accept: filter.format === 'jsonl' ? 'application/jsonl' : 'text/csv',
        },
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw new KindgiApiError(fromWire(unwrapErrorEnvelope(body, res.status), res.status));
      }
      return res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
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

    async change(correctionId, input, options) {
      return transport.request<Correction>({
        method: 'PATCH',
        path: `/v1/corrections/${encodeURIComponent(correctionId)}`,
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async counts(input) {
      return transport.request<CorrectionCounts>({
        method: 'GET',
        path: '/v1/corrections/counts',
        query: {
          ...scopeToQuery({ kind: 'project', projectId: input.projectId }),
          ...(input.agentId !== undefined && { agentId: input.agentId }),
        },
      });
    },
  };
}

const many = <T extends string>(v: T | readonly T[]): T[] => (typeof v === 'string' ? [v] : [...v]);

/** The list's filters as query parameters, for `list` and `export`. */
function filterQuery(
  filter: Omit<CorrectionFilter, 'limit' | 'cursor'>,
): Record<string, QueryValue> {
  return {
    ...(filter.runId !== undefined && { runId: filter.runId }),
    ...(filter.agentId !== undefined && { agentId: filter.agentId }),
    ...(filter.agentVersion !== undefined && { agentVersion: filter.agentVersion }),
    ...(filter.flowId !== undefined && { flowId: filter.flowId }),
    ...(filter.status !== undefined && { status: many(filter.status) }),
    ...(filter.sortedTo !== undefined && { sortedTo: many(filter.sortedTo) }),
    ...(filter.from !== undefined && { from: filter.from }),
    ...(filter.madeBy !== undefined && { madeBy: filter.madeBy }),
    ...(filter.since !== undefined && { since: filter.since }),
    ...(filter.until !== undefined && { until: filter.until }),
    ...(filter.correctorGroupId !== undefined && { correctorGroupId: filter.correctorGroupId }),
    ...(filter.participantId !== undefined && { participantId: filter.participantId }),
    ...(filter.scope !== undefined && scopeToQuery(filter.scope)),
  };
}
