// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `OrgBinding` — CRUD surface for the `Org` primitive within a tenant.
 *
 * Conventions shared by every binding in this package:
 * - Every method takes `tenantId: TenantId` as its first argument. The
 *   binding is responsible for enforcing tenant isolation: a call from
 *   tenant A must never surface a row from tenant B.
 * - `list` returns the shared `Page<T>` envelope from
 *   `@kindgi/types` (`items` + `nextCursor`).
 * - `list` filters extend the shared `Filter` shape so every list call
 *   shares the same pagination fields.
 * - A write the caller can get wrong (a slug already taken, a row that
 *   doesn't exist) resolves to an outcome — a union discriminated on
 *   `kind`, `'ok'` on success — and never rejects for it. Each
 *   non-`ok` `kind` is also the API error code the routes answer with
 *   (`slug-conflict` is a 409, `org-not-found` a 404). A rejected
 *   promise means the backend failed.
 *
 * This package ships the interface + reference in-memory adapter
 * (in `./in-memory/org-binding.ts`). Any adapter can be checked with
 * the conformance suite in `packages/platform/tests/`
 * (`runOrgBindingConformance`).
 */

import type { Filter, OrgId, Page, TenantId } from '@kindgi/types';

import type { Org, OrgPatch, OrgSpec } from './types.js';

/**
 * `list` filter for orgs. Extends the shared `Filter` with `orgs`-
 * specific facets. Every additional field on the list contract lives
 * here (not on the method signature) so the shape survives SDK codegen
 * unchanged.
 *
 * - `nameContains` — case-sensitive substring match on `Org.name`.
 *   Optional; absent = no name filter. The `@kindgi/api` orgs route
 *   exposes it as `?nameContains=`.
 */
export interface OrgListFilter extends Filter {
  readonly nameContains?: string;
}

/**
 * The org CRUD binding. Framework consumers implement one of these
 * per persistence backend (Postgres, in-memory for tests).
 */
export interface OrgBinding {
  /**
   * Create a new `Org` in the given tenant. Resolves to `ok` with the
   * freshly-assigned `OrgId`, or to `slug-conflict` when another org in
   * the tenant has `spec.slug`. The binding is responsible for
   * allocating IDs, timestamps, and slug-uniqueness enforcement within
   * the tenant.
   */
  create(tenantId: TenantId, spec: OrgSpec): Promise<OrgCreateOutcome>;
  /**
   * Look up an `Org` by id. Returns `undefined` when no row exists in
   * the given tenant, or when the row exists in a different tenant
   * (tenant isolation is by construction, never a silent leak).
   */
  get(tenantId: TenantId, orgId: OrgId): Promise<Org | undefined>;
  /**
   * Cursor-paginated list of orgs within a tenant. Uses the shared
   * `Page<Org>` envelope from `@kindgi/types` — consumers loop on
   * `nextCursor` until it's absent.
   */
  list(tenantId: TenantId, filter: OrgListFilter): Promise<Page<Org>>;
  /**
   * Partially update an `Org`. Fields absent from `patch` are left
   * unchanged; fields present are set to the new value. Resolves to
   * `org-not-found` when no org has `orgId` in the tenant, and to
   * `slug-conflict` when `patch.slug` is another org's slug.
   */
  update(tenantId: TenantId, orgId: OrgId, patch: OrgPatch): Promise<OrgUpdateOutcome>;
  /**
   * Delete an `Org`. Cascade semantics (dependent teams / projects) are
   * a storage-layer concern — the in-memory adapter does the delete
   * unconditionally.
   */
  delete(tenantId: TenantId, orgId: OrgId): Promise<void>;
}

/** What `OrgBinding.create` did. */
export type OrgCreateOutcome =
  | { readonly kind: 'ok'; readonly orgId: OrgId }
  | {
      /** Another org in the tenant already has this slug. */
      readonly kind: 'slug-conflict';
      readonly slug: string;
    };

/** What `OrgBinding.update` did. */
export type OrgUpdateOutcome =
  | { readonly kind: 'ok' }
  | {
      /** No org with this id in the tenant. */
      readonly kind: 'org-not-found';
    }
  | {
      /** Another org in the tenant already has the patched slug. */
      readonly kind: 'slug-conflict';
      readonly slug: string;
    };
