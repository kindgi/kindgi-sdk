// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Tenant — the caller's current tenant view + config.
 *
 * @wire /v1/tenant/*  (packages/api/src/routes/tenant.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * `.config` is a key/value catalog scoped to the tenant (residency,
 * retention defaults, feature flags, FGA model refs, etc.). Distinct
 * from `env` + `secrets` (those live on their own clients).
 */

import type {
  Tenant,
  TenantConfigCollectionPage,
  TenantConfigKind,
  UpsertTenantConfigBody,
  UpsertTenantConfigResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type TenantInfo = Tenant;
export type TenantConfigPage = TenantConfigCollectionPage;
export type UpsertConfigInput = UpsertTenantConfigBody;
export type UpsertConfigResult = UpsertTenantConfigResult;

export interface ListTenantConfigFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: TenantConfigKind;
  readonly keyPrefix?: string;
}

export interface TenantClient {
  /** @wire GET /v1/tenant */
  get(): Promise<TenantInfo>;
  readonly config: TenantConfigClient;
}

export interface TenantConfigClient {
  /** @wire GET /v1/tenant/config */
  list(filter?: ListTenantConfigFilter): Promise<TenantConfigPage>;
  /** @wire PATCH /v1/tenant/config */
  upsert(
    input: UpsertConfigInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UpsertConfigResult>;
}

export function makeTenantClient(transport: Transport): TenantClient {
  return {
    async get() {
      return transport.request<TenantInfo>({
        method: 'GET',
        path: '/v1/tenant',
      });
    },
    config: {
      async list(filter) {
        return transport.request<TenantConfigPage>({
          method: 'GET',
          path: '/v1/tenant/config',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
            ...(filter?.kind !== undefined && { kind: filter.kind }),
            ...(filter?.keyPrefix !== undefined && { keyPrefix: filter.keyPrefix }),
          },
        });
      },
      async upsert(input, options) {
        return transport.request<UpsertConfigResult>({
          method: 'PATCH',
          path: '/v1/tenant/config',
          body: input,
          ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
        });
      },
    },
  };
}
