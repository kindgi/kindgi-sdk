// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A refusal the authorizer decides itself, before asking the binding (what
 * the caller's API key rules out, or a check the model can't answer), is
 * recorded through the binding's `recordDecision`, as the binding records
 * its own decisions: so the audit holds every refusal, whichever check made
 * it. The binding's own decisions aren't recorded twice.
 */

import { type Context, Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type ResourceRef,
  ref,
  userPrincipal,
} from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createAuthorizer } from '../src/middleware/authorize.js';
import type { AppEnv } from '../src/types.js';

const tenantId = '00000000-0000-4000-8000-0000000000aa' as TenantId;
const projectA = '00000000-0000-4000-8000-00000000000a';
const projectB = '00000000-0000-4000-8000-00000000000b';

interface Recorded {
  readonly action: Action;
  readonly resource: string;
  readonly decision: Decision;
  readonly correlationId: string | undefined;
}

const allowed = (action: Action, r: ResourceRef): Decision => ({
  allowed: true,
  reason: 'test: granted',
  evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
});

/** A binding that grants everything, so only the authorizer itself refuses. */
function harness(
  key: { readonly role?: 'admin' | 'member'; readonly projectId?: string } = {},
  options: { readonly recordThrows?: boolean; readonly inProject?: boolean } = {},
) {
  const recorded: Recorded[] = [];
  const checked: string[] = [];
  const binding: AuthzCheckBinding = {
    check: async (_p, action, r) => {
      checked.push(`${action} ${r.type}:${r.id}`);
      return allowed(action, r);
    },
    checkBatch: async (_p, action, rs) => {
      for (const r of rs) checked.push(`${action} ${r.type}:${r.id}`);
      return rs.map((r) => allowed(action, r));
    },
    inProject: async () => options.inProject ?? false,
    recordDecision: (_p, action, r, decision, ctx) => {
      if (options.recordThrows) throw new Error('the audit store is down');
      recorded.push({
        action,
        resource: `${r.type}:${r.id}`,
        decision,
        correlationId: ctx?.correlationId,
      });
    },
  };
  const authorizer = createAuthorizer(binding);
  /** A fresh app per call (Hono takes no route once it has answered), the caller set as given. */
  const mount = () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('requestId' as never, 'req-own-1' as never);
      c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
      if (key.role !== undefined) c.set('tokenRole' as never, key.role as never);
      if (key.projectId !== undefined) c.set('tokenProjectId' as never, key.projectId as never);
      await next();
    });
    return app;
  };
  const inHandler = async <T>(run: (c: Context<AppEnv>) => Promise<T>): Promise<T> => {
    let out: T | undefined;
    const app = mount();
    app.get('/', async (c) => {
      out = await run(c);
      return c.text('ok');
    });
    await app.request('/');
    return out as T;
  };
  const ask = (action: Action, resource: ResourceRef) =>
    inHandler((c) => authorizer.can(c, action, resource));
  const filter = (action: Action, resources: readonly ResourceRef[]) =>
    inHandler((c) => authorizer.filterByCan(c, action, resources, (x) => x));
  const guarded = (action: Action, resource: ResourceRef) => {
    const app = mount();
    app.get(
      '/guarded',
      authorizer.authorize(action, () => resource),
      (c) => c.text('ok'),
    );
    return app.request('/guarded');
  };
  return { recorded, checked, ask, filter, guarded };
}

describe('the authorizer records the refusals it decides itself', () => {
  test("a member key asking a tenant admin's action: refused, recorded once, with the request", async () => {
    const h = harness({ role: 'member' });
    expect(await h.ask('admin', ref('tenant', tenantId))).toBe(false);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      action: 'admin',
      resource: `tenant:${tenantId}`,
      correlationId: 'req-own-1',
      decision: { allowed: false, failing: 'scope' },
    });
    expect(h.recorded[0]?.decision.reason).toMatch(/member API key takes no admin action/);
    expect(h.recorded[0]?.decision.evidence.actorSubject).toBe('user:u-1');
    expect(h.checked).toEqual([]);
  });

  test('the same refusal through the authorize middleware: a 403, recorded', async () => {
    const h = harness({ role: 'member' });
    expect((await h.guarded('admin', ref('tenant', tenantId))).status).toBe(403);
    expect(h.recorded.map((r) => `${r.action} ${r.resource}`)).toEqual([
      `admin tenant:${tenantId}`,
    ]);
  });

  test('a key limited to a project: another project, and an object outside its project, are recorded', async () => {
    const h = harness({ projectId: projectA });
    expect(await h.ask('read', ref('project', projectB))).toBe(false);
    expect(await h.ask('read', ref('agent', 'acme.elsewhere'))).toBe(false);
    expect(h.recorded.map((r) => [r.resource, r.decision.reason])).toEqual([
      [`project:${projectB}`, `the API key is limited to project ${projectA}`],
      ['agent:acme.elsewhere', `the API key is limited to project ${projectA}`],
    ]);
  });

  test("a check the model can't answer (a bug in the route) is recorded as one", async () => {
    const h = harness();
    expect(await h.ask('execute', ref('tenant', tenantId))).toBe(false);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.decision).toMatchObject({ allowed: false, failing: 'invalid-action' });
  });

  test("the binding's own decisions aren't recorded here: the binding records them", async () => {
    const h = harness({ projectId: projectA });
    expect(await h.ask('read', ref('project', projectA))).toBe(true);
    expect(h.checked).toEqual([`read project:${projectA}`]);
    expect(h.recorded).toEqual([]);
  });

  test('filtering a list: each item the key rules out is recorded; the rest go to the binding', async () => {
    const h = harness({ projectId: projectA }, { inProject: false });
    const kept = await h.filter('read', [ref('project', projectA), ref('project', projectB)]);
    expect(kept).toEqual([ref('project', projectA)]);
    expect(h.recorded.map((r) => r.resource)).toEqual([`project:${projectB}`]);
    expect(h.checked).toEqual([`read project:${projectA}`]);
  });

  test("a recording that fails doesn't fail the request", async () => {
    const h = harness({ role: 'member' }, { recordThrows: true });
    expect(await h.ask('admin', ref('tenant', tenantId))).toBe(false);
    expect((await h.guarded('admin', ref('tenant', tenantId))).status).toBe(403);
  });

  test('a binding without recordDecision (an older runtime) still refuses, recording nothing', async () => {
    const binding: AuthzCheckBinding = {
      check: async (_p, action, r) => allowed(action, r),
      checkBatch: async (_p, action, rs) => rs.map((r) => allowed(action, r)),
    };
    const authorizer = createAuthorizer(binding);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('tenantId' as never, tenantId as never);
      c.set('principal' as never, userPrincipal('u-1' as UserId, tenantId) as never);
      c.set('tokenRole' as never, 'member' as never);
      await next();
    });
    app.get(
      '/',
      authorizer.authorize('admin', () => ref('tenant', tenantId)),
      (c) => c.text('ok'),
    );
    expect((await app.request('/')).status).toBe(403);
  });
});
