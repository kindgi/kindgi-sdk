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
 *
 * On a runtime serving one tenant, the deployment's own token is the
 * system principal on `/v1/system/keys` alone, where it mints, lists and
 * revokes the system keys (`TokenResolution.systemKeysOperator`), and a
 * system key holds `system:license` alone: it reads the deployment's
 * license, nothing else.
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
 * `kindgi:system` holds them all, but for one read. None of them reads
 * customer content (runs, conversations, memory, files);
 * `system:tenants:contacts` reads account contacts only, and
 * `system:pack-env` reads the env values a deployment's pack declares. Its
 * secrets' values are given only when asked (`?secrets=values`), each
 * audited, and only to a key holding `system:pack-env` itself, never to
 * one holding `kindgi:system`.
 */
export const SYSTEM_SCOPES = [
  /** Create, list, read, rename and close tenants. */
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
  /**
   * The plain env values each deployment's pack declares, to give its pack
   * service, and what its service runs on. On a key of its own: the
   * deployments key can't read a value.
   */
  'system:pack-env',
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

/**
 * The one system scope a system key holds on a runtime serving one tenant:
 * its license, for the renewal job that sends the deployment's use.
 */
export const ONE_TENANT_SYSTEM_SCOPES: readonly SystemScope[] = ['system:license'];

/**
 * Whether `path` is `/v1/system/keys` or under it: where, serving one
 * tenant, the deployment's own token is the system principal.
 */
export function isSystemKeysPath(path: string): boolean {
  return path === '/v1/system/keys' || path.startsWith('/v1/system/keys/');
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
}[] = [
  { method: 'GET', path: '/v1/license', scope: 'system:license' },
  { method: 'GET', path: '/v1/license/usage', scope: 'system:license' },
];
