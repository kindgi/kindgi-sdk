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

/** A route whose body has a size limit of its own, checked before the body is read. */
export interface OwnBodyLimit {
  readonly method: string;
  readonly path: string;
  readonly limit: MiddlewareHandler<AppEnv>;
}

/**
 * Reads a write's body once, as bytes, and keeps them for everything
 * after it. A route in `ownLimits` has its limit checked first, after the
 * caller is known, so a large one is never read for a caller who isn't.
 */
export function readBodyOnce(ownLimits: readonly OwnBodyLimit[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.raw.body === null) return next();
    const read = async () => {
      c.set('requestBody', new Uint8Array(await c.req.arrayBuffer()));
      await next();
    };
    const own = ownLimits.find(
      (route) => route.method === c.req.method && route.path === c.req.path,
    );
    if (own === undefined) return read();
    return own.limit(c, read);
  };
}

/**
 * The kept body as a stream holding its only reference: the copies
 * `readBodyOnce` kept are let go, so a route that parses the whole body
 * (an upload's form) doesn't hold it twice while it does.
 */
export function takeBody(c: Context<AppEnv>): ReadableStream<Uint8Array> {
  let chunk = c.get('requestBody');
  if (chunk === undefined) {
    return c.req.raw.body ?? new ReadableStream({ start: (controller) => controller.close() });
  }
  c.set('requestBody', undefined);
  // Gone, not undefined: Hono reads any key it finds in its cache.
  Reflect.deleteProperty(c.req.bodyCache, 'arrayBuffer');
  return new ReadableStream({
    pull(controller) {
      if (chunk !== undefined) controller.enqueue(chunk);
      chunk = undefined;
      controller.close();
    },
  });
}

/**
 * Whether kept bytes could be a JSON object: the first byte past a
 * byte-order mark and JSON whitespace is `{`. Unknown bytes could be.
 */
export function mayBeJsonObject(bytes: Uint8Array | undefined): boolean {
  if (bytes === undefined) return true;
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  // Space, tab, line feed, carriage return: JSON's whitespace.
  while (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d) i += 1;
  return bytes[i] === 0x7b;
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
