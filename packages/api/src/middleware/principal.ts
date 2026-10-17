// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

//
// principalMiddleware — Hono middleware that constructs a composite
// authz Principal from the values `bearerAuthMiddleware` set on the
// context (tenantId + optional userId + optional sessionId).
//
// Runs AFTER bearerAuthMiddleware. Every route below `/v1` gets a
// principal populated via `c.get('principal')`. Downstream:
//   - `authorize(action, resource)` reads it for enforcement.
//   - Route handlers can read it directly for conditional logic.
//
// Delegation chains (agent-on-behalf-of-user) are constructed at
// deeper layers (kernel start-of-run) — the request-scoped principal
// is always a single actor.
//

import type { MiddlewareHandler } from 'hono';

import { principalFromToken } from '@kindgi/authz';

import type { AppEnv } from '../types.js';

export function principalMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const tenantId = c.get('tenantId');
    const userId = c.get('userId');
    const tokenId = c.get('tokenId');
    const sessionId = c.get('sessionId');
    const keyServiceAccount = c.get('serviceAccountId');

    if (tenantId === undefined) {
      // Bearer middleware didn't populate — either the route is
      // pre-auth (unlikely at this mount point) or the resolver
      // failed silently. Skip; downstream authorize() will 403 in a
      // coherent way if it needs the principal.
      return next();
    }

    // A user when the token names one; otherwise a service account: the
    // one an API key acts for, else the key's own id (a store built before
    // principals), else the session id (which uniquely identifies the
    // token record). With none of them, leave `principal` unset;
    // `authorize()` treats that as "no principal" and 403s cleanly.
    const serviceAccountId =
      keyServiceAccount ??
      (tokenId as unknown as string | undefined) ??
      (sessionId as unknown as string | undefined);
    if (userId === undefined && serviceAccountId === undefined) {
      return next();
    }
    try {
      const principal = principalFromToken({
        tenantId,
        ...(userId !== undefined ? { userId } : {}),
        ...(userId === undefined && serviceAccountId !== undefined
          ? { tokenId: serviceAccountId }
          : {}),
      });
      c.set('principal', principal);
    } catch {
      // Defensive: principalFromToken throws when its guardrail is
      // violated; downstream authorize() handles the missing principal.
    }
    return next();
  };
}
