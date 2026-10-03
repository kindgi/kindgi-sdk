// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor, Filter, Page, PolicyId } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import type { Transport } from '../transport.js';
import type {
  Policy,
  PolicyDecision,
  PolicyEvaluateInput,
  PolicyKind,
  PolicySpec,
} from '../types.js';

/**
 * Policies resource — versioned tenant policy registry.
 *
 * Each policy carries a `kind` (`access-control`, `model-routing`,
 * `adapter-allowlist`, `rate-limit`, `retention`, `compliance`) and a
 * `spec` object whose shape that kind defines. The API stores and
 * versions policies (semver per id); enforcement happens where each
 * kind is consumed, not in this resource.
 *
 * Routes back `author` (publish), `get`, `list`, `versions`,
 * `getVersion`, `unregister` and `reinstateVersion`. `activate` and
 * `evaluate` have no API route — a policy is active once published.
 */
export interface PoliciesClient {
  /**
   * Publish a policy version. The server validates the top-level
   * shape (id, semver version, `kind`, `spec` object) — failures return
   * `400 validation-failed` with the issue list; deeper validation of
   * `spec` belongs to the consumer of that kind. Publishing the same
   * `(id, version)` twice returns `409 policy-already-registered`.
   *
   * @wire `POST /v1/policies` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1policies/post`.
   *
   * The wire action is publish; there is no draft lifecycle.
   */
  author(
    spec: PolicySpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly policyId: PolicyId; readonly version: string }>;

  /**
   * @wire `GET /v1/policies/{policyId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1policies~1{policyId}/get`.
   */
  get(id: PolicyId): Promise<Policy>;

  /**
   * @wire `GET /v1/policies` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1policies/get`.
   */
  list(filter?: PolicyListFilter): Promise<Page<Policy>>;

  /**
   * Historical versions of a policy.id. Defaults to active-only. Pass
   * `filter.includeTombstoned = true` to include soft-tombstoned rows
   * too — tombstoned rows carry an `unregisteredAt` ISO timestamp,
   * active rows do not.
   *
   * @wire `GET /v1/policies/{policyId}/versions` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1policies~1{policyId}~1versions/get`.
   */
  versions(id: PolicyId, filter?: PolicyVersionsFilter): Promise<Page<PolicyVersionRow>>;

  /**
   * Fetch a specific version of a policy.
   *
   * @wire `GET /v1/policies/{policyId}/versions/{version}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1policies~1{policyId}~1versions~1{version}/get`.
   */
  getVersion(id: PolicyId, version: string): Promise<Policy>;

  /**
   * Unregister a specific version.
   *
   * @wire `POST /v1/policies/{policyId}/versions/{version}/unregister`
   *   — see `@kindgi/api/openapi.json#/paths/~1v1~1policies~1{policyId}~1versions~1{version}~1unregister/post`.
   */
  unregister(
    id: PolicyId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<void>;

  /**
   * Un-tombstone a previously-unregistered version. Idempotent.
   *
   * @wire `POST /v1/policies/{policyId}/versions/{version}/reinstate`
   */
  reinstateVersion(
    id: PolicyId,
    version: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ReinstatePolicyVersionResult>;

  /**
   * @unwired No `POST /v1/policies/{policyId}/activate` route — a
   *   policy is active once published.
   */
  activate(id: PolicyId): Promise<void>;

  /**
   * @unwired No `POST /v1/policies/{policyId}/evaluate` route.
   */
  evaluate(id: PolicyId, input: PolicyEvaluateInput): Promise<PolicyDecision>;
}

export interface PolicyListFilter extends Filter {
  readonly kind?: PolicyKind;
  /** Prefix filter on policy id (matches the server's `?name=` query). */
  readonly name?: string;
}

export interface PolicyVersionsFilter {
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
 * A row in a `versions` response — standard `Policy` fields plus an
 * optional `unregisteredAt` timestamp, present iff the version is
 * soft-tombstoned. Callers can ignore the extra field and treat the
 * row as a plain `Policy`.
 */
export type PolicyVersionRow = Policy & {
  readonly unregisteredAt?: string;
};

export interface ReinstatePolicyVersionResult {
  readonly policyId: PolicyId;
  readonly version: string;
  readonly wasTombstoned: boolean;
}

interface WirePage<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

interface PublishPolicyWire {
  readonly policyId: string;
  readonly version: string;
}

export function makePoliciesClient(transport: Transport): PoliciesClient {
  return {
    async author(spec, options) {
      const result = await transport.request<PublishPolicyWire>({
        method: 'POST',
        path: '/v1/policies',
        body: {
          id: spec.id,
          version: spec.version,
          kind: spec.kind,
          ...(spec.description !== undefined && { description: spec.description }),
          spec: spec.spec,
        },
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return {
        policyId: result.policyId as unknown as PolicyId,
        version: result.version,
      };
    },

    async get(id) {
      return transport.request<Policy>({
        method: 'GET',
        path: `/v1/policies/${encodeURIComponent(id as unknown as string)}`,
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<Policy>>({
        method: 'GET',
        path: '/v1/policies',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.kind !== undefined && { kind: filter.kind }),
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
      const page = await transport.request<WirePage<PolicyVersionRow>>({
        method: 'GET',
        path: `/v1/policies/${encodeURIComponent(id as unknown as string)}/versions`,
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.includeTombstoned === true && { includeTombstoned: 'true' }),
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
      return transport.request<Policy>({
        method: 'GET',
        path: `/v1/policies/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}`,
      });
    },

    async unregister(id, version, options) {
      await transport.request<{
        readonly policyId: string;
        readonly version: string;
        readonly unregistered: true;
      }>({
        method: 'POST',
        path: `/v1/policies/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/unregister`,
        body: {},
        discardResponse: true,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
    },

    async reinstateVersion(id, version, options) {
      const wire = await transport.request<{
        readonly policyId: string;
        readonly version: string;
        readonly wasTombstoned: boolean;
      }>({
        method: 'POST',
        path: `/v1/policies/${encodeURIComponent(id as unknown as string)}/versions/${encodeURIComponent(version)}/reinstate`,
        ...(options?.idempotencyKey !== undefined && {
          idempotencyKey: options.idempotencyKey,
        }),
      });
      return {
        policyId: wire.policyId as unknown as PolicyId,
        version: wire.version,
        wasTombstoned: wire.wasTombstoned,
      };
    },

    async activate(_id) {
      throw new KindgiApiError(
        notYetWired(
          'policies.activate',
          'no POST /v1/policies/{policyId}/activate route on the API — the wire has no draft/active lifecycle; policies are active at publish',
        ),
      );
    },

    async evaluate(_id, _input) {
      throw new KindgiApiError(
        notYetWired(
          'policies.evaluate',
          'no POST /v1/policies/{policyId}/evaluate route on the API — evaluation is a runtime primitive without an SDK surface yet',
        ),
      );
    },
  };
}
