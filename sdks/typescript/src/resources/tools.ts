// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Page, ToolId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type { Tool } from '../types.js';

/**
 * Tools resource — discovery + versioned lifecycle.
 *
 * The wire `Tool` shape is the MCP-compatible manifest (`ToolManifest`
 * in `@kindgi/tools`). Direct invocation outside a run (`invoke`) and a
 * separate `manifests` endpoint have no API routes.
 *
 * Versioned CRUD mirroring the pattern used by
 * agents/flows/policies/eval-suites. Tools carry an
 * exact semver `version`; agent bindings reference tools by a semver
 * range; the server resolves the range at run start.
 */
export interface ToolsClient {
  /**
   * Paginated list of tools available in the caller's tenant. Only
   * currently-active tools appear (i.e., tools with at least one
   * non-tombstoned version). Fully-retired tools drop from the list
   * but retain their identity — `get(id)` still resolves them to a
   * 410 gone.
   *
   * @wire `GET /v1/tools` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tools/get`.
   */
  list(filter?: ToolFilter): Promise<Page<Tool>>;

  /**
   * Fetch the latest active version of a tool.
   *
   * Retirement is derived: when all versions are unregistered, the
   * head row persists but `latestVersion` goes NULL — GET returns
   * `410 tool-gone`. `404 tool-not-found` means the id was never
   * registered. Distinct signals so callers can decide whether to
   * publish new bytes vs. reinstate a tombstoned version.
   *
   * @wire `GET /v1/tools/{toolId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1tools~1{toolId}/get`.
   */
  get(id: ToolId): Promise<Tool>;

  /** A tool's versions: list, get, unregister and reinstate. */
  readonly versions: ToolVersionsClient;

