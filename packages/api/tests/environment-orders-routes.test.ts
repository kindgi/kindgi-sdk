// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Environment orders (`/v1/environment-orders`): the order a tenant runs a
 * project through on its way to live.
 *
 *   - GET  / lists the orders the caller can read a project in;
 *   - GET  /tenant and /orgs/:orgId read one, empty when unset;
 *   - PUT  /tenant and /orgs/:orgId replace one (tenant admin), `[]` clears;
 *   - a project the caller can't read is named by its position alone;
 *   - a set that changes nothing is a no-op (no write, no audit event);
 *   - a signed `environment-order-set` event records the order before and after.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent, AuditEventBinding } from '@kindgi/audit-events';
import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { OrgId, ProjectId, TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  EnvironmentOrder,
  EnvironmentOrderBinding,
  EnvironmentOrderKey,
  EnvironmentOrderParent,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';
import { createStubAppBindings } from '../src/testing/index.js';

const tenantId = randomUUID() as TenantId;
const org1 = randomUUID() as OrgId;
const org2 = randomUUID() as OrgId;
const p = Object.fromEntries(
  ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [k, randomUUID() as ProjectId]),
) as Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f', ProjectId>;

const PEOPLE = ['admin', 'orgadmin', 'viewer'] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((who) => [who, randomUUID() as UserId])) as Record<
  Person,
  UserId
