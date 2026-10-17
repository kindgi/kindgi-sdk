// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { AdapterConfig, ProviderMetadata } from '@kindgi/capabilities';
import type { Cursor, TenantId } from '@kindgi/types';

import type { CapabilityDescriptor } from './capability-binding.js';

/**
 * Caller-plugged surface for the model-provider catalog — part of the
 * admin control plane. Full CRUD: tenants register
 * their own providers (hosted model APIs, self-hosted inference servers,
 * embedding backends, sandbox-exec fleets, ...). The runtime's capability
 * router consults the registered set at run time to pick a best-fit
 * provider per capability requirement.
 *
 * `ProviderMetadata` is the **wire shape** — no secrets (API keys,
 * endpoints, credentials) cross the HTTP boundary. Secrets stay inside
 * the binding implementation; the wire surface returns only routing-
 * relevant metadata: provider-level `id` / `region` / `attributes` /
 * `capabilityKind` / `labels` + `models[]` (each entry carries `name`,
 * `contextWindow`, `features`, `cost`, optional `p95LatencyMs`,
 * `maxOutputTokens`, `description`).
 *
 * Every method is tenant-scoped: callers pass `tenantId` explicitly so
 * multi-tenant deployments can partition storage without exposing that
 * scoping inside the API package.
 *
 * Cursors are opaque — the binding chooses its encoding. The API layer
 * only validates round-trip as a string; it never inspects the payload.
 */
export interface ProviderRegistryBinding {
  /**
   * Cursor-paginated list of registered providers. Optional
   * `featureFilter` narrows the result to providers that self-report
   * support for the given capability feature — same semantics as the
   * `?feature=` query param on the route.
   */
  list(input: ProviderListInput): Promise<ProviderPage>;
  /**
   * Fetch a provider by id, or `null` when unknown or unregistered. The
   * route surfaces `null` as `404 provider-not-found`.
   */
  get(input: ProviderGetInput): Promise<ProviderMetadata | null>;
  /**
   * Register a provider under the given tenant. The route validates
   * the wire shape via the `@kindgi/capabilities` runtime rules
   * before calling — the binding receives well-formed metadata.
   * Bindings MAY reject with `already-registered` when the same
   * `providerId` is re-registered; the route maps that to `409`. An
   * unregistered id is free: registering it again makes a new provider.
   */
  register(input: ProviderRegisterInput): Promise<ProviderRegisterOutcome>;
  /**
   * Unregister a provider: a tombstone, not an erase. From then on the
   * provider is gone from `list`, `get`, `capabilitiesFor` and
   * `resolveForRuntime`, and the router never picks it; a retention
   * policy on the `provider` domain purges the row. Returns
   * `{ unregistered: true }` on success; `{ unregistered: false }` when
   * the id was unknown or already unregistered — the route flips the
   * latter to `404`.
   */
  unregister(input: ProviderUnregisterInput): Promise<ProviderUnregisterOutcome>;
  /**
   * Sub-resource: return the catalog capabilities this provider
   * satisfies. Returns `null` when the provider is unknown so the
   * route can flip that to `404 provider-not-found`. An empty array
   * is a valid answer for a known provider with no matches.
   */
  capabilitiesFor(
    input: ProviderCapabilitiesForInput,
  ): Promise<readonly CapabilityDescriptor[] | null>;
  /**
   * Bulk-read for the runtime bridge. Returns every
   * provider registered under `tenantId` bundled with the fields the
   * runtime needs to instantiate a `ModelProvider`: the routing
   * metadata (`metadata`), which adapter package to invoke
   * (`adapterId`), and where to resolve the API key from
   * (`secretRef`, optional).
   *
   * Consumed by the runtime at agent-turn start; separate from `list`
   * because HTTP callers of `list` see only the wire-safe metadata,
   * not the plumbing fields.
   */
  resolveForRuntime(
    input: ProviderResolveForRuntimeInput,
  ): Promise<readonly ProviderRuntimeEntry[]>;
}

export interface ProviderListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /**
   * Filter to providers whose `metadata.features` includes this feature
   * name. Exact match, not prefix — `Feature` is a closed enum, so
   * partial matches would over-match noisily.
   */
  readonly featureFilter?: string;
}

export interface ProviderGetInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
}

export interface ProviderRegisterInput {
  readonly tenantId: TenantId;
  readonly metadata: ProviderMetadata;
  /**
   * Identifies which adapter package instantiates the `ModelProvider`
   * at invoke time (runtime bridge). MUST reference an adapter
   * previously registered for this tenant (see `AdapterRegistryBinding`)
   * — implementations reject an unknown adapter at register time
   * rather than at agent-invoke time.
   */
  readonly adapterId: string;
  /**
   * Optional pointer to the tenant-scoped secret carrying the
   * adapter's credential. Shape: `{envName, name}`. The runtime bridge
   * resolves it through the secrets binding for the calling tenant —
   * tenant scoping applies at resolve time, so this ref is
   * tenant-agnostic. Absent when the adapter needs no external
   * credentials (dev-echo, local models).
   */
  readonly secretRef?: ProviderSecretRef;
  /**
   * The adapter's connection settings (a cloud project, a base URL):
   * flat, non-secret values the adapter factory receives as `config`.
   * Like `secretRef`, plumbing — stored with the provider and handed
   * to the runtime, never returned by `list` / `get`.
   */
  readonly adapterConfig?: AdapterConfig;
  /**
   * Whether the runtime sends each model call's W3C `traceparent` to this
   * provider (as a header; ids only, never content), so the vendor's
   * request logs can be matched to the run. Opt-in: absent or `false`
   * sends none. The runtime enforces it, not the adapter: it sets
   * `ModelCallInput.traceparent` only for a provider that opted in.
   */
  readonly sendTraceparent?: boolean;
}

export interface ProviderSecretRef {
  readonly envName: string;
  readonly name: string;
}

/**
 * Runtime-side persistence view bundled for the runtime bridge.
 * `list`/`get` on the binding return the wire-safe `ProviderMetadata`
 * only; this shape adds the plumbing fields (`adapterId`,
 * `secretRef`) the runtime needs to instantiate a `ModelProvider`.
 *
 * Consumed by the runtime at agent-turn start via
 * `resolveForRuntime`.
 */
export interface ProviderRuntimeEntry {
  readonly metadata: ProviderMetadata;
  readonly adapterId: string;
  readonly secretRef?: ProviderSecretRef;
  readonly adapterConfig?: AdapterConfig;
  /** `ProviderRegisterInput.sendTraceparent`: absent is `false`. */
  readonly sendTraceparent?: boolean;
}

export interface ProviderResolveForRuntimeInput {
  readonly tenantId: TenantId;
  /**
   * Optional capability-kind filter. When present, returns only
   * providers whose declared `capabilityKind` matches — mirrors the
   * router's own kind gate and lets the runtime bridge skip
   * instantiating irrelevant providers.
   */
  readonly capabilityKind?: string;
}

export interface ProviderUnregisterInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
}

export interface ProviderCapabilitiesForInput {
  readonly tenantId: TenantId;
  readonly providerId: string;
}

export interface ProviderPage {
  readonly data: readonly ProviderMetadata[];
  readonly nextCursor?: Cursor;
}

export type ProviderRegisterOutcome =
  | {
      readonly kind: 'ok';
      readonly providerId: string;
    }
  | {
      readonly kind: 'already-registered';
      readonly providerId: string;
    }
  | {
      readonly kind: 'invalid';
      readonly providerId: string;
      readonly message: string;
      readonly reason?: string;
    };

export type ProviderUnregisterOutcome = {
  readonly unregistered: boolean;
};
