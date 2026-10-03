// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Filter, FlowId, Page } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
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
   * @wire `GET /v1/flows` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows/get`.
   */
  list(filter?: FlowFilter): Promise<Page<Flow>>;

  /**
   * Historical versions of a flow.id.
   *
   * @wire `GET /v1/flows/{flowId}/versions` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}~1versions/get`.
   */
  versions(id: FlowId, filter?: PageFilter): Promise<Page<Flow>>;

  /**
   * Fetch a specific version of a flow.
   *
   * @wire `GET /v1/flows/{flowId}/versions/{version}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}~1versions~1{version}/get`.
   */
  getVersion(id: FlowId, version: string): Promise<Flow>;

  /**
   * Unregister a specific version (an explicit version is required —
   * flows are versioned). Historical runs remain in the journal; only
   * future `runs.start` calls against this `(flowId, version)` fail
   * with `not-found/flow`.
   *
   * @wire `POST /v1/flows/{flowId}/versions/{version}/unregister` —
   *   see `@kindgi/api/openapi.json#/paths/~1v1~1flows~1{flowId}~1versions~1{version}~1unregister/post`.
   */
  delete(
    id: FlowId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;

  /**
   * Un-tombstone a previously-unregistered version — the reverse of
   * `delete`. Idempotent — reinstating an active version returns
   * `wasTombstoned: false`.
   *
   * @wire `POST /v1/flows/{flowId}/versions/{version}/reinstate`
   */
  reinstateVersion(
    id: FlowId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstateFlowVersionResult>;
}

export interface ReinstateFlowVersionResult {
  readonly flowId: FlowId;
  readonly version: string;
  readonly wasTombstoned: boolean;
}

export interface FlowFilter extends Filter {
  /** Prefix filter on flow id (matches the server's `?name=` query). */
  readonly name?: string;
}

export interface PageFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
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

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

interface PublishFlowWire {
  readonly flowId: string;
  readonly version: string;
}

export function makeFlowsClient(transport: Transport): FlowsClient {
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
      const page = await transport.request<WirePage<Flow>>({
        method: 'GET',
        path: '/v1/flows',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.name !== undefined && { name: filter.name }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && {
          nextCursor: page.nextCursor as unknown as Cursor,
        }),
      };
    },

    async versions(id, filter) {
      const page = await transport.request<WirePage<Flow>>({
        method: 'GET',
        path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
        },
      });
      return {
        items: page.data,
        ...(page.nextCursor !== undefined && {
          nextCursor: page.nextCursor as unknown as Cursor,
        }),
      };
    },

    async getVersion(id, version) {
      return transport.request<Flow>({
        method: 'GET',
        path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}`,
      });
    },

    async delete(id, version, options) {
      await transport.request<{
        readonly flowId: string;
        readonly version: string;
        readonly unregistered: true;
      }>({
        method: 'POST',
        path: `/v1/flows/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/unregister`,
        body: {},
        discardResponse: true,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async reinstateVersion(id, version, options) {
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
  };
}
