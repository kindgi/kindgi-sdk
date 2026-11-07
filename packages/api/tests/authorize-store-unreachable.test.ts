// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A check the authorization store couldn't be reached for: the binding
 * throws an error marked `code: 'authz-backend-unavailable'`
 * (`AuthzCheckBinding`'s contract). Before the handler, in `authorize`,
 * it answers `503 authz-backend-unavailable` with `Retry-After` on any
 * method; inside a handler, on a GET or HEAD only. Any other throw is a
 * 500, as before. A route that reads an in-handler `authorize` (`deniedBy`)
 * as yes or no returns that 503, never a refusal of its own.
 *
 * A database too busy for the check's read (the runtime reads the tenant's
 * store id first), or for the resource getter's, is the same before the
 * handler: `503 database-busy` with `Retry-After` on any method. Inside a
 * handler, a write keeps the 500.
 */

import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type ResourceRef,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import { type Logger, noopLogger } from '@kindgi/log';
import type { TenantId, UserId } from '@kindgi/types';

import { type Authorizer, createAuthorizer } from '../src/middleware/authorize.js';
import { mapThrownError } from '../src/middleware/error-mapper.js';
import {
  createInMemoryIdempotencyStore,
  idempotencyMiddleware,
} from '../src/middleware/idempotency.js';
import { deniedBy } from '../src/routes/denied.js';
import { resolveTriggerOwner, triggerOwnerDeps } from '../src/routes/trigger-owners.js';
import { hiddenOr } from '../src/routes/turn-access.js';
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

/** What the runtime's storage throws when the database was too busy for a read: the mark, the driver's error as its cause. */
function busy(): Error {
  return Object.assign(
    new Error('Tenant-scoped query failed: canceling statement due to lock timeout', {
      cause: new Error('canceling statement due to lock timeout'),
    }),
    { code: 'database-busy' },
  );
}

