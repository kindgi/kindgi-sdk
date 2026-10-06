// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { FactId, LogEntryId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  AppendLogInput,
  Fact,
  FactFilter,
  LogEntry,
  LogFilter,
  LogVerifyResult,
  RetrievalResult,
  SearchInput,
  WriteFactInput,
} from '../types.js';

/**
 * Memory resource — facts + retrieval.
 *
 * Facts are versioned, typed records scoped to a tenant (and
 * optionally a project, user, thread, …). Retrieval lists facts or
 * searches them by keyword, semantic similarity, or both.
 *
 * Routes:
 *   - `GET  /v1/memory/facts` (cursor-paginated)
 *   - `GET  /v1/memory/facts/{factId}`
 *   - `POST /v1/memory/facts` (returns the created `Fact` with its
 *     server-assigned version)
 *   - `POST /v1/memory/facts/{factId}/supersede` (soft delete)
 *   - `POST /v1/memory/retrieve` (`RetrieveIntent` body → `{ results:
 *     RetrievalHit[] }`; not paginated — bounded by `limit`)
 *
 * The `.logs.*` methods have no API routes and throw `not-yet-wired`.
 *
 * `.facts.delete` maps to the `supersede` route (facts are append-only
 * on the wire) and returns its envelope (`{ factId, superseded: true }`).
 *
 * `.search` returns a bounded array, not a paginated page.
 */
export interface MemoryClient {
  readonly facts: FactsClient;
  readonly logs: LogsClient;

  /**
   * Retrieve facts. `mode` selects the search: `list` (no query),
   * `keyword` (full-text), `semantic` (vector similarity) or `both`.
   * Results are filtered by `type` / `scope` and ranked, each with a
   * `score` except in `list` mode.
   *
   * @wire `POST /v1/memory/retrieve` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1retrieve/post`.
   *
   * Returns a bounded array, not a paginated page (retrieval is best-N;
   * use `limit` on `SearchInput`).
   */
  search(input: SearchInput): Promise<readonly RetrievalResult[]>;
}

export interface FactsClient {
  /**
   * Write a fact. Server assigns the numeric `version`; retention
   * defaults to tenant policy when omitted. Returns the created
   * `Fact`.
   *
   * @wire `POST /v1/memory/facts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts/post`.
   */
  write(input: WriteFactInput, options?: { readonly idempotencyKey?: string }): Promise<Fact>;

  /**
   * @wire `GET /v1/memory/facts/{factId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}/get`.
   */
  read(id: FactId): Promise<Fact>;

  /**
   * @wire `GET /v1/memory/facts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts/get`.
   *
   * `filter.type` maps to the wire's `?type=` query param. `filter.scope`
   * is serialized as a JSON-encoded `?scope=` query param per the
   * server-side parser (`parseScopeParam`).
   */
  list(filter?: FactFilter): Promise<ListPage<Fact>>;

  /**
   * Soft-delete a fact via supersession. Facts are append-only on the
   * wire. Returns the wire envelope `{ factId, superseded: true }`;
   * unknown ids fail with `404 fact-not-found`.
   *
   * @wire `POST /v1/memory/facts/{factId}/supersede` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}~1supersede/post`.
   */
  delete(
    id: FactId,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly factId: FactId; readonly superseded: true }>;
}

export interface LogsClient {
  /**
   * @unwired No `POST /v1/memory/logs` route.
   */
  append(input: AppendLogInput): Promise<LogEntryId>;

  /**
   * @unwired No `GET /v1/memory/logs` route.
   */
  list(filter?: LogFilter): Promise<ListPage<LogEntry>>;

  /**
   * @unwired No `POST /v1/memory/logs/verify` route. Verifying the
   *   hash chain needs the log entries, which the API does not
   *   expose.
   */
  verify(entries: readonly LogEntry[]): Promise<LogVerifyResult>;
}

interface WireRetrieveResult {
  readonly results: readonly RetrievalResult[];
}

export function makeMemoryClient(transport: Transport): MemoryClient {
  return {
    facts: {
      async write(input, options) {
        return transport.request<Fact>({
          method: 'POST',
          path: '/v1/memory/facts',
          body: input,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      async read(id) {
        return transport.request<Fact>({
          method: 'GET',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}`,
        });
      },

      async list(filter) {
        const page = await transport.request<WirePage<Fact>>({
          method: 'GET',
          path: '/v1/memory/facts',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
            ...(filter?.type !== undefined && { type: filter.type }),
            ...(filter?.scope !== undefined && { scope: JSON.stringify(filter.scope) }),
          },
        });
        return listPage(page);
      },

      async delete(id, options) {
        return transport.request<{
          readonly factId: FactId;
          readonly superseded: true;
        }>({
          method: 'POST',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}/supersede`,
          body: {},
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },
    },

    logs: {
      async append(_input) {
        throw new KindgiApiError(
          notYetWired(
            'memory.logs.append',
            'no POST /v1/memory/logs route on the API — append-only log HTTP surface has not landed (runtime primitive exists in-process)',
          ),
        );
      },
      async list(_filter) {
        throw new KindgiApiError(
          notYetWired(
            'memory.logs.list',
            'no GET /v1/memory/logs route on the API — log HTTP surface has not landed',
          ),
        );
      },
      async verify(_entries) {
        throw new KindgiApiError(
          notYetWired(
            'memory.logs.verify',
            'no POST /v1/memory/logs/verify route on the API — log HTTP surface has not landed; verification is client-side callable in principle but requires logs.list first',
          ),
        );
      },
    },

    async search(input) {
      const envelope = await transport.request<WireRetrieveResult>({
        method: 'POST',
        path: '/v1/memory/retrieve',
        body: input,
      });
      return envelope.results;
    },
  };
}
