// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';
import { errorXml } from '../xml.js';

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

/** How long a tenant's state is kept between reads: a change of state takes effect within it. */
export const TENANT_STATE_CACHE_MS = 5_000;
const RETRY_AFTER_S = 5;

/**
 * A closing or suspended tenant is frozen. Its own keys and sessions still
 * read and export it, sign in, and delete, erase and revoke in it, but
 * nothing else changes: `409 tenant-closing` or `409 tenant-suspended`.
 * Nothing new runs, since starting a run is a write.
 *
 * The state is asked of `states` for every principal of a tenant, whatever
 * way it authenticated (a key, a session, SigV4), so a new way in can't skip
 * it. A system principal is fenced elsewhere. Without `states` (a runtime
 * serving one tenant) nothing is frozen. The state is read with
 * {@link tenantStateReader} and answered with {@link frozenTenantRefusal},
 * which the webhook receiver uses too.
 *
 * On the S3-compatible surface (`surface: 's3'`) it answers in S3's terms,
 * which S3 clients parse: `403 AllAccessDisabled` for a frozen tenant, and
 * `503 ServiceUnavailable` with `Retry-After` when the state can't be read.
 */
export function tenantStateGate(
  states: TenantStateBinding | undefined,
  options: { readonly cacheMs?: number; readonly surface?: 'api' | 's3' } = {},
): MiddlewareHandler<AppEnv> {
  const stateOf = states === undefined ? undefined : tenantStateReader(states, options.cacheMs);
  return async (c, next) => {
    if (stateOf === undefined || c.get('systemPrincipal') !== undefined) return next();
    const tenantId = c.get('tenantId');
    if (tenantId === undefined) return next();
    const method = c.req.method;
    if (
      ALWAYS.has(method) ||
      (method === 'POST' && ALLOWED_POSTS.some((re) => re.test(c.req.path)))
    ) {
      return next();
    }
    const state = await stateOf(c, tenantId);
    return state === 'active' ? next() : frozenTenantRefusal(c, state, options.surface);
  };
}

/** A tenant's state for a write: `active`, frozen, or `unreadable` when its lookup failed. */
export type TenantWriteState = 'active' | 'closing' | 'suspended' | 'unreadable';

/**
 * Reads a tenant's state for a write. It's cached per tenant for `cacheMs`
 * ({@link TENANT_STATE_CACHE_MS}), so a change of state takes effect within
 * that. A failed lookup is logged and read as `unreadable`, which every
 * caller refuses: it fails closed.
 */
export function tenantStateReader(
  states: TenantStateBinding,
  cacheMs: number = TENANT_STATE_CACHE_MS,
): (c: Context<AppEnv>, tenantId: TenantId) => Promise<TenantWriteState> {
  const cache = new Map<string, { readonly state: string | undefined; readonly at: number }>();
  const stateOf = async (tenantId: TenantId) => {
    const key = tenantId as unknown as string;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < cacheMs) return hit.state;
    const state = await states.of(tenantId);
    cache.set(key, { state, at: Date.now() });
    return state;
  };
  return async (c, tenantId) => {
    let state: string | undefined;
    try {
      state = await stateOf(tenantId);
    } catch (cause) {
      c.get('log').error("could not read the tenant's state; the write is refused", {
        err: cause,
        tenantId,
      });
      return 'unreadable';
    }
    return state === 'closing' || state === 'suspended' ? state : 'active';
  };
}

/**
 * What a frozen tenant's write is answered: `409 tenant-closing` or `409
 * tenant-suspended` (`details.state`), or `503 tenant-state-unavailable`
 * with `Retry-After` when its state can't be read. On the S3-compatible
 * surface, `403 AllAccessDisabled` and `503 ServiceUnavailable`.
 */
export function frozenTenantRefusal(
  c: Context<AppEnv>,
  state: Exclude<TenantWriteState, 'active'>,
  surface: 'api' | 's3' = 'api',
): Response {
  const s3 = surface === 's3';
  if (state === 'unreadable') {
    c.header('Retry-After', String(RETRY_AFTER_S));
    const message =
      "This workspace's state can't be read just now, so nothing was changed: try again.";
    return s3
      ? s3Answer(c, 'ServiceUnavailable', message, 503)
      : answer(c, 'tenant-state-unavailable', message);
  }
  const message =
    state === 'closing'
      ? 'This workspace is closing: it can be read and exported until it is deleted, and nothing in it changes but deletes, revocations and erasures.'
      : 'This workspace is suspended: it can be read and exported, and nothing in it changes but deletes, revocations and erasures until it is restored.';
  return s3
    ? s3Answer(c, 'AllAccessDisabled', message, 403)
    : answer(c, `tenant-${state}`, message, { state });
}

function s3Answer(c: Context<AppEnv>, code: string, message: string, status: 403 | 503): Response {
  return c.body(errorXml(code, message), status, { 'Content-Type': 'application/xml' });
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
