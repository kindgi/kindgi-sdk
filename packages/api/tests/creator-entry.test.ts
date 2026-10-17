// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import {
  type CreateOrgParams,
  type CreateProjectParams,
  type CreateTeamParams,
  type TenantHierarchyBinding,
  makeInMemoryOrgBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { OrgId, ProjectId, TeamId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

/**
 * Who an org, team or project create makes its creator. A person's key
 * hands the tenant-hierarchy binding the person, who is made the
 * project's owner or the org's or team's admin. A key with no person
 * behind it (a service account's) hands it no one: nobody is made its
 * creator, and the tenant's admins reach it through its parent.
 */

const tenantId = randomUUID() as TenantId;
const PERSON = randomUUID() as UserId;
const PERSON_KEY = 'creator-entry-person';
const ACCOUNT_KEY = 'creator-entry-account';

const resolveToken: TokenResolver = async (token) => {
  if (token === PERSON_KEY) return { tenantId, userId: PERSON };
  if (token === ACCOUNT_KEY) return { tenantId, serviceAccountId: 'sa-ci' };
  return null;
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

function allowed(action: Action, resource: ResourceRef): Decision {
  return {
    allowed: true,
    reason: 'test: allowed',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}

/** The app, with an authorizer (so creates go through the binding) that allows everything. */
function makeApp() {
  const asked = {
    org: [] as CreateOrgParams[],
    team: [] as CreateTeamParams[],
    project: [] as CreateProjectParams[],
  };
  const stubs = createStubAppBindings();
  // The routes mount with these; the creates go to the binding below.
  const orgs = makeInMemoryOrgBinding();
  const teams = makeInMemoryTeamBinding();
  const projects = makeInMemoryProjectBinding();
  const tenantHierarchyBinding: TenantHierarchyBinding = {
    ...stubs.tenantHierarchyBinding,
    createOrg: async (params) => {
      asked.org.push(params);
      return { kind: 'ok', value: { orgId: randomUUID() as OrgId } };
    },
    createTeam: async (params) => {
      asked.team.push(params);
      return { kind: 'ok', value: { teamId: randomUUID() as TeamId } };
    },
    createProject: async (params) => {
      asked.project.push(params);
      return { kind: 'ok', value: { projectId: randomUUID() as ProjectId } };
    },
  };
  const app = createApp({
    ...stubs,
    tenantHierarchyBinding,
    orgBinding: orgs,
    teamBinding: teams.teams,
    teamMembershipBinding: teams.memberships,
    projectBinding: projects.projects,
    projectMembershipBinding: projects.memberships,
    teamProjectGrantBinding: projects.grants,
    resolveToken,
    runHandler,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, resource) => allowed(action, resource),
        checkBatch: async (_p, action, resources) => resources.map((r) => allowed(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  return { app, asked };
}

async function create(app: ReturnType<typeof makeApp>['app'], path: string, key: string) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Acme', slug: `acme-${randomUUID().slice(0, 8)}` }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
}

const kinds = [
  ['org', '/v1/orgs'],
  ['team', '/v1/teams'],
  ['project', '/v1/projects'],
] as const;

describe('creating an org, a team or a project: who is made its creator', () => {
  for (const [kind, path] of kinds) {
    test(`${kind}: a person's key names them`, async () => {
      const { app, asked } = makeApp();
      await create(app, path, PERSON_KEY);
      expect(asked[kind]).toHaveLength(1);
      expect(asked[kind][0]?.creatorUserId).toBe(PERSON);
    });

    test(`${kind}: a service account's key names no one`, async () => {
      const { app, asked } = makeApp();
      await create(app, path, ACCOUNT_KEY);
      expect(asked[kind]).toHaveLength(1);
      expect(asked[kind][0]).not.toHaveProperty('creatorUserId');
    });
  }
});
