// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import {
  type ProjectMembershipBinding,
  type TeamMembershipBinding,
  type TenantHierarchyBinding,
  makeInMemoryOrgBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '@kindgi/testing';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * Conflicts and missing rows on the tenant-hierarchy routes (orgs, teams,
 * projects) answer with their own 409 / 404 error codes — never a 500 —
 * whether the deployment enforces authorization or not. With an
 * authorizer, creates and member adds go through the
 * `TenantHierarchyBinding`; without one, through the plain bindings. Both
 * write paths are covered: the hierarchy binding here is a test double over
 * the same in-memory bindings, as a runtime's is over its storage.
 */

const TOKEN_A = 'hierarchy-conflicts-tenant-a';
const TOKEN_B = 'hierarchy-conflicts-tenant-b';
const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const userA = randomUUID() as UserId;

const resolveToken: TokenResolver = async (token) => {
  if (token === TOKEN_A) return { tenantId: tenantA, userId: userA };
  if (token === TOKEN_B) return { tenantId: tenantB, userId: userA };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/** Allows everything: these tests are about the write paths, not the decisions. */
const allowed = (action: Action, resource: ResourceRef): Decision => ({
  allowed: true,
  reason: 'test: allow all',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});
const allowAll: AuthzCheckBinding = {
  check: async (_principal, action, resource) => allowed(action, resource),
  checkBatch: async (_principal, action, resources) =>
    resources.map((resource) => allowed(action, resource)),
};

interface Options {
  readonly authorized: boolean;
  /** Membership adds find the team or project gone (deleted after the route's get). */
  readonly membershipTargetsGone?: boolean;
}

function makeApp(options: Options) {
  const orgs = makeInMemoryOrgBinding();
  const teamPair = makeInMemoryTeamBinding();
  const projectTrio = makeInMemoryProjectBinding();

  const teamMemberships: TeamMembershipBinding =
    options.membershipTargetsGone === true
      ? { ...teamPair.memberships, add: async () => ({ kind: 'team-not-found' }) }
      : teamPair.memberships;
  const projectMemberships: ProjectMembershipBinding =
    options.membershipTargetsGone === true
      ? { ...projectTrio.memberships, add: async () => ({ kind: 'project-not-found' }) }
      : projectTrio.memberships;

  const hierarchy: TenantHierarchyBinding = {
    async createOrg({ tenantId, spec }) {
      const outcome = await orgs.create(tenantId, spec);
      return outcome.kind === 'ok'
        ? { kind: 'ok', value: { orgId: outcome.orgId } }
        : { kind: 'err', error: { code: 'slug-conflict', message: 'slug taken' } };
    },
    async createTeam({ tenantId, spec }) {
      const outcome = await teamPair.teams.create(tenantId, spec);
      return outcome.kind === 'ok'
        ? { kind: 'ok', value: { teamId: outcome.teamId } }
        : { kind: 'err', error: { code: 'slug-conflict', message: 'slug taken' } };
    },
    async createProject({ tenantId, spec }) {
      const outcome = await projectTrio.projects.create(tenantId, spec);
      if (outcome.kind === 'ok') return { kind: 'ok', value: { projectId: outcome.projectId } };
      return {
        kind: 'err',
        error:
          outcome.kind === 'slug-conflict'
            ? { code: 'slug-conflict', message: 'slug taken' }
            : { code: 'default-conflict', message: 'Default taken' },
      };
    },
    async addTeamMember({ tenantId, teamId, userId, role }) {
      const outcome = await teamMemberships.add(tenantId, { teamId, userId, role });
      return outcome.kind === 'ok'
        ? { kind: 'ok', value: undefined }
        : { kind: 'err', error: { code: 'team-not-found', message: 'team gone' } };
    },
    async addProjectMember({ tenantId, projectId, userId, role }) {
      const outcome = await projectMemberships.add(tenantId, { projectId, userId, role });
      return outcome.kind === 'ok'
        ? { kind: 'ok', value: undefined }
        : { kind: 'err', error: { code: 'project-not-found', message: 'project gone' } };
    },
    getTenant: async () => null,
  };

  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tenantHierarchyBinding: hierarchy,
    orgBinding: orgs,
    teamBinding: teamPair.teams,
    teamMembershipBinding: teamMemberships,
    projectBinding: projectTrio.projects,
    projectMembershipBinding: projectMemberships,
    teamProjectGrantBinding: projectTrio.grants,
    ...(options.authorized && {
      authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: allowAll },
    }),
  });
}

