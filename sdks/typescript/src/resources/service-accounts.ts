// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Cursor } from '@kindgi/types';

import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  CreateServiceAccountInput,
  ServiceAccount,
  ServiceAccountGrantInput,
  ServiceAccountGrantTarget,
} from '../types.js';

/**
 * Service accounts resource: named, non-human principals for an app, a
 * pipeline or a schedule, with grants of their own. They act through API
 * keys: `tokens.create({ for: { kind: 'service-account', id } })`. Tenant
 * admins only.
 */
export interface ServiceAccountsClient {
  /**
   * Create one with its first grants, written before it is returned.
   * Names are unique among active accounts (`409 service-account-name-taken`).
   *
   * @wire `POST /v1/service-accounts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1service-accounts/post`.
   */
  create(
    input: CreateServiceAccountInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ServiceAccount>;

  /**
   * Oldest first; active only unless `includeUnregistered`.
   *
   * @wire `GET /v1/service-accounts` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1service-accounts/get`.
   */
  list(filter?: ServiceAccountFilter): Promise<ListPage<ServiceAccount>>;

  /**
   * One account, also an unregistered one.
   *
   * @wire `GET /v1/service-accounts/{serviceAccountId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1service-accounts~1{serviceAccountId}/get`.
   */
  get(serviceAccountId: string): Promise<ServiceAccount>;

  /**
   * Add a grant: tenant admin, or a role on a project (replacing the
   * account's role there).
   *
   * @wire `POST /v1/service-accounts/{serviceAccountId}/grant` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1service-accounts~1{serviceAccountId}~1grant/post`.
   */
  grant(
    serviceAccountId: string,
    grant: ServiceAccountGrantInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ServiceAccount>;

  /**
   * Remove a grant; a no-op when the account does not hold it.
   *
   * @wire `POST /v1/service-accounts/{serviceAccountId}/ungrant` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1service-accounts~1{serviceAccountId}~1ungrant/post`.
   */
  ungrant(
    serviceAccountId: string,
    grant: ServiceAccountGrantTarget,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ServiceAccount>;

  /**
   * Unregister it: its grants go and its keys stop working; it stays
   * readable. Idempotent.
   *
   * @wire `POST /v1/service-accounts/{serviceAccountId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1service-accounts~1{serviceAccountId}~1unregister/post`.
   */
  unregister(
    serviceAccountId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ServiceAccount>;
}

export interface ServiceAccountFilter {
  readonly limit?: number;
  readonly cursor?: Cursor;
  /** Unregistered accounts too. */
  readonly includeUnregistered?: boolean;
}

export function makeServiceAccountsClient(transport: Transport): ServiceAccountsClient {
  const withKey = (options?: { readonly idempotencyKey?: string }) =>
    options?.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {};

  return {
    async create(input, options) {
      return transport.request<ServiceAccount>({
        method: 'POST',
        path: '/v1/service-accounts',
        body: input,
        ...withKey(options),
      });
    },

    async list(filter) {
      const page = await transport.request<WirePage<ServiceAccount>>({
        method: 'GET',
        path: '/v1/service-accounts',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.includeUnregistered === true && { includeUnregistered: 'true' }),
        },
      });
      return listPage(page);
    },

    async get(serviceAccountId) {
      return transport.request<ServiceAccount>({
        method: 'GET',
        path: `/v1/service-accounts/${encodeURIComponent(serviceAccountId)}`,
      });
    },

    async grant(serviceAccountId, grant, options) {
      return transport.request<ServiceAccount>({
        method: 'POST',
        path: `/v1/service-accounts/${encodeURIComponent(serviceAccountId)}/grant`,
        body: grant,
        ...withKey(options),
      });
    },

    async ungrant(serviceAccountId, grant, options) {
      return transport.request<ServiceAccount>({
        method: 'POST',
        path: `/v1/service-accounts/${encodeURIComponent(serviceAccountId)}/ungrant`,
        body: grant,
        ...withKey(options),
      });
    },

    async unregister(serviceAccountId, options) {
      return transport.request<ServiceAccount>({
        method: 'POST',
        path: `/v1/service-accounts/${encodeURIComponent(serviceAccountId)}/unregister`,
        body: {},
        ...withKey(options),
      });
    },
  };
}
