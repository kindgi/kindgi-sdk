// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The authorizer's 403: the error envelope every route answers in
 * (`permission-denied`, with what was denied in `details`), so clients and
 * the CLI read it as a typed auth error.
 */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { type AuthzCheckBinding, type Decision, ref, userPrincipal } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createAuthorizer } from '../src/middleware/authorize.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;

function app(decision: Decision, withPrincipal = true) {
  const binding: AuthzCheckBinding = {
    check: async () => decision,
  } as unknown as AuthzCheckBinding;
  const authorizer = createAuthorizer(binding);
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-authz-1' as never);
    if (withPrincipal) {
      c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
    }
    return next();
  });
  r.get(
    '/agents/:id',
    authorizer.authorize('read', (c) => ref('agent', c.req.param('id') ?? '')),
    (c) => c.json({ ok: true }),
  );
  return r;
}

const denied: Decision = {
  allowed: false,
  failing: 'actor',
  reason: 'actor user:u-1 does not have can_read on agent:acme.drafter',
  evidence: {
    action: 'read',
    relation: 'can_read',
    resource: 'agent:acme.drafter',
    actorSubject: 'user:u-1',
  },
} as Decision;

describe('authorize(): a denial', () => {
  test('is a 403 in the error envelope, with what was denied in details', async () => {
    const res = await app(denied).request('/agents/acme.drafter');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'permission-denied',
        message: 'Permission denied: actor user:u-1 does not have can_read on agent:acme.drafter',
        details: {
          action: 'read',
          resource: 'agent:acme.drafter',
          reason: 'actor user:u-1 does not have can_read on agent:acme.drafter',
        },
        requestId: 'req-authz-1',
      },
    });
  });

  test('without a principal, the same envelope', async () => {
    const res = await app(denied, false).request('/agents/acme.drafter');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details: { action: string } } };
    expect(body.error.code).toBe('permission-denied');
    expect(body.error.details.action).toBe('read');
  });

  test('an allowed request goes through', async () => {
    const res = await app({ ...denied, allowed: true } as Decision).request('/agents/acme.drafter');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
