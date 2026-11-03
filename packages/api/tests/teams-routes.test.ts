// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { makeInMemoryTeamBinding } from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * Teams route tests.
 *
 * Wires the reference in-memory `TeamBinding` + `TeamMembershipBinding`
 * combined-factory from `@kindgi/platform`. Covers team CRUD, member
 * add / remove / role update, cross-tenant isolation.
 */

const TOKEN_A = 'teams-token-tenant-a';
const TOKEN_B = 'teams-token-tenant-b';
/** A signed-in user in tenant A, for the authorization tests. */
const USER_A = 'teams-token-user-a';
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
  const pair = makeInMemoryTeamBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    teamBinding: pair.teams,
    teamMembershipBinding: pair.memberships,
    ...(authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: authz },
    }),
  });
  return { app, pair };
}

async function createTeam(
  app: ReturnType<typeof makeApp>['app'],
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.request('/v1/teams', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`team create failed: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  return id;
}

describe('API — teams CRUD', () => {
  test('create → get roundtrip', async () => {
    const { app } = makeApp();
    const id = await createTeam(app, TOKEN_A, {
      name: 'Alpha Team',
      slug: 'alpha',
      description: 'test',
    });
    const get = await app.request(`/v1/teams/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      id: string;
      name: string;
      slug: string;
      description: string;
    };
    expect(body.name).toBe('Alpha Team');
    expect(body.slug).toBe('alpha');
    expect(body.description).toBe('test');
  });

  test('list', async () => {
    const { app } = makeApp();
    await createTeam(app, TOKEN_A, { name: 'A', slug: 'a' });
    await createTeam(app, TOKEN_A, { name: 'B', slug: 'b' });
    const res = await app.request('/v1/teams', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const body = (await res.json()) as { data: unknown[]; hasMore: boolean };
    expect(body.data).toHaveLength(2);
    expect(body.hasMore).toBe(false);
  });

  test('patch updates description; orgId can be cleared with null', async () => {
    const { app } = makeApp();
    const orgId = randomUUID();
    const id = await createTeam(app, TOKEN_A, {
      name: 'x',
      slug: 'x',
      orgId,
    });
    const patch = await app.request(`/v1/teams/${id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'new', orgId: null }),
    });
    expect(patch.status).toBe(204);
    const get = await app.request(`/v1/teams/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const body = (await get.json()) as { description: string; orgId?: string };
    expect(body.description).toBe('new');
    expect(body.orgId).toBeUndefined();
  });

  test('a PATCH naming orgId also takes admin on the tenant: the team admin is a 403 that changes nothing', async () => {
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
    const { app, pair } = makeApp(authz);
    const made = await pair.teams.create(tenantA, {
      name: 'moved',
      slug: 'moved',
      orgId: 'org-a',
    } as never);
    if (made.kind !== 'ok') throw new Error(made.kind);
    const id = made.teamId as unknown as string;
    // Its admin: admin on the team, not on the tenant.
    granted.add(`read team:${id}`).add(`admin team:${id}`);
    const patch = (body: unknown) =>
      app.request(`/v1/teams/${id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${USER_A}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const read = async () => {
      const res = await app.request(`/v1/teams/${id}`, {
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

    // A PATCH without `orgId` takes admin on the team, as before.
    expect((await patch({ name: 'renamed' })).status).toBe(204);
    expect(await read()).toMatchObject({ name: 'renamed', orgId: 'org-a' });

    granted.add(`admin tenant:${tenantA as unknown as string}`);
    expect((await patch({ orgId: 'org-b' })).status).toBe(204);
    expect(await read()).toMatchObject({ orgId: 'org-b' });
    expect((await patch({ orgId: null })).status).toBe(204);
    expect((await read()).orgId).toBeUndefined();
  });

  test('patch unknown → 404 team-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/teams/no-such-team', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('team-not-found');
  });

  test('delete → subsequent get 404', async () => {
    const { app } = makeApp();
    const id = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const del = await app.request(`/v1/teams/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(del.status).toBe(204);
    const get = await app.request(`/v1/teams/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(get.status).toBe(404);
  });
});

describe('API — team memberships', () => {
  test('add + list + remove', async () => {
    const { app } = makeApp();
    const teamId = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const userId = randomUUID();
    const add = await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role: 'member' }),
    });
    expect(add.status).toBe(201);
    const list = await app.request(`/v1/teams/${teamId}/memberships`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const listBody = (await list.json()) as {
      data: Array<{ userId: string; role: string }>;
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.userId).toBe(userId);
    expect(listBody.data[0]?.role).toBe('member');

    const del = await app.request(`/v1/teams/${teamId}/memberships/${userId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(del.status).toBe(204);
    const list2 = await app.request(`/v1/teams/${teamId}/memberships`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const list2Body = (await list2.json()) as { data: unknown[] };
    expect(list2Body.data).toEqual([]);
  });

  test('re-add keeps the role held: the same role 201 again, another a 409 naming it', async () => {
    const { app } = makeApp();
    const teamId = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const userId = randomUUID();
    await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role: 'member' }),
    });
    const again = await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role: 'member' }),
    });
    expect(again.status).toBe(201);
    // Another role: refused, naming the role held, which is kept.
    const readd = await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role: 'admin' }),
    });
    expect(readd.status).toBe(409);
    expect(((await readd.json()) as { error: unknown }).error).toMatchObject({
      code: 'membership-exists',
      details: { role: 'member' },
    });
    const list = await app.request(`/v1/teams/${teamId}/memberships`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const listBody = (await list.json()) as {
      data: Array<{ userId: string; role: string }>;
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.role).toBe('member');
  });

  test('add with unknown team → 404 team-not-found', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/teams/no-such/memberships', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID(), role: 'member' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('team-not-found');
  });

  test('add with invalid role → 400 bad-input', async () => {
    const { app } = makeApp();
    const teamId = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const res = await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID(), role: 'god-emperor' }),
    });
    expect(res.status).toBe(400);
  });

  test('updateRole on absent membership → 404 team-membership-not-found', async () => {
    const { app } = makeApp();
    const teamId = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const res = await app.request(`/v1/teams/${teamId}/memberships/${randomUUID()}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('team-membership-not-found');
  });

  test('updateRole on existing membership → 204', async () => {
    const { app } = makeApp();
    const teamId = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const userId = randomUUID();
    await app.request(`/v1/teams/${teamId}/memberships`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role: 'member' }),
    });
    const patch = await app.request(`/v1/teams/${teamId}/memberships/${userId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(patch.status).toBe(204);
    const list = await app.request(`/v1/teams/${teamId}/memberships`, {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    const body = (await list.json()) as { data: Array<{ role: string }> };
    expect(body.data[0]?.role).toBe('admin');
  });

  test('DELETE membership is idempotent', async () => {
    const { app } = makeApp();
    const teamId = await createTeam(app, TOKEN_A, { name: 'x', slug: 'x' });
    const res = await app.request(`/v1/teams/${teamId}/memberships/${randomUUID()}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(204);
  });
});

describe('API — teams cross-tenant isolation', () => {
  test('tenant B never sees tenant A teams', async () => {
    const { app } = makeApp();
    const id = await createTeam(app, TOKEN_A, { name: 'A', slug: 'a' });
    const list = await app.request('/v1/teams', {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    const body = (await list.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);

    const get = await app.request(`/v1/teams/${id}`, {
      headers: { authorization: `Bearer ${TOKEN_B}` },
    });
    expect(get.status).toBe(404);
  });
});

describe('API — teams surface unmounted when bindings missing', () => {
  test('no team bindings → routes 404 at Hono level', async () => {
    const app = createApp({ ...createStubAppBindings(), resolveToken, runHandler });
    const res = await app.request('/v1/teams', {
      headers: { authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(404);
  });
});
