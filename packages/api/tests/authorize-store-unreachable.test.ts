// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A check the authorization store couldn't be reached for: the binding
 * throws an error marked `code: 'authz-backend-unavailable'`
 * (`AuthzCheckBinding`'s contract). Before the handler, in `authorize`,
 * it answers `503 authz-backend-unavailable` with `Retry-After` on any
 * method; inside a handler, on a GET or HEAD only. Any other throw is a
 * 500, as before.
 */

import { type Context, Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { type AuthzCheckBinding, ref, userPrincipal } from '@kindgi/authz';
import { type Logger, noopLogger } from '@kindgi/log';
import type { TenantId, UserId } from '@kindgi/types';

import { createAuthorizer } from '../src/middleware/authorize.js';
import { mapThrownError } from '../src/middleware/error-mapper.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000ab' as TenantId;

/** What the binding throws when the store can't be reached: the mark, the store's error as its cause. */
function unreachable(): Error {
  return Object.assign(
    new Error("the authorization store couldn't be reached", {
      cause: new Error('FGA Error: connect ECONNREFUSED 10.0.0.7:8080'),
    }),
    { code: 'authz-backend-unavailable' },
  );
}

/** The lines logged at `error`, with their fields. */
function recordingLogger(): { readonly log: Logger; readonly errors: unknown[][] } {
  const errors: unknown[][] = [];
  const log: Logger = {
    ...noopLogger,
    error: (message, fields) => {
      errors.push([message, fields]);
    },
    child: () => log,
  };
  return { log, errors };
}

/**
 * An app whose binding's `check` and `inProject` do `fails`, with the
 * error handler `createApp` sets. `authorize` guards `/agents/:id` (GET and
 * POST); `/inside/:id` asks `can` inside the handler.
 */
function app(fails: () => never, options: { readonly keyProject?: string } = {}) {
  const binding = {
    check: async () => fails(),
    checkBatch: async () => fails(),
    inProject: async () => fails(),
  } as unknown as AuthzCheckBinding;
  const authorizer = createAuthorizer(binding);
  const { log, errors } = recordingLogger();
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    c.set('log', log);
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-authz-9' as never);
    c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
    if (options.keyProject !== undefined) c.set('tokenProjectId', options.keyProject);
    return next();
  });
  const guard = authorizer.authorize('read', (c) => ref('agent', c.req.param('id') ?? ''));
  r.get('/agents/:id', guard, (c) => c.json({ ok: true }));
  r.post('/agents/:id', guard, (c) => c.json({ ok: true }));
  const inside = async (c: Context<AppEnv>) =>
    c.json({ ok: await authorizer.can(c, 'read', ref('agent', c.req.param('id') ?? '')) });
  r.get('/inside/:id', inside);
  r.post('/inside/:id', inside);
  r.onError(mapThrownError);
  return { r, errors };
}

const UNAVAILABLE = {
  error: {
    code: 'authz-backend-unavailable',
    message:
      "The authorization store couldn't be reached, so the request wasn't run. Try again after Retry-After.",
    requestId: 'req-authz-9',
  },
};

describe('authorize(): a store that can not be reached', () => {
  test.each(['GET', 'POST'])(
    '%s: 503 authz-backend-unavailable with Retry-After: 5, and none of the store text',
    async (method) => {
      const { r, errors } = app(() => {
        throw unreachable();
      });
      const res = await r.request('/agents/acme.drafter', { method });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      const text = await res.text();
      expect(JSON.parse(text)).toEqual(UNAVAILABLE);
      expect(text).not.toContain('ECONNREFUSED');
      // The store's error is in the log, at error.
      expect(errors).toHaveLength(1);
      expect(errors[0]?.[0]).toBe('authorization store unreachable');
    },
  );

  test('the mark found down the cause chain answers the same', async () => {
    const { r } = app(() => {
      throw new Error('check failed', { cause: new Error('wrapped', { cause: unreachable() }) });
    });
    const res = await r.request('/agents/acme.drafter', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  test('a throw without the mark is the 500, as before', async () => {
    const { r } = app(() => {
      throw new Error('FGA API Error: 401 Unauthorized');
    });
    for (const method of ['GET', 'POST']) {
      const res = await r.request('/agents/acme.drafter', { method });
      expect(res.status).toBe(500);
      expect(res.headers.get('retry-after')).toBeNull();
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'internal-server-error',
      );
    }
  });

  test("a key limited to a project: the store's project test that can't be reached is the 503", async () => {
    let asked = 0;
    const { r } = app(
      () => {
        asked += 1;
        throw unreachable();
      },
      { keyProject: '00000000-0000-4000-8000-0000000000cd' },
    );
    const res = await r.request('/agents/acme.drafter', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    // `inProject` failed, so `check` was never asked.
    expect(asked).toBe(1);
  });
});

describe('a check inside a handler, when the store can not be reached', () => {
  test('a GET answers 503 authz-backend-unavailable with Retry-After: 5', async () => {
    const { r } = app(() => {
      throw unreachable();
    });
    const res = await r.request('/inside/acme.drafter');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  test('a POST keeps the 500: the handler may have written before its check', async () => {
    const { r } = app(() => {
      throw unreachable();
    });
    const res = await r.request('/inside/acme.drafter', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'internal-server-error',
    );
  });
});
