// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Filter } from '@kindgi/types';

import { KindgiApiError, notYetWired } from '../errors.js';
import { type ListPage, type WirePage, listPage } from '../list-page.js';
import type { Transport } from '../transport.js';
import type { CapabilityDeclaration, CapabilityNeed, RouteResult } from '../types.js';
import { type Provider, type RegisterProviderInput, makeProvidersClient } from './providers.js';

/**
 * Capabilities resource — capability declarations + model router +
 * provider configuration.
 *
 * Primitives (`@kindgi/capabilities`): `defineCapability`, `route`,
 * `createProviderRegistry`. Capabilities are declarative constraints
 * (`structured-output`, `vision`, `long-context`, `tool-use`, ...);
 * per-workspace policy filters candidates before selection.
 *
 * The API routes:
 *   - `GET /v1/capabilities` + `GET /v1/capabilities/{id}` (read-only)
 *     — capabilities are framework-declared (closed enum from
 *     `@kindgi/capabilities.FEATURES`); tenants do NOT author them
 *     via the HTTP surface (that would fork the closed-enum feature
 *     set the router depends on).
 *   - `GET /v1/providers` + `GET /v1/providers/{id}` + `POST /v1/providers`
 *     + `POST /v1/providers/{id}/unregister` (full CRUD) — providers
 *     are tenant-owned model endpoints, served by the top-level
 *     `client.providers`. The `providers` sub-client here is deprecated:
 *     its methods call `client.providers`'s and answer as they do.
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

  /**
   * @deprecated Use `client.providers`, which these methods call: `list`
   *   is `providers.list`, `get` is `providers.get`, `configure` is
   *   `providers.register`, `capabilitiesFor(id)` is
   *   `(await providers.capabilities(id)).data`, and `delete` is
   *   `providers.unregister`. `enable` and `disable` have none: a
   *   provider has no enabled state, and unregistering removes one.
   */
  readonly providers: ProvidersClient;
}

/** @deprecated Use `client.providers` (`ProvidersClient` from the package). */
export interface ProvidersClient {
  /**
   * Paginated list of registered providers, as the API sends them (each
   * with its `models[]`).
   *
   * @deprecated Use `client.providers.list`.
   * @wire `GET /v1/providers` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers/get`.
   */
  list(filter?: ProviderFilter): Promise<ListPage<Provider>>;

  /**
   * @deprecated Use `client.providers.get`.
   * @wire `GET /v1/providers/{providerId}` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers~1{providerId}/get`.
   */
  get(id: string): Promise<Provider>;

  /**
   * Register a new provider: its routing metadata (`metadata`, with its
   * `models[]`), the adapter that instantiates it (`adapter_id`), and
   * that adapter's plumbing (`secret_ref`, `adapter_config`). A
   * duplicate id answers `409 provider-already-registered`. Credentials
   * never cross the wire: `secret_ref` names the workspace secret that
   * holds one.
   *
   * @deprecated Use `client.providers.register`.
   * @wire `POST /v1/providers` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers/post`.
   */
  configure(
    input: RegisterProviderInput,
    options?: { readonly idempotencyKey?: string },
  ): Promise<{ readonly providerId: string }>;

  /**
   * The catalog capabilities this provider satisfies: the features of
   * its models (`models[].features`), for its `capabilityKind`.
   *
   * @deprecated Use `client.providers.capabilities`, whose `data` this is.
   * @wire `GET /v1/providers/{providerId}/capabilities` — see
   *   `@kindgi/api/openapi.json#/paths/~1v1~1providers~1{providerId}~1capabilities/get`.
   */
  capabilitiesFor(id: string): Promise<readonly CapabilityDeclaration[]>;

  /**
   * @deprecated A provider has no enabled state; unregistering removes one
   *   (`client.providers.unregister`).
   * @unwired The API has no `POST /v1/providers/{id}/enable` route —
   *   providers have no active/inactive state (a provider is either
   *   registered or unregistered).
   */
  enable(id: string): Promise<void>;

  /**
   * @deprecated A provider has no enabled state; unregistering removes one
   *   (`client.providers.unregister`).
   * @unwired The API has no `POST /v1/providers/{id}/disable` route.
   */
  disable(id: string): Promise<void>;

  /**
   * Retire a provider. An unknown or already-unregistered id answers
   * `not-found`, with the resource kind `provider`.
   *
   * @deprecated Use `client.providers.unregister`.
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
  /** Server-side match on any provider with a model whose `features[]` contains this value. */
  readonly feature?: string;
}

export function makeCapabilitiesClient(transport: Transport): CapabilitiesClient {
  const current = makeProvidersClient(transport);
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

    // The deprecated sub-client: `client.providers`'s methods, under the
    // older names.
    providers: {
      async list(filter) {
        return listPage(
          await current.list({
            ...(filter?.limit !== undefined && { limit: filter.limit }),
            ...(filter?.cursor !== undefined && { cursor: filter.cursor as unknown as string }),
            ...(filter?.feature !== undefined && { feature: filter.feature }),
          }),
        );
      },

      async get(id) {
        return current.get(id);
      },

      async configure(input, options) {
        return current.register(input, options);
      },

      async capabilitiesFor(id) {
        return (await current.capabilities(id)).data;
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
        return current.unregister(id, options);
      },
    },
  };
}
