// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Shared HTTP transport for resource clients.
 *
 * Responsibilities (all per `docs/API-ROUTE-CONVENTIONS.md`):
 *   - Bearer token injection from `ClientOptions.auth`.
 *   - Base URL prefixing from `ClientOptions.apiUrl`.
 *   - `Idempotency-Key` header on mutating verbs when supplied.
 *   - JSON body parsing on 2xx.
 *   - Error envelope (`{ error: {...} }`) hydration into `KindgiError` via
 *     `fromWire` — thrown as `KindgiApiError`.
 *   - Timeout with `AbortController`: `ClientOptions.timeoutMs` (default
 *     30 s), overridable per call via `TransportRequest.timeoutMs`.
 *
 * Deliberately does NOT retry. Callers layer their own retry policy; the
 * server's idempotency-key window already gives at-most-once semantics on
 * mutating verbs.
 */

import { KindgiApiError, type NetworkError, fromWire } from './errors.js';
import type { AuthConfig, ClientOptions } from './types.js';

/** Signature the resource clients call into. */
export interface Transport {
  /** Base URL, no trailing slash. */
  readonly apiUrl: string;
  request<T>(input: TransportRequest): Promise<T>;
  /**
   * Fetch implementation the transport is bound to. Exposed so streaming
   * callers (`runs.follow`, `evalRuns.events`, `adapters.prepare`, the
   * secrets rotation event stream) can hand it to `readSse` without
   * going through `request` (SSE is a `text/event-stream` body, not JSON).
   */
  readonly fetchImpl: typeof fetch;
  /**
   * Build the auth headers this transport injects on every request
   * (`Authorization: Bearer <token>`, from the API token or the OAuth
   * access token). Exposed so streaming callers can merge them into the
   * SSE `Accept: text/event-stream` header set.
   *
   * A method rather than a stored object, so the headers are computed
   * per request.
   */
  authHeaders(): Readonly<Record<string, string>>;
}

/** One query parameter's value: an array repeats the key (`segment=a&segment=b`). */
export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface TransportRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path beginning with `/` (e.g. `/v1/agents`). Combined with `apiUrl`. */
  readonly path: string;
  /** JSON body (serialized here). Omitted for `GET`/`DELETE` without body. */
  readonly body?: unknown;
  /** Query parameters. `undefined` values are dropped; an array repeats its key, in order. */
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** Extra headers merged after `Authorization` + `Content-Type`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Overrides the client-level timeout. */
  readonly timeoutMs?: number;
  /**
   * Caller-supplied idempotency key. Applied to mutating verbs
   * (`POST`/`PUT`/`PATCH`/`DELETE`) as the `Idempotency-Key` header per
   * `docs/API-ROUTE-CONVENTIONS.md` §3.1.
   */
  readonly idempotencyKey?: string;
  /**
   * When `true`, resolves with `undefined` on 2xx regardless of body content.
   * Use for endpoints that return `void`.
   */
  readonly discardResponse?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const MUTATING: ReadonlySet<TransportRequest['method']> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * Construct a Transport bound to the given client options. One instance
 * per client — created inside `createClient()` and passed to every
 * resource maker.
 */
export function createTransport(options: ClientOptions): Transport {
  const apiUrl = options.apiUrl.replace(/\/+$/u, '');
  const fetchImpl = options.fetch ?? fetch;
  const clientTimeoutMs = checkedTimeoutMs(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'ClientOptions.timeoutMs',
  );

  return {
    apiUrl,
    fetchImpl,
    authHeaders(): Readonly<Record<string, string>> {
      return { Authorization: `Bearer ${authTokenFor(options.auth)}` };
    },
    async request<T>(input: TransportRequest): Promise<T> {
      const url = buildUrl(apiUrl, input.path, input.query);
      const headers = buildHeaders(input, options.auth);
      const timeoutMs =
        input.timeoutMs === undefined
          ? clientTimeoutMs
          : checkedTimeoutMs(input.timeoutMs, 'timeoutMs');

      const ac = new AbortController();
      let timedOut = false;
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error('timeout'));
      }, timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: input.method,
          headers,
          ...(input.body !== undefined && { body: JSON.stringify(input.body) }),
          signal: ac.signal,
        });
      } catch (cause) {
        clearTimeout(timer);
        const err: NetworkError = timedOut
          ? {
              code: 'network',
              message: `No answer within ${seconds(timeoutMs)}, the client's timeout (timeoutMs).`,
              cause,
              timeoutMs,
            }
          : {
              code: 'network',
              message: cause instanceof Error ? cause.message : 'network request failed',
              cause,
            };
        throw new KindgiApiError(err);
      }
      clearTimeout(timer);

      if (response.ok) {
        if (input.discardResponse === true || response.status === 204) {
          // Swallow the body for void endpoints.
          try {
            await response.arrayBuffer();
          } catch {
            /* body already consumed / absent */
          }
          return undefined as T;
        }
        try {
          return (await response.json()) as T;
        } catch (cause) {
          const err: NetworkError = {
            code: 'network',
            message: 'Response body was not valid JSON',
            cause,
          };
          throw new KindgiApiError(err);
        }
      }

      // Non-2xx: parse wire envelope + hydrate.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      throw new KindgiApiError(
        fromWire(unwrapErrorEnvelope(body, response.status), response.status),
      );
    },
  };
}

/** A timeout must be a positive number of milliseconds. */
function checkedTimeoutMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds. Got ${String(value)}.`);
  }
  return value;
}

/** `30000` → `30 s`, `1500` → `1.5 s`. */
export function seconds(ms: number): string {
  return `${ms / 1000} s`;
}

function buildUrl(
  apiUrl: string,
  path: string,
  query?: Readonly<Record<string, QueryValue>>,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = `${apiUrl}${normalizedPath}`;
  if (query === undefined) return base;
  const params: string[] = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined) continue;
    const values = typeof value === 'object' ? value : [String(value)];
    for (const v of values) params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return params.length === 0 ? base : `${base}?${params.join('&')}`;
}

function buildHeaders(input: TransportRequest, auth: AuthConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${authTokenFor(auth)}`,
  };
  if (input.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (input.idempotencyKey !== undefined && MUTATING.has(input.method)) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }
  if (input.headers !== undefined) {
    for (const key of Object.keys(input.headers)) {
      headers[key] = input.headers[key] as string;
    }
  }
  return headers;
}

function authTokenFor(auth: AuthConfig): string {
  if (auth.kind === 'apiToken') return auth.token;
  return auth.accessToken;
}

/**
 * The API layer wraps every error body as `{ error: {...} }` per
 * `docs/API-ROUTE-CONVENTIONS.md` §4.2. `fromWire` reads the inner
 * fields directly, so we unwrap here. Bodies that are missing or
 * malformed still produce a synthetic entry so `fromWire` returns a
 * meaningful `ServerError`.
 */
export function unwrapErrorEnvelope(body: unknown, status: number): unknown {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const inner = (body as Record<string, unknown>).error;
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      return inner;
    }
  }
  return { code: 'unknown', message: `HTTP ${status} without recognizable error envelope` };
}
