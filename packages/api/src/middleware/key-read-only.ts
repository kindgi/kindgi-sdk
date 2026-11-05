// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { Context, MiddlewareHandler } from 'hono';

import { ref } from '@kindgi/authz';

import { type Refusal, refused } from '../routes/denied.js';
import type { AppEnv } from '../types.js';
import type { Authorizer } from './authorize.js';

/** What a key that only reads is told when it asks for more. */
export const READ_ONLY_KEY_MESSAGE =
  "This key can only read, so it can't change anything. Use a key that can write, or ask someone who can.";

/**
 * The `POST`s a key that only reads may still make: reads that are posts,
 * each of which writes nothing, calls nothing outside the runtime, and
 * asks only `read` of the authorizer. Each is matched against the whole
 * path, a segment never holding a `/` or a `%`. So a trailing slash, an
 * escaped slash or a doubled one is refused, as anything else that isn't
 * exactly one of these.
 *
 * The pin check is the route `isAgentPinCheck` (`agent-pins.ts`) calls a
 * read; this matches it by its whole path, where that matches its end.
 *
 * Reads that are posts and stay refused: a deploy's check and a
 * promotion's check (each asks `admin`), an improve run's check (it asks
 * `publish`), a memory search (it may embed the query with a model
 * provider), and the signed exports (each writes an audit event).
 */
export const READ_ONLY_POSTS: readonly RegExp[] = [
  // what an agent's pin gate would say, writing nothing (`read` on the agent)
  /^\/v1\/agents\/[^/%]+\/pinned\/check$/,
];

/** The refusal of a key that only reads, for a route that refuses it itself (a mint, a revoke). */
export function readOnlyKeyRefusal(c: Context<AppEnv>): Refusal {
  return {
    action: 'write',
    resource: ref('tenant', c.get('tenantId') as unknown as string),
    message: READ_ONLY_KEY_MESSAGE,
    failing: 'scope',
    code: 'read-only-key',
  };
}

/**
 * A key minted with `readOnly` is refused, `403 read-only-key`, on every
 * request but a `GET` or a `HEAD`, before any route runs, apart from the
 * `POST`s in {@link READ_ONLY_POSTS}. The rule is the method's, never a
 * list of the methods that write, so a method added later is refused too.
 * It holds whether or not the runtime has an authorization store, and on
 * routes that ask no authorizer. The authorizer holds such a key to `read`
 * as well (`keyCeilingDeny`). Sessions and every other caller pass
 * untouched. The refusal is recorded with `authorizer`, as every refusal
 * the API decides itself is.
 */
export function refuseWritesForReadOnlyKey(authorizer?: Authorizer): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('tokenReadOnly') !== true) return next();
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD') return next();
    if (method === 'POST' && READ_ONLY_POSTS.some((re) => re.test(c.req.path))) return next();
    return refused(c, authorizer, readOnlyKeyRefusal(c));
  };
}
