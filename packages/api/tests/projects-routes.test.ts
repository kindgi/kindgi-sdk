// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { makeInMemoryProjectBinding } from '@kindgi/platform';
import type { TenantId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * Projects route tests.
 *
 * Wires the reference in-memory project combined-factory from
 * `@kindgi/platform`. Covers CRUD, `/default` shortcut, memberships,
 * cross-tenant isolation.
 */

const TOKEN_A = 'projects-token-tenant-a';
const TOKEN_B = 'projects-token-tenant-b';
const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN_A) return { tenantId: tenantA };
  if (token === TOKEN_B) return { tenantId: tenantB };
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

function makeApp() {
  const trio = makeInMemoryProjectBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    projectBinding: trio.projects,
    projectMembershipBinding: trio.memberships,
    teamProjectGrantBinding: trio.grants,
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
  test('no Default → 404 project-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/projects/default', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('project-not-found');
  });

  test('after Default created → 200 with isDefault: true', async () => {
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
    // No Default provisioned — /default returns 404 project-not-found
    // (a proof that the /default route ran, not the :projectId route
    // which would return 404 with the same code but different message
    // — the message helps disambiguate but the code is the same, so
    // this test just documents ordering intent).
    const res = await app.request('/v1/projects/default', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    // getDefault's 404 says "Tenant has no Default project"; the
    // :projectId 404 says "No project with id 'default'". Distinct
    // messages confirm the /default route handled the request.
    expect(body.error.message).toContain('Default');
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

  test("tenant A's Default is not tenant B's Default", async () => {
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
