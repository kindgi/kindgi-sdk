// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Providers — tenant-mutable model-routing catalog. CRUD.
 *
 * @wire /v1/providers/*  (packages/api/src/routes/providers.ts)
 * @generated Wire shapes from `../generated/api.js`.
 *
 * Distinct from `client.adapters` (deployment-wired infrastructure
 * inventory, read-only + smoke-test): adapters = static deployment
 * inventory; providers = dynamic tenant catalog.
 */

import type {
  ProviderCapabilitiesResult,
  ProviderCollectionPage,
  ProviderMetadata,
  RegisterProviderBody,
  RegisterProviderResult,
  UnregisterProviderResult,
} from '../generated/api.js';
import type { Transport } from '../transport.js';

export type Provider = ProviderMetadata;
export type ProviderPage = ProviderCollectionPage;
export type ProviderCapabilities = ProviderCapabilitiesResult;
export type RegisterProviderInput = RegisterProviderBody;
export type RegisterProviderOutcome = RegisterProviderResult;
export type UnregisterProviderOutcome = UnregisterProviderResult;

export interface ListProvidersFilter {
  readonly limit?: number;
  readonly cursor?: string;
  readonly feature?: string;
}

export interface ProvidersClient {
  /** @wire POST /v1/providers */
  register(
    input: RegisterProviderInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<RegisterProviderOutcome>;
  /** @wire GET /v1/providers */
  list(filter?: ListProvidersFilter): Promise<ProviderPage>;
  /** @wire GET /v1/providers/:providerId */
  get(providerId: string): Promise<Provider>;
  /** @wire GET /v1/providers/:providerId/capabilities */
  capabilities(providerId: string): Promise<ProviderCapabilities>;
  /** @wire POST /v1/providers/:providerId/unregister */
  unregister(
    providerId: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<UnregisterProviderOutcome>;
}

export function makeProvidersClient(transport: Transport): ProvidersClient {
  const seg = (s: string): string => encodeURIComponent(s);
  return {
    async register(input, options) {
      return transport.request<RegisterProviderOutcome>({
        method: 'POST',
        path: '/v1/providers',
        body: input,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
    async list(filter) {
      return transport.request<ProviderPage>({
        method: 'GET',
        path: '/v1/providers',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor }),
          ...(filter?.feature !== undefined && { feature: filter.feature }),
        },
      });
    },
    async get(providerId) {
      return transport.request<Provider>({
        method: 'GET',
        path: `/v1/providers/${seg(providerId)}`,
      });
    },
    async capabilities(providerId) {
      return transport.request<ProviderCapabilities>({
        method: 'GET',
        path: `/v1/providers/${seg(providerId)}/capabilities`,
      });
    },
    async unregister(providerId, options) {
      return transport.request<UnregisterProviderOutcome>({
        method: 'POST',
        path: `/v1/providers/${seg(providerId)}/unregister`,
        ...(options?.idempotencyKey !== undefined && { idempotencyKey: options.idempotencyKey }),
      });
    },
  };
}
