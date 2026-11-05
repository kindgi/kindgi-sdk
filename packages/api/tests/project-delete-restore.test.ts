// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A deleted project is kept, and a workspace admin restores it.
 *
 * `DELETE /v1/projects/{projectId}` takes the project out of every read:
 * its get, the list, its memberships. Its slugs stay its own, and the
 * workspace's default project is refused (`409 project-is-default`).
 * `GET /v1/projects/deleted` lists the deleted ones, newest first, and
 * `POST /v1/projects/{projectId}/restore` brings one back as it was. Both
 * are a workspace admin's.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { type ProjectBinding, makeInMemoryProjectBinding } from '@kindgi/platform';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const TOKEN = 'delete-restore-token';
const USER = 'delete-restore-user';
const OTHER_TENANT = 'delete-restore-other-tenant';
const tenantId = randomUUID() as TenantId;
const otherTenantId = randomUUID() as TenantId;

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN) return { tenantId };
  if (token === USER) return { tenantId, userId: 'user-1' as UserId };
  if (token === OTHER_TENANT) return { tenantId: otherTenantId };
  return null;
};

/** An authorization check that allows exactly the `"<action> <type>:<id>"` entries in `granted`. */
function grantedOnly(granted: Set<string>): AuthzCheckBinding {
  const decide = (action: string, resource: { type: string; id: string }) => {
    const allowed = granted.has(`${action} ${resource.type}:${resource.id}`);
    return { allowed, reason: 'test', failing: allowed ? undefined : 'actor' } as Decision;
  };
  return {
    check: async (_principal: unknown, action: string, resource: { type: string; id: string }) =>
      decide(action, resource),
    checkBatch: async (
      _principal: unknown,
      action: string,
      resources: readonly { type: string; id: string }[],
    ) => resources.map((resource) => decide(action, resource)),
  } as unknown as AuthzCheckBinding;
}

function makeApp(options: { authz?: AuthzCheckBinding; projects?: ProjectBinding } = {}) {
  const trio = makeInMemoryProjectBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    projectBinding: options.projects ?? trio.projects,
    projectMembershipBinding: trio.memberships,
    teamProjectGrantBinding: trio.grants,
    ...(options.authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: options.authz },
    }),
  });
  return { app, trio };
}

