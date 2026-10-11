// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Filter, FlowId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { Flow } from '../types.js';

/**
 * Flows resource — raw task-flow authoring.
 *
 * Primitives (`@kindgi/flow`): `defineFlow`, `loadFlow`.
 * JSON-serializable structure with `@kindgi/specs/flow.schema.json` as
 * source of truth.
 *
 * A `Flow` is the data-as-code substrate agents get compiled TO.
 * Raw flows — webhook processors,
 * ETL jobs, ingest pipelines, non-agent workflows — go through this
 * resource, then execute via `client.runs.start({ flow, input })`.
 *
 * Register once, execute many times against different inputs. Every
 * registered flow is version-pinned, and a run stays pinned to the
 * flow version it started with: resuming it against a different
 * version fails with `flow-mismatch`.
 */
export interface FlowsClient {
  /**
   * Publish a flow definition into a project (`options.projectId`,
   * sent next to the flow fields in the request body; `400 bad-input`
   * when it does not name a project in the tenant). Server validates against
   * `@kindgi/specs/flow.schema.json` via `@kindgi/flow.loadFlow` (cycles
   * rejected, unresolved node references rejected, unresolved edge
   * references rejected). Validation failures return
   * `400 validation-failed` with issue list under `details.issues`.
   *
   * @wire `POST /v1/flows` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows/post`.
   *
   * Returns `{ flowId, version }` — flows are version-pinned; the caller
   * needs both to construct subsequent `runs.start({ flow, flowVersion })`
   * calls.
   */
  define(
    flow: Flow,
    options: DefineFlowOptions,
  ): Promise<{ readonly flowId: FlowId; readonly version: string }>;

  /**
   * @unwired The API has no `POST /v1/flows/validate` route —
   *   validation happens inline on `define()` (server returns
   *   `400 validation-failed` with the issue list).
   */
  validate(flow: Flow): Promise<FlowValidateResult>;

  /**
   * @wire `GET /v1/flows/{flowId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}/get`.
   */
  get(id: FlowId): Promise<Flow>;

  /**
   * Flows, the latest version of each. `filter.includeRetired = true`
   * lists retired flows too (every version unregistered), each as its
   * highest version with `unregisteredAt`.
   *
   * @wire `GET /v1/flows` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows/get`.
   */
  list(filter?: FlowFilter): Promise<ListPage<FlowVersionRow>>;

