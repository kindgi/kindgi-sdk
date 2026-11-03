// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { AuthzCheckBinding, Decision } from '@kindgi/authz';
import { type ProjectBinding, makeInMemoryProjectBinding } from '@kindgi/platform';
import type { EnvName, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ConnectionBinding,
  ConnectionRecord,
  CreateAppInput,
  TokenResolver,
} from '../src/index.js';

/**
 * `PUT` and `DELETE /v1/projects/:projectId/repo-connection`: the
 * company-wide GitHub connection a project opens its block changes' pull
 * requests through, and what `GET /v1/projects/:id` says about it.
 */

const TOKEN = 'repo-connection-token';
const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;

const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId } : null;

const connection = (over: Partial<ConnectionRecord>): ConnectionRecord =>
  ({
    connectionId: 'conn-github',
    tenantId,
    envName: 'prod',
    appId: 'app-1',
    app: 'github',
    owner: { kind: 'company' },
    account: { id: 'acme', name: 'acme' },
    permissions: ['contents.write', 'pull_requests.write'],
    state: 'connected',
    ...over,
  }) as unknown as ConnectionRecord;

const CONNECTIONS: readonly ConnectionRecord[] = [
  connection({}),
  connection({ connectionId: 'conn-mine', owner: { kind: 'member', userId } }),
  connection({ connectionId: 'conn-google', app: 'google' }),
  connection({ connectionId: 'conn-removed', removedAt: '2026-10-29T00:00:00.000Z' }),
];

interface Setup {
  readonly projects?: ProjectBinding;
  /** `false`: a runtime with no connections. */
  readonly connections?: boolean;
  readonly authz?: AuthzCheckBinding;
}

function makeApp(setup: Setup = {}) {
  const trio = makeInMemoryProjectBinding();
  const connections = {
    get: async (q: { connectionId: string }) =>
      CONNECTIONS.find((c) => c.connectionId === q.connectionId) ?? null,
  } as unknown as ConnectionBinding;
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    projectBinding: setup.projects ?? trio.projects,
    projectMembershipBinding: trio.memberships,
    ...(setup.connections !== false && { connections, envName: 'local' as EnvName }),
    ...(setup.authz !== undefined && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: setup.authz },
    }),
  } as CreateAppInput);
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

type App = ReturnType<typeof makeApp>['app'];

