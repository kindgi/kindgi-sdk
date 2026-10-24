// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import {
  type ProjectBinding,
  type TenantHierarchyBinding,
  type TenantSummary,
  makeInMemoryProjectBinding,
} from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { CreateAppInput, RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * `PUT /v1/projects/:projectId/production`: a project in production, or
 * out of it; the production gate; and what `GET /v1/projects/:id` and
 * `GET /v1/tenant` say about it.
 */

const TOKEN = 'production-token';
const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const NEXT = 'https://platform.example.com/account/billing';

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

interface Setup {
  readonly tenant?: Partial<TenantSummary>;
  readonly production?: CreateAppInput['production'];
  readonly projects?: ProjectBinding;
  readonly authz?: AuthzCheckBinding;
}

function makeApp(setup: Setup = {}) {
  // The binding reads the tenant's limit itself, as a runtime's does where it keeps it.
  const trio = makeInMemoryProjectBinding({
    productionLimit: () => setup.tenant?.limits?.projectsInProduction,
  });
  const stubs = createStubAppBindings();
  const tenantHierarchyBinding: TenantHierarchyBinding = {
    ...stubs.tenantHierarchyBinding,
    getTenant: async () => ({
      id: tenantId,
      name: 'Acme',
      slug: 'acme',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...setup.tenant,
    }),
  };
  const app = createApp({
    ...stubs,
    tenantHierarchyBinding,
    resolveToken,
    runHandler,
    projectBinding: setup.projects ?? trio.projects,
    projectMembershipBinding: trio.memberships,
    ...(setup.production !== undefined && { production: setup.production }),
    ...(setup.authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: setup.authz },
    }),
  });
  return { app, trio };
}

async function newProject(trio: ReturnType<typeof makeInMemoryProjectBinding>): Promise<string> {
  const made = await trio.projects.create(tenantId, {
    name: 'Shop',
    slug: `shop-${randomUUID().slice(0, 8)}`,
    role: 'owner',
  } as never);
  if (made.kind !== 'ok') throw new Error(made.kind);
  return made.projectId as unknown as string;
}

