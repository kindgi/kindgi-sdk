// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import type { TenantId } from '@kindgi/types';

import { statusFor, toWireError } from '../errors.js';

/**
 * Idempotency-key store: `(tenantId, route, key) → cached response`,
 * cached for `ttlMs` (default 24h per API-ROUTE-CONVENTIONS.md §3.1).
 *
 * Injected into the middleware so deployments can plug in a durable
 * store (e.g. Postgres, Redis). The bundled `createInMemoryIdempotencyStore()`
 * is fine for dev + tests; production installs are expected to plug
 * in a persistent one so retries survive restarts.
 */
export interface IdempotencyStore {
  get(key: string): Promise<StoredIdempotencyEntry | null>;
  set(key: string, entry: StoredIdempotencyEntry): Promise<void>;
}

export interface StoredIdempotencyEntry {
  readonly bodyHash: string;
  readonly status: number;
  readonly contentType: string;
  readonly bodyText: string;
  readonly expiresAt: number;
}

/** Simple in-memory store with lazy expiry — swap for a DB store in prod. */
export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const table = new Map<string, StoredIdempotencyEntry>();
  return {
    async get(key) {
      const hit = table.get(key);
      if (hit === undefined) return null;
      if (hit.expiresAt <= Date.now()) {
        table.delete(key);
        return null;
      }
      return hit;
    },
    async set(key, entry) {
      table.set(key, entry);
    },
  };
}

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Idempotency-Key middleware per API-ROUTE-CONVENTIONS.md §3.1.
 *
 * Behaviour:
 * - Only applies to mutating methods (POST/PUT/PATCH/DELETE).
 * - No `Idempotency-Key` header → pass through.
 * - Cached hit with matching body hash → replay stored response
 *   byte-identical (status, content-type, body).
 * - Cached hit with different body hash → 409
 *   `idempotency-key-body-mismatch`.
 * - Cache miss → run the handler, then store the response when the
 *   request took effect (a status below 400). A refusal (4xx) changed
 *   nothing, and a failure (5xx) may be transient: neither is stored, so
 *   a retry with the same key after fixing the cause runs again instead
 *   of replaying the old error.
 *
 * The middleware sits AFTER auth so `tenantId` is available; the
 * cache key is namespaced by tenant so callers can't collide across
 * tenants.
 */
export function idempotencyMiddleware(
  store: IdempotencyStore,
  opts: { ttlMs?: number } = {},
): MiddlewareHandler {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method.toUpperCase())) {
      return next();
    }
    const rawKey = c.req.header('idempotency-key');
    if (rawKey === undefined || rawKey.length === 0) {
      return next();
    }
    const requestId = c.get('requestId') as string;
    const tenantId = c.get('tenantId') as TenantId | undefined;
    if (tenantId === undefined) {
      // Auth middleware didn't set it — bail out and let the auth
      // failure surface. This shouldn't happen because auth runs
      // first, but the guard keeps the cache key well-formed.
      return next();
    }

    const bodyText = await readRawBody(c.req.raw);
    const bodyHash = hashBody(bodyText);
    const cacheKey = `${tenantId}|${c.req.method.toUpperCase()}:${c.req.path}|${rawKey}`;
    const hit = await store.get(cacheKey);

    if (hit !== null) {
      if (hit.bodyHash !== bodyHash) {
        c.status(statusFor('idempotency-key-body-mismatch') as never);
        return c.json(
          toWireError(
            {
              code: 'idempotency-key-body-mismatch',
              message:
                'Idempotency-Key was reused with a different request body. Use a fresh key or the original body.',
            },
            requestId,
          ),
        );
      }
      return c.body(hit.bodyText, hit.status as never, {
        'Content-Type': hit.contentType,
        'X-Idempotent-Replay': 'true',
      });
    }

    // Re-attach the buffered body so downstream handlers reading
    // `c.req.json()` see the same bytes.
    if (bodyText.length > 0) rebindBody(c, bodyText);
    await next();

    const res = c.res;
    // Only what took effect is replayed; see the doc above.
    if (res.status >= 400) return;
    const savedBody = await res.clone().text();
    const contentType = res.headers.get('Content-Type') ?? 'application/octet-stream';
    await store.set(cacheKey, {
      bodyHash,
      status: res.status,
      contentType,
      bodyText: savedBody,
      expiresAt: Date.now() + ttlMs,
    });
    return;
  };
}

async function readRawBody(req: Request): Promise<string> {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return '';
  try {
    return await req.clone().text();
  } catch {
    return '';
  }
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function rebindBody(c: { req: { raw: Request } }, body: string): void {
  const original = c.req.raw;
  const rebuilt = new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body,
  });
  Object.defineProperty(c.req, 'raw', { value: rebuilt, configurable: true });
}
