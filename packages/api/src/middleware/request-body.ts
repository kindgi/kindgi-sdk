// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A request's body, read once as the bytes it came with, before any
 * middleware or route parses it. Hono keeps the copy: `c.req.json()`,
 * `c.req.text()` and `c.req.formData()` all read from it, so the
 * key-project check, idempotency and the route see the same body, and
 * idempotency fingerprints the bytes themselves rather than their text.
 */

import { tenantInputBounds } from '@kindgi/bounds';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/**
 * Paths the API's body limit leaves alone: the webhook receiver and a wait
 * token's link read their bodies under their own limits, before any
 * lookup, and the S3-compatible routes take objects, not JSON.
 */
const OTHER_BODY_PATHS = ['/v1/hooks/', '/v1/wait-tokens/', '/s3/'];

/**
 * The API's limit on a request body, `requestMaxBytes`, checked before
 * anything reads the body and before the caller is known: a declared
 * length over it is refused unread, and a streamed body as soon as it
 * passes it. `413 request-too-large`, with `details.maxBytes`. A route in
 * `ownLimits` is checked against its own limit instead, in `readBodyOnce`.
 */
export function requestBodyLimit(
  ownLimits: readonly OwnBodyLimit[] = [],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      OTHER_BODY_PATHS.some((prefix) => c.req.path.startsWith(prefix)) ||
      ownLimitOf(c, ownLimits)
    ) {
      return next();
    }
    return underApiLimit(c, next);
  };
}

/** The body under `requestMaxBytes`: `413 request-too-large`, with `details.maxBytes`, past it. */
const underApiLimit: MiddlewareHandler<AppEnv> = (c, next) => {
  const maxBytes = tenantInputBounds().requestMaxBytes;
  return bodyLimit({
    maxSize: maxBytes,
    onError: (limited) => {
      limited.status(statusFor('request-too-large') as never);
      return limited.json(
        toWireError(
          {
            code: 'request-too-large',
            message: `The request body is over the limit of ${maxBytes} bytes`,
            maxBytes,
          },
          limited.get('requestId'),
        ),
      );
    },
  })(c, next);
};

/** A route whose body has a size limit of its own, checked before the body is read. */
export interface OwnBodyLimit {
  readonly method: string;
  readonly path: string;
  readonly limit: MiddlewareHandler<AppEnv>;
}

/**
 * Reads a write's body once, as bytes, and keeps them for everything
 * after it. Never without a limit: a route in `ownLimits` has its own,
 * checked first, after the caller is known, so a large one is never read
 * for a caller who isn't; any other body is read under the API's
 * `requestMaxBytes`, as `requestBodyLimit` checks it, which also holds a
 * path that check leaves alone and nothing else took (a `/v1/hooks/` path
 * the receiver doesn't route).
 */
export function readBodyOnce(ownLimits: readonly OwnBodyLimit[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.raw.body === null) return next();
    const read = async () => {
      c.set('requestBody', new Uint8Array(await c.req.arrayBuffer()));
      await next();
    };
    return (ownLimitOf(c, ownLimits)?.limit ?? underApiLimit)(c, read);
  };
}

/** The route's own body limit: by method and path, exactly. */
function ownLimitOf(
  c: Context<AppEnv>,
  ownLimits: readonly OwnBodyLimit[],
): OwnBodyLimit | undefined {
  return ownLimits.find((route) => route.method === c.req.method && route.path === c.req.path);
}

/**
 * Whether the request is to a route in `ownLimits`: one that takes an
 * upload, never JSON, so nothing before it reads its body as JSON (the
 * body can be as large as the route's own limit).
 */
export function takesUpload(c: Context<AppEnv>, ownLimits: readonly OwnBodyLimit[]): boolean {
  return ownLimitOf(c, ownLimits) !== undefined;
}

/**
 * A JSON body nested deeper than `requestJsonMaxDepth` is `400 bad-input`,
 * with `details.maxDepth`, before anything walks it: the checks after
 * this one, idempotency and the route. A body that isn't JSON is the
 * route's to refuse, as is an upload's (`ownLimits`), which isn't parsed.
 */
export function refuseDeepJson(ownLimits: readonly OwnBodyLimit[] = []): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (takesUpload(c, ownLimits)) return next();
    const first = firstJsonByte(c.get('requestBody'));
    // Only an object or an array can nest.
    if (first !== 0x7b && first !== 0x5b) return next();
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      return next();
    }
    const maxDepth = tenantInputBounds().requestJsonMaxDepth;
    if (!nestsDeeperThan(value, maxDepth)) return next();
    c.status(statusFor('bad-input') as never);
    return c.json(toWireError(deepJsonRefusal(maxDepth), c.get('requestId')));
  };
}

/**
 * The refusal for JSON nested more than `maxDepth` levels: `400 bad-input`,
 * with `details.maxDepth`. The webhook receiver refuses a delivery's event
 * with it too.
 */
export function deepJsonRefusal(maxDepth: number) {
  return {
    code: 'bad-input',
    message: `The JSON body nests objects and arrays more than ${maxDepth} deep, the limit`,
    maxDepth,
  };
}

/** Whether a parsed value nests objects and arrays more than `max` levels, its own being 1. */
export function nestsDeeperThan(value: unknown, max: number): boolean {
  const pending: [unknown, number][] = [[value, 1]];
  while (pending.length > 0) {
    const [item, depth] = pending.pop() as [unknown, number];
    if (item === null || typeof item !== 'object') continue;
    if (depth > max) return true;
    for (const inner of Object.values(item)) pending.push([inner, depth + 1]);
  }
  return false;
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
  return bytes === undefined || firstJsonByte(bytes) === 0x7b;
}

/** The first byte of kept bytes past a byte-order mark and JSON whitespace. */
function firstJsonByte(bytes: Uint8Array | undefined): number | undefined {
  if (bytes === undefined) return undefined;
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  // Space, tab, line feed, carriage return: JSON's whitespace.
  while (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d) i += 1;
  return bytes[i];
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
