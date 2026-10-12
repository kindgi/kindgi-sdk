// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A request's body, read once as the bytes it came with, before any
 * middleware or route parses it. Hono keeps the copy: `c.req.json()`,
 * `c.req.text()` and `c.req.formData()` all read from it, so the
 * key-project check, idempotency and the route see the same body, and
 * idempotency fingerprints the bytes themselves rather than their text.
 */

import type { Context, MiddlewareHandler } from 'hono';

import type { AppEnv } from '../types.js';

/** Writes whose route reads the raw body itself, under a limit of its own. */
const RAW_BODY_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'POST', path: '/v1/artifacts' },
];

/** Reads a write's body once, as bytes, and keeps them for everything after it. */
export function readBodyOnce(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.raw.body === null || readsRawBody(c)) return next();
    c.set('requestBody', new Uint8Array(await c.req.arrayBuffer()));
    return next();
  };
}

/**
 * The body's bytes as they came: what `readBodyOnce` kept, else a copy of
 * a raw body nothing has read yet, else Hono's copy of what was read.
 */
export async function requestBodyBytes(c: Context<AppEnv>): Promise<Uint8Array> {
  const kept = c.get('requestBody');
  if (kept !== undefined) return kept;
  if (c.req.raw.body === null) return new Uint8Array();
  if (!c.req.raw.bodyUsed) return new Uint8Array(await c.req.raw.clone().arrayBuffer());
  return new Uint8Array(await c.req.arrayBuffer());
}

function readsRawBody(c: Context<AppEnv>): boolean {
  return RAW_BODY_ROUTES.some(
    (route) => route.method === c.req.method && route.path === c.req.path,
  );
}
