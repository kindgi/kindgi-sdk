// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { CapabilityKind, Feature } from '@kindgi/capabilities';
import type { Cursor, TenantId } from '@kindgi/types';

/**
 * Caller-plugged surface for the capability catalog — part of the admin
 * control plane.
 *
 * Capabilities are **read-only** over HTTP. They are framework-declared
 * (see `@kindgi/specs/capability.schema.json` + the `FEATURES` enum from
 * `@kindgi/capabilities`) and deployment-extensible at boot time via
 * this binding — never tenant-created via the API. Deployments that
 * expose custom capability kinds (embedding, gpu-compute, sandbox-exec,
 * browser-session, ...) plug a binding that also lists their extensions.
 *
 * Cursors are opaque — the binding chooses its encoding. The API layer
 * only validates round-trip as a string; it never inspects the payload.
 */
export interface CapabilityRegistryBinding {
  /**
   * Cursor-paginated list of capability descriptors. Optional
   * `featureFilter` is a prefix match on `descriptor.feature` — matches
   * the `?feature=` filter shape on the route.
   */
  list(input: CapabilityListInput): Promise<CapabilityPage>;
  /**
   * Fetch a capability descriptor by its id, or `null` when unknown.
   * The route surfaces `null` as `404 capability-not-found`.
   */
  get(input: CapabilityGetInput): Promise<CapabilityDescriptor | null>;
}

/**
 * Wire shape returned by the capability routes. Lean by design — the
 * runtime `Capability` (`@kindgi/capabilities.Capability`) is a
 * declarative query shape (needs / prefer / budget) that agents attach
 * to their spec; that's a different concept from a descriptor entry in
 * the *catalog* of features a deployment supports. The catalog entry
 * carries the identifier + human description + the optional params
 * schema pointer.
 *
 * `id` is caller-chosen — for example `feature:<feature>`
 * (e.g. `feature:tool-use`); deployments that extend
 * the catalog with non-LLM capability kinds may pick other conventions
 * (`kind:embedding`, `kind:sandbox-exec`, ...).
 */
export interface CapabilityDescriptor {
  readonly id: string;
  readonly feature: Feature | string;
  readonly description: string;
  /**
   * Kind of resource the capability targets. Optional — absent value
   * defaults to `'llm-inference'`. Adapters for non-LLM kinds set this
   * explicitly so the catalog can be filtered by kind downstream.
   */
  readonly kind?: CapabilityKind;
  /**
   * Optional JSON Schema shape describing the parameters an agent may
   * carry alongside `{ feature }` in a `Requirement`. Opaque to the API
   * layer — the SDK surfaces it for tooling / doc generation.
   */
  readonly paramsSchema?: Readonly<Record<string, unknown>>;
}

export interface CapabilityListInput {
  readonly tenantId: TenantId;
  readonly limit: number;
  readonly cursor?: Cursor;
  /** Prefix match on `CapabilityDescriptor.feature`. */
  readonly featureFilter?: string;
}

export interface CapabilityGetInput {
  readonly tenantId: TenantId;
  readonly capabilityId: string;
}

export interface CapabilityPage {
  readonly data: readonly CapabilityDescriptor[];
  readonly nextCursor?: Cursor;
}
