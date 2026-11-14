// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Action } from '@kindgi/authz';
import type { Hono } from 'hono';

import type { TokenResolution } from '../middleware/auth.js';
import type { AppEnv } from '../types.js';

/**
 * Where an in-process `/v1` request carries its caller: a key in Hono's
 * `env`, the request's bindings. A request from the network can't carry
 * it. The server builds `env` itself (the Node server's `incoming` and
 * `outgoing`), and no header or body becomes a symbol key.
 */
const IN_PROCESS_CALLER: unique symbol = Symbol('kindgi.in-process-caller');

/**
 * Who an in-process `/v1` request acts as: a person a `/mcp` token named,
 * already checked there, and the actions its scopes allow. `bearerAuthMiddleware`
 * takes it in place of a token.
 */
export interface InProcessCaller {
  readonly resolution: Pick<
    TokenResolution,
    'tenantId' | 'userId' | 'tokenId' | 'tokenRole' | 'expiresAt' | 'scopes'
  >;
  readonly allowedActions: readonly Action[];
  /** The calls its `/mcp` request was counted for. Absent: each call counts. */
  readonly cover?: InProcessCover;
}

/**
 * The `/v1` calls a `/mcp` request's tools make on the count that request
 * took at `/mcp` toward the tenant's API requests a minute. Each call uses
 * one; once they're used up, each call counts as any request does. One is
 * made for each `/mcp` request, on its caller only, so nothing carries
 * over to another request, and a request from the network never has one.
 */
export interface InProcessCover {
  /** One call on the cover: `false` once it's used up. */
  use(): boolean;
}

export function inProcessCover(calls: number): InProcessCover {
  let left = calls;
  return {
    use() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
  };
}

/** The caller an in-process request carries, else `undefined`. */
export function inProcessCallerOf(env: unknown): InProcessCaller | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  return (env as { readonly [IN_PROCESS_CALLER]?: InProcessCaller })[IN_PROCESS_CALLER];
}

/** A `/v1` route a tool may call, as `METHOD /v1/path/:param`. */
export type V1Route = `${'GET' | 'POST'} /v1/${string}`;

export interface V1CallOptions {
  /** Query parameters; an array repeats the name, `undefined` leaves it out. */
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** A JSON body (`POST`). */
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

/**
 * A `/v1` request in this process, as the `/mcp` caller, through the whole
 * `/v1` chain: the route's own checks run as for any request. Only the
 * routes the tools declared may be called; another path throws, so a
 * tool's bug can't reach the rest of the API. The answer is the route's
 * own: the tool reads it and says any refusal in its own words.
 */
export type V1Call = (
  method: 'GET' | 'POST',
  path: string,
  options?: V1CallOptions,
) => Promise<Response>;

export function inProcessV1Call(
  app: Hono<AppEnv>,
  caller: InProcessCaller,
  outer: { readonly requestId: string; readonly traceparent: string | undefined },
  routes: readonly V1Route[],
): V1Call {
  const allowed = routes.map(routeMatcher);
  return async (method, path, options = {}) => {
    const url = declaredUrl(method, path, allowed);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      for (const one of typeof value === 'string' ? [value] : (value ?? [])) {
        url.searchParams.append(name, one);
      }
    }
    const headers = v1Headers(outer, options);
    return app.request(
      url.pathname + url.search,
      {
        method,
        headers,
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      },
      { [IN_PROCESS_CALLER]: caller },
    );
  };
}

/**
 * Only what the `/v1` chain reads for its own records: the outer request's
 * id (one id across the `/mcp` call and what it did) and trace. Nothing
 * else the chat client sent reaches a route.
 */
function v1Headers(
  outer: { readonly requestId: string; readonly traceparent: string | undefined },
  options: V1CallOptions,
): Headers {
  const headers = new Headers({ 'x-request-id': outer.requestId });
  if (outer.traceparent !== undefined) headers.set('traceparent', outer.traceparent);
  if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return headers;
}

/**
 * `path` as the router will see it (`..` and `.` segments resolved), when
 * it's one of the declared routes; else it throws.
 */
function declaredUrl(
  method: string,
  path: string,
  allowed: readonly ((method: string, pathname: string) => boolean)[],
): URL {
  const url = new URL(path, 'http://in-process');
  if (url.origin !== 'http://in-process' || url.search !== '' || url.hash !== '') {
    throw new Error(`in-process call: "${path}" isn't a bare /v1 path`);
  }
  if (!allowed.some((matches) => matches(method, url.pathname))) {
    throw new Error(`in-process call: ${method} ${url.pathname} isn't a route the tools declared`);
  }
  return url;
}

function routeMatcher(route: V1Route): (method: string, pathname: string) => boolean {
  const space = route.indexOf(' ');
  const routeMethod = route.slice(0, space);
  const segments = route.slice(space + 1).split('/');
  return (method, pathname) => {
    if (method !== routeMethod) return false;
    const parts = pathname.split('/');
    if (parts.length !== segments.length) return false;
    return segments.every((segment, i) => {
      const part = parts[i] as string;
      return segment.startsWith(':') ? part.length > 0 : part === segment;
    });
  };
}
