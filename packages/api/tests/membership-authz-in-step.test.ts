// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * With authorization enforced, a membership change keeps the
 * authorization store in step: removing a team or project member, or
 * changing their role, goes through the tenant-hierarchy binding, which
 * changes the row and its tuple together. A binding that can't is
 * refused (501): removing the row alone would leave the permission in
 * place. Without authorization, the plain membership bindings do it.
 *
 * Registering or unregistering an approval reviewer needs `admin` on the
 * tenant when authorization is enforced.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import {
  type TenantHierarchyBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { ReviewerId, TenantId, Timestamp, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ReviewerRecord,
  ReviewerRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const admin = randomUUID() as UserId;
const member = randomUUID() as UserId;
const TOKENS: Record<string, UserId> = { 'admin-token': admin, 'member-token': member };
const resolveToken: TokenResolver = async (token) =>
  TOKENS[token] === undefined ? null : { tenantId, userId: TOKENS[token] };

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

const decision = (allowed: boolean, action: Action, resource: ResourceRef): Decision => ({
  allowed,
  reason: allowed ? 'test: allowed' : 'test: denied',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});

/** The admin may do anything; anyone else, anything but `admin` on the tenant. */
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) =>
    decision(
      principal.actor.id === admin || !(action === 'admin' && resource.type === 'tenant'),
      action,
      resource,
    ),
  checkBatch: async (_principal, action, resources) =>
    resources.map((resource) => decision(true, action, resource)),
};

/** Which in-step hierarchy methods the runtime's binding has. */
type InStep = 'all' | 'none';

function makeApp(options: { readonly authorized: boolean; readonly inStep: InStep }) {
  const teams = makeInMemoryTeamBinding();
  const projects = makeInMemoryProjectBinding();
  const calls: string[] = [];
  const reviewers: ReviewerRecord[] = [];
  const reviewerRegistry = {
    list: async () => ({ data: reviewers }),
    get: async () => null,
    register: async (input: { userId: UserId; role: ReviewerRecord['role'] }) => {
      const reviewer: ReviewerRecord = {
        id: randomUUID() as ReviewerId,
        tenantId,
        userId: input.userId,
        role: input.role,
        createdAt: new Date().toISOString() as Timestamp,
      };
      reviewers.push(reviewer);
      return { kind: 'ok' as const, reviewer };
    },
    unregister: async () => ({ unregistered: true }),
  } as unknown as ReviewerRegistryBinding;

  const inStep: Partial<TenantHierarchyBinding> =
    options.inStep === 'none'
      ? {}
      : {
          async removeTeamMember({ teamId, userId }) {
            calls.push(`removeTeamMember ${userId}`);
            await teams.memberships.remove(tenantId, teamId, userId);
            return { kind: 'ok', value: undefined };
          },
          async updateTeamMemberRole({ teamId, userId, role }) {
            calls.push(`updateTeamMemberRole ${userId} ${role}`);
            const outcome = await teams.memberships.updateRole(tenantId, teamId, userId, role);
            return { kind: 'ok', value: outcome };
          },
          async removeProjectMember({ projectId, userId }) {
            calls.push(`removeProjectMember ${userId}`);
            await projects.memberships.remove(tenantId, projectId, userId);
            return { kind: 'ok', value: undefined };
          },
          async updateProjectMemberRole({ projectId, userId, role }) {
            calls.push(`updateProjectMemberRole ${userId} ${role}`);
            const outcome = await projects.memberships.updateRole(
              tenantId,
              projectId,
              userId,
              role,
            );
            return { kind: 'ok', value: outcome };
          },
        };
  // The stub has every method (each throws); a binding that can't keep
  // memberships in step has none of the four.
  const {
    removeTeamMember: _rt,
    updateTeamMemberRole: _ut,
    removeProjectMember: _rp,
    updateProjectMemberRole: _up,
    ...stub
  } = createStubAppBindings().tenantHierarchyBinding;
  const hierarchy = {
    ...stub,
    async addTeamMember({ teamId, userId, role }) {
      await teams.memberships.add(tenantId, { teamId, userId, role });
      return { kind: 'ok', value: undefined };
    },
    async addProjectMember({ projectId, userId, role }) {
      await projects.memberships.add(tenantId, { projectId, userId, role });
      return { kind: 'ok', value: undefined };
    },
    ...inStep,
  } as TenantHierarchyBinding;

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tenantHierarchyBinding: hierarchy,
    teamBinding: teams.teams,
    teamMembershipBinding: teams.memberships,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    reviewerRegistry,
    ...(options.authorized && { authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding } }),
  });
  return { app, teams, projects, calls, reviewers };
}

async function send(
  app: ReturnType<typeof makeApp>['app'],
  method: string,
  path: string,
  body?: unknown,
  token = 'admin-token',
) {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text === '' ? {} : JSON.parse(text)) as { error?: { code: string; message: string } },
  };
}

