// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { createHash, randomUUID } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

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
  /** Store an answer. It replaces a hold on the key, never a stored answer: the first stays. */
  set(key: string, entry: StoredIdempotencyEntry): Promise<void>;
  /**
   * Hold a key while its request runs (T349), so a repeat sent meanwhile
   * is answered 409 `idempotency-key-in-flight` instead of running the
   * operation again. Optional: a store without holds holds nothing, and
   * such a repeat runs again (the behaviour before 0.1.5).
   */
  readonly holds?: IdempotencyHolds;
}

/** A store's holds: all three or none. */
export interface IdempotencyHolds {
  /** Take the key for `hold.holder`, unless an unexpired hold or a stored answer has it. */
  hold(key: string, hold: IdempotencyHold): Promise<IdempotencyHoldOutcome>;
  /** Extend the holder's hold: its request still runs. */
  renew(key: string, holder: string, expiresAt: number): Promise<void>;
  /** Drop the holder's hold: its request ended with nothing to replay. */
  release(key: string, holder: string): Promise<void>;
}

export interface IdempotencyHold {
  /** Who holds it: one id per request. */
  readonly holder: string;
  readonly bodyHash: string;
  readonly expiresAt: number;
}

export type IdempotencyHoldOutcome =
  | { readonly kind: 'held' }
  | { readonly kind: 'in-flight'; readonly bodyHash: string }
  | { readonly kind: 'stored'; readonly entry: StoredIdempotencyEntry };

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
  const held = new Map<string, IdempotencyHold>();
  const stored = (key: string): StoredIdempotencyEntry | null => {
    const hit = table.get(key);
    if (hit === undefined) return null;
    if (hit.expiresAt <= Date.now()) {
      table.delete(key);
      return null;
    }
    return hit;
  };
  return {
    async get(key) {
      return stored(key);
    },
    async set(key, entry) {
      held.delete(key);
      if (stored(key) === null) table.set(key, entry);
    },
    holds: {
      async hold(key, hold) {
        const entry = stored(key);
        if (entry !== null) return { kind: 'stored', entry };
        const current = held.get(key);
        if (current !== undefined && current.expiresAt > Date.now()) {
          return { kind: 'in-flight', bodyHash: current.bodyHash };
        }
        held.set(key, hold);
        return { kind: 'held' };
      },
      async renew(key, holder, expiresAt) {
        const current = held.get(key);
        if (current?.holder === holder) held.set(key, { ...current, expiresAt });
      },
      async release(key, holder) {
        if (held.get(key)?.holder === holder) held.delete(key);
      },
    },
  };
}

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a hold lasts unless renewed; renewed every third of it while the request runs. */
const DEFAULT_HOLD_MS = 30 * 1000;
/** What a repeat in flight is told to wait, in seconds. */
const IN_FLIGHT_RETRY_AFTER_S = 5;

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
 * - With a store that holds keys (`store.holds`, T349): the key is held
 *   while the handler runs (for `holdMs`, renewed every third of it), so
 *   a repeat sent meanwhile gets 409 `idempotency-key-in-flight` with
 *   `Retry-After`, or `idempotency-key-body-mismatch` for another body,
 *   instead of running the operation again. The hold becomes the stored
 *   answer, or is released when nothing is stored. A crashed request's
 *   hold lapses within `holdMs`.
 *
 * The middleware sits AFTER auth so `tenantId` is available; the
 * cache key is namespaced by tenant so callers can't collide across
 * tenants.
 */
export function idempotencyMiddleware(
  store: IdempotencyStore,
  opts: { ttlMs?: number; holdMs?: number } = {},
): MiddlewareHandler {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS;
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
    if (hit !== null) return replay(c, hit, bodyHash, requestId);

    const { holds } = store;
    const holder = randomUUID();
    if (holds !== undefined) {
      const held = await holds.hold(cacheKey, {
        holder,
        bodyHash,
        expiresAt: Date.now() + holdMs,
      });
      if (held.kind === 'stored') return replay(c, held.entry, bodyHash, requestId);
      if (held.kind === 'in-flight') {
        if (held.bodyHash !== bodyHash) return bodyMismatch(c, requestId);
        c.header('Retry-After', String(IN_FLIGHT_RETRY_AFTER_S));
        c.status(statusFor('idempotency-key-in-flight') as never);
        return c.json(
          toWireError(
            {
              code: 'idempotency-key-in-flight',
              message:
                "A request with this Idempotency-Key is still running. Retry after it answers (Retry-After), and you'll get its answer.",
            },
            requestId,
          ),
        );
      }
    }

    // Re-attach the buffered body so downstream handlers reading
    // `c.req.json()` see the same bytes.
    if (bodyText.length > 0) rebindBody(c, bodyText);
    const renewal =
      holds === undefined
        ? undefined
        : setInterval(
            () => {
              holds.renew(cacheKey, holder, Date.now() + holdMs).catch(() => undefined);
            },
            Math.max(1, Math.floor(holdMs / 3)),
          );
    renewal?.unref?.();
    let answered = false;
    try {
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
      answered = true;
    } finally {
      if (renewal !== undefined) clearInterval(renewal);
      // Nothing stored (a refusal, a failure, a throw): let a retry run.
      if (!answered && holds !== undefined) {
        await holds.release(cacheKey, holder).catch(() => undefined);
      }
    }
  };
}

/** A stored answer, replayed; or the refusal for the same key with another body. */
function replay(c: Context, hit: StoredIdempotencyEntry, bodyHash: string, requestId: string) {
  if (hit.bodyHash !== bodyHash) return bodyMismatch(c, requestId);
  return c.body(hit.bodyText, hit.status as never, {
    'Content-Type': hit.contentType,
    'X-Idempotent-Replay': 'true',
  });
}

function bodyMismatch(c: Context, requestId: string) {
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