function put(app: ReturnType<typeof makeApp>['app'], projectId: string, body: unknown) {
  return app.request(`/v1/projects/${projectId}/production`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getJson(app: ReturnType<typeof makeApp>['app'], path: string) {
  const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('PUT /v1/projects/:projectId/production', () => {
  test('on, then off: the answer and the project read follow it', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);

    const on = await put(app, id, { production: true });
    expect(on.status).toBe(200);
    const onBody = (await on.json()) as { projectId: string; productionSince: string };
    expect(onBody.projectId).toBe(id);
    expect(Number.isNaN(Date.parse(onBody.productionSince))).toBe(false);
    expect((await getJson(app, `/v1/projects/${id}`)).body.productionSince).toBe(
      onBody.productionSince,
    );

    const off = await put(app, id, { production: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ projectId: id, productionSince: null });
    expect((await getJson(app, `/v1/projects/${id}`)).body).not.toHaveProperty('productionSince');
  });

  test('a repeat answers 200 unchanged and keeps the first productionSince', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    const first = (await (await put(app, id, { production: true })).json()) as {
      productionSince: string;
    };
    const again = await put(app, id, { production: true });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ projectId: id, productionSince: first.productionSince });

    await put(app, id, { production: false });
    const offAgain = await put(app, id, { production: false });
    expect(offAgain.status).toBe(200);
    expect(await offAgain.json()).toEqual({ projectId: id, productionSince: null });
  });

  test('a renamed project keeps its productionSince', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    const on = (await (await put(app, id, { production: true })).json()) as {
      productionSince: string;
    };
    const patched = await app.request(`/v1/projects/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shop, renamed' }),
    });
    expect(patched.status).toBe(204);
    expect((await getJson(app, `/v1/projects/${id}`)).body.productionSince).toBe(
      on.productionSince,
    );
  });

  test('a body that is not { production: boolean } is 400 bad-input', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    for (const body of ['not json', {}, { production: 'yes' }, [true], null]) {
      const res = await put(app, id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
    }
  });

  test('an unknown project is 404 project-not-found', async () => {
    const { app } = makeApp();
    const res = await put(app, randomUUID(), { production: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'project-not-found',
    );
  });

  test('a project binding without setProduction answers 501 production-unsupported', async () => {
    const { trio } = makeApp();
    const { setProduction: _no, ...without } = trio.projects;
    const { app } = makeApp({ projects: without });
    const id = await newProject(trio);
    const res = await put(app, id, { production: true });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'production-unsupported',
    );
  });
});

describe('the production gate', () => {
  test('gate on, tenant not allowed: 403 production-not-allowed, naming next', async () => {
    const { app, trio } = makeApp({
      tenant: { productionAllowed: false },
      production: { gate: true, next: NEXT },
    });
    const id = await newProject(trio);
    const res = await put(app, id, { production: true });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details: Record<string, unknown> };
    };
    expect(error.code).toBe('production-not-allowed');
    expect(error.details).toEqual({ projectId: id, next: NEXT });
    expect(error.message).toContain(NEXT);
    expect((await getJson(app, `/v1/projects/${id}`)).body).not.toHaveProperty('productionSince');
  });

  test('gate on, no next: the refusal carries no next, and says to ask', async () => {
    const { app, trio } = makeApp({
      tenant: { productionAllowed: false },
      production: { gate: true },
    });
    const id = await newProject(trio);
    const res = await put(app, id, { production: true });
    expect(res.status).toBe(403);
    const { error } = (await res.json()) as {
      error: { message: string; details: Record<string, unknown> };
    };
    expect(error.details).toEqual({ projectId: id });
    expect(error.message).toContain('ask whoever runs this Kindgi');
  });

  test('gate on, tenant allowed (or saying nothing): it goes into production', async () => {
    for (const tenant of [{ productionAllowed: true }, {}]) {
      const { app, trio } = makeApp({ tenant, production: { gate: true, next: NEXT } });
      const id = await newProject(trio);
      expect((await put(app, id, { production: true })).status, JSON.stringify(tenant)).toBe(200);
    }
  });

  test('gate on, no record of the tenant: refused, never read as allowed', async () => {
    const { trio } = makeApp();
    const stubs = createStubAppBindings();
    const app = createApp({
      ...stubs,
      tenantHierarchyBinding: { ...stubs.tenantHierarchyBinding, getTenant: async () => null },
      resolveToken,
      runHandler,
      projectBinding: trio.projects,
      projectMembershipBinding: trio.memberships,
      production: { gate: true, next: NEXT },
    });
    const id = await newProject(trio);
    const res = await put(app, id, { production: true });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('tenant-not-found');
    expect((await trio.projects.get(tenantId, id as never))?.productionSince).toBeUndefined();
  });

  test('gate off: a tenant that is not allowed still goes into production', async () => {
    const { app, trio } = makeApp({ tenant: { productionAllowed: false } });
    const id = await newProject(trio);
    expect((await put(app, id, { production: true })).status).toBe(200);
  });

  test('gate on: taking a project out is never refused, and one already in stays in', async () => {
    const { app, trio } = makeApp({
      tenant: { productionAllowed: false },
      production: { gate: true, next: NEXT },
    });
    const id = await newProject(trio);
    // It went into production before the tenant was switched off.
    await trio.projects.setProduction?.(tenantId, id as never, true);
    const again = await put(app, id, { production: true });
    expect(again.status).toBe(200);
    const off = await put(app, id, { production: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ projectId: id, productionSince: null });
    // Back on is the gate's to decide again.
    expect((await put(app, id, { production: true })).status).toBe(403);
  });
});

describe('the limit on projects in production', () => {
  /** A refusal's code, message and details. */
  async function refusal(res: Response) {
    expect(res.status).toBe(403);
    return (
      (await res.json()) as {
        error: { code: string; message: string; details: Record<string, unknown> };
      }
    ).error;
  }

  async function inProduction(
    trio: ReturnType<typeof makeInMemoryProjectBinding>,
    id: string,
  ): Promise<boolean> {
    return (await trio.projects.get(tenantId, id as never))?.productionSince !== undefined;
  }

  test('at the limit: 403 production-limit-reached, with the limit, the count and next', async () => {
    const { app, trio } = makeApp({
      tenant: { limits: { projectsInProduction: 2 } },
      production: { next: NEXT },
    });
    const [a, b, c] = [await newProject(trio), await newProject(trio), await newProject(trio)];
    expect((await put(app, a, { production: true })).status).toBe(200);
    expect((await put(app, b, { production: true })).status).toBe(200);
    const error = await refusal(await put(app, c, { production: true }));
    expect(error.code).toBe('production-limit-reached');
    expect(error.details).toEqual({
      projectId: c,
      limit: 'projects-in-production',
      projectsInProduction: 2,
      inProduction: 2,
      next: NEXT,
    });
    expect(error.message).toBe(
      `This tenant's limit is 2 projects in production, and it has 2. To put another in production: ${NEXT}, or take one out of production first.`,
    );
    expect(await inProduction(trio, c)).toBe(false);
  });

  test('no next: the refusal carries none, and says to take one out or ask', async () => {
    const { app, trio } = makeApp({ tenant: { limits: { projectsInProduction: 1 } } });
    const [a, b] = [await newProject(trio), await newProject(trio)];
    expect((await put(app, a, { production: true })).status).toBe(200);
    const error = await refusal(await put(app, b, { production: true }));
    expect(error.details).not.toHaveProperty('next');
    expect(error.message).toBe(
      "This tenant's limit is 1 project in production, and it has 1. To put another in production, take one out first, or ask whoever runs this Kindgi to raise the limit.",
    );
  });

  test('a repeat isn’t counted, and taking one out frees its place', async () => {
    const { app, trio } = makeApp({ tenant: { limits: { projectsInProduction: 1 } } });
    const [a, b] = [await newProject(trio), await newProject(trio)];
    expect((await put(app, a, { production: true })).status).toBe(200);
    // At the limit, the one already in production answers its repeat unchanged.
    expect((await put(app, a, { production: true })).status).toBe(200);
    expect((await refusal(await put(app, b, { production: true }))).code).toBe(
      'production-limit-reached',
    );
    expect((await put(app, a, { production: false })).status).toBe(200);
    expect((await put(app, b, { production: true })).status).toBe(200);
  });

  test('a limit lowered below the count takes nothing out; the next waits until the count is under it', async () => {
    const tenant: { limits: { projectsInProduction: number } } = {
      limits: { projectsInProduction: 3 },
    };
    const { app, trio } = makeApp({ tenant });
    const ids = [await newProject(trio), await newProject(trio), await newProject(trio)];
    for (const id of ids) expect((await put(app, id, { production: true })).status).toBe(200);
    const next = await newProject(trio);

    tenant.limits = { projectsInProduction: 1 };
    for (const id of ids) expect(await inProduction(trio, id)).toBe(true);
    const over = await refusal(await put(app, next, { production: true }));
    expect(over.details).toMatchObject({ projectsInProduction: 1, inProduction: 3 });
    expect(over.message).toContain('take 3 out first');
    // Taking one out is never refused, even over the limit.
    expect((await put(app, ids[0] as string, { production: false })).status).toBe(200);
    expect((await put(app, ids[1] as string, { production: false })).status).toBe(200);
    // 1 in production, and the limit is 1: still no place.
    expect((await refusal(await put(app, next, { production: true }))).details).toMatchObject({
      inProduction: 1,
    });
    expect((await put(app, ids[2] as string, { production: false })).status).toBe(200);
    expect((await put(app, next, { production: true })).status).toBe(200);
  });

  test('with the gate on and the tenant not allowed, the gate answers first', async () => {
    const { app, trio } = makeApp({
      tenant: { productionAllowed: false, limits: { projectsInProduction: 1 } },
      production: { gate: true, next: NEXT },
    });
    const [a, b] = [await newProject(trio), await newProject(trio)];
    await trio.projects.setProduction?.(tenantId, a as never, true);
    expect((await refusal(await put(app, b, { production: true }))).code).toBe(
      'production-not-allowed',
    );
  });

  test('two projects put in production at once, with one place left: one goes in', async () => {
    const { app, trio } = makeApp({ tenant: { limits: { projectsInProduction: 1 } } });
    const [a, b] = [await newProject(trio), await newProject(trio)];
    const statuses = (
      await Promise.all([put(app, a, { production: true }), put(app, b, { production: true })])
    ).map((res) => res.status);
    expect(statuses.sort()).toEqual([200, 403]);
    expect([await inProduction(trio, a), await inProduction(trio, b)].filter(Boolean)).toHaveLength(
      1,
    );
  });

  test('no limit set: nothing is counted', async () => {
    const { app, trio } = makeApp({ tenant: { limits: { runsAtOnce: 1 } } });
    for (let i = 0; i < 3; i += 1) {
      expect((await put(app, await newProject(trio), { production: true })).status).toBe(200);
    }
  });
});