  /**
   * A flow's versions: list, get, unregister and reinstate. Calling it
   * directly lists them (deprecated: use `flows.versions.list`).
   */
  readonly versions: FlowVersionsClient;
  /** @deprecated Use `flows.versions.get`; removed in 0.2. */
  getVersion(id: FlowId, version: string): Promise<Flow>;
  /** @deprecated Use `flows.versions.unregister`; removed in 0.2. */
  delete(
    id: FlowId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;
  /** @deprecated Use `flows.versions.reinstate`; removed in 0.2. */
  reinstateVersion(
    id: FlowId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateFlowVersionResult>;
}

export interface FlowVersionsClient {
  /** @deprecated Use `flows.versions.list`; removed in 0.2. */
  (id: FlowId, filter?: PageFilter): Promise<ListPage<Flow>>;
  /**
   * Historical versions of a flow.id: active ones, or with
   * `filter.includeTombstoned = true` unregistered ones too (each with
   * `unregisteredAt`), a retired flow's included.
   *
   * @wire `GET /v1/flows/{flowId}/versions` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}~1versions/get`.
   */
  list(id: FlowId, filter?: FlowVersionFilter): Promise<ListPage<FlowVersionRow>>;
  /**
   * Fetch a specific version of a flow.
   *
   * @wire `GET /v1/flows/{flowId}/versions/{version}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}~1versions~1{version}/get`.
   */
  get(id: FlowId, version: string): Promise<Flow>;
  /**
   * Unregister a specific version (an explicit version is required —
   * flows are versioned). Historical runs remain in the journal; only
   * future `runs.start` calls against this `(flowId, version)` fail
   * with `not-found/flow`. Reversible via `flows.versions.reinstate`.
   *
   * @wire `POST /v1/flows/{flowId}/versions/{version}/unregister` —
   *   see `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}~1versions~1{version}~1unregister/post`.
   */
  unregister(
    id: FlowId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterFlowVersionResult>;
  /**
   * Un-tombstone a previously-unregistered version. Idempotent —
   * reinstating an active version returns `wasTombstoned: false`.
   *
   * @wire `POST /v1/flows/{flowId}/versions/{version}/reinstate`
   */
  reinstate(
    id: FlowId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateFlowVersionResult>;
}

export interface UnregisterFlowVersionResult {
  readonly flowId: FlowId;
  readonly version: string;
  readonly unregistered: boolean;
}

export interface ReinstateFlowVersionResult {
  readonly flowId: FlowId;
  readonly version: string;
  readonly wasTombstoned: boolean;
}

export interface FlowFilter extends Filter {
  /** Prefix filter on flow id (matches the server's `?name=` query). */
  readonly name?: string;
  /**
   * List retired flows too (every version unregistered), each as its
   * highest version with `unregisteredAt`. Default: `false`.
   */
  readonly includeRetired?: boolean;
}

export interface PageFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
}

/**
 * A flow as a list reads it: the standard `Flow` fields plus
 * `unregisteredAt`, present on an unregistered version (a retired
 * flow's, or one `includeTombstoned` lists). Callers can ignore the
 * extra field and treat the row as a plain `Flow`.
 */
export type FlowVersionRow = Flow & {
  readonly unregisteredAt?: string;
};

export interface FlowVersionFilter extends PageFilter {
  /**
   * List unregistered versions too, each with `unregisteredAt`.
   * Default: `false` (active versions only).
   */
  readonly includeTombstoned?: boolean;
}

export interface DefineFlowOptions {
  /** Project the flow is published into. `POST /v1/flows` requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface FlowValidateResult {
  readonly valid: boolean;
  /** JSON-pointer issues if `valid: false`. */
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

interface PublishFlowWire {
  readonly flowId: string;
  readonly version: string;
}

export function makeFlowsClient(transport: Transport): FlowsClient {
  const list: FlowVersionsClient['list'] = async (id, filter) => {
    const page = await transport.request<WirePage<FlowVersionRow>>({
      method: 'GET',
      path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions`,
      query: {
        ...(filter?.limit !== undefined && { limit: filter.limit }),
        ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
        ...(filter?.includeTombstoned === true && { includeTombstoned: 'true' }),
      },
    });
    return listPage(page);
  };
  const versions: FlowVersionsClient = Object.assign(
    (id: FlowId, filter?: PageFilter) => list(id, filter),
    {
      list,
      async get(id: FlowId, version: string) {
        return transport.request<Flow>({
          method: 'GET',
          path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}`,
        });
      },
      async unregister(
        id: FlowId,
        version: string,
        options?: { readonly idempotencyKey?: string },
      ): Promise<UnregisterFlowVersionResult> {
        const wire = await transport.request<{
          readonly flowId: string;
          readonly version: string;
          readonly unregistered: boolean;
        }>({
          method: 'POST',
          path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/unregister`,
          body: {},
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
        return {
          flowId: wire.flowId as unknown as FlowId,
          version: wire.version,
          unregistered: wire.unregistered,
        };
      },
      async reinstate(
        id: FlowId,
        version: string,
        options?: { readonly idempotencyKey?: string },
      ): Promise<ReinstateFlowVersionResult> {
        const wire = await transport.request<{
          readonly flowId: string;
          readonly version: string;
          readonly wasTombstoned: boolean;
        }>({
          method: 'POST',
          path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/reinstate`,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
        return {
          flowId: wire.flowId as unknown as FlowId,
          version: wire.version,
          wasTombstoned: wire.wasTombstoned,
        };
      },
    },
  );
  return {
    async define(flow, options) {
      const result = await transport.request<PublishFlowWire>({
        method: 'POST',
        path: '/v1/flows',
        body: { ...flow, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return {
        flowId: result.flowId as unknown as FlowId,
        version: result.version,
      };
    },

    async validate(_graph) {
      throw new KindgiApiError(
        notYetWired(
          'flows.validate',
          'no POST /v1/flows/validate route on the API — validation is inline on define() (server returns 400 validation-failed)',
        ),
      );
    },

    async get(id) {
      return transport.request<Flow>({
        method: 'GET',
        path: `/v1/flows/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<FlowVersionRow>>({
        method: 'GET',
        path: '/v1/flows',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.name !== undefined && { name: filter.name }),
          ...(filter?.includeRetired === true && { includeRetired: 'true' }),
        },
      });
      return listPage(page);
    },

    versions,
    getVersion: (id, version) => versions.get(id, version),
    async delete(id, version, options) {
      await versions.unregister(id, version, options);
    },
    reinstateVersion: (id, version, options) => versions.reinstate(id, version, options),
  };
}