/** The lines logged at `error` and at `warn`, with their fields. */
function recordingLogger(): {
  readonly log: Logger;
  readonly errors: unknown[][];
  readonly warns: unknown[][];
} {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const log: Logger = {
    ...noopLogger,
    error: (message, fields) => {
      errors.push([message, fields]);
    },
    warn: (message, fields) => {
      warns.push([message, fields]);
    },
    child: () => log,
  };
  return { log, errors, warns };
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

/**
 * POST `/do`, answered by `answer` with the API's own authorizer, over a
 * store that can't be reached for the checks `unreachableOn` names
 * (`<action> <type>`) and allows every other. With `thrown`, those checks
 * throw its error instead.
 */
function routeAnswering(
  unreachableOn: readonly string[],
  answer: (c: Context<AppEnv>, authorizer: Authorizer) => Promise<Response>,
  thrown: () => Error = unreachable,
) {
  const decide = (action: Action, r: { type: string; id: string }): Decision => {
    if (unreachableOn.includes(`${action} ${r.type}`)) throw thrown();
    return {
      allowed: true,
      reason: 'test: allowed',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const authorizer = createAuthorizer({
    check: async (_p, action, r) => decide(action, r),
    checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
  });
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    c.set('log', noopLogger);
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-authz-9' as never);
    c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
    return next();
  });
  r.post('/do', (c) => answer(c, authorizer));
  r.onError(mapThrownError);
  return r;
}

describe('a check a route reads as yes or no, when the store can not be reached', () => {
  test("naming a service account as a trigger's owner answers the act_as check's 503, not a 403", async () => {
    const accounts = { get: async () => ({ serviceAccountId: 'sa-1', name: 'Nightly', tenantId }) };
    const r = routeAnswering(['act_as service_account'], async (c, authorizer) => {
      const owner = await resolveTriggerOwner(
        c,
        { runAsServiceAccountId: 'sa-1' },
        { kind: 'agent', agentId: 'acme.drafter' },
        triggerOwnerDeps(c, authorizer, accounts as never),
      );
      return owner.kind === 'refused' ? owner.response : c.json({ ok: true });
    });
    const res = await r.request('/do', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual(UNAVAILABLE);
  });

  test("a refusal a conversation route hides as one that isn't there: the 503 goes back as is", async () => {
    const r = routeAnswering(['execute agent', 'read project'], async (c, authorizer) => {
      const refusal = await deniedBy(authorizer, c, 'execute', ref('agent', 'acme.drafter'));
      if (refusal === undefined) return c.json({ ok: true });
      const conversation = { agentId: 'acme.drafter', projectId: 'p-1' };
      return hiddenOr(c, authorizer, 'conv-1', conversation, refusal);
    });
    const res = await r.request('/do', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual(UNAVAILABLE);
  });
});

const BUSY = {
  error: {
    code: 'database-busy',
    message: 'The database was too busy to answer in time. Try again after Retry-After.',
    requestId: 'req-authz-9',
  },
};

const ALLOWED: Decision = {
  allowed: true,
  reason: 'test: allowed',
  evidence: { action: 'write', relation: '', resource: '', actorSubject: '' },
};

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * An app whose binding's checks answer `decide`, with the error handler and
 * the `Idempotency-Key` middleware `createApp` sets. `authorize` guards
 * `/agents/:id` on every method, and `/got/:id` with `getResource`;
 * `/inside/:id` asks `can` inside the handler. `ran` counts the guarded
 * handlers that ran.
 */
function busyApp(
  decide: () => Decision,
  getResource: (c: Context<AppEnv>) => Promise<ResourceRef> = async (c) =>
    ref('agent', c.req.param('id') ?? ''),
) {
  const authorizer = createAuthorizer({
    check: async () => decide(),
    checkBatch: async (_p, _a, rs) => rs.map(() => decide()),
  });
  const { log, errors, warns } = recordingLogger();
  const ran = { count: 0 };
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    c.set('log', log);
    c.set('tenantId' as never, tenantId as never);
    c.set('requestId' as never, 'req-authz-9' as never);
    c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
    return next();
  });
  r.use('*', idempotencyMiddleware(createInMemoryIdempotencyStore()));
  const handler = (c: Context<AppEnv>) => {
    ran.count += 1;
    return c.json({ ok: true });
  };
  r.on(
    ['GET', ...WRITES],
    '/agents/:id',
    authorizer.authorize('write', (c) => ref('agent', c.req.param('id') ?? '')),
    handler,
  );
  r.post('/got/:id', authorizer.authorize('write', getResource), handler);
  r.post('/inside/:id', async (c) =>
    c.json({ ok: await authorizer.can(c, 'write', ref('agent', c.req.param('id') ?? '')) }),
  );
  r.onError(mapThrownError);
  return { r, errors, warns, ran };
}

describe('authorize(): a database too busy for the check', () => {
  test.each(WRITES)(
    '%s: 503 database-busy with Retry-After: 5, and the handler never runs',
    async (method) => {
      const { r, errors, warns, ran } = busyApp(() => {
        throw busy();
      });
      const res = await r.request('/agents/acme.drafter', { method });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      const text = await res.text();
      expect(JSON.parse(text)).toEqual(BUSY);
      expect(text).not.toContain('lock timeout');
      expect(ran.count).toBe(0);
      // A busy database is a warning, not an operator's error.
      expect(warns.map(([message]) => message)).toEqual(['database busy']);
      expect(errors).toHaveLength(0);
    },
  );

  test('a GET answers the same 503', async () => {
    const { r } = busyApp(() => {
      throw busy();
    });
    const res = await r.request('/agents/acme.drafter');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual(BUSY);
  });

  test('the mark found down the cause chain answers the same', async () => {
    const { r } = busyApp(() => {
      throw new Error('check failed', { cause: new Error('wrapped', { cause: busy() }) });
    });
    const res = await r.request('/agents/acme.drafter', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(BUSY);
  });

  test('a resource getter the database was too busy for answers the 503 on a POST', async () => {
    const { r, ran } = busyApp(
      () => ALLOWED,
      async () => {
        throw busy();
      },
    );
    const res = await r.request('/got/acme.drafter', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual(BUSY);
    expect(ran.count).toBe(0);
  });

  test("a resource getter's own refusal answers as before", async () => {
    const { r, ran } = busyApp(
      () => ALLOWED,
      async () => {
        throw new HTTPException(404, { message: 'No agent acme.missing' });
      },
    );
    const res = await r.request('/got/acme.missing', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(ran.count).toBe(0);
  });

  test('a keyed POST the check was too busy for runs when sent again with the same key', async () => {
    let calls = 0;
    const { r, ran } = busyApp(() => {
      calls += 1;
      if (calls === 1) throw busy();
      return ALLOWED;
    });
    const send = () =>
      r.request('/agents/acme.drafter', {
        method: 'POST',
        headers: { 'idempotency-key': 'busy-then-free', 'content-type': 'application/json' },
        body: '{}',
      });
    const first = await send();
    expect(first.status).toBe(503);
    // A 5xx isn't kept against the key, and its hold is let go.
    const again = await send();
    expect(again.status, await again.text()).toBe(200);
    expect(ran.count).toBe(1);
  });
});

describe('a check inside a handler, when the database is too busy for it', () => {
  test('a POST keeps the 500: the handler may have written before its check', async () => {
    const { r } = busyApp(() => {
      throw busy();
    });
    const res = await r.request('/inside/acme.drafter', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  test('a handler that runs the middleware itself gets the 503, and one that goes on past it answers its own status', async () => {
    let answer: Response | undefined;
    const r = routeAnswering(
      ['admin agent'],
      async (c, authorizer) => {
        answer = await deniedBy(authorizer, c, 'admin', ref('agent', 'acme.drafter'));
        return c.json({ ok: true });
      },
      busy,
    );
    const res = await r.request('/do', { method: 'POST' });
    expect(answer?.status).toBe(503);
    expect(answer?.headers.get('retry-after')).toBe('5');
    expect(await answer?.json()).toEqual(BUSY);
    // Nothing of the 503 is left on the request.
    expect(res.status).toBe(200);
    expect(res.headers.get('retry-after')).toBeNull();
  });
});
