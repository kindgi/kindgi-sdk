// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/** Where a tenant stands: `closing` wins over `suspended`; absent is active. */
export interface TenantStateBinding {
  of(tenantId: TenantId): Promise<'active' | 'suspended' | 'closing' | undefined>;
}

/** Methods that change nothing, and deletes: always allowed. */
const ALWAYS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * `POST`s a frozen tenant may still make: reads that are posts, its signed
 * exports, signing in and out, and every way this API deletes, erases and
 * revokes (unregistering is its soft delete). Nothing here creates or
 * changes what the tenant runs. Matched for `POST` only: any other write to
 * these paths is refused.
 */
const ALLOWED_POSTS: readonly RegExp[] = [
  // signing in and out; registering or changing a provider is a write
  /^\/v1\/auth\/(?:token-sign-in|refresh|logout)$/,
  // reads that are posts
  /^\/v1\/memory\/retrieve$/,
  // the signed exports a closing tenant takes away with it
  /^\/v1\/approvals\/[^/]+\/audit-bundle$/,
  /^\/v1\/provenance\/[^/]+\/export$/,
  /^\/v1\/compliance\/evidence\/export$/,
  // erasure, in every state before purge: the runtime processes the data, and
  // an erasure request can't wait on billing or a suspension
  /^\/v1\/memory\/erasures$/,
  /^\/v1\/memory\/erasures\/replay$/,
  /^\/v1\/memory\/erasures\/[^/]+\/resume$/,
  /^\/v1\/retention\/sweep(?:\/[^/]+)?$/,
  // deletes and revocations
  /\/unregister$/,
  /\/revoke$/,
  /\/revoke-sessions$/,
];

const DEFAULT_CACHE_MS = 5_000;
const RETRY_AFTER_S = 5;

/**
 * A closing or suspended tenant is frozen. Its own keys and sessions still
 * read and export it, sign in, and delete, erase and revoke in it, but
 * nothing else changes: `409 tenant-closing` or `409 tenant-suspended`.
 * Nothing new runs, since starting a run is a write.
 *
 * The state is asked of `states` for every principal of a tenant, whatever
 * way it authenticated (a key, a session, SigV4), so a new way in can't skip
 * it. It's cached per tenant for `cacheMs`, so a change of state takes effect
 * within that. A failed lookup refuses the write (`503
 * tenant-state-unavailable`): it fails closed. A system principal is fenced
 * elsewhere. Without `states` (a runtime serving one tenant) nothing is
 * frozen.
 */
export function tenantStateGate(
  states: TenantStateBinding | undefined,
  options: { readonly cacheMs?: number } = {},
): MiddlewareHandler<AppEnv> {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const cache = new Map<string, { readonly state: string | undefined; readonly at: number }>();
  const stateOf = async (lookup: TenantStateBinding, tenantId: TenantId) => {
    const key = tenantId as unknown as string;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < cacheMs) return hit.state;
    const state = await lookup.of(tenantId);
    cache.set(key, { state, at: Date.now() });
    return state;
  };
  return async (c, next) => {
    if (states === undefined || c.get('systemPrincipal') !== undefined) return next();
    const tenantId = c.get('tenantId');
    if (tenantId === undefined) return next();
    const method = c.req.method;
    if (
      ALWAYS.has(method) ||
      (method === 'POST' && ALLOWED_POSTS.some((re) => re.test(c.req.path)))
    ) {
      return next();
    }
    let state: string | undefined;
    try {
      state = await stateOf(states, tenantId);
    } catch (cause) {
      c.get('log').error("could not read the tenant's state; the write is refused", {
        err: cause,
        tenantId,
      });
      c.header('Retry-After', String(RETRY_AFTER_S));
      return answer(
        c,
        'tenant-state-unavailable',
        "This workspace's state can't be read just now, so nothing was changed: try again.",
      );
    }
    if (state !== 'closing' && state !== 'suspended') return next();
    return answer(
      c,
      `tenant-${state}`,
      state === 'closing'
        ? 'This workspace is closing: it can be read and exported until it is deleted, and nothing in it changes.'
        : 'This workspace is suspended: it can be read and exported, and nothing in it changes until it is restored.',
      { state },
    );
  };
}

function answer(
  c: Context<AppEnv>,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Response {
  c.status(statusFor(code) as never);
  // `toWireError` puts every field besides code and message under `details`.
  return c.json(toWireError({ code, message, ...details }, c.get('requestId')));
}