async function seed(
  projects: ProjectBinding,
  spec: { name: string; slug: string; isDefault?: boolean },
): Promise<string> {
  const made = await projects.create(tenantId, spec);
  if (made.kind !== 'ok') throw new Error(`project not made: ${made.kind}`);
  return made.projectId as unknown as string;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

type App = ReturnType<typeof makeApp>['app'];

function call(app: App, method: string, path: string, token = TOKEN, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

interface DeletedEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly orgId?: string;
  readonly name: string;
  readonly slug: string;
  readonly formerSlugs: readonly string[];
  readonly deletedAt: string;
}

async function deletedList(
  app: App,
  query = '',
): Promise<{ data: DeletedEntry[]; hasMore: boolean; nextCursor?: string }> {
  const res = await call(app, 'GET', `/v1/projects/deleted${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { data: DeletedEntry[]; hasMore: boolean; nextCursor?: string };
}

describe('DELETE /v1/projects/{projectId}', () => {
  test('204, and the project is gone from its get, the list and its memberships', async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    const kept = await seed(trio.projects, { name: 'Kept', slug: 'kept' });
    expect((await call(app, 'DELETE', `/v1/projects/${id}`)).status).toBe(204);

    const get = await call(app, 'GET', `/v1/projects/${id}`);
    expect(get.status).toBe(404);
    expect(((await get.json()) as { error: { code: string } }).error.code).toBe(
      'project-not-found',
    );
    const list = (await (await call(app, 'GET', '/v1/projects')).json()) as {
      data: { id: string }[];
    };
    expect(list.data.map((p) => p.id)).toEqual([kept]);
    const members = await call(app, 'GET', `/v1/projects/${id}/memberships`);
    expect(members.status).toBe(404);
    const patch = await call(app, 'PATCH', `/v1/projects/${id}`, TOKEN, { name: 'Shop 2' });
    expect(patch.status).toBe(404);
  });

  test('a second delete answers 204 and keeps the first time; an unknown id is 204', async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    await call(app, 'DELETE', `/v1/projects/${id}`);
    const first = (await deletedList(app)).data[0]?.deletedAt;
    expect(typeof first).toBe('string');
    await tick();
    expect((await call(app, 'DELETE', `/v1/projects/${id}`)).status).toBe(204);
    expect((await deletedList(app)).data.map((p) => [p.id, p.deletedAt])).toEqual([[id, first]]);
    expect((await call(app, 'DELETE', `/v1/projects/${randomUUID()}`)).status).toBe(204);
  });

  test("the workspace's default project: 409 project-is-default, and it stays", async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Default', slug: 'default', isDefault: true });
    const del = await call(app, 'DELETE', `/v1/projects/${id}`);
    expect(del.status).toBe(409);
    const body = (await del.json()) as {
      error: { code: string; message: string; details?: { projectId?: string } };
    };
    expect(body.error.code).toBe('project-is-default');
    expect(body.error.details?.projectId).toBe(id);
    expect((await call(app, 'GET', '/v1/projects/default')).status).toBe(200);
    expect((await deletedList(app)).data).toEqual([]);
  });

  test('its slug stays its own: a create with it answers 409 slug-conflict with deletedProject', async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    await call(app, 'DELETE', `/v1/projects/${id}`);
    const res = await call(app, 'POST', '/v1/projects', TOKEN, { name: 'Shop', slug: 'shop' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { slug?: string; deletedProject?: boolean } };
    };
    expect(body.error.code).toBe('slug-conflict');
    expect(body.error.details).toMatchObject({ slug: 'shop', deletedProject: true });
  });
});

describe('GET /v1/projects/deleted', () => {
  test('newest first, each with its slugs and when; it pages', async () => {
    const { app, trio } = makeApp();
    const a = await seed(trio.projects, { name: 'A', slug: 'a' });
    const b = await seed(trio.projects, { name: 'B', slug: 'b' });
    const c = await seed(trio.projects, { name: 'C', slug: 'c' });
    await seed(trio.projects, { name: 'Live', slug: 'live' });
    await call(app, 'PATCH', `/v1/projects/${a}`, TOKEN, { slug: 'a2' });
    for (const id of [a, b, c]) {
      await call(app, 'DELETE', `/v1/projects/${id}`);
      await tick();
    }
    const page1 = await deletedList(app, '?limit=2');
    expect(page1.data.map((p) => p.id)).toEqual([c, b]);
    expect(page1.hasMore).toBe(true);
    const page2 = await deletedList(app, `?limit=2&cursor=${page1.nextCursor ?? ''}`);
    expect(page2.data.map((p) => p.id)).toEqual([a]);
    expect(page2.hasMore).toBe(false);
    expect(page2.data[0]).toEqual({
      id: a,
      tenantId,
      name: 'A',
      slug: 'a2',
      formerSlugs: ['a'],
      deletedAt: expect.any(String),
    });
  });

  test("another workspace's deleted projects aren't listed", async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'A', slug: 'a' });
    await call(app, 'DELETE', `/v1/projects/${id}`);
    const res = await call(app, 'GET', '/v1/projects/deleted', OTHER_TENANT);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

describe('POST /v1/projects/{projectId}/restore', () => {
  test('200 with the project; it is back in its get, the list and its memberships', async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    await trio.memberships.add(tenantId, {
      projectId: id as ProjectId,
      userId: 'user-1' as UserId,
      role: 'editor',
    });
    await call(app, 'DELETE', `/v1/projects/${id}`);
    const res = await call(app, 'POST', `/v1/projects/${id}/restore`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { id: string; slug: string }).toMatchObject({
      id,
      slug: 'shop',
      isDefault: false,
    });
    expect((await call(app, 'GET', `/v1/projects/${id}`)).status).toBe(200);
    const members = (await (await call(app, 'GET', `/v1/projects/${id}/memberships`)).json()) as {
      data: { userId: string; role: string }[];
    };
    expect(members.data).toMatchObject([{ userId: 'user-1', role: 'editor' }]);
    expect((await deletedList(app)).data).toEqual([]);
  });

  test('a live project answers 200, unchanged; an unknown id is 404 project-not-found', async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    const live = await call(app, 'POST', `/v1/projects/${id}/restore`);
    expect(live.status).toBe(200);
    expect(((await live.json()) as { id: string }).id).toBe(id);
    const unknown = await call(app, 'POST', `/v1/projects/${randomUUID()}/restore`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'project-not-found',
    );
  });

  test("another workspace's deleted project is 404, and stays deleted", async () => {
    const { app, trio } = makeApp();
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    await call(app, 'DELETE', `/v1/projects/${id}`);
    expect((await call(app, 'POST', `/v1/projects/${id}/restore`, OTHER_TENANT)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/projects/${id}`)).status).toBe(404);
  });
});

describe('where authorization is enforced', () => {
  test("restore and the deleted list are a workspace admin's: 403 without it, before any change", async () => {
    const granted = new Set<string>();
    const { app, trio } = makeApp({ authz: grantedOnly(granted) });
    const id = await seed(trio.projects, { name: 'Shop', slug: 'shop' });
    granted.add(`delete project:${id}`);
    expect((await call(app, 'DELETE', `/v1/projects/${id}`, USER)).status).toBe(204);

    // A project admin, not a workspace admin: its own tuples are gone with it.
    granted.add(`admin project:${id}`);
    const restore = await call(app, 'POST', `/v1/projects/${id}/restore`, USER);
    expect(restore.status).toBe(403);
    expect((await call(app, 'GET', '/v1/projects/deleted', USER)).status).toBe(403);
    expect(await trio.projects.get(tenantId, id as ProjectId)).toBeUndefined();

    granted.add(`admin tenant:${tenantId}`);
    const listed = await call(app, 'GET', '/v1/projects/deleted', USER);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { data: { id: string }[] }).data.map((p) => p.id)).toEqual([
      id,
    ]);
    expect((await call(app, 'POST', `/v1/projects/${id}/restore`, USER)).status).toBe(200);
    expect((await trio.projects.get(tenantId, id as ProjectId))?.id).toBe(id);
  });
});

describe('a project binding without restore', () => {
  test('both routes answer 501 project-restore-unsupported; the delete still answers 204', async () => {
    const trio = makeInMemoryProjectBinding();
    const { restore: _restore, listDeleted: _listDeleted, ...plain } = trio.projects;
    const { app } = makeApp({ projects: plain });
    const id = await seed(plain, { name: 'Shop', slug: 'shop' });
    expect((await call(app, 'DELETE', `/v1/projects/${id}`)).status).toBe(204);
    for (const res of [
      await call(app, 'POST', `/v1/projects/${id}/restore`),
      await call(app, 'GET', '/v1/projects/deleted'),
    ]) {
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'project-restore-unsupported',
      );
    }
  });
});
