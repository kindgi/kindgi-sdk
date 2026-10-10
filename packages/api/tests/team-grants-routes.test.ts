// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A team's role on a project (`/v1/projects/:projectId/team-grants`,
 * `/v1/teams/:teamId/project-grants`), and who may see who has access:
 *
 * - without an authorizer, the routes use the grant binding: add (201; 200
 *   for the role held; 409 naming another), change, remove, both lists;
 *   a team never owns a project;
 * - with one, writes go through the tenant-hierarchy binding (row and
 *   tuple together) or are refused (501); giving a project takes `read` on
 *   the team too;
 * - a project's viewers don't list its members or its team grants (those
 *   take `write`), and a team's plain members don't list its members or
 *   its projects (those take team `admin`);
 * - deleting a team goes through the hierarchy binding, so its tuples go too.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import {
  type TeamProjectGrant,
  type TenantHierarchyBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { ProjectId, TeamId, TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PEOPLE = [
  'admin',
  'projectAdmin',
  'editor',
  'viewer',
  'teamAdmin',
  'teamMember',
  'outsider',
] as const;
type Person = (typeof PEOPLE)[number];
const ids = Object.fromEntries(PEOPLE.map((p) => [p, randomUUID() as UserId])) as Record<
  Person,
  UserId
>;
const resolveToken: TokenResolver = async (token) => {
  const who = PEOPLE.find((p) => token === `${p}-token`);
  return who === undefined ? null : { tenantId, userId: ids[who] };
};
const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/**
 * Who may do what: the admin anything; on the project, its admin
 * administers (and can't read the team), the editor writes and the viewer
 * reads; on the team, its admin administers and its member reads. The
 * outsider can do nothing.
 */
function allowed(who: Person | undefined, action: Action, resource: ResourceRef): boolean {
  if (who === 'admin') return true;
  if (resource.type === 'project') {
    if (who === 'projectAdmin') return action !== 'delete';
    if (who === 'editor') return action === 'read' || action === 'write';
    if (who === 'viewer') return action === 'read';
    return false;
  }
  if (resource.type === 'team') {
    if (who === 'teamAdmin') return action === 'read' || action === 'admin';
    if (who === 'teamMember' || who === 'editor') return action === 'read';
    return false;
  }
  return false;
}

const decision = (ok: boolean, action: Action, resource: ResourceRef): Decision => ({
  allowed: ok,
  reason: ok ? 'test: allowed' : 'test: denied',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});

const personOf = (actorId: string) => PEOPLE.find((p) => ids[p] === actorId);

const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) =>
    decision(allowed(personOf(principal.actor.id), action, resource), action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((r) => decision(allowed(personOf(principal.actor.id), action, r), action, r)),
};

function makeApp(options: { readonly authorized: boolean; readonly inStep?: boolean }) {
  const teams = makeInMemoryTeamBinding();
  const projects = makeInMemoryProjectBinding();
  const calls: string[] = [];
  const stub = createStubAppBindings().tenantHierarchyBinding;
  const {
    addTeamProjectGrant: _a,
    updateTeamProjectGrantRole: _u,
    removeTeamProjectGrant: _r,
    deleteTeam: _d,
    ...withoutInStep
  } = stub;
  // Members added as the runtime's binding adds them: the role held is kept.
  const members: Partial<TenantHierarchyBinding> = {
    async addTeamMember({ teamId, userId, role }) {
      const out = await teams.memberships.add(tenantId, { teamId, userId, role });
      if (out.kind === 'membership-exists') {
        return {
          kind: 'err',
          error: { code: 'membership-exists', message: 'held', role: out.role },
        };
      }
      return { kind: 'ok', value: undefined };
    },
    async addProjectMember({ projectId, userId, role }) {
      const out = await projects.memberships.add(tenantId, { projectId, userId, role });
      if (out.kind === 'membership-exists') {
        return {
          kind: 'err',
          error: { code: 'membership-exists', message: 'held', role: out.role },
        };
      }
      return { kind: 'ok', value: undefined };
    },
  };
  const inStep: Partial<TenantHierarchyBinding> =
    options.inStep === false
      ? {}
      : {
          async addTeamProjectGrant({ projectId, teamId, role }) {
            calls.push(`add ${role}`);
            const held = await projects.grants.get?.(tenantId, teamId, projectId);
            if (held !== undefined) return { kind: 'ok', value: { created: false, grant: held } };
            await projects.grants.add(tenantId, { teamId, projectId, role });
            const grant = (await projects.grants.get?.(
              tenantId,
              teamId,
              projectId,
            )) as TeamProjectGrant;
            return { kind: 'ok', value: { created: true, grant } };
          },
          async updateTeamProjectGrantRole({ projectId, teamId, role }) {
            calls.push(`update ${role}`);
            const held = await projects.grants.get?.(tenantId, teamId, projectId);
            if (held === undefined) return { kind: 'ok', value: { kind: 'team-grant-not-found' } };
            await projects.grants.updateRole(tenantId, teamId, projectId, role);
            return { kind: 'ok', value: { kind: 'ok', grant: { ...held, role } } };
          },
          async removeTeamProjectGrant({ projectId, teamId }) {
            calls.push('remove');
            await projects.grants.remove(tenantId, teamId, projectId);
            return { kind: 'ok', value: undefined };
          },
          async deleteTeam({ teamId }) {
            calls.push('deleteTeam');
            await teams.teams.delete(tenantId, teamId);
            return { kind: 'ok', value: { deleted: true } };
          },
        };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    teamBinding: teams.teams,
    teamMembershipBinding: teams.memberships,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    tenantHierarchyBinding: { ...withoutInStep, ...members, ...inStep } as TenantHierarchyBinding,
    ...(options.authorized && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
    }),
  });
  const call = async (who: Person, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}-token`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text === '' ? {} : JSON.parse(text)) as Record<string, any>,
    };
  };
  const seed = async () => {
    const p = await projects.projects.create(tenantId, {
      name: 'Support',
      slug: `s-${randomUUID()}`,
    });
    const t = await teams.teams.create(tenantId, {
      name: 'Support crew',
      slug: `c-${randomUUID()}`,
    });
    if (p.kind !== 'ok' || t.kind !== 'ok') throw new Error('seed failed');
    return { projectId: p.projectId as ProjectId, teamId: t.teamId as TeamId };
  };
  return { call, calls, seed, teams, projects };
}

describe('without an authorizer: the grant binding', () => {
  test('add, the role held again, another role, change, both lists, remove', async () => {
    const h = makeApp({ authorized: false });
    const { projectId, teamId } = await h.seed();
    const grants = `/v1/projects/${projectId}/team-grants`;

    const added = await h.call('admin', 'POST', grants, { teamId, role: 'editor' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      teamId,
      projectId,
      role: 'editor',
      teamName: 'Support crew',
      projectName: 'Support',
      grantedAt: expect.any(String),
    });
    // A role already held: 201 again, with the grant as it is.
    const again = await h.call('admin', 'POST', grants, { teamId, role: 'editor' });
    expect([again.status, again.body.grantedAt]).toEqual([201, added.body.grantedAt]);
    const other = await h.call('admin', 'POST', grants, { teamId, role: 'admin' });
    expect([other.status, other.body.error?.code, other.body.error?.details]).toEqual([
      409,
      'team-grant-exists',
      { role: 'editor' },
    ]);

    expect((await h.call('admin', 'PATCH', `${grants}/${teamId}`, { role: 'viewer' })).status).toBe(
      204,
    );
    const listed = await h.call('admin', 'GET', grants);
    expect(listed.body).toMatchObject({
      data: [{ teamId, role: 'viewer', teamName: 'Support crew' }],
      hasMore: false,
    });
    const onTeam = await h.call('admin', 'GET', `/v1/teams/${teamId}/project-grants`);
    expect(onTeam.body.data).toEqual([
      expect.objectContaining({ projectId, projectName: 'Support' }),
    ]);

    expect((await h.call('admin', 'DELETE', `${grants}/${teamId}`)).status).toBe(204);
    expect((await h.call('admin', 'GET', grants)).body.data).toEqual([]);
    const gone = await h.call('admin', 'PATCH', `${grants}/${teamId}`, { role: 'viewer' });
    expect([gone.status, gone.body.error?.code]).toEqual([404, 'team-grant-not-found']);
  });

  test('a team never owns a project; `member` is no role; unknown team or project: 404', async () => {
    const h = makeApp({ authorized: false });
    const { projectId, teamId } = await h.seed();
    const grants = `/v1/projects/${projectId}/team-grants`;
    for (const [role, message] of [
      ['owner', "A team can't own a project: give it `admin`"],
      ['member', "`member` isn't a project role: use `viewer`, which grants the same"],
      ['boss', '`role` must be one of: viewer, editor, admin'],
    ] as const) {
      const r = await h.call('admin', 'POST', grants, { teamId, role });
      expect([r.status, r.body.error?.message]).toEqual([400, message]);
    }
    const team = await h.call('admin', 'POST', grants, { teamId: randomUUID(), role: 'viewer' });
    expect([team.status, team.body.error?.code]).toEqual([404, 'team-not-found']);
    const project = await h.call('admin', 'POST', `/v1/projects/${randomUUID()}/team-grants`, {
      teamId,
      role: 'viewer',
    });
    expect([project.status, project.body.error?.code]).toEqual([404, 'project-not-found']);
  });
});

describe('with an authorizer: writes in step, and who may see who has access', () => {
  test('writes go through the hierarchy binding; without it they are refused', async () => {
    const h = makeApp({ authorized: true });
    const { projectId, teamId } = await h.seed();
    const grants = `/v1/projects/${projectId}/team-grants`;
    expect((await h.call('admin', 'POST', grants, { teamId, role: 'editor' })).status).toBe(201);
    expect((await h.call('admin', 'PATCH', `${grants}/${teamId}`, { role: 'admin' })).status).toBe(
      204,
    );
    expect((await h.call('admin', 'DELETE', `${grants}/${teamId}`)).status).toBe(204);
    expect(h.calls).toEqual(['add editor', 'update admin', 'remove']);

    const refused = makeApp({ authorized: true, inStep: false });
    const s = await refused.seed();
    const r = await refused.call('admin', 'POST', `/v1/projects/${s.projectId}/team-grants`, {
      teamId: s.teamId,
      role: 'viewer',
    });
    expect([r.status, r.body.error?.code]).toEqual([501, 'authz-membership-unsupported']);
    expect((await refused.call('admin', 'DELETE', `/v1/teams/${s.teamId}`)).status).toBe(501);
  });

  test('giving a project takes admin on it and read on the team', async () => {
    const h = makeApp({ authorized: true });
    const { projectId, teamId } = await h.seed();
    const grants = `/v1/projects/${projectId}/team-grants`;
    expect((await h.call('editor', 'POST', grants, { teamId, role: 'viewer' })).status).toBe(403);
    // The project's admin, who can't read the team.
    const unseen = await h.call('projectAdmin', 'POST', grants, { teamId, role: 'viewer' });
    expect([unseen.status, unseen.body.error?.message]).toEqual([
      403,
      'A project is given only to a team you can read',
    ]);
    // A team admin administers the team, not the project.
    expect((await h.call('teamAdmin', 'POST', grants, { teamId, role: 'viewer' })).status).toBe(
      403,
    );
    expect(h.calls).toEqual([]);
  });

  test("a project's viewers list neither its members nor its team grants; its editors do", async () => {
    const h = makeApp({ authorized: true });
    const { projectId, teamId } = await h.seed();
    await h.call('admin', 'POST', `/v1/projects/${projectId}/team-grants`, {
      teamId,
      role: 'viewer',
    });
    for (const path of [
      `/v1/projects/${projectId}/memberships`,
      `/v1/projects/${projectId}/team-grants`,
    ]) {
      const viewer = await h.call('viewer', 'GET', path);
      expect([path, viewer.status, viewer.body.error?.code]).toEqual([
        path,
        403,
        'permission-denied',
      ]);
      expect([path, (await h.call('editor', 'GET', path)).status]).toEqual([path, 200]);
    }
    // The viewer still reads the project itself.
    expect((await h.call('viewer', 'GET', `/v1/projects/${projectId}`)).status).toBe(200);
  });

  test("a team's plain members list neither its members nor its projects; its admins do", async () => {
    const h = makeApp({ authorized: true });
    const { teamId } = await h.seed();
    for (const path of [`/v1/teams/${teamId}/memberships`, `/v1/teams/${teamId}/project-grants`]) {
      const member = await h.call('teamMember', 'GET', path);
      expect([path, member.status]).toEqual([path, 403]);
      expect([path, (await h.call('teamAdmin', 'GET', path)).status]).toEqual([path, 200]);
    }
    expect((await h.call('teamMember', 'GET', `/v1/teams/${teamId}`)).status).toBe(200);
  });

  test('deleting a team goes through the hierarchy binding, so its tuples go too', async () => {
    const h = makeApp({ authorized: true });
    const { teamId } = await h.seed();
    expect((await h.call('admin', 'DELETE', `/v1/teams/${teamId}`)).status).toBe(204);
    expect(h.calls).toEqual(['deleteTeam']);
  });
});

describe('re-adding a member with another role', () => {
  for (const authorized of [false, true]) {
    test(`a 409 naming the role held, kept (${authorized ? 'with' : 'without'} an authorizer)`, async () => {
      const h = makeApp({ authorized });
      const { projectId, teamId } = await h.seed();
      const userId = randomUUID();
      for (const [path, held, other] of [
        [`/v1/projects/${projectId}/memberships`, 'viewer', 'admin'],
        [`/v1/teams/${teamId}/memberships`, 'member', 'admin'],
      ] as const) {
        expect((await h.call('admin', 'POST', path, { userId, role: held })).status).toBe(201);
        expect((await h.call('admin', 'POST', path, { userId, role: held })).status).toBe(201);
        const r = await h.call('admin', 'POST', path, { userId, role: other });
        expect([path, r.status, r.body.error?.code, r.body.error?.details]).toEqual([
          path,
          409,
          'membership-exists',
          { role: held },
        ]);
        const listed = await h.call('admin', 'GET', path);
        expect(listed.body.data).toEqual([expect.objectContaining({ userId, role: held })]);
      }
    });
  }
});