type App = ReturnType<typeof makeApp>;

interface Answer {
  readonly status: number;
  readonly body: {
    readonly id?: string;
    readonly error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

async function send(
  app: App,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  token = TOKEN_A,
): Promise<Answer> {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

async function created(app: App, path: string, body: unknown): Promise<string> {
  const answer = await send(app, 'POST', path, body);
  expect(answer.status).toBe(201);
  return answer.body.id as string;
}

const RESOURCES = [
  { resource: 'org', path: '/v1/orgs' },
  { resource: 'team', path: '/v1/teams' },
  { resource: 'project', path: '/v1/projects' },
] as const;

describe.each([
  { mode: 'without an authorizer', authorized: false },
  { mode: 'with an authorizer', authorized: true },
])('hierarchy conflicts, $mode', ({ authorized }) => {
  describe.each(RESOURCES)('$path', ({ resource, path }) => {
    test('a slug the tenant already has → 409 slug-conflict', async () => {
      const app = makeApp({ authorized });
      await created(app, path, { name: 'Acme', slug: 'acme' });
      const second = await send(app, 'POST', path, { name: 'Acme again', slug: 'acme' });
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('slug-conflict');
      expect(second.body.error?.message).toBe(
        `Another ${resource} in the tenant has the slug "acme"`,
      );
      expect(second.body.error?.details).toEqual({ resource, slug: 'acme' });
    });

    test('another tenant may use the slug → 201', async () => {
      const app = makeApp({ authorized });
      await created(app, path, { name: 'Acme', slug: 'acme' });
      const other = await send(app, 'POST', path, { name: 'Acme', slug: 'acme' }, TOKEN_B);
      expect(other.status).toBe(201);
    });

    test('PATCH to a slug another one has → 409 slug-conflict', async () => {
      const app = makeApp({ authorized });
      await created(app, path, { name: 'Acme', slug: 'acme' });
      const id = await created(app, path, { name: 'Globex', slug: 'globex' });
      const patched = await send(app, 'PATCH', `${path}/${id}`, { slug: 'acme' });
      expect(patched.status).toBe(409);
      expect(patched.body.error?.code).toBe('slug-conflict');
      expect(patched.body.error?.details).toEqual({ resource, slug: 'acme' });
    });

    test('PATCH of a missing one → 404', async () => {
      const app = makeApp({ authorized });
      const patched = await send(app, 'PATCH', `${path}/${randomUUID()}`, { name: 'X' });
      expect(patched.status).toBe(404);
      expect(patched.body.error?.code).toBe(`${resource}-not-found`);
    });
  });

  test('a second Default project → 409 project-default-already-exists', async () => {
    const app = makeApp({ authorized });
    await created(app, '/v1/projects', { name: 'Default', slug: 'default', isDefault: true });
    const second = await send(app, 'POST', '/v1/projects', {
      name: 'Another Default',
      slug: 'another-default',
      isDefault: true,
    });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('project-default-already-exists');
  });

  test.each([
    { path: '/v1/teams', code: 'team-not-found', role: 'member' },
    { path: '/v1/projects', code: 'project-not-found', role: 'editor' },
  ])(
    'a member added to a $path entry deleted mid-request → 404 $code',
    async ({ path, code, role }) => {
      const app = makeApp({ authorized, membershipTargetsGone: true });
      const id = await created(app, path, { name: 'Acme', slug: 'acme' });
      const added = await send(app, 'POST', `${path}/${id}/memberships`, {
        userId: randomUUID(),
        role,
      });
      expect(added.status).toBe(404);
      expect(added.body.error?.code).toBe(code);
    },
  );

  test.each([
    { path: '/v1/teams', code: 'team-membership-not-found', role: 'admin' },
    { path: '/v1/projects', code: 'project-membership-not-found', role: 'owner' },
  ])(
    'a role change for a non-member of a $path entry → 404 $code',
    async ({ path, code, role }) => {
      const app = makeApp({ authorized });
      const id = await created(app, path, { name: 'Acme', slug: 'acme' });
      const changed = await send(app, 'PATCH', `${path}/${id}/memberships/${randomUUID()}`, {
        role,
      });
      expect(changed.status).toBe(404);
      expect(changed.body.error?.code).toBe(code);
    },
  );
});