>;
const whoById = (id: string): Person | undefined => PEOPLE.find((who) => ids[who] === id);
const resolveToken: TokenResolver = async (token) => {
  const who = PEOPLE.find((person) => token === `${person}-token`);
  return who === undefined ? null : { tenantId, userId: ids[who] };
};
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/** Only the viewer is narrowed: it reads projects a and c, admins everything. */
const viewerReads = new Set<string>([p.a, p.c]);
function allowed(actorId: string, action: Action, resource: ResourceRef): boolean {
  const who = whoById(actorId);
  if (who === 'admin') return true;
  if (action === 'admin') {
    // The org admin admins an org, never the tenant; the viewer admins nothing.
    return who === 'orgadmin' && resource.type === 'org';
  }
  if (action === 'read' && resource.type === 'project') {
    return who === 'viewer' ? viewerReads.has(resource.id) : true;
  }
  return who !== 'viewer';
}
const decision = (ok: boolean, action: Action, resource: ResourceRef): Decision => ({
  allowed: ok,
  reason: ok ? 'test: allowed' : 'test: denied',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) =>
    decision(allowed(principal.actor.id, action, resource), action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((r) => decision(allowed(principal.actor.id, action, r), action, r)),
};

const notUsed = (): never => {
  throw new Error('not used');
};

function parentKey(parent: EnvironmentOrderParent): string {
  return parent.kind === 'tenant' ? 'tenant' : `org:${parent.orgId as unknown as string}`;
}
function toOrder(
  parent: EnvironmentOrderParent,
  projectIds: readonly ProjectId[],
): EnvironmentOrder {
  return { parent, entries: projectIds.map((projectId, position) => ({ position, projectId })) };
}
const sameIds = (a: readonly ProjectId[], b: readonly ProjectId[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

interface FakeOptions {
  /** Initial orders, keyed as 'tenant' or 'org:<id>'. */
  readonly initial?: Readonly<Record<string, readonly ProjectId[]>>;
  /** Which parent each project is live under; a project absent is "not live". */
  readonly liveUnder?: Readonly<Record<string, string>>;
  /** Projects the binding reports as already in another order (for 409). */
  readonly taken?: ReadonlySet<ProjectId>;
}

/** A controllable in-memory order binding — enough to exercise the route. */
function fakeBinding(opts: FakeOptions): EnvironmentOrderBinding {
  const orders = new Map<string, ProjectId[]>(
    Object.entries(opts.initial ?? {}).map(([k, v]) => [k, [...v]]),
  );
  const liveUnder = opts.liveUnder ?? {};
  const taken = opts.taken ?? new Set<ProjectId>();
  return {
    async list() {
      const all: EnvironmentOrder[] = [];
      for (const [key, pids] of orders) {
        const parent: EnvironmentOrderParent = key.startsWith('org:')
          ? { kind: 'org', orgId: key.slice('org:'.length) as unknown as OrgId }
          : { kind: 'tenant' };
        all.push(toOrder(parent, pids));
      }
      return { orders: all };
    },
    async get({ parent }) {
      return toOrder(parent, orders.get(parentKey(parent)) ?? []);
    },
    async set({ parent, projectIds }) {
      const key = parentKey(parent);
      for (const id of projectIds) {
        if (taken.has(id)) {
          return {
            kind: 'project-in-another-order',
            projectId: id,
            message: `"${id as unknown as string}" already belongs to another order`,
          };
        }
        if (liveUnder[id as unknown as string] !== key) {
          return {
            kind: 'bad-input',
            message: `"${id as unknown as string}" isn't a live project under this parent`,
          };
        }
      }
      const before = orders.get(key) ?? [];
      if (sameIds(before, projectIds)) return { kind: 'no-op', order: toOrder(parent, before) };
      orders.set(key, [...projectIds]);
      return {
        kind: 'ok',
        order: toOrder(parent, projectIds),
        before: [...before],
        after: [...projectIds],
      };
    },
    async orderOf({ projectId }) {
      for (const [key, pids] of orders) {
        const position = pids.indexOf(projectId);
        if (position < 0) continue;
        const parent: EnvironmentOrderParent = key.startsWith('org:')
          ? { kind: 'org', orgId: key.slice('org:'.length) as unknown as OrgId }
          : { kind: 'tenant' };
        return { orderId: key as EnvironmentOrderKey, parent, projects: [...pids], position };
      }
      return undefined;
    },
    async hasEnvironmentOrder() {
      for (const pids of orders.values()) if (pids.length > 0) return true;
      return false;
    },
  };
}

function makeApp(opts: FakeOptions & { readonly authz?: boolean } = {}) {
  const appended: AuditEvent[] = [];
  const auditEvents: AuditEventBinding = {
    async append(events) {
      appended.push(...events);
      return { kind: 'ok', value: undefined };
    },
    query: notUsed,
    purge: notUsed,
    describe: () => ({ name: 'spy', version: '0' }),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    environmentOrders: fakeBinding(opts),
    auditEvents,
    ...(opts.authz !== false && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });
  const call = async (path: string, init?: { who?: Person; method?: string; body?: unknown }) => {
    const who = init?.who ?? 'admin';
    const res = await app.request(path, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${who}-token`,
        ...(init?.body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(init?.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, any>,
    };
  };
  return { call, appended };
}

describe('reading an order', () => {
  test('a parent with no order reads as an empty one', async () => {
    const r = await makeApp().call('/v1/environment-orders/tenant');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ parent: { kind: 'tenant' }, entries: [] });
  });

  test('the projects, each at its 0-based position', async () => {
    const h = makeApp({ initial: { tenant: [p.a, p.b] } });
    const r = await h.call('/v1/environment-orders/tenant');
    expect(r.body).toEqual({
      parent: { kind: 'tenant' },
      entries: [
        { position: 0, projectId: p.a },
        { position: 1, projectId: p.b },
      ],
    });
  });

  test("an org's order, by its id in the path", async () => {
    const h = makeApp({ initial: { [`org:${org1}`]: [p.c, p.d] } });
    const r = await h.call(`/v1/environment-orders/orgs/${org1}`);
    expect(r.body).toEqual({
      parent: { kind: 'org', orgId: org1 },
      entries: [
        { position: 0, projectId: p.c },
        { position: 1, projectId: p.d },
      ],
    });
  });

  test("a project the caller can't read is its position alone, no id", async () => {
    const h = makeApp({ initial: { tenant: [p.a, p.b] } });
    const r = await h.call('/v1/environment-orders/tenant', { who: 'viewer' });
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([{ position: 0, projectId: p.a }, { position: 1 }]);
  });

  test('an order the caller can read no project in reads as empty, like the list hides it', async () => {
    const h = makeApp({ initial: { [`org:${org2}`]: [p.e, p.f] } }); // viewer reads neither
    const r = await h.call(`/v1/environment-orders/orgs/${org2}`, { who: 'viewer' });
    expect(r.status).toBe(200);
    // Not its member count by position, and the same as an org with no order at all.
    expect(r.body).toEqual({ parent: { kind: 'org', orgId: org2 }, entries: [] });
  });
});

describe('listing orders', () => {
  test('every order, for an admin who reads them all', async () => {
    const h = makeApp({
      initial: { tenant: [p.a, p.b], [`org:${org1}`]: [p.c, p.d] },
    });
    const r = await h.call('/v1/environment-orders');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(2);
    expect(r.body).toMatchObject({ hasMore: false });
  });

  test('an order the caller can read no project in is left out', async () => {
    const h = makeApp({
      initial: {
        tenant: [p.a, p.b], // viewer reads a
        [`org:${org1}`]: [p.c, p.d], // viewer reads c
        [`org:${org2}`]: [p.e, p.f], // viewer reads neither
      },
    });
    const r = await h.call('/v1/environment-orders', { who: 'viewer' });
    const parents = (r.body.data as EnvironmentOrder[]).map((o) => o.parent);
    expect(parents).toEqual([{ kind: 'tenant' }, { kind: 'org', orgId: org1 }]);
  });

  test('a cursor this list never gave is a 400, listing nothing', async () => {
    const h = makeApp({ initial: { tenant: [p.a, p.b] } });
    // Undecodable, and decodable but not a uuid org id: neither is a cursor the list mints.
    const notUuid = Buffer.from(JSON.stringify({ orgId: 'not-a-uuid' }), 'utf8').toString(
      'base64url',
    );
    for (const cursor of ['not-a-real-cursor', notUuid]) {
      const r = await h.call(`/v1/environment-orders?cursor=${cursor}`);
      expect([r.status, r.body.error?.code]).toEqual([400, 'bad-input']);
      expect(r.body.data).toBeUndefined();
    }
  });
});

describe('setting an order', () => {
  const live = { [p.a]: 'tenant', [p.b]: 'tenant', [p.c]: 'tenant' };

  test('replaces the order, returns it, and records it before and after', async () => {
    const h = makeApp({ initial: { tenant: [p.a, p.b] }, liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.b, p.a, p.c] },
    });
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([
      { position: 0, projectId: p.b },
      { position: 1, projectId: p.a },
      { position: 2, projectId: p.c },
    ]);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      kind: 'environment-order-set',
      outcome: 'succeeded',
      payload: {
        doc: {
          parent: { kind: 'tenant' },
          before: [p.a, p.b],
          after: [p.b, p.a, p.c],
        },
      },
    });
  });

  test('the Default project can be ordered, at any position (an existing workspace puts it last, as prod)', async () => {
    // Nothing special-cases the Default project — it's a tenant-level project
    // like any other, so a tenant order may list it anywhere. (Refusing a deploy
    // into it, promoting into it and keeping its pins aren't this route's job:
    // it only has to let it be placed in a tenant-level order.)
    const dflt = p.c; // stands for the tenant's Default project (parent = tenant)
    const h = makeApp({ liveUnder: { [p.a]: 'tenant', [p.b]: 'tenant', [dflt]: 'tenant' } });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.a, p.b, dflt] },
    });
    expect(r.status).toBe(200);
    expect(r.body.entries[2]).toEqual({ position: 2, projectId: dflt });
  });

  test('`[]` clears it', async () => {
    const h = makeApp({ initial: { tenant: [p.a, p.b] }, liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [] },
    });
    expect(r.status).toBe(200);
    expect(r.body.entries).toEqual([]);
    expect(h.appended[0]).toMatchObject({ payload: { doc: { after: [] } } });
  });

  test('a write that changes nothing is a no-op: no event recorded', async () => {
    const h = makeApp({ initial: { tenant: [p.a, p.b] }, liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.a, p.b] },
    });
    expect(r.status).toBe(200);
    expect(r.body.entries).toHaveLength(2);
    expect(h.appended).toEqual([]);
  });

  test('one project is refused — an order needs two or more', async () => {
    const h = makeApp({ liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.a] },
    });
    expect([r.status, r.body.error?.code]).toEqual([400, 'bad-input']);
    expect(r.body.error?.message).toContain('two or more');
    expect(h.appended).toEqual([]);
  });

  test('a project named twice is refused', async () => {
    const h = makeApp({ liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.a, p.a] },
    });
    expect([r.status, r.body.error?.code]).toEqual([400, 'bad-input']);
    expect(r.body.error?.message).toContain('twice');
  });

  test('projectIds must be an array of non-empty strings', async () => {
    const h = makeApp({ liveUnder: live });
    for (const body of [
      {},
      { projectIds: 'nope' },
      { projectIds: [1, 2] },
      { projectIds: ['a', ''] },
    ]) {
      const r = await h.call('/v1/environment-orders/tenant', { method: 'PUT', body });
      expect([r.status, r.body.error?.code]).toEqual([400, 'bad-input']);
    }
  });

  test('a project not live under this parent is refused (from the binding)', async () => {
    const h = makeApp({ liveUnder: { [p.a]: 'tenant' } }); // b not live under tenant
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.a, p.b] },
    });
    expect([r.status, r.body.error?.code]).toEqual([400, 'bad-input']);
    expect(h.appended).toEqual([]);
  });

  test('a project already in another order is a 409 naming it', async () => {
    const h = makeApp({ liveUnder: live, taken: new Set([p.b]) });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      body: { projectIds: [p.a, p.b] },
    });
    expect([r.status, r.body.error?.code]).toEqual([409, 'project-in-another-order']);
    expect(r.body.error?.details?.projectId).toBe(p.b);
    expect(h.appended).toEqual([]);
  });
});

describe('who may write an order', () => {
  const live = { [p.a]: 'tenant', [p.b]: 'tenant' };

  test('a tenant admin may', async () => {
    const h = makeApp({ liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      who: 'admin',
      body: { projectIds: [p.a, p.b] },
    });
    expect(r.status).toBe(200);
  });

  test('an org admin may not — not even on an org order', async () => {
    const liveOrg = { [p.c]: `org:${org1}`, [p.d]: `org:${org1}` };
    const h = makeApp({ liveUnder: liveOrg });
    for (const path of ['/v1/environment-orders/tenant', `/v1/environment-orders/orgs/${org1}`]) {
      const r = await h.call(path, {
        method: 'PUT',
        who: 'orgadmin',
        body: { projectIds: [p.c, p.d] },
      });
      expect([r.status, r.body.error?.code]).toEqual([403, 'permission-denied']);
    }
    expect(h.appended).toEqual([]);
  });

  test('a project admin / plain member may not', async () => {
    const h = makeApp({ liveUnder: live });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      who: 'viewer',
      body: { projectIds: [p.a, p.b] },
    });
    expect([r.status, r.body.error?.code]).toEqual([403, 'permission-denied']);
  });

  test('without authorization configured, any caller may (a dev runtime)', async () => {
    const h = makeApp({ liveUnder: live, authz: false });
    const r = await h.call('/v1/environment-orders/tenant', {
      method: 'PUT',
      who: 'viewer',
      body: { projectIds: [p.a, p.b] },
    });
    expect(r.status).toBe(200);
  });
});

describe('not mounted without a binding', () => {
  test('no binding: no such route', async () => {
    const app = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler,
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    });
    const res = await app.request('/v1/environment-orders/tenant', {
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(res.status).toBe(404);
  });
});