describe('who may', () => {
  function recording(allowed: boolean) {
    const asked: string[] = [];
    const binding = {
      check: async (
        _principal: unknown,
        action: string,
        resource: { type: string; id: string },
      ) => {
        asked.push(`${action} ${resource.type}:${resource.id}`);
        return { allowed, reason: 'test', failing: allowed ? undefined : 'actor' } as Decision;
      },
    } as unknown as AuthzCheckBinding;
    return { binding, asked };
  }

  test('a tenant admin: it asks for admin on the tenant, both ways', async () => {
    const { binding, asked } = recording(true);
    const { app, trio } = makeApp({ authz: binding });
    const id = await newProject(trio);
    expect((await put(app, id, { production: true })).status).toBe(200);
    expect((await put(app, id, { production: false })).status).toBe(200);
    expect(asked.filter((a) => a.startsWith('admin '))).toEqual([
      `admin tenant:${tenantId}`,
      `admin tenant:${tenantId}`,
    ]);
  });

  test('anyone else: 403 permission-denied, before any gate or card link', async () => {
    const { binding } = recording(false);
    const { app, trio } = makeApp({
      authz: binding,
      tenant: { productionAllowed: false },
      production: { gate: true, next: NEXT },
    });
    const id = await newProject(trio);
    const res = await put(app, id, { production: true });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('permission-denied');
    expect(JSON.stringify(body)).not.toContain(NEXT);
  });
});

