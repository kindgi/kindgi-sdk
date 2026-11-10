// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuditEvent } from '@kindgi/audit-events';
import { createInMemoryAuditEventBinding } from '@kindgi/audit-events-inmemory';
import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { createLogger } from '@kindgi/log';
import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';
import { makeInMemoryEnvironmentOrderBinding } from './support/in-memory-environment-order-binding.js';

import { createApp } from '../src/index.js';
import type {
  RunHandlerBinding,
  ServiceAccountBinding,
  SessionRevokeByProjectInput,
  SessionStoreBinding,
  TokenAdmin,
  TokenResolver,
  TokenRevokeByProjectInput,
} from '../src/index.js';

/**
 * Projects route tests.
 *
 * Wires the reference in-memory project combined-factory from
 * `@kindgi/platform`. Covers CRUD, `/default` shortcut, memberships,
 * cross-tenant isolation.
 */

const TOKEN_A = 'projects-token-tenant-a';
const TOKEN_B = 'projects-token-tenant-b';
/** A signed-in user in tenant A, for the authorization tests. */
const USER_A = 'projects-token-user-a';
const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN_A) return { tenantId: tenantA };
  if (token === TOKEN_B) return { tenantId: tenantB };
  if (token === USER_A) return { tenantId: tenantA, userId: 'user-a' as UserId };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  invokeFlow: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used' },
  }),
  resumeRun: async () => ({
    kind: 'err',
    error: { code: 'bad-input', message: 'not used in this suite' },
  }),
};

function makeApp(authz?: AuthzCheckBinding) {
  const trio = makeInMemoryProjectBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    projectBinding: trio.projects,
    projectMembershipBinding: trio.memberships,
    teamProjectGrantBinding: trio.grants,
    ...(authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: authz },
    }),
  });
  return { app, trio };
}

