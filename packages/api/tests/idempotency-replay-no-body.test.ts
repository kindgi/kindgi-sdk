// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import {
  makeInMemoryOrgBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import {
  createInMemoryIdempotencyStore,
  idempotencyMiddleware,
} from '../src/middleware/idempotency.js';
import { createStubAppBindings } from '../src/testing/index.js';
import type { AppEnv } from '../src/types.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * A retry with the same Idempotency-Key replays a 204, 205 or 304 with no
 * body. The stored body of such an answer is `''`, and a Response refuses
 * any body with those statuses, so replaying it threw and the retry was
 * answered 500 though the change had run once.
 */

const tenantId = randomUUID() as TenantId;

describe('idempotencyMiddleware: an answer with no body', () => {
  test.each([204, 205, 304])(
    'a %i is replayed with no body, marked X-Idempotent-Replay, and the handler ran once',
    async (status) => {
      let ran = 0;
      const hono = new Hono<AppEnv>();
      hono.use('*', async (c, next) => {
        c.set('requestId', 'req-test');
        c.set('tenantId', tenantId);
        await next();
      });
      hono.use('*', idempotencyMiddleware(createInMemoryIdempotencyStore()));
      hono.patch('/v1/things/:id', (c) => {
        ran += 1;
        return c.body(null, status as never);
      });
      const patch = () =>
        hono.request('/v1/things/thing-1', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
          body: JSON.stringify({ name: 'acme' }),
        });

      const first = await patch();
      const again = await patch();
      expect(first.status).toBe(status);
      expect(first.headers.get('X-Idempotent-Replay')).toBeNull();
      expect(again.status).toBe(status);
      expect(again.headers.get('X-Idempotent-Replay')).toBe('true');
      expect(again.body).toBeNull();
      expect(again.headers.get('content-type')).toBe(first.headers.get('content-type'));
      expect(ran).toBe(1);
    },
  );
});

const TOKEN = 'idempotency-no-body-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/** The API with an org, a project and a team, a member of each, and the team's grant on the project. */
async function seeded() {
  const orgBinding = makeInMemoryOrgBinding();
  const projects = makeInMemoryProjectBinding();
  const teams = makeInMemoryTeamBinding();
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    orgBinding,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    teamBinding: teams.teams,
    teamMembershipBinding: teams.memberships,
  });
  const org = await orgBinding.create(tenantId, { name: 'Acme', slug: `acme-${randomUUID()}` });
  const project = await projects.projects.create(tenantId, {
    name: 'Acme Web',
    slug: `web-${randomUUID()}`,
  });
  const team = await teams.teams.create(tenantId, { name: 'Desk', slug: `desk-${randomUUID()}` });
  if (org.kind !== 'ok' || project.kind !== 'ok' || team.kind !== 'ok') {
    throw new Error('seed failed');
  }
  const userId = randomUUID() as UserId;
  const { projectId } = project;
  const { teamId } = team;
  await projects.memberships.add(tenantId, { projectId, userId, role: 'editor' });
  await teams.memberships.add(tenantId, { teamId, userId, role: 'member' });
  await projects.grants.add(tenantId, { teamId, projectId, role: 'editor' });
  return {
    app,
    ids: {
      orgId: org.orgId as string,
      projectId: projectId as string,
      teamId: teamId as string,
      userId: userId as string,
    },
  };
}

type Ids = Awaited<ReturnType<typeof seeded>>['ids'];

/** Every `/v1` route that answers 204. */
const NO_BODY_ROUTES: readonly {
  readonly name: string;
  readonly method: 'PATCH' | 'DELETE';
  readonly path: (ids: Ids) => string;
  readonly body?: object;
}[] = [
  {
    name: 'PATCH /v1/orgs/{id}',
    method: 'PATCH',
    path: (i) => `/v1/orgs/${i.orgId}`,
    body: { name: 'Acme West' },
  },
  { name: 'DELETE /v1/orgs/{id}', method: 'DELETE', path: (i) => `/v1/orgs/${i.orgId}` },
  {
    name: 'PATCH /v1/projects/{id}',
    method: 'PATCH',
    path: (i) => `/v1/projects/${i.projectId}`,
    body: { name: 'Acme Shop' },
  },
  {
    name: 'DELETE /v1/projects/{id}',
    method: 'DELETE',
    path: (i) => `/v1/projects/${i.projectId}`,
  },
  {
    name: 'PATCH /v1/projects/{id}/memberships/{userId}',
    method: 'PATCH',
    path: (i) => `/v1/projects/${i.projectId}/memberships/${i.userId}`,
    body: { role: 'viewer' },
  },
  {
    name: 'DELETE /v1/projects/{id}/memberships/{userId}',
    method: 'DELETE',
    path: (i) => `/v1/projects/${i.projectId}/memberships/${i.userId}`,
  },
  {
    name: 'PATCH /v1/projects/{id}/team-grants/{teamId}',
    method: 'PATCH',
    path: (i) => `/v1/projects/${i.projectId}/team-grants/${i.teamId}`,
    body: { role: 'viewer' },
  },
  {
    name: 'DELETE /v1/projects/{id}/team-grants/{teamId}',
    method: 'DELETE',
    path: (i) => `/v1/projects/${i.projectId}/team-grants/${i.teamId}`,
  },
  {
    name: 'PATCH /v1/teams/{id}',
    method: 'PATCH',
    path: (i) => `/v1/teams/${i.teamId}`,
    body: { name: 'Front Desk' },
  },
  { name: 'DELETE /v1/teams/{id}', method: 'DELETE', path: (i) => `/v1/teams/${i.teamId}` },
  {
    name: 'PATCH /v1/teams/{id}/memberships/{userId}',
    method: 'PATCH',
    path: (i) => `/v1/teams/${i.teamId}/memberships/${i.userId}`,
    body: { role: 'admin' },
  },
  {
    name: 'DELETE /v1/teams/{id}/memberships/{userId}',
    method: 'DELETE',
    path: (i) => `/v1/teams/${i.teamId}/memberships/${i.userId}`,
  },
];

describe('API: a retry of a route that answers 204, with the same Idempotency-Key', () => {
  test.each(NO_BODY_ROUTES)('$name replays its 204', async (route) => {
    const { app, ids } = await seeded();
    const send = () =>
      app.request(route.path(ids), {
        method: route.method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'idempotency-key': `k-${route.method}`,
          ...(route.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(route.body !== undefined && { body: JSON.stringify(route.body) }),
      });

    const first = await send();
    expect(first.status).toBe(204);
    expect(first.headers.get('X-Idempotent-Replay')).toBeNull();
    const again = await send();
    expect(again.status).toBe(204);
    expect(again.headers.get('X-Idempotent-Replay')).toBe('true');
    expect(again.body).toBeNull();
  });
});
