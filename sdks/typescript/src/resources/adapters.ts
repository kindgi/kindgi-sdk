// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import { postSse, unwrapSseData } from '../streaming.js';
import type { Transport } from '../transport.js';
import type { Adapter, AdapterKind, AdapterStatus, AdapterTestOutcome } from '../types.js';

/**
 * Progress + terminal events emitted by `adapters.prepare()`. Shape
 * mirrors `@kindgi/capabilities.PrepareEvent` — not imported directly
 * because the SDK does not carry a runtime dep on framework server-side
 * packages. `progress` events populate whichever numeric fields the
 * adapter can report (byte-count download, step-count warmup, etc.);
 * consumers render what's present.
 */
export type PrepareEvent =
  | {
      readonly kind: 'progress';
      readonly message?: string;
      readonly ratio?: number;
      readonly loadedBytes?: number;
      readonly totalBytes?: number;
      readonly file?: string;
    }
  | { readonly kind: 'ready'; readonly message?: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Adapters resource — enumerate wired adapters + probe them. Server
 * routes live in `packages/api/src/routes/adapters.ts`.
 *
 * Adapters are wired at deployment boot (config-as-code) — the SDK
 * does not manage their lifecycle. The API has no routes for adapter
 * discovery (`candidates`) or runtime rebinding (`configure`); use
 * `list` for the wired set.
 */
export interface AdaptersClient {
  /**
   * Paginated list of the adapters this deployment has wired.
   *
   * @wire `GET /v1/adapters` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1adapters/get`.
   */
  list(filter?: AdapterFilter): Promise<ListPage<Adapter>>;

  /**
   * Fetch a single wired adapter.
   *
   * @wire `GET /v1/adapters/{adapterId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1adapters~1{adapterId}/get`.
   */
  get(adapterId: string): Promise<Adapter>;

  /**
   * Run a kind-specific smoke probe. Probe failures return HTTP 200
   * with `ok: false` — a failed probe is a valid observation, not a
   * server error.
   *
   * @wire `POST /v1/adapters/{adapterId}/test` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1adapters~1{adapterId}~1test/post`.
   */
  test(input: AdapterTestInput): Promise<AdapterTestOutcome>;

  /**
   * Pre-warm an adapter — download weights, initialize sessions,
   * whatever the adapter needs before its first model call. Streams
   * `PrepareEvent`s so the caller can render progress. Call this after
   * `providers.register` and before the first `runs.start` — otherwise
   * the first invocation of the provider stalls on lazy download inside
   * the request path.
   *
   * `params` is adapter-specific and passed through verbatim
   * (e.g. `{ model: 'smollm2-360m' }` for the in-process ONNX adapter).
   *
   * Terminal events: `{ kind: 'ready' }` or `{ kind: 'error', message }`.
   * The stream ends after the terminal event; the iterator completes.
   *
   * @wire `POST /v1/adapters/{adapterId}/prepare` — SSE.
   */
  prepare(input: AdapterPrepareInput): AsyncIterable<PrepareEvent>;

  /**
   * @unwired The API has no `/v1/adapters/candidates` route; the
   *   deployment's wired set (`list`) is the source of truth.
   */
  candidates(): Promise<never>;

  /**
   * @unwired The API has no keyed-by-kind view; use `list()` (a
   *   paginated array) instead.
   */
  configured(): Promise<never>;

  /**
   * @unwired Adapters are wired at boot (config-as-code); the API has
   *   no route for rebinding an adapter at runtime.
   */
  configure(input: AdapterConfigureInput): Promise<never>;
}

export interface AdapterFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  readonly kind?: AdapterKind;
  readonly status?: AdapterStatus;
}

export interface AdapterTestInput {
  readonly adapterId: string;
  /**
   * Optional kind-specific probe payload. Omit to let the adapter pick
   * its default probe (e.g. a small model roundtrip for `model` kind).
   */
  readonly probe?: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
}

export interface AdapterPrepareInput {
  readonly adapterId: string;
  /** Adapter-specific parameters. In-process ONNX accepts `{ model }`. */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Cancels the SSE stream mid-flight (aborts the pipeline load). */
  readonly signal?: AbortSignal;
}

export interface AdapterConfigureInput {
  readonly kind: AdapterKind;
  readonly vendor: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export function makeAdaptersClient(transport: Transport): AdaptersClient {
  return {
    async list(filter) {
      const page = await transport.request<WirePage<Adapter>>({
        method: 'GET',
        path: '/v1/adapters',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.kind !== undefined && { kind: filter.kind }),
          ...(filter?.status !== undefined && { status: filter.status }),
        },
      });
      return listPage(page);
    },

    async get(adapterId) {
      return transport.request<Adapter>({
        method: 'GET',
        path: `/v1/adapters/${encodeURIComponent(adapterId)}`,
      });
    },

    async test(input) {
      return transport.request<AdapterTestOutcome>({
        method: 'POST',
        path: `/v1/adapters/${encodeURIComponent(input.adapterId)}/test`,
        body: input.probe ?? {},
        ...(input.idempotencyKey !== undefined && { idempotencyKey: input.idempotencyKey }),
      });
    },

    prepare(input) {
      const url = `${transport.apiUrl}/v1/adapters/${encodeURIComponent(input.adapterId)}/prepare`;
      const source = postSse<PrepareEvent>({
        url,
        headers: transport.authHeaders(),
        fetchImpl: transport.fetchImpl,
        ...(input.params !== undefined && { body: { params: input.params } }),
        ...(input.signal !== undefined && { signal: input.signal }),
      });
      return unwrapSseData(source);
    },

    async candidates() {
      throw new KindgiApiError(
        notYetWired(
          'adapters.candidates',
          'no /v1/adapters/candidates route on the API — deployment-wired set is authoritative, no upstream catalog surface',
        ),
      );
    },

    async configured() {
      throw new KindgiApiError(
        notYetWired(
          'adapters.configured',
          'use adapters.list() — the record-by-kind shape does not map to the wire paginated list',
        ),
      );
    },

    async configure(_input) {
      throw new KindgiApiError(
        notYetWired(
          'adapters.configure',
          'adapters are wired at boot via config-as-code; runtime rebinding requires a platform capability that has not landed',
        ),
      );
    },
  };
}
