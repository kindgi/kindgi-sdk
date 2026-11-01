// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import type { TenantHierarchyBinding, TenantLimits } from '@kindgi/platform';
import type { TenantId } from '@kindgi/types';

import { retryAfterSeconds, statusFor, toWireError } from '../errors.js';
import { type RateLimitStore, createInMemoryRateLimitStore } from '../rate-limit-store.js';
import type { AppEnv } from '../types.js';
import { errorXml } from '../xml.js';

const MINUTE_MS = 60_000;
const DEFAULT_CACHE_MS = 60_000;
const WARN_EVERY_MS = 60_000;

/** A tenant's per-minute limit the API enforces itself. */
export type TenantRateLimitName = 'api-requests' | 'webhook-receives';

/** What each limit is named in a refusal's message. */
const WHAT: Readonly<Record<TenantRateLimitName, string>> = {
  'api-requests': 'API requests',
  'webhook-receives': 'webhook deliveries',
};

/**
 * `createApp`'s `tenantLimits`: enforce the per-tenant limits a runtime
 * sets (`TenantSummary.limits`). Without it, nothing is limited.
 */
export interface TenantLimitsOptions {
  /**
   * Where the counts live. A deployment with several instances passes one
   * they share; the default counts in this process, so N instances let N ×
   * a limit through.
   */
  readonly store?: RateLimitStore;
  /** How long a tenant's limits are kept before they're read again. Default 60 s. */
  readonly cacheMs?: number;
  /** Test seam: the clock. */
  readonly now?: () => number;
}

/** A tenant's limits, read through the tenant binding and kept a while, and its counts. */
export interface TenantLimiter {
  /** The tenant's limits as last read (at most `cacheMs` old). */
  limitsOf(c: Context<AppEnv>, tenantId: TenantId): Promise<TenantLimits | undefined>;
  /**
   * One from the tenant's minute for `name`. Allowed when no limit is set,
   * and when the store fails (logged, at most once a minute), so a broken
   * store never refuses everyone.
   */
  take(
    c: Context<AppEnv>,
    tenantId: TenantId,
    name: TenantRateLimitName,
    perMinute: number | undefined,
  ): Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number }
  >;
}

export function createTenantLimiter(
  tenantHierarchy: TenantHierarchyBinding,
  options: TenantLimitsOptions = {},
): TenantLimiter {
  const now = options.now ?? Date.now;
  const store = options.store ?? createInMemoryRateLimitStore(now);
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const cache = new Map<
    string,
    { readonly limits: TenantLimits | undefined; readonly until: number }
  >();
  let lastStoreWarning: number | undefined;
  let lastReadWarning: number | undefined;

  const warnOnce = (c: Context<AppEnv>, last: number | undefined, message: string): number => {
    const at = now();
    if (last === undefined || at - last >= WARN_EVERY_MS) {
      c.get('log').warn(message);
      return at;
    }
    return last;
  };

  return {
    async limitsOf(c, tenantId) {
      const key = tenantId as unknown as string;
      const kept = cache.get(key);
      if (kept !== undefined && kept.until > now()) return kept.limits;
      try {
        const tenant = await tenantHierarchy.getTenant(tenantId);
        const limits = tenant?.limits;
        cache.set(key, { limits, until: now() + cacheMs });
        return limits;
      } catch (cause) {
        // A failed read keeps what was last read, or limits nothing.
        lastReadWarning = warnOnce(
          c,
          lastReadWarning,
          `tenant limits: couldn't read the tenant's limits, so the last ones read apply: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return kept?.limits;
      }
    },
    async take(c, tenantId, name, perMinute) {
      if (perMinute === undefined) return { allowed: true };
      try {
        return await store.take({
          key: `tenant-limit:${name}:${tenantId as unknown as string}`,
          limit: perMinute,
          windowMs: MINUTE_MS,
        });
      } catch (cause) {
        lastStoreWarning = warnOnce(
          c,
          lastStoreWarning,
          `tenant limits: the rate-limit store failed, so ${WHAT[name]} aren't counted: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return { allowed: true };
      }
    },
  };
}

/** `429 rate-limit-exceeded` for a tenant's limit, with `Retry-After` and `details.limit`. */
export function tenantLimitReached(
  c: Context<AppEnv>,
  name: TenantRateLimitName,
  retryAfterMs: number,
): Response {
  const seconds = retryAfterSeconds(retryAfterMs);
  c.header('Retry-After', String(seconds));
  c.status(statusFor('rate-limit-exceeded') as never);
  return c.json(
    toWireError(
      {
        code: 'rate-limit-exceeded',
        message: `This workspace's limit on ${WHAT[name]} a minute is reached: try again in ${seconds} s.`,
        limit: name,
      },
      c.get('requestId'),
    ),
  );
}

/**
 * The tenant's API requests a minute (`limits.apiRequestsPerMinute`), on
 * every authenticated `/v1` request a tenant's key or session makes. A
 * system key acts in no tenant and isn't counted.
 */
export function tenantApiRequestLimit(limiter: TenantLimiter): MiddlewareHandler<AppEnv> {
  return countApiRequest(limiter, (c, retryAfterMs) =>
    tenantLimitReached(c, 'api-requests', retryAfterMs),
  );
}

/**
 * The same minute on the S3-compatible surface (`/s3`, after SigV4 names
 * the tenant): one count for `/v1` and `/s3` together. Past it, S3's own
 * answer to too many requests, `503 SlowDown` (an S3 error document) with
 * `Retry-After`, which S3 clients back off from and retry.
 */
export function tenantS3RequestLimit(limiter: TenantLimiter): MiddlewareHandler<AppEnv> {
  return countApiRequest(limiter, (c, retryAfterMs) => {
    const seconds = retryAfterSeconds(retryAfterMs);
    c.header('Retry-After', String(seconds));
    return c.body(
      errorXml(
        'SlowDown',
        `This workspace's limit on ${WHAT['api-requests']} a minute is reached: try again in ${seconds} s.`,
      ),
      503,
      { 'Content-Type': 'application/xml' },
    );
  });
}

/** Take one from the tenant's API requests a minute; past it, `refuse` answers. */
function countApiRequest(
  limiter: TenantLimiter,
  refuse: (c: Context<AppEnv>, retryAfterMs: number) => Response,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenantId = c.get('tenantId');
    if (tenantId === undefined || c.get('systemPrincipal') !== undefined) return next();
    const limits = await limiter.limitsOf(c, tenantId);
    const taken = await limiter.take(c, tenantId, 'api-requests', limits?.apiRequestsPerMinute);
    if (!taken.allowed) return refuse(c, taken.retryAfterMs);
    return next();
  };
}
