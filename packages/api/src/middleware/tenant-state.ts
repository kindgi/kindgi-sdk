// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import type { MiddlewareHandler } from 'hono';

import { statusFor, toWireError } from '../errors.js';
import type { AppEnv } from '../types.js';

/** Methods that change nothing, and deletes, which erasure needs: always allowed. */
const ALWAYS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'DELETE']);

/**
 * Routes that answer a `POST` but only read: the signed exports a closing
 * tenant takes away with it, and sign-in, so its people reach the console.
 */
const READ_ONLY_POSTS: readonly RegExp[] = [
  /^\/v1\/auth\//,
  /^\/v1\/approvals\/[^/]+\/audit-bundle$/,
  /^\/v1\/provenance\/[^/]+\/export$/,
  /^\/v1\/compliance\/evidence\/export$/,
];

/**
 * A closing or suspended tenant (`TokenResolution.tenantState`) is frozen:
 * its own keys and sessions still read and export it, and delete from it,
 * but nothing else changes: `409 tenant-closing` or `409 tenant-suspended`.
 * Nothing new runs, since starting a run is a write. Its running runs were
 * cancelled when the state was set. A system principal is fenced elsewhere.
 */
export function tenantStateGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const state = c.get('tenantState');
    if (state === undefined || state === 'active') return next();
    if (c.get('systemPrincipal') !== undefined) return next();
    if (ALWAYS.has(c.req.method) || READ_ONLY_POSTS.some((re) => re.test(c.req.path))) {
      return next();
    }
    const code = `tenant-${state}`;
    c.status(statusFor(code) as never);
    return c.json(
      toWireError(
        {
          code,
          message:
            state === 'closing'
              ? 'This workspace is closing: it can be read and exported until it is deleted, and nothing in it changes.'
              : 'This workspace is suspended: it can be read and exported, and nothing in it changes until it is restored.',
          state,
        },
        c.get('requestId'),
      ),
    );
  };
}
