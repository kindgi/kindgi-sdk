// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { TenantId } from '@kindgi/types';

/**
 * The deployment's operator, acting in no tenant: a system key
 * (`kgi_sy_…`), or the deployment's own token on a runtime that serves
 * many tenants. Present on a request's `TokenResolution` (`system`) and
 * as `c.get('systemPrincipal')`.
 *
 * A system principal reaches `/v1/system/*` and the routes in
 * `SYSTEM_PRINCIPAL_ALLOWED_ROUTES`, nothing else: every other route
 * answers `403 system-key-on-tenant-route` before its code runs.
 */
export interface SystemPrincipal {
  /** The system key's id, or `boot` for the deployment's own token. */
  readonly keyId: string;
}

/**
 * The tenant a system principal's requests resolve to. No tenant has
 * it, so a tenant-scoped read under it sees nothing (row-level security)
 * and a write fails at the tenant foreign key. A runtime refuses it as a
 * configured tenant id.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-4000-8000-000000000000' as TenantId;

/** The capability that holds every system scope: the deployment's own token's. */
export const FULL_SYSTEM_CAPABILITY = 'kindgi:system';

/**
 * The scopes a system key can hold, each the least one service needs.
 * `kindgi:system` holds them all. None of them reads customer content
 * (runs, conversations, secrets, memory, files); `system:tenants:contacts`
 * reads account contacts only.
 */
export const SYSTEM_SCOPES = [
  /** Create, list, read and close tenants. */
  'system:tenants',
  /**
   * Create tenants only, each with a first admin, production blocked, no
   * image prefix and not a test tenant: sign-up's, on the public surface.
   */
  'system:tenants:create',
  /** A tenant's image repository: who binds its slot. Changing one already set takes `kindgi:system`. */
  'system:tenants:image-prefix',
  /** A tenant's "production allowed" switch. */
  'system:tenants:production',
  /** A tenant's limits. */
  'system:tenants:limits',
  /** A tenant's admins' contact addresses, for service notices. */
  'system:tenants:contacts',
  /** Purging a closed tenant. */
  'system:tenants:purge',
  /** Suspending and restoring a tenant, a project or a pack. */
  'system:suspend',
  /** The packs' deployments and their endpoints. */
  'system:deployments',
  /** Usage across tenants: counts and sums only. */
  'system:usage:read',
  /** The deployment's license: reading it, for its renewal. */
  'system:license',
] as const;

export type SystemScope = (typeof SYSTEM_SCOPES)[number];

const SYSTEM_SCOPE_SET: ReadonlySet<string> = new Set(SYSTEM_SCOPES);

export function isSystemScope(value: string): value is SystemScope {
  return SYSTEM_SCOPE_SET.has(value);
}

/** Whether a capability is the system's: `kindgi:system` or any `system:*`. */
export function isSystemCapability(value: string): boolean {
  return value === FULL_SYSTEM_CAPABILITY || value.startsWith('system:');
}

/** Whether `capabilities` hold `scope`, directly or through `kindgi:system`. */
export function holdsSystemScope(
  capabilities: readonly string[] | undefined,
  scope: SystemScope,
): boolean {
  if (capabilities === undefined) return false;
  return capabilities.includes(FULL_SYSTEM_CAPABILITY) || capabilities.includes(scope);
}

/**
 * The routes outside `/v1/system/*` a system principal may call: the
 * deployment's own, not a tenant's. Each names the scope it needs besides
 * `kindgi:system`.
 */
export const SYSTEM_PRINCIPAL_ALLOWED_ROUTES: readonly {
  readonly method: string;
  readonly path: string;
  readonly scope: SystemScope;
}[] = [{ method: 'GET', path: '/v1/license', scope: 'system:license' }];
