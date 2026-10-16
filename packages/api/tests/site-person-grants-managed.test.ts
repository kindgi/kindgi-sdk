// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A person a site signs in holds only the grants their site's sign-in
 * writes. The deployment's bindings refuse anything else naming them
 * (`site-person-grants-managed`), and each route answers that refusal as a
 * 403 with its code: a project or team membership, a role change, a tenant
 * grant, a reviewer role, an API key.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import {
  type TenantHierarchyBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  PersonGrantsBinding,
  ReviewerRegistryBinding,
  RunHandlerBinding,
  TokenAdmin,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const admin = randomUUID() as UserId;
/** A person a site signs in. */
const jane = randomUUID() as UserId;
const MANAGED = {
  code: 'site-person-grants-managed' as const,
  message: 'This person is signed in by a site: their grants are its to give',
};

const resolveToken: TokenResolver = async (token) =>
  token === 'admin-token' ? { tenantId, userId: admin } : null;

const allow = (action: Action, resource: ResourceRef): Decision => ({
  allowed: true,
  reason: 'test: allowed',
  evidence: { action, relation: '', resource: `${resource.type}:${resource.id}`, actorSubject: '' },
});
const authzCheckBinding: AuthzCheckBinding = {
  check: async (_principal, action, resource) => allow(action, resource),
  checkBatch: async (_principal, action, resources) => resources.map((r) => allow(action, r)),
};

function makeApp() {
  const teams = makeInMemoryTeamBinding();
  const projects = makeInMemoryProjectBinding();
  const refusing = (userId: UserId) => userId === jane;
  const hierarchy = {
    ...createStubAppBindings().tenantHierarchyBinding,
    async addTeamMember({ teamId, userId, role }) {
      if (refusing(userId)) return { kind: 'err', error: MANAGED };
      await teams.memberships.add(tenantId, { teamId, userId, role });
      return { kind: 'ok', value: undefined };
    },
    async addProjectMember({ projectId, userId, role }) {
      if (refusing(userId)) return { kind: 'err', error: MANAGED };
      await projects.memberships.add(tenantId, { projectId, userId, role });
      return { kind: 'ok', value: undefined };
    },
    async removeTeamMember({ userId }) {
      return refusing(userId) ? { kind: 'err', error: MANAGED } : { kind: 'ok', value: undefined };
    },
    async removeProjectMember({ userId }) {
      return refusing(userId) ? { kind: 'err', error: MANAGED } : { kind: 'ok', value: undefined };
    },
    async updateTeamMemberRole({ userId }) {
      return refusing(userId)
        ? { kind: 'err', error: MANAGED }
        : { kind: 'ok', value: { kind: 'team-membership-not-found' } };
    },
    async updateProjectMemberRole({ userId }) {
      return refusing(userId)
        ? { kind: 'err', error: MANAGED }
        : { kind: 'ok', value: { kind: 'project-membership-not-found' } };
    },
  } as TenantHierarchyBinding;
  const personGrants = {
    read: async () => null,
    grant: async () => ({ kind: 'err', error: MANAGED }),
    ungrant: async () => ({ kind: 'err', error: MANAGED }),
  } as unknown as PersonGrantsBinding;
  // A key for a site's person would outlive their site's pause or unregister.
  const tokenAdmin = {
    mint: async () => ({ kind: 'site-person-grants-managed', message: MANAGED.message }),
    list: async () => [],
    get: async () => undefined,
    revoke: async () => ({ kind: 'not-found' }),
  } as unknown as TokenAdmin;
  const reviewerRegistry = {
    list: async () => ({ data: [] }),
    get: async () => null,
    register: async () => ({ kind: 'refused', ...MANAGED }),
    unregister: async () => ({ unregistered: false, refused: MANAGED }),
  } as unknown as ReviewerRegistryBinding;

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as unknown as RunHandlerBinding,
    tenantHierarchyBinding: hierarchy,
    teamBinding: teams.teams,
    teamMembershipBinding: teams.memberships,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    personGrants,
    reviewerRegistry,
    tokenAdmin,
    identityDirectory: {
      getUser: async ({ userId }) =>
        userId === jane
          ? {
              userId: jane,
              tenantId,
              displayName: 'Jane, via Acme store',
              createdAt: '2026-10-11T00:00:00.000Z' as never,
            }
          : null,
      listUsers: async () => ({ data: [] }),
      listSessions: async () => ({ data: [] }),
      revokeAllSessions: async ({ userId }) => ({ userId, revokedCount: 0 }),
    },
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  return { app, teams, projects };
}

async function send(
  app: ReturnType<typeof makeApp>['app'],
  method: string,
  path: string,
  body: unknown,
) {
  const res = await app.request(path, {
    method,
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text === '' ? {} : JSON.parse(text)) as { error?: { code: string } },
  };
}

async function seeded(a: ReturnType<typeof makeApp>) {
  const team = await a.teams.teams.create(tenantId, { name: 'Desk', slug: `desk-${randomUUID()}` });
  const project = await a.projects.projects.create(tenantId, {
    name: 'Desk',
    slug: `desk-${randomUUID()}`,
  });
  if (team.kind !== 'ok' || project.kind !== 'ok') throw new Error('seed failed');
  return {
    teamId: team.teamId as unknown as string,
    projectId: project.projectId as unknown as string,
  };
}

describe("a grant naming a site's person is refused with its own code", () => {
  test.each([
    [
      'a project membership',
      'POST',
      (ids: Ids) => `/v1/projects/${ids.projectId}/memberships`,
      { userId: jane, role: 'viewer' },
    ],
    [
      'a project role change',
      'PATCH',
      (ids: Ids) => `/v1/projects/${ids.projectId}/memberships/${jane}`,
      { role: 'editor' },
    ],
    [
      'a team membership',
      'POST',
      (ids: Ids) => `/v1/teams/${ids.teamId}/memberships`,
      { userId: jane, role: 'member' },
    ],
    [
      'a team role change',
      'PATCH',
      (ids: Ids) => `/v1/teams/${ids.teamId}/memberships/${jane}`,
      { role: 'admin' },
    ],
    ['tenant admin', 'POST', () => `/v1/identity/users/${jane}/grant`, { kind: 'tenant-admin' }],
    ['a reviewer role', 'POST', () => '/v1/approvals/reviewers', { userId: jane, role: 'admin' }],
    [
      'removing a project membership',
      'DELETE',
      (ids: Ids) => `/v1/projects/${ids.projectId}/memberships/${jane}`,
      undefined,
    ],
    [
      'removing a team membership',
      'DELETE',
      (ids: Ids) => `/v1/teams/${ids.teamId}/memberships/${jane}`,
      undefined,
    ],
    ['an API key', 'POST', () => '/v1/tokens', { for: { kind: 'user', id: jane } }],
    [
      'unregistering a reviewer',
      'POST',
      () => `/v1/approvals/reviewers/${randomUUID()}/unregister`,
      undefined,
    ],
  ] as const)('%s', async (_what, method, path, body) => {
    const a = makeApp();
    const ids = await seeded(a);
    const answer = await send(a.app, method, path(ids), body);
    expect(answer.status).toBe(403);
    expect(answer.body.error?.code).toBe('site-person-grants-managed');
  });
});

type Ids = { readonly teamId: string; readonly projectId: string };