async function createProject(
  app: ReturnType<typeof makeApp>['app'],
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request('/v1/projects', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`project create failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

// A composed in-memory server: the project binding's environment-order guard
// hook wired to an in-memory EnvironmentOrderBinding they share.
function makeGuardApp() {
  const orders = makeInMemoryEnvironmentOrderBinding();
  const trio = makeInMemoryProjectBinding({
    environmentOrderOf: async (tenantId, projectId) =>
      (await orders.orderOf({ tenantId, projectId }))?.orderId,
  });
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    projectBinding: trio.projects,
    projectMembershipBinding: trio.memberships,
    teamProjectGrantBinding: trio.grants,
    environmentOrders: orders,
  });
  return { app, trio, orders };
}

describe('API — projects environment-order guard', () => {
  async function seedOrder(
    app: ReturnType<typeof makeGuardApp>['app'],
    orders: ReturnType<typeof makeGuardApp>['orders'],
  ) {
    const staging = await createProject(app, TOKEN_A, { name: 'Staging', slug: 'staging' });
    const prod = await createProject(app, TOKEN_A, { name: 'Prod', slug: 'prod' });
    const set = await orders.set({
      tenantId: tenantA,
      parent: { kind: 'tenant' },
      projectIds: [staging, prod] as ProjectId[],
    });
    expect(set.kind).toBe('ok');
    return { staging, prod };
  }

  test('DELETE a project in an environment order → 409 project-in-environment-order; it stays', async () => {
    const { app, orders } = makeGuardApp();
    const { staging } = await seedOrder(app, orders);
    const del = await app.request(`/v1/projects/${staging}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(del.status).toBe(409);
    const body = (await del.json()) as {
      error: { code: string; details?: { orderId?: string } };
    };
    expect(body.error.code).toBe('project-in-environment-order');
    expect(body.error.details?.orderId).toBe(`tenant:${tenantA}`);
    const get = await app.request(`/v1/projects/${staging}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(get.status).toBe(200);
  });

  test('PATCH orgId on a project in an environment order → 409', async () => {
    const { app, orders } = makeGuardApp();
    const { staging } = await seedOrder(app, orders);
    const patch = await app.request(`/v1/projects/${staging}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: randomUUID() }),
    });
    expect(patch.status).toBe(409);
    const body = (await patch.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project-in-environment-order');
  });

  test('a rename PATCH on an ordered project still succeeds (204)', async () => {
    const { app, orders } = makeGuardApp();
    const { staging } = await seedOrder(app, orders);
    const patch = await app.request(`/v1/projects/${staging}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Staging-renamed' }),
    });
    expect(patch.status).toBe(204);
  });
});

/** The fields of a JSON log line these tests read. */
interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly tenantId?: string;
  readonly projectId?: string;
}

// A project to delete, with recording fakes where its keys and sessions are
// revoked: each call is kept, with how many errors were logged before it, and
// the first `keysFail` / `sessionsFail` calls throw. `inUse` makes the
// binding answer `project-in-use` for a project that isn't the default.
function makeDeleteApp(
  options: {
    readonly inUse?: boolean;
    readonly keysFail?: number;
    readonly sessionsFail?: number;
    readonly sessionsEnded?: number;
    readonly canRevokeByProject?: boolean;
    readonly authz?: AuthzCheckBinding;
  } = {},
) {
  const trio = makeInMemoryProjectBinding({ projectInUse: () => options.inUse === true });
  const lines: string[] = [];
  const logged = (level: string) =>
    lines.map((line) => JSON.parse(line) as LogLine).filter((rec) => rec.level === level);
  const keyCalls: TokenRevokeByProjectInput[] = [];
  const sessionCalls: SessionRevokeByProjectInput[] = [];
  const errorsBeforeKeyCall: number[] = [];
  const unregistered: string[] = [];
  let keysFail = options.keysFail ?? 0;
  let sessionsFail = options.sessionsFail ?? 0;
  // The first revoke that succeeds ends the sessions; a repeat ends none.
  let sessionsRevoked = false;
  const canRevoke = options.canRevokeByProject !== false;
  const tokenAdmin = {
    ...(canRevoke && {
      revokeByProject: async (input: TokenRevokeByProjectInput) => {
        keyCalls.push(input);
        errorsBeforeKeyCall.push(logged('error').length);
        if (keysFail > 0) {
          keysFail -= 1;
          throw new Error('the key store is unreachable');
        }
        return { revokedCount: 1 };
      },
    }),
  } as unknown as TokenAdmin;
  const sessionStore = {
    ...(canRevoke && {
      revokeByProject: async (input: SessionRevokeByProjectInput) => {
        sessionCalls.push(input);
        if (sessionsFail > 0) {
          sessionsFail -= 1;
          throw new Error('the session store is unreachable');
        }
        if (sessionsRevoked) return { revokedCount: 0 };
        sessionsRevoked = true;
        return { revokedCount: options.sessionsEnded ?? 0 };
      },
    }),
  } as unknown as SessionStoreBinding;
  const serviceAccountBinding = {
    projectAccounts: {
      get: async () => ({ serviceAccountId: 'acme-project-account' }),
      ensure: async () => {
        throw new Error('not used in this suite');
      },
    },
    unregister: async (input: { serviceAccountId: string }) => {
      unregistered.push(input.serviceAccountId);
      return { kind: 'ok', value: {} };
    },
  } as unknown as ServiceAccountBinding;
  const store = createInMemoryAuditEventBinding();
  const written: AuditEvent[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    logger: createLogger({ write: (line) => lines.push(line) }),
    projectBinding: trio.projects,
    projectMembershipBinding: trio.memberships,
    teamProjectGrantBinding: trio.grants,
    tokenAdmin,
    sessionStore,
    serviceAccountBinding,
    auditEvents: {
      ...store,
      append: async (events) => {
        written.push(...events);
        return store.append(events);
      },
    },
    ...(options.authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: options.authz },
    }),
  });
  const del = (id: string) =>
    app.request(`/v1/projects/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${USER_A}` },
    });
  const get = (id: string) =>
    app.request(`/v1/projects/${id}`, { headers: { authorization: `Bearer ${USER_A}` } });
  const sessionsEnded = () => written.filter((e) => e.kind === 'sessions-ended');
  return {
    app,
    trio,
    del,
    get,
    logged,
    keyCalls,
    sessionCalls,
    errorsBeforeKeyCall,
    unregistered,
    sessionsEnded,
  };
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe('API — deleting a project', () => {
  test('the default project: 409 project-is-default, even in use; nothing goes with it', async () => {
    const h = makeDeleteApp({ inUse: true });
    const id = await createProject(h.app, TOKEN_A, {
      name: 'Default',
      slug: 'default',
      isDefault: true,
    });
    const del = await h.del(id);
    expect(del.status).toBe(409);
    expect(await errorCode(del)).toBe('project-is-default');
    expect((await h.get(id)).status).toBe(200);
    expect(h.unregistered).toEqual([]);
    expect(h.keyCalls).toEqual([]);
    expect(h.sessionCalls).toEqual([]);
  });

  test('a project in use: 409 project-in-use; its account, keys and sessions stay', async () => {
    const h = makeDeleteApp({ inUse: true });
    const id = await createProject(h.app, TOKEN_A, { name: 'Support', slug: 'support' });
    const del = await h.del(id);
    expect(del.status).toBe(409);
    const body = (await del.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('project-in-use');
    expect(body.error.message).toContain(
      '`kindgi sites unregister <site-id> --project=<project-id>`',
    );
    expect(body.error.message).toContain('`kindgi artifacts delete <blob-id>`');
    expect(body.error.message).toContain('`kindgi connection-choices unset <choice-id>`');
    expect((await h.get(id)).status).toBe(200);
    expect(h.unregistered).toEqual([]);
    expect(h.keyCalls).toEqual([]);
    expect(h.sessionCalls).toEqual([]);
  });

  test("a deleted project's keys and sessions are revoked as the caller, and again on a repeat", async () => {
    const h = makeDeleteApp({ sessionsEnded: 2 });
    const id = await createProject(h.app, TOKEN_A, { name: 'Support', slug: 'support' });
    expect((await h.del(id)).status).toBe(204);
    expect(h.unregistered).toEqual(['acme-project-account']);
    expect(h.keyCalls).toEqual([{ tenantId: tenantA, projectId: id, revokedBy: 'user:user-a' }]);
    expect(h.sessionCalls).toEqual([{ tenantId: tenantA, projectId: id }]);
    const ended = h.sessionsEnded();
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actor: 'user:user-a',
      payload: { doc: { projectId: id, reason: 'project-deleted', revokedCount: 2 } },
    });
    expect(ended[0]?.projectId).toBeUndefined();
    expect((await h.get(id)).status).toBe(404);

    // The project is gone: a repeat delete answers 204 and revokes again.
    expect((await h.del(id)).status).toBe(204);
    expect(h.keyCalls).toHaveLength(2);
    expect(h.sessionCalls).toHaveLength(2);
    expect(h.sessionsEnded()).toHaveLength(1);
    expect(h.logged('error')).toEqual([]);
  });

  test('a revoke that fails is logged with the workspace and the project, then tried once more', async () => {
    const h = makeDeleteApp({ keysFail: 1 });
    const id = await createProject(h.app, TOKEN_A, { name: 'Support', slug: 'support' });
    expect((await h.del(id)).status).toBe(204);
    // Logged before the second try, not after it.
    expect(h.errorsBeforeKeyCall).toEqual([0, 1]);
    const errors = h.logged('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ tenantId: tenantA, projectId: id });
    expect(errors[0]?.message).toContain('trying once more');
    expect(h.sessionCalls).toHaveLength(1);
    expect(h.sessionsEnded()).toEqual([]);
  });

  test('a revoke that fails twice is logged twice; the delete answers 204, and a repeat finishes it', async () => {
    const h = makeDeleteApp({ sessionsFail: 2, sessionsEnded: 3 });
    const id = await createProject(h.app, TOKEN_A, { name: 'Support', slug: 'support' });
    expect((await h.del(id)).status).toBe(204);
    expect(h.sessionCalls).toHaveLength(2);
    const errors = h.logged('error');
    const where = { tenantId: tenantA, projectId: id };
    expect(errors).toMatchObject([where, where]);
    expect(errors[1]?.message).toContain('deleting it again revokes them');
    expect(h.sessionsEnded()).toEqual([]);
    expect((await h.get(id)).status).toBe(404);

    expect((await h.del(id)).status).toBe(204);
    expect(h.sessionCalls).toHaveLength(3);
    expect(h.sessionsEnded()).toHaveLength(1);
  });

  test("a runtime that can't revoke by project: 204, and one warning per delete", async () => {
    const h = makeDeleteApp({ canRevokeByProject: false });
    const id = await createProject(h.app, TOKEN_A, { name: 'Support', slug: 'support' });
    expect((await h.del(id)).status).toBe(204);
    const warnings = h.logged('warn').filter((line) => line.message.includes("weren't revoked"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ tenantId: tenantA, projectId: id });
    expect(warnings[0]?.message).toContain('keys and sessions');
    expect(h.logged('error')).toEqual([]);
  });

  test('deleting takes delete on the project: without it, a 403 that deletes and revokes nothing', async () => {
    const granted = new Set<string>();
    const authz = {
      check: async (
        _principal: unknown,
        action: string,
        resource: { type: string; id: string },
      ) => {
        const allowed = granted.has(`${action} ${resource.type}:${resource.id}`);
        return { allowed, reason: 'test', failing: allowed ? undefined : 'actor' } as Decision;
      },
    } as unknown as AuthzCheckBinding;
    const h = makeDeleteApp({ authz });
    const made = await h.trio.projects.create(tenantA, { name: 'Support', slug: 'support' });
    if (made.kind !== 'ok') throw new Error(made.kind);
    const id = made.projectId as unknown as string;
    granted.add(`read project:${id}`);

    const refused = await h.del(id);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe('permission-denied');
    expect((await h.get(id)).status).toBe(200);
    expect(h.unregistered).toEqual([]);
    expect(h.keyCalls).toEqual([]);
    expect(h.sessionCalls).toEqual([]);

    granted.add(`delete project:${id}`);
    expect((await h.del(id)).status).toBe(204);
    expect(h.keyCalls).toHaveLength(1);
  });
});

describe('API — projects CRUD', () => {
  test('create → get roundtrip; isDefault defaults to false', async () => {
    const { app } = makeApp();
    const id = await createProject(app, TOKEN_A, { name: 'Foo', slug: 'foo' });
    const get = await app.request(`/v1/projects/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const body = (await get.json()) as {
      id: string;
      name: string;
      slug: string;
      isDefault: boolean;
    };
    expect(body.id).toBe(id);
    expect(body.name).toBe('Foo');
    expect(body.slug).toBe('foo');
    expect(body.isDefault).toBe(false);
  });

  test('unknown projectId → 404 project-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/projects/nope', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project-not-found');
  });

  test('patch + delete roundtrip', async () => {
    const { app } = makeApp();
    const id = await createProject(app, TOKEN_A, { name: 'x', slug: 'x' });
    const patch = await app.request(`/v1/projects/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'updated' }),
    });
    expect(patch.status).toBe(204);

    const get = await app.request(`/v1/projects/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const body = (await get.json()) as { description?: string };
    expect(body.description).toBe('updated');

    const del = await app.request(`/v1/projects/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(del.status).toBe(204);
  });

  test('sortEndUserCorrections reads false until a PATCH turns it on; a non-boolean is a 400 that changes nothing', async () => {
    const { app } = makeApp();
    const id = await createProject(app, TOKEN_A, { name: 'x', slug: 'x' });
    const read = async () =>
      (
        (await (
          await app.request(`/v1/projects/${id}`, {
            headers: { authorization: `Bearer ${TOKEN_A}` },
          })
        ).json()) as { sortEndUserCorrections?: boolean }
      ).sortEndUserCorrections;
    const patch = (body: unknown) =>
      app.request(`/v1/projects/${id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect(await read()).toBe(false);
    expect((await patch({ sortEndUserCorrections: true })).status).toBe(204);
    expect(await read()).toBe(true);

    const bad = await patch({ sortEndUserCorrections: 'yes' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe(
      '`sortEndUserCorrections` must be a boolean when present',
    );
    expect(await read()).toBe(true);

    expect((await patch({ sortEndUserCorrections: false })).status).toBe(204);
    expect(await read()).toBe(false);
  });

  test('turning sortEndUserCorrections on takes admin on the project: write is a 403 that changes nothing', async () => {
    const granted = new Set<string>();
    const authz = {
      check: async (
        _principal: unknown,
        action: string,
        resource: { type: string; id: string },
      ) => {
        const allowed = granted.has(`${action} ${resource.type}:${resource.id}`);
        return { allowed, reason: 'test', failing: allowed ? undefined : 'actor' } as Decision;
      },
    } as unknown as AuthzCheckBinding;
    const { app, trio } = makeApp(authz);
    const made = await trio.projects.create(tenantA, {
      name: 'x',
      slug: 'x',
      role: 'owner',
    } as never);
    if (made.kind !== 'ok') throw new Error(made.kind);
    const id = made.projectId as unknown as string;
    granted.add(`read project:${id}`).add(`write project:${id}`);
    const patch = () =>
      app.request(`/v1/projects/${id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${USER_A}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sortEndUserCorrections: true }),
      });
    const read = async () => {
      const res = await app.request(`/v1/projects/${id}`, {
        headers: { authorization: `Bearer ${USER_A}` },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { sortEndUserCorrections?: boolean }).sortEndUserCorrections;
    };

    expect(await read()).toBe(false);
    const refused = await patch();
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'permission-denied',
    );
    expect(await read()).toBe(false);

    granted.add(`admin project:${id}`);
    expect((await patch()).status).toBe(204);
    expect(await read()).toBe(true);
  });

  test('a PATCH naming orgId also takes admin on the tenant: the project admin is a 403 that changes nothing', async () => {
    const granted = new Set<string>();
    const authz = {
      check: async (
        _principal: unknown,
        action: string,
        resource: { type: string; id: string },
      ) => {
        const allowed = granted.has(`${action} ${resource.type}:${resource.id}`);
        return { allowed, reason: 'test', failing: allowed ? undefined : 'actor' } as Decision;
      },
    } as unknown as AuthzCheckBinding;
    const { app, trio } = makeApp(authz);
    const made = await trio.projects.create(tenantA, {
      name: 'moved',
      slug: 'moved',
      orgId: 'org-a',
      role: 'owner',
    } as never);
    if (made.kind !== 'ok') throw new Error(made.kind);
    const id = made.projectId as unknown as string;
    // Its owner: admin on the project, not on the tenant.
    granted.add(`read project:${id}`).add(`admin project:${id}`);
    const patch = (body: unknown) =>
      app.request(`/v1/projects/${id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${USER_A}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const read = async () => {
      const res = await app.request(`/v1/projects/${id}`, {
        headers: { authorization: `Bearer ${USER_A}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { name: string; orgId?: string };
    };

    // Into another org, out of any, its own org again, and beside a rename.
    for (const body of [
      { orgId: 'org-b' },
      { orgId: null },
      { orgId: 'org-a' },
      { name: 'renamed', orgId: 'org-b' },
    ]) {
      const refused = await patch(body);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: {
          code: 'permission-denied',
          details: { action: 'admin', resource: `tenant:${tenantA as unknown as string}` },
        },
      });
    }
    expect(await read()).toMatchObject({ name: 'moved', orgId: 'org-a' });

    // A PATCH without `orgId` takes admin on the project, as before.
    expect((await patch({ name: 'renamed' })).status).toBe(204);
    expect(await read()).toMatchObject({ name: 'renamed', orgId: 'org-a' });

    granted.add(`admin tenant:${tenantA as unknown as string}`);
    expect((await patch({ orgId: 'org-b' })).status).toBe(204);
    expect(await read()).toMatchObject({ orgId: 'org-b' });
    expect((await patch({ orgId: null })).status).toBe(204);
    expect((await read()).orgId).toBeUndefined();
  });

  test('pagination with limit + cursor', async () => {
    const { app } = makeApp();
    for (let i = 0; i < 3; i += 1) {
      await createProject(app, TOKEN_A, { name: `p${i}`, slug: `p-${i}` });
    }
    const first = await app.request('/v1/projects?limit=2', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const firstBody = (await first.json()) as {
      data: unknown[];
      hasMore: boolean;
      nextCursor?: string;
    };
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);
    const second = await app.request(
      `/v1/projects?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: { authorization: `Bearer ${TOKEN_A}` } },
    );
    const secondBody = (await second.json()) as { data: unknown[]; hasMore: boolean };
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.hasMore).toBe(false);
  });
});

describe('API — projects /default', () => {
  test('no default → 404 project-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/projects/default', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project-not-found');
  });

  test('after the default is created → 200 with isDefault: true', async () => {
    const { app } = makeApp();
    await createProject(app, TOKEN_A, {
      name: 'Default',
      slug: 'default',
      isDefault: true,
    });
    const res = await app.request('/v1/projects/default', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; isDefault: boolean };
    expect(body.name).toBe('Default');
    expect(body.isDefault).toBe(true);
  });

  test('/default is resolved BEFORE /:projectId (literal wins)', async () => {
    // Even if a project literally named "default" exists as an id
    // (impossible with UUIDs but conceptually — the route is mounted
    // before the param handler), the /default segment resolves to
    // getDefault, not to a get-by-id call.
    const { app } = makeApp();
    // No default provisioned — /default returns 404 project-not-found
    // (a proof that the /default route ran, not the :projectId route
    // which would return 404 with the same code but different message
    // — the message helps disambiguate but the code is the same, so
    // this test just documents ordering intent).
    const res = await app.request('/v1/projects/default', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    // getDefault's 404 says "Tenant has no default project"; the
    // :projectId 404 says "No project with id 'default'". Distinct
    // messages confirm the /default route handled the request.
    expect(body.error.message).toBe('Workspace has no default project');
  });
});

describe('API — project memberships', () => {
  test('add + list + patch role + remove', async () => {
    const { app } = makeApp();
    const projectId = await createProject(app, TOKEN_A, { name: 'x', slug: 'x' });
    const userId = randomUUID();
    const add = await app.request(`/v1/projects/${projectId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role: 'viewer' }),
    });
    expect(add.status).toBe(201);

    const list = await app.request(`/v1/projects/${projectId}/memberships`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const listBody = (await list.json()) as {
      data: Array<{ userId: string; role: string }>;
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.role).toBe('viewer');

    const patch = await app.request(`/v1/projects/${projectId}/memberships/${userId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(patch.status).toBe(204);

    const list2 = await app.request(`/v1/projects/${projectId}/memberships`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const list2Body = (await list2.json()) as { data: Array<{ role: string }> };
    expect(list2Body.data[0]?.role).toBe('editor');

    const del = await app.request(`/v1/projects/${projectId}/memberships/${userId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(del.status).toBe(204);
  });

  test('membership list on unknown project → 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/projects/no-such/memberships', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project-not-found');
  });

  test('updateRole on absent membership → 404 project-membership-not-found', async () => {
    const { app } = makeApp();
    const projectId = await createProject(app, TOKEN_A, { name: 'x', slug: 'x' });
    const res = await app.request(`/v1/projects/${projectId}/memberships/${randomUUID()}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project-membership-not-found');
  });

  test('invalid role → 400', async () => {
    const { app } = makeApp();
    const projectId = await createProject(app, TOKEN_A, { name: 'x', slug: 'x' });
    const res = await app.request(`/v1/projects/${projectId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID(), role: 'bad' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('`role` must be one of: viewer, editor, owner, admin');
  });

  test('`member` is retired: adding or changing to it is a 400 naming `viewer`, and changes nothing', async () => {
    const { app } = makeApp();
    const projectId = await createProject(app, TOKEN_A, { name: 'x', slug: 'x' });
    const userId = randomUUID();
    const send = (method: string, path: string, body: unknown) =>
      app.request(`/v1/projects/${projectId}/memberships${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const roles = async () => {
      const res = await app.request(`/v1/projects/${projectId}/memberships`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
      return ((await res.json()) as { data: { role: string }[] }).data.map((m) => m.role);
    };
    const retired = {
      code: 'bad-input',
      message: "`member` isn't a project role: use `viewer`, which grants the same",
    };

    const add = await send('POST', '', { userId, role: 'member' });
    expect(add.status).toBe(400);
    expect(((await add.json()) as { error: unknown }).error).toMatchObject(retired);
    expect(await roles()).toEqual([]);

    expect((await send('POST', '', { userId, role: 'editor' })).status).toBe(201);
    const change = await send('PATCH', `/${userId}`, { role: 'member' });
    expect(change.status).toBe(400);
    expect(((await change.json()) as { error: unknown }).error).toMatchObject(retired);
    expect(await roles()).toEqual(['editor']);
  });
});

describe('API — projects cross-tenant isolation', () => {
  test('tenant B never sees tenant A projects', async () => {
    const { app } = makeApp();
    const id = await createProject(app, TOKEN_A, { name: 'A', slug: 'a' });
    const list = await app.request('/v1/projects', {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    const body = (await list.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
    const get = await app.request(`/v1/projects/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    expect(get.status).toBe(404);
  });

  test("tenant A's default is not tenant B's default", async () => {
    const { app } = makeApp();
    await createProject(app, TOKEN_A, {
      name: 'A-Default',
      slug: 'a-default',
      isDefault: true,
    });
    const bDefault = await app.request('/v1/projects/default', {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    expect(bDefault.status).toBe(404);
  });
});

describe('API — projects surface unmounted when bindings missing', () => {
  test('no project bindings → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/projects', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
  });
});