  /** @deprecated Use `tools.versions.list`; removed in 0.2. */
  listVersions(id: ToolId, filter?: ToolVersionFilter): Promise<Page<ToolVersionRow>>;
  /** @deprecated Use `tools.versions.get`; removed in 0.2. */
  getVersion(id: ToolId, version: string): Promise<Tool>;
  /** @deprecated Use `tools.versions.reinstate`; removed in 0.2. */
  reinstateVersion(
    id: ToolId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateToolVersionResult>;
  /** @deprecated Use `tools.versions.unregister`; removed in 0.2. */
  unregisterVersion(
    id: ToolId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterToolVersionResult>;

  /**
   * @unwired No `POST /v1/tools/{toolId}/invoke` route; tools run
   *   inside agent and flow runs.
   */
  invoke(id: ToolId, input: unknown): Promise<never>;

  /**
   * @unwired No separate manifests route — the wire `Tool` shape is
   *   the manifest; use `list`.
   */
  manifests(filter?: ToolFilter): Promise<never>;
}

export interface ToolVersionsClient {
  /**
   * Cursor-paginated list of tool versions. Defaults to active-only.
   * Pass `filter.includeTombstoned = true` to include soft-tombstoned
   * versions alongside active ones — tombstoned rows carry an
   * `unregisteredAt` ISO timestamp; active rows do not.
   *
   * @wire `GET /v1/tools/{toolId}/versions`
   */
  list(id: ToolId, filter?: ToolVersionFilter): Promise<Page<ToolVersionRow>>;
  /**
   * Fetch a specific tool version by exact semver. Returns
   * `404 tool-not-found` when the (id, version) pair isn't registered
   * under this tenant.
   *
   * @wire `GET /v1/tools/{toolId}/versions/{version}`
   */
  get(id: ToolId, version: string): Promise<Tool>;
  /**
   * Tombstone a specific version. Reversible via `tools.versions.reinstate`.
   * Idempotent — repeat call returns `unregistered: false`.
   *
   * @wire `POST /v1/tools/{toolId}/versions/{version}/unregister`
   */
  unregister(
    id: ToolId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterToolVersionResult>;
  /**
   * Un-tombstone a specific previously-unregistered version.
   * Restores the manifest bytes verbatim (semver hygiene: reinstate
   * never mutates). Recomputes the tool's latest active version.
   * Idempotent — reinstating an active version
   * returns `wasTombstoned: false`.
   *
   * Reinstating any version of a fully-retired tool reactivates the
   * identity. Publish always works too — this verb is for restoring
   * previously-published bytes; a fresh publish is the way to bring
   * a tool back with new bytes.
   *
   * @wire `POST /v1/tools/{toolId}/versions/{version}/reinstate`
   */
  reinstate(
    id: ToolId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateToolVersionResult>;
}

export interface ToolFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  /** Prefix filter on tool id (matches the server's `?name=` query). */
  readonly name?: string;
}

export interface ToolVersionFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  /**
   * When `true`, include soft-tombstoned versions in the result. Each
   * tombstoned row carries `unregisteredAt` (ISO string); active rows
   * do not. Default: `false` (active-only).
   */
  readonly includeTombstoned?: boolean;
}

/**
 * A row in a `listVersions` response — the standard `Tool` fields plus
 * an optional `unregisteredAt` timestamp, present iff the version has
 * been soft-tombstoned. Callers can ignore the extra field and treat
 * the row as a plain `Tool`.
 */
export type ToolVersionRow = Tool & {
  readonly unregisteredAt?: string;
};

export interface ReinstateToolVersionResult {
  readonly toolId: ToolId;
  readonly version: string;
  readonly wasTombstoned: boolean;
}

export interface UnregisterToolVersionResult {
  readonly toolId: ToolId;
  readonly version: string;
  readonly unregistered: boolean;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

interface ReinstateToolVersionWire {
  readonly toolId: string;
  readonly version: string;
  readonly wasTombstoned: boolean;
}

export function makeToolsClient(transport: Transport): ToolsClient {
  const versions: ToolVersionsClient = {
    async list(id, filter) {
      const page = await transport.request<WirePage<ToolVersionRow>>({
        method: 'GET',
        path: `/v1/tools/${encodeURIComponent(id as unknown as string)}/versions`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.includeTombstoned === true && { includeTombstoned: 'true' }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },

    async get(id, version) {
      return transport.request<Tool>({
        method: 'GET',
        path: `/v1/tools/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}`,
      });
    },

    async reinstate(id, version, options) {
      const wire = await transport.request<ReinstateToolVersionWire>({
        method: 'POST',
        path: `/v1/tools/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/reinstate`,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return {
        toolId: wire.toolId as unknown as ToolId,
        version: wire.version,
        wasTombstoned: wire.wasTombstoned,
      };
    },

    async unregister(id, version, options) {
      const wire = await transport.request<{
        readonly toolId: string;
        readonly version: string;
        readonly unregistered: boolean;
      }>({
        method: 'POST',
        path: `/v1/tools/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/unregister`,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return {
        toolId: wire.toolId as unknown as ToolId,
        version: wire.version,
        unregistered: wire.unregistered,
      };
    },
  };
  return {
    async list(filter) {
      const page = await transport.request<WirePage<Tool>>({
        method: 'GET',
        path: '/v1/tools',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.name !== undefined && { name: filter.name }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && { nextCursor: page.nextCursor as unknown as Cursor }),
      };
    },

    async get(id) {
      return transport.request<Tool>({
        method: 'GET',
        path: `/v1/tools/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    versions,
    listVersions: (id, filter) => versions.list(id, filter),
    getVersion: (id, version) => versions.get(id, version),
    reinstateVersion: (id, version, options) => versions.reinstate(id, version, options),
    unregisterVersion: (id, version, options) => versions.unregister(id, version, options),

    async invoke(_id, _input) {
      throw new KindgiApiError(
        notYetWired(
          'tools.invoke',
          'no POST /v1/tools/{toolId}/invoke route on the API — direct invocation surface unrouted',
        ),
      );
    },

    async manifests(_filter) {
      throw new KindgiApiError(
        notYetWired(
          'tools.manifests',
          'the wire `Tool` is the manifest; the API has no separate manifests endpoint',
        ),
      );
    },
  };
}
