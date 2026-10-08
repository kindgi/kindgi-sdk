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
  SupersedeFactInput,
  WriteFactInput,
} from '../types.js';

/**
 * Memory resource — facts + retrieval.
 *
 * Facts are versioned, typed records scoped to a tenant (and
 * optionally a project, user, thread, end user, …). A fact keeps its id
 * across revisions. Every read sees only the facts the caller may.
 * Retrieval lists facts or searches them by keyword, semantic
 * similarity, or both.
 *
 * Routes:
 *   - `GET    /v1/memory/facts` (cursor-paginated)
 *   - `GET    /v1/memory/facts/{factId}` (`?version`, `?asOf`)
 *   - `GET    /v1/memory/facts/{factId}/revisions`
 *   - `POST   /v1/memory/facts` (returns the created `Fact` with its
 *     server-assigned version)
 *   - `POST   /v1/memory/facts/{factId}/supersede` (the next revision)
 *   - `DELETE /v1/memory/facts/{factId}` (closes the current revision)
 *   - `POST   /v1/memory/facts/{factId}/verify`
 *   - `POST   /v1/memory/retrieve` (`RetrieveIntent` body → `{ results:
 *     RetrievalHit[] }`; not paginated — bounded by `limit`)
 *
 * The `.logs.*` methods have no API routes and throw `not-yet-wired`.
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
   * The fact's current revision; `version` reads one revision, `asOf` the
   * revision current at that time (ISO 8601).
   *
   * @wire `GET /v1/memory/facts/{factId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}/get`.
   */
  read(id: FactId, options?: { readonly version?: number; readonly asOf?: string }): Promise<Fact>;

  /**
   * Every revision of the fact, newest first (superseded and deleted
   * ones included).
   *
   * @wire `GET /v1/memory/facts/{factId}/revisions` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}~1revisions/get`.
   */
  revisions(id: FactId): Promise<readonly Fact[]>;

  /**
   * @wire `GET /v1/memory/facts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts/get`.
   *
   * `filter.type` maps to the wire's `?type=` query param. `filter.scope`
   * is serialized as a JSON-encoded `?scope=` query param per the
   * server-side parser (`parseScopeParam`). `filter.asOf` lists memory
   * as it stood then.
   */
  list(filter?: FactFilter): Promise<ListPage<Fact>>;

  /**
   * Change a fact's content: writes the next revision (same id) and
   * returns it. `input.expectVersion` refuses with `409 fact-changed` if
   * someone changed it first; a fact under legal hold refuses with
   * `409 legal-hold`.
   *
   * @wire `POST /v1/memory/facts/{factId}/supersede` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}~1supersede/post`.
   */
  supersede(
    id: FactId,
    input: SupersedeFactInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<Fact>;

  /**
   * Delete a fact: closes its current revision (returned). Reads no
   * longer see it; its history stays until the retention sweep.
   *
   * @wire `DELETE /v1/memory/facts/{factId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}/delete`.
   */
  delete(id: FactId, options?: { readonly expectVersion?: number }): Promise<Fact>;

  /**
   * Mark a fact verified (a person who may write in its scope checked
   * it): returns the next revision, with `trust: 'verified'`.
   *
   * @wire `POST /v1/memory/facts/{factId}/verify` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1memory~1facts~1{factId}~1verify/post`.
   */
  verify(
    id: FactId,
    options?: { readonly expectVersion?: number; readonly idempotencyKey?: string },
  ): Promise<Fact>;
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

      async read(id, options) {
        return transport.request<Fact>({
          method: 'GET',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}`,
          query: {
            ...(options?.version !== undefined && { version: options.version }),
            ...(options?.asOf !== undefined && { asOf: options.asOf }),
          },
        });
      },

      async revisions(id) {
        const envelope = await transport.request<{ readonly data: readonly Fact[] }>({
          method: 'GET',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}/revisions`,
        });
        return envelope.data;
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
            ...(filter?.asOf !== undefined && { asOf: filter.asOf }),
          },
        });
        return listPage(page);
      },

      async supersede(id, input, options) {
        return transport.request<Fact>({
          method: 'POST',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}/supersede`,
          body: input,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      async delete(id, options) {
        return transport.request<Fact>({
          method: 'DELETE',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}`,
          query: {
            ...(options?.expectVersion !== undefined && { expectVersion: options.expectVersion }),
          },
        });
      },

      async verify(id, options) {
        return transport.request<Fact>({
          method: 'POST',
          path: `/v1/memory/facts/${encodeURIComponent(id as unknown as string)}/verify`,
          body: {
            ...(options?.expectVersion !== undefined && { expectVersion: options.expectVersion }),
          },
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
