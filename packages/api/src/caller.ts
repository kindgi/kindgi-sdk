// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context } from 'hono';

import { ref } from '@kindgi/authz';

import type { Authorizer } from './middleware/authorize.js';
import type { TokenPrincipal } from './token-admin.js';
import type { AppEnv } from './types.js';

/**
 * Whom the request acts for, as an API key names it: the person when the
 * token names one; otherwise the service account an API key acts for,
 * else the key itself (a key store built before principals).
 */
export function callerPrincipal(c: Context<AppEnv>): TokenPrincipal | undefined {
  const userId = c.get('userId');
  if (userId !== undefined) return { kind: 'user', userId: userId as unknown as string };
  const serviceAccountId = c.get('serviceAccountId') ?? (c.get('tokenId') as string | undefined);
  if (serviceAccountId !== undefined) return { kind: 'service-account', serviceAccountId };
  return undefined;
}

/**
 * Whether the caller is a tenant admin: `admin` on the tenant when
 * authorization is on, otherwise the `tenant-admin` scope. Never through
 * a `member` key or a key limited to a project (see the authorizer).
 */
export async function isTenantAdmin(
  c: Context<AppEnv>,
  authorizer: Authorizer | undefined,
): Promise<boolean> {
  if (authorizer !== undefined) {
    const tenantId = c.get('tenantId') as unknown as string;
    return authorizer.can(c, 'admin', ref('tenant', tenantId));
  }
  return (
    (c.get('scopes') ?? []).includes('tenant-admin') &&
    c.get('tokenRole') !== 'member' &&
    c.get('tokenProjectId') === undefined
  );
}

/** A principal on the wire: `{kind: 'user' | 'service-account', id}`. */
export function principalToWire(p: TokenPrincipal): {
  kind: 'user' | 'service-account';
  id: string;
} {
  return p.kind === 'user'
    ? { kind: 'user', id: p.userId }
    : { kind: 'service-account', id: p.serviceAccountId };
}

/** The caller as a principal reference: `user:<id>` or `service_account:<id>`. */
export function callerRef(c: Context<AppEnv>): string | undefined {
  const caller = callerPrincipal(c);
  if (caller === undefined) return undefined;
  return caller.kind === 'user'
    ? `user:${caller.userId}`
    : `service_account:${caller.serviceAccountId}`;
}