async function call(app: App, method: 'PUT' | 'DELETE', projectId: string, body?: unknown) {
  const res = await app.request(`/v1/projects/${projectId}/repo-connection`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function project(app: App, projectId: string) {
  const res = await app.request(`/v1/projects/${projectId}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

const codeOf = (body: Record<string, unknown>) => (body.error as { code: string }).code;

describe('PUT and DELETE /v1/projects/:projectId/repo-connection', () => {
  test('set, read back on the project, then cleared', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);

    expect(await call(app, 'PUT', id, { connectionId: 'conn-github' })).toEqual({
      status: 200,
      body: { projectId: id, repoConnectionId: 'conn-github' },
    });
    expect((await project(app, id)).repoConnectionId).toBe('conn-github');

    expect(await call(app, 'DELETE', id)).toEqual({
      status: 200,
      body: { projectId: id, repoConnectionId: null },
    });
    expect(await project(app, id)).not.toHaveProperty('repoConnectionId');
  });

  test('a repeat answers 200 unchanged, both ways', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    await call(app, 'PUT', id, { connectionId: 'conn-github' });
    expect(await call(app, 'PUT', id, { connectionId: 'conn-github' })).toEqual({
      status: 200,
      body: { projectId: id, repoConnectionId: 'conn-github' },
    });
    await call(app, 'DELETE', id);
    expect(await call(app, 'DELETE', id)).toEqual({
      status: 200,
      body: { projectId: id, repoConnectionId: null },
    });
  });

  test('a connection that is not there, or was removed: 404 connection-not-found', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    for (const connectionId of ['conn-nothing', 'conn-removed']) {
      const out = await call(app, 'PUT', id, { connectionId });
      expect(out.status).toBe(404);
      expect(codeOf(out.body)).toBe('connection-not-found');
    }
    expect(await project(app, id)).not.toHaveProperty('repoConnectionId');
  });

  test("a person's own connection, or another app's: 400 repo-connection-not-company-github", async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    const mine = await call(app, 'PUT', id, { connectionId: 'conn-mine' });
    expect(mine.status).toBe(400);
    expect(mine.body.error).toMatchObject({
      code: 'repo-connection-not-company-github',
      details: { connectionId: 'conn-mine', app: 'github', owner: 'member' },
    });
    const google = await call(app, 'PUT', id, { connectionId: 'conn-google' });
    expect(google.status).toBe(400);
    expect(google.body.error).toMatchObject({
      code: 'repo-connection-not-company-github',
      details: { connectionId: 'conn-google', app: 'google', owner: 'company' },
    });
    expect(await project(app, id)).not.toHaveProperty('repoConnectionId');
  });

  test('a body that is not { connectionId } is 400 bad-input', async () => {
    const { app, trio } = makeApp();
    const id = await newProject(trio);
    for (const body of ['not json', {}, { connectionId: '' }, { connectionId: 7 }]) {
      const out = await call(app, 'PUT', id, body);
      expect(out.status).toBe(400);
      expect(codeOf(out.body)).toBe('bad-input');
    }
  });

  test('an unknown project is 404 project-not-found, both ways', async () => {
    const { app } = makeApp();
    const missing = randomUUID();
    const set = await call(app, 'PUT', missing, { connectionId: 'conn-github' });
    expect(set.status).toBe(404);
    expect(codeOf(set.body)).toBe('project-not-found');
    const clear = await call(app, 'DELETE', missing);
    expect(clear.status).toBe(404);
    expect(codeOf(clear.body)).toBe('project-not-found');
  });

  test('a project binding without setRepoConnection answers 501 repo-connection-unsupported', async () => {
    const trio = makeInMemoryProjectBinding();
    const { setRepoConnection: _, ...withoutIt } = trio.projects;
    const { app } = makeApp({ projects: withoutIt as ProjectBinding });
    const id = await newProject(trio);
    for (const out of [
      await call(app, 'PUT', id, { connectionId: 'conn-github' }),
      await call(app, 'DELETE', id),
    ]) {
      expect(out.status).toBe(501);
      expect(out.body.error).toMatchObject({
        code: 'repo-connection-unsupported',
        message: "This runtime can't connect a project to a repo",
      });
    }
  });

  test('a runtime with no connections: setting is 501, clearing still works', async () => {
    const { app, trio } = makeApp({ connections: false });
    const id = await newProject(trio);
    const set = await call(app, 'PUT', id, { connectionId: 'conn-github' });
    expect(set.status).toBe(501);
    expect(codeOf(set.body)).toBe('repo-connection-unsupported');
    expect((await call(app, 'DELETE', id)).status).toBe(200);
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

  test('a project admin: it asks for admin on the project, both ways', async () => {
    const { binding, asked } = recording(true);
    const { app, trio } = makeApp({ authz: binding });
    const id = await newProject(trio);
    expect((await call(app, 'PUT', id, { connectionId: 'conn-github' })).status).toBe(200);
    expect((await call(app, 'DELETE', id)).status).toBe(200);
    expect(asked.filter((a) => a.startsWith('admin '))).toEqual([
      `admin project:${id}`,
      `admin project:${id}`,
    ]);
  });

  test('anyone else: 403 permission-denied, and nothing changes', async () => {
    const { binding } = recording(false);
    const { app, trio } = makeApp({ authz: binding });
    const id = await newProject(trio);
    const out = await call(app, 'PUT', id, { connectionId: 'conn-github' });
    expect(out.status).toBe(403);
    expect(codeOf(out.body)).toBe('permission-denied');
    expect((await trio.projects.get(tenantId, id as never))?.repoConnectionId).toBeUndefined();
  });
});