/** A team and a project, each with `member` as a member. */
async function seeded(app: ReturnType<typeof makeApp>) {
  const team = await app.teams.teams.create(tenantId, {
    name: 'Desk',
    slug: `desk-${randomUUID()}`,
  });
  const project = await app.projects.projects.create(tenantId, {
    name: 'Desk',
    slug: `desk-${randomUUID()}`,
  });
  if (team.kind !== 'ok' || project.kind !== 'ok') throw new Error('seed failed');
  await app.teams.memberships.add(tenantId, {
    teamId: team.teamId,
    userId: member,
    role: 'member',
  });
  await app.projects.memberships.add(tenantId, {
    projectId: project.projectId,
    userId: member,
    role: 'editor',
  });
  return {
    teamId: team.teamId as unknown as string,
    projectId: project.projectId as unknown as string,
  };
}

const MEMBERSHIPS = [
  {
    resource: 'team',
    path: (ids: { teamId: string }) => `/v1/teams/${ids.teamId}/memberships/${member}`,
    newRole: 'admin',
    remove: 'removeTeamMember',
    update: 'updateTeamMemberRole',
    rows: async (a: ReturnType<typeof makeApp>, ids: { teamId: string }) =>
      (await a.teams.memberships.list(tenantId, ids.teamId as never, { limit: 10 })).items,
  },
  {
    resource: 'project',
    path: (ids: { projectId: string }) => `/v1/projects/${ids.projectId}/memberships/${member}`,
    newRole: 'viewer',
    remove: 'removeProjectMember',
    update: 'updateProjectMemberRole',
    rows: async (a: ReturnType<typeof makeApp>, ids: { projectId: string }) =>
      (await a.projects.memberships.list(tenantId, ids.projectId as never, { limit: 10 })).items,
  },
] as const;

describe.each(MEMBERSHIPS)('a $resource membership with authorization enforced', (m) => {
  test('removing a member goes through the hierarchy binding, row and tuple together', async () => {
    const a = makeApp({ authorized: true, inStep: 'all' });
    const ids = await seeded(a);
    const answer = await send(a.app, 'DELETE', m.path(ids as never));
    expect(answer.status).toBe(204);
    expect(a.calls).toEqual([`${m.remove} ${member}`]);
    expect(await m.rows(a, ids as never)).toEqual([]);
  });

  test("changing a member's role goes through it too", async () => {
    const a = makeApp({ authorized: true, inStep: 'all' });
    const ids = await seeded(a);
    const answer = await send(a.app, 'PATCH', m.path(ids as never), { role: m.newRole });
    expect(answer.status).toBe(204);
    expect(a.calls).toEqual([`${m.update} ${member} ${m.newRole}`]);
    expect((await m.rows(a, ids as never))[0]?.role).toBe(m.newRole);
  });

  test("a binding that can't keep them in step is refused, and nothing changes", async () => {
    const a = makeApp({ authorized: true, inStep: 'none' });
    const ids = await seeded(a);
    for (const [method, body, name] of [
      ['DELETE', undefined, m.remove],
      ['PATCH', { role: m.newRole }, m.update],
    ] as const) {
      const answer = await send(a.app, method, m.path(ids as never), body);
      expect(answer.status).toBe(501);
      expect(answer.body.error).toMatchObject({
        code: 'authz-membership-unsupported',
        message: `This runtime can't keep permissions in step with a membership change (its tenant-hierarchy binding has no ${name}), so nothing was changed.`,
      });
    }
    const rows = await m.rows(a, ids as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).not.toBe(m.newRole);
  });
});

describe.each(MEMBERSHIPS)('a $resource membership without authorization', (m) => {
  test('the membership binding removes it and changes its role', async () => {
    const a = makeApp({ authorized: false, inStep: 'none' });
    const ids = await seeded(a);
    expect((await send(a.app, 'PATCH', m.path(ids as never), { role: m.newRole })).status).toBe(
      204,
    );
    expect((await m.rows(a, ids as never))[0]?.role).toBe(m.newRole);
    expect((await send(a.app, 'DELETE', m.path(ids as never))).status).toBe(204);
    expect(await m.rows(a, ids as never)).toEqual([]);
  });
});

describe('approval reviewers with authorization enforced', () => {
  test('registering or unregistering one needs admin on the tenant', async () => {
    const a = makeApp({ authorized: true, inStep: 'all' });
    const asMember = await send(
      a.app,
      'POST',
      '/v1/approvals/reviewers',
      { userId: member, role: 'admin' },
      'member-token',
    );
    expect(asMember.status).toBe(403);
    expect(a.reviewers).toEqual([]);
    const unregister = await send(
      a.app,
      'POST',
      `/v1/approvals/reviewers/${randomUUID()}/unregister`,
      {},
      'member-token',
    );
    expect(unregister.status).toBe(403);

    const asAdmin = await send(a.app, 'POST', '/v1/approvals/reviewers', {
      userId: member,
      role: 'standard',
    });
    expect(asAdmin.status).toBe(201);
    expect(a.reviewers.map((r) => r.userId)).toEqual([member]);
  });

  test('reading the roster does not', async () => {
    const a = makeApp({ authorized: true, inStep: 'all' });
    const answer = await send(a.app, 'GET', '/v1/approvals/reviewers', undefined, 'member-token');
    expect(answer.status).toBe(200);
  });
});

describe('approval reviewers without authorization', () => {
  test('any caller registers one, as before', async () => {
    const a = makeApp({ authorized: false, inStep: 'none' });
    const answer = await send(
      a.app,
      'POST',
      '/v1/approvals/reviewers',
      { userId: member, role: 'standard' },
      'member-token',
    );
    expect(answer.status).toBe(201);
  });
});