describe('GET /v1/tenant', () => {
  test('a runtime that says nothing: the fields are absent', async () => {
    const { app } = makeApp({ production: { gate: true, next: NEXT } });
    const { body } = await getJson(app, '/v1/tenant');
    expect(body).not.toHaveProperty('productionAllowed');
    expect(body).not.toHaveProperty('productionNext');
    expect(body).not.toHaveProperty('limits');
  });

  test('not allowed: productionAllowed false, with productionNext', async () => {
    const { app } = makeApp({
      tenant: { productionAllowed: false },
      production: { gate: true, next: NEXT },
    });
    const { body } = await getJson(app, '/v1/tenant');
    expect(body.productionAllowed).toBe(false);
    expect(body.productionNext).toBe(NEXT);
  });

  test('allowed: productionAllowed true, and no productionNext', async () => {
    const { app } = makeApp({
      tenant: { productionAllowed: true },
      production: { gate: true, next: NEXT },
    });
    const { body } = await getJson(app, '/v1/tenant');
    expect(body.productionAllowed).toBe(true);
    expect(body).not.toHaveProperty('productionNext');
  });

  test('limits: the ones that are set', async () => {
    const limits = { apiRequestsPerMinute: 600, runsAtOnce: 20 };
    const { app } = makeApp({ tenant: { limits } });
    const { body } = await getJson(app, '/v1/tenant');
    expect(body.limits).toEqual(limits);
  });
});
