// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type {
  CapabilityDeclaration,
  CapabilityNeed,
  LegacyCapabilitiesProvider as Provider,
  ProviderSpec,
  RouteResult,
} from '../types.js';

/**
 * Capabilities resource — capability declarations + model router +
 * provider configuration.
 *
 * Primitives (`@kindgi/capabilities`): `defineCapability`, `route`,
 * `createProviderRegistry`. Capabilities are declarative constraints
 * (`structured-output`, `vision`, `long-context`, `tool-use`, ...);
 * per-tenant policy filters candidates before selection.
 *
 * The API routes:
 *   - `GET /v1/capabilities` + `GET /v1/capabilities/{id}` (read-only)
 *     — capabilities are framework-declared (closed enum from
 *     `@kindgi/capabilities.FEATURES`); tenants do NOT author them
 *     via the HTTP surface (that would fork the closed-enum feature
 *     set the router depends on).
 *   - `GET /v1/providers` + `GET /v1/providers/{id}` + `POST /v1/providers`
 *     + `POST /v1/providers/{id}/unregister` (full CRUD) — providers
 *     are tenant-owned model endpoints. The same routes back the
 *     top-level `client.providers`.
 *
 * `capabilities.route` (preview routing) and provider `enable` /
 * `disable` have no API route (providers have no active/inactive state
 * — a provider is either registered or unregistered).
 */
export interface CapabilitiesClient {
  /**
   * Catalog of declared capability kinds available for `needs:`
   * declarations. Read-only — capabilities are framework-declared.
   *
   * @wire `GET /v1/capabilities` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1capabilities/get`.
   */
  list(filter?: CapabilityFilter): Promise<ListPage<CapabilityDeclaration>>;

  /**
   * Fetch a single capability declaration by id.
   *
   * @wire `GET /v1/capabilities/{capabilityId}`
   */
  get(capabilityId: string): Promise<CapabilityDeclaration>;

  /**
   * @unwired The API has no `POST /v1/capabilities/route` route;
   *   routing is available only in-process, as `route` from
   *   `@kindgi/capabilities`.
   */
  route(needs: readonly CapabilityNeed[]): Promise<RouteResult>;

  readonly providers: ProvidersClient;
}

export interface ProvidersClient {
  /**
   * Paginated list of registered providers.
   *
   * @wire `GET /v1/providers` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers/get`.
   */
  list(filter?: ProviderFilter): Promise<ListPage<Provider>>;

  /**
   * @wire `GET /v1/providers/{providerId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers~1{providerId}/get`.
   */
  get(id: string): Promise<Provider>;

  /**
   * Register a new provider. Server validates the shape via
   * `@kindgi/capabilities.createProviderRegistry`'s validator and
   * rejects with `409 provider-already-registered` on duplicate id.
   * Credentials do NOT cross the wire — they are bound at deployment
   * boot in the caller-plugged `ProviderRegistryBinding`.
   *
   * @wire `POST /v1/providers` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers/post`.
   */
  configure(
    spec: ProviderSpec,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly providerId: string }>;

  /**
   * List the capabilities exposed by a specific provider (derived from
   * the provider's `features[]` + `capabilityKind`).
   *
   * @wire `GET /v1/providers/{providerId}/capabilities` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers~1{providerId}~1capabilities/get`.
   */
  capabilitiesFor(id: string): Promise<readonly CapabilityDeclaration[]>;

  /**
   * @unwired The API has no `POST /v1/providers/{id}/enable` route —
   *   providers have no active/inactive state (a provider is either
   *   registered or unregistered).
   */
  enable(id: string): Promise<void>;

  /**
   * @unwired The API has no `POST /v1/providers/{id}/disable` route.
   */
  disable(id: string): Promise<void>;

  /**
   * Retire a provider. Idempotent on already-unregistered ids —
   * returns `unregistered: true` in either case; only unknown ids
   * produce a `404 provider-not-found`.
   *
   * @wire `POST /v1/providers/{providerId}/unregister` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers~1{providerId}~1unregister/post`.
   */
  delete(
    id: string,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly providerId: string; readonly unregistered: true }>;
}

export interface CapabilityFilter extends Filter {
  /** Server-side match on `feature` (either a closed enum value or a deployment-declared name). */
  readonly feature?: string;
}

export interface ProviderFilter extends Filter {
  /** Server-side match on any provider whose `features[]` contains this value. */
  readonly feature?: string;
}

export function makeCapabilitiesClient(transport: Transport): CapabilitiesClient {
  return {
    async list(filter) {
      const page = await transport.request<WirePage<CapabilityDeclaration>>({
        method: 'GET',
        path: '/v1/capabilities',
        query: {
          ...(filter?.limit !== undefined && { limit: filter.limit }),
          ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
          ...(filter?.feature !== undefined && { feature: filter.feature }),
        },
      });
      return listPage(page);
    },

    async get(capabilityId) {
      return transport.request<CapabilityDeclaration>({
        method: 'GET',
        path: `/v1/capabilities/${encodeURIComponent(capabilityId)}`,
      });
    },

    async route(_needs) {
      throw new KindgiApiError(
        notYetWired(
          'capabilities.route',
          'no POST /v1/capabilities/route route on the API — preview routing is a runtime primitive without an HTTP surface yet',
        ),
      );
    },

    providers: {
      async list(filter) {
        const page = await transport.request<WirePage<Provider>>({
          method: 'GET',
          path: '/v1/providers',
          query: {
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
            ...(filter?.feature !== undefined && { feature: filter.feature }),
          },
        });
        return listPage(page);
      },

      async get(id) {
        return transport.request<Provider>({
          method: 'GET',
          path: `/v1/providers/${encodeURIComponent(id)}`,
        });
      },

      async configure(spec, options) {
        return transport.request<{ readonly providerId: string }>({
          method: 'POST',
          path: '/v1/providers',
          body: spec,
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },

      async capabilitiesFor(id) {
        const envelope = await transport.request<{
          readonly data: readonly CapabilityDeclaration[];
        }>({
          method: 'GET',
          path: `/v1/providers/${encodeURIComponent(id)}/capabilities`,
        });
        return envelope.data;
      },

      async enable(_id) {
        throw new KindgiApiError(
          notYetWired(
            'capabilities.providers.enable',
            'no POST /v1/providers/{id}/enable route on the API — wire has no active/inactive state',
          ),
        );
      },

      async disable(_id) {
        throw new KindgiApiError(
          notYetWired(
            'capabilities.providers.disable',
            'no POST /v1/providers/{id}/disable route on the API — wire has no active/inactive state',
          ),
        );
      },

      async delete(id, options) {
        return transport.request<{
          readonly providerId: string;
          readonly unregistered: true;
        }>({
          method: 'POST',
          path: `/v1/providers/${encodeURIComponent(id)}/unregister`,
          body: {},
          ...(options?.idempotencyKey !== undefined && {
            idempotencyKey: options.idempotencyKey,
          }),
        });
      },
    },
  };
}
