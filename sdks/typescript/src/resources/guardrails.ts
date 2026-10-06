// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter, GuardrailId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { BuiltInGuardrail, EvaluationResult, Guardrail, GuardrailSpec } from '../types.js';

/**
 * Guardrails resource — declarative rules that gate runs.
 *
 * Declarative check library (`@kindgi/guardrails`: `evaluateGuardrail`,
 * `evaluateAll`). Guardrails are pure functions over run traces (or
 * LLM-judge oracles bundled server-side).
 *
 * SDK exposes:
 *   - **Author + list + get + unregister**: register a new guardrail
 *     against a server-registered `check` implementation; enumerate
 *     the tenant's active set; retire a specific id.
 *
 * Registration is metadata-only (`{id, kind, action, check?, config?,
 * severity?, scope?, budget?, judgeCapabilities?}`), with the `check`
 * string referencing a server-registered implementation. There is no
 * version history or built-in catalog on the API: `versions`,
 * `builtIns`, and `evaluate` throw `not-yet-wired`.
 */
export interface GuardrailsClient {
  /**
   * Author a new guardrail in a project (`options.projectId`, sent
   * next to the spec fields in the request body; `400 bad-input` when it
   * does not name a project in the tenant). Server validates the spec via
   * `@kindgi/guardrails.validateGuardrailSpec` and rejects with
   * `409 guardrail-already-registered` on duplicate id.
   *
   * @wire `POST /v1/guardrails` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1guardrails/post`.
   */
  author(
    spec: GuardrailSpec,
    options: AuthorGuardrailOptions,
  ): Promise<{ readonly guardrailId: GuardrailId }>;

  /**
   * @wire `GET /v1/guardrails/{guardrailId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1guardrails~1{guardrailId}/get`.
   */
  get(id: GuardrailId): Promise<Guardrail>;

  /**
   * @wire `GET /v1/guardrails` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1guardrails/get`.
   */
  list(filter?: GuardrailFilter): Promise<ListPage<Guardrail>>;

  /**
   * Retire a guardrail. Idempotent on already-unregistered ids —
   * returns `unregistered: true` in either case; only unknown ids
   * produce a `404 guardrail-not-found`.
   *
   * @wire `POST /v1/guardrails/{guardrailId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1guardrails~1{guardrailId}~1unregister/post`.
   */
  delete(
    id: GuardrailId,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly guardrailId: GuardrailId; readonly unregistered: true }>;

  /**
   * @unwired The API has no `GET /v1/guardrails/{id}/versions` route —
   *   guardrails are flat metadata registrations (single active spec
   *   per id; supersession via `unregister` + re-`register`), with no
   *   version history.
   */
  versions(id: GuardrailId): Promise<ListPage<Guardrail>>;

  /**
   * @unwired The API has no `GET /v1/guardrails/built-ins` route for
   *   the built-in check catalog.
   */
  builtIns(): Promise<ListPage<BuiltInGuardrail>>;

  /**
   * @unwired The API has no `POST /v1/guardrails/{id}/evaluate`
   *   route — guardrails are evaluated inline during a run
   *   (`evaluateGuardrail` / `evaluateAll` in `@kindgi/guardrails`); the
   *   API has no standalone evaluation route for offline testing or CI.
   */
  evaluate(id: GuardrailId, trace: unknown): Promise<EvaluationResult>;
}

export interface AuthorGuardrailOptions {
  /** Project the guardrail is registered in. `POST /v1/guardrails` requires it. */
  readonly projectId: string;
  readonly idempotencyKey?: string;
}

export interface GuardrailFilter extends Filter {
  /** Server-side prefix match on `name` (guardrail name, NOT id). */
  readonly name?: string;
}

export function makeGuardrailsClient(transport: Transport): GuardrailsClient {
  return {
    async author(spec, options) {
      return transport.request<{ readonly guardrailId: GuardrailId }>({
        method: 'POST',
        path: '/v1/guardrails',
        body: { ...spec, projectId: options.projectId },
        ...(options.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async get(id) {
      return transport.request<Guardrail>({
        method: 'GET',
        path: `/v1/guardrails/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<Guardrail>>({
        method: 'GET',
        path: '/v1/guardrails',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.name !== undefined && { name: filter.name }),
        },
      });
      return listPage(page);
    },

    async delete(id, options) {
      return transport.request<{
        readonly guardrailId: GuardrailId;
        readonly unregistered: true;
      }>({
        method: 'POST',
        path: `/v1/guardrails/${encodeURIComponent(id as unknown as string)}/unregister`,
        body: {},
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },

    async versions(_id) {
      throw new KindgiApiError(
        notYetWired(
          'guardrails.versions',
          'no GET /v1/guardrails/{id}/versions route on the API — wire treats guardrails as flat metadata registrations, no version history',
        ),
      );
    },

    async builtIns() {
      throw new KindgiApiError(
        notYetWired(
          'guardrails.builtIns',
          'no GET /v1/guardrails/built-ins route on the API — built-in catalog is a runtime discovery primitive without an HTTP surface yet',
        ),
      );
    },

    async evaluate(_id, _trace) {
      throw new KindgiApiError(
        notYetWired(
          'guardrails.evaluate',
          'no POST /v1/guardrails/{id}/evaluate route on the API — direct evaluation is a runtime primitive; standalone HTTP evaluation has no wire surface yet',
        ),
      );
    },
  };
}
