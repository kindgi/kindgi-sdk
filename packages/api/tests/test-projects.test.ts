// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type Action,
  type AuthzCheckBinding,
  type Decision,
  type ResourceRef,
  projectObject,
  tuplesForCreate,
  userSubject,
} from '@kindgi/authz';
import {
  type TenantHierarchyBinding,
  makeInMemoryProjectBinding,
  makeInMemoryTeamBinding,
} from '@kindgi/platform';
import type { ProjectId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ConnectionBinding,
  EnvironmentOrderBinding,
  RunHandlerBinding,
  SecretBinding,
  SecretRecord,
  TenantHostAccess,
  TokenResolver,
} from '../src/index.js';
import { inMemoryMemory } from './support/in-memory-memory.js';

/**
 * A person's own test project (`Project.testFor`): any member of the
 * workspace makes their own, one each, on a runtime that holds them
 * (`isolated`). It's theirs alone: they're its `admin`, nobody else joins
 * it, no team is given it, and it never goes into production, into an
 * environment order or onto a repo connection. Its person writes its
 * secrets without `secrets:write`, and a key limited to it reads only its
 * own facts.
 */

const tenantId = randomUUID() as TenantId;
const PERSON = 'person-1' as UserId;
const OTHER = 'person-2' as UserId;
const ADMIN = 'admin-1' as UserId;

const PERSON_TOKEN = 'person-token';
const OTHER_TOKEN = 'other-token';
const ADMIN_TOKEN = 'admin-token';
/** The person's key limited to their test project, and to the shared project. */
const PERSON_TEST_KEY = 'person-test-key';
const PERSON_SHARED_KEY = 'person-shared-key';

/** Only the workspace admin holds `admin` on the workspace; everything else is allowed. */
function decision(principal: unknown, action: Action, resource: ResourceRef): Decision {
  const who = (principal as { actor: { id: string } }).actor.id;
  const allowed = !(action === 'admin' && resource.type === 'tenant') || who === ADMIN;
  return {
    allowed,
    reason: allowed ? 'test: granted' : 'test: not granted',
    evidence: {
      action,
      relation: '',
      resource: `${resource.type}:${resource.id}`,
      actorSubject: '',
    },
  };
}
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) => decision(principal, action, resource),
  checkBatch: async (principal, action, resources) =>
    resources.map((resource) => decision(principal, action, resource)),
};

const runHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'not used' } }),
};

/** A secret store that keeps what it's given. */
function secretsBinding(): { readonly names: string[]; readonly binding: SecretBinding } {
  const names: string[] = [];
  const binding: Pick<SecretBinding, 'get' | 'set'> = {
    get: async () => null,
    set: async (input) => {
      names.push(input.name);
      const record: SecretRecord = {
        scope: input.scope,
        envName: input.envName,
        name: input.name,
        currentVersion: 1,
        createdAt: '2026-11-07T00:00:00.000Z',
        updatedAt: '2026-11-07T00:00:00.000Z',
      };
      return { kind: 'ok', record, versionId: 1 };
    },
  };
  return { names, binding: binding as SecretBinding };
}

function makeApp(hostAccess: TenantHostAccess = 'isolated') {
  const trio = makeInMemoryProjectBinding();
  const teams = makeInMemoryTeamBinding();
  const memory = inMemoryMemory();
  const secrets = secretsBinding();
  let ordersSet = 0;
  const environmentOrders = {
    list: async () => ({ orders: [] }),
    get: async ({ parent }: { parent: unknown }) => ({ parent, projects: [] }),
    set: async () => {
      ordersSet += 1;
      return { kind: 'bad-input', message: 'not reached' };
    },
    orderOf: async () => undefined,
    hasEnvironmentOrder: async () => false,
  } as unknown as EnvironmentOrderBinding;
  const connections = {
    get: async () => null,
  } as unknown as ConnectionBinding;

  // The binding's own refusals, as a runtime's hierarchy binding gives them.
  const tenantHierarchy: Pick<
    TenantHierarchyBinding,
    | 'createProject'
    | 'addProjectMember'
    | 'removeProjectMember'
    | 'updateProjectMemberRole'
    | 'getTenant'
  > = {
    async createProject({ tenantId: t, spec }) {
      const outcome = await trio.projects.create(t, spec);
      if (outcome.kind === 'ok') return { kind: 'ok', value: { projectId: outcome.projectId } };
      return {
        kind: 'err',
        error:
          outcome.kind === 'project-test-already-exists'
            ? { code: 'test-conflict', message: 'Test project taken' }
            : outcome.kind === 'slug-conflict'
              ? { code: 'slug-conflict', message: 'slug taken' }
              : { code: 'default-conflict', message: 'Default taken' },
      };
    },
    async addProjectMember({ tenantId: t, projectId, userId, role }) {
      const outcome = await trio.memberships.add(t, { projectId, userId, role });
      return outcome.kind === 'ok'
        ? { kind: 'ok', value: undefined }
        : { kind: 'err', error: { code: 'project-not-found', message: 'project gone' } };
    },
    async removeProjectMember({ tenantId: t, projectId, userId }) {
      await trio.memberships.remove(t, projectId, userId);
      return { kind: 'ok', value: undefined };
    },
    async updateProjectMemberRole({ tenantId: t, projectId, userId, role }) {
      return { kind: 'ok', value: await trio.memberships.updateRole(t, projectId, userId, role) };
    },
    getTenant: async () => null,
  };

  const keyProjects = new Map<string, ProjectId>();
  const resolveToken: TokenResolver = async (token) => {
    if (token === PERSON_TOKEN) return { tenantId, userId: PERSON };
    if (token === OTHER_TOKEN) return { tenantId, userId: OTHER };
    if (token === ADMIN_TOKEN) return { tenantId, userId: ADMIN };
    const keyProject = keyProjects.get(token);
    if (keyProject !== undefined) {
      return { tenantId, userId: PERSON, tokenProjectId: keyProject as unknown as string };
    }
    return null;
  };

  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler,
    tenantHostAccess: hostAccess,
    tenantHierarchyBinding: tenantHierarchy as TenantHierarchyBinding,
    projectBinding: trio.projects,
    projectMembershipBinding: trio.memberships,
    teamBinding: teams.teams,
    teamMembershipBinding: teams.memberships,
    teamProjectGrantBinding: trio.grants,
    secretsBinding: secrets.binding,
    memory: memory.binding,
    environmentOrders,
    connections,
    envName: 'local' as never,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Record<string, any>,
    };
  };

  /** The person's test project and a shared one, made through the routes. */
  const seed = async () => {
    const made = await call('POST', '/v1/projects', PERSON_TOKEN, {
      name: 'Mine',
      slug: 'mine',
      testFor: PERSON,
    });
    expect(made.status).toBe(201);
    const shared = await call('POST', '/v1/projects', ADMIN_TOKEN, {
      name: 'Shop',
      slug: 'shop',
    });
    expect(shared.status).toBe(201);
    const testId = made.body.id as ProjectId;
    const sharedId = shared.body.id as ProjectId;
    keyProjects.set(PERSON_TEST_KEY, testId);
    keyProjects.set(PERSON_SHARED_KEY, sharedId);
    return { testId, sharedId };
  };

  return { call, seed, trio, memory, secrets, ordersSet: () => ordersSet };
}

const refused = (
  r: { status: number; body: Record<string, any> },
  status: number,
  code: string,
) => {
  expect(r.status).toBe(status);
  expect(r.body.error.code).toBe(code);
};

describe('making a test project', () => {
  test('a member makes their own, and it reads back with `testFor`', async () => {
    const h = makeApp();
    const { testId } = await h.seed();
    const got = await h.call('GET', `/v1/projects/${testId}`, PERSON_TOKEN);
    expect(got.status).toBe(200);
    expect(got.body.testFor).toBe(PERSON);
    expect(got.body.isDefault).toBe(false);
    expect(got.body.orgId ?? null).toBeNull();
  });

  test('a member still makes no other project', async () => {
    const h = makeApp();
    refused(
      await h.call('POST', '/v1/projects', PERSON_TOKEN, { name: 'Shop', slug: 'shop' }),
      403,
      'permission-denied',
    );
  });

  test('one each: a second one for the same person is refused', async () => {
    const h = makeApp();
    await h.seed();
    const again = await h.call('POST', '/v1/projects', PERSON_TOKEN, {
      name: 'Mine 2',
      slug: 'mine-2',
      testFor: PERSON,
    });
    refused(again, 409, 'project-test-already-exists');
    // Another person makes their own.
    const theirs = await h.call('POST', '/v1/projects', OTHER_TOKEN, {
      name: 'Theirs',
      slug: 'theirs',
      testFor: OTHER,
    });
    expect(theirs.status).toBe(201);
  });

  test("nobody makes one for someone else, not even the workspace's admin", async () => {
    const h = makeApp();
    for (const token of [OTHER_TOKEN, ADMIN_TOKEN]) {
      refused(
        await h.call('POST', '/v1/projects', token, {
          name: 'Mine',
          slug: 'mine',
          testFor: PERSON,
        }),
        403,
        'project-test-not-yours',
      );
    }
  });

  test('a key limited to a project makes none', async () => {
    const h = makeApp();
    await h.seed();
    const r = await h.call('POST', '/v1/projects', PERSON_SHARED_KEY, {
      name: 'Mine 2',
      slug: 'mine-2',
      testFor: PERSON,
    });
    refused(r, 403, 'project-test-not-yours');
    expect(r.body.error.message).toContain('limited to project');
  });

  test.each([
    ['in an org', { orgId: randomUUID() }],
    ['as the default', { isDefault: true }],
    ['for an empty id', { testFor: '' }],
  ])('none is made %s', async (_name, extra) => {
    const h = makeApp();
    refused(
      await h.call('POST', '/v1/projects', PERSON_TOKEN, {
        name: 'Mine',
        slug: 'mine',
        testFor: PERSON,
        ...extra,
      }),
      400,
      'bad-input',
    );
  });

  test("a runtime that isn't isolated holds none, and says how to get one", async () => {
    const h = makeApp('deployed');
    const r = await h.call('POST', '/v1/projects', PERSON_TOKEN, {
      name: 'Mine',
      slug: 'mine',
      testFor: PERSON,
    });
    refused(r, 409, 'project-test-needs-isolated-runtime');
    expect(r.body.error.message).toContain('KINDGI_TENANT_HOST_ACCESS=isolated');
  });

  test('its person is made its admin, never its owner, whoever creates it', () => {
    const id = randomUUID() as ProjectId;
    const tuples = tuplesForCreate({ kind: 'project', id, tenantId, testFor: PERSON }, ADMIN);
    const onIt = tuples.filter((t) => t.object === projectObject(id) && t.relation !== 'parent');
    expect(onIt.map((t) => [t.relation, t.user])).toEqual([['admin', userSubject(PERSON)]]);
    // Any other project's creator owns it, as before.
    const other = tuplesForCreate({ kind: 'project', id, tenantId }, ADMIN);
    expect(other.filter((t) => t.relation === 'owner').map((t) => t.user)).toEqual([
      userSubject(ADMIN),
    ]);
  });
});

describe('a test project stays its person’s', () => {
  test('`testFor` is set only at create: PATCH refuses it', async () => {
    const h = makeApp();
    const { sharedId } = await h.seed();
    refused(
      await h.call('PATCH', `/v1/projects/${sharedId}`, ADMIN_TOKEN, { testFor: PERSON }),
      400,
      'bad-input',
    );
  });

  test('it goes into no org', async () => {
    const h = makeApp();
    const { testId } = await h.seed();
    const r = await h.call('PATCH', `/v1/projects/${testId}`, ADMIN_TOKEN, {
      orgId: randomUUID(),
    });
    refused(r, 409, 'project-is-a-test-project');
    expect(r.body.error.details.projectId).toBe(testId);
    // Its name still changes.
    const renamed = await h.call('PATCH', `/v1/projects/${testId}`, PERSON_TOKEN, {
      name: 'Mine, renamed',
    });
    expect(renamed.status).toBe(204);
  });

  test('nobody else joins it, and its person keeps their role', async () => {
    const h = makeApp();
    const { testId, sharedId } = await h.seed();
    const base = `/v1/projects/${testId}/memberships`;
    refused(
      await h.call('POST', base, ADMIN_TOKEN, { userId: OTHER, role: 'viewer' }),
      409,
      'project-is-a-test-project',
    );
    refused(
      await h.call('PATCH', `${base}/${PERSON}`, ADMIN_TOKEN, { role: 'viewer' }),
      409,
      'project-is-a-test-project',
    );
    refused(
      await h.call('DELETE', `${base}/${PERSON}`, ADMIN_TOKEN),
      409,
      'project-is-a-test-project',
    );
    // A shared project takes members, as before.
    const joined = await h.call('POST', `/v1/projects/${sharedId}/memberships`, ADMIN_TOKEN, {
      userId: OTHER,
      role: 'viewer',
    });
    expect(joined.status).toBe(201);
  });

  test('no team is given it', async () => {
    const h = makeApp();
    const { testId } = await h.seed();
    refused(
      await h.call('POST', `/v1/projects/${testId}/team-grants`, ADMIN_TOKEN, {
        teamId: randomUUID(),
        role: 'viewer',
      }),
      409,
      'project-is-a-test-project',
    );
  });

  test('it never goes into production; taking it out is still answered', async () => {
    const h = makeApp();
    const { testId, sharedId } = await h.seed();
    const on = await h.call('PUT', `/v1/projects/${testId}/production`, ADMIN_TOKEN, {
      production: true,
    });
    refused(on, 409, 'project-is-a-test-project');
    expect(on.body.error.message).toContain('production project');
    const off = await h.call('PUT', `/v1/projects/${testId}/production`, ADMIN_TOKEN, {
      production: false,
    });
    expect(off.status).toBe(200);
    const shared = await h.call('PUT', `/v1/projects/${sharedId}/production`, ADMIN_TOKEN, {
      production: true,
    });
    expect(shared.status).toBe(200);
  });

  test('it is in no environment order', async () => {
    const h = makeApp();
    const { testId, sharedId } = await h.seed();
    const r = await h.call('PUT', '/v1/environment-orders/tenant', ADMIN_TOKEN, {
      projectIds: [sharedId, testId],
    });
    refused(r, 409, 'project-is-a-test-project');
    expect(r.body.error.details.projectId).toBe(testId);
    expect(h.ordersSet()).toBe(0);
  });

  test('it has no repo connection', async () => {
    const h = makeApp();
    const { testId } = await h.seed();
    refused(
      await h.call('PUT', `/v1/projects/${testId}/repo-connection`, ADMIN_TOKEN, {
        connectionId: randomUUID(),
      }),
      409,
      'project-is-a-test-project',
    );
  });
});

describe('what its person does in it', () => {
  const secret = (projectId: ProjectId, name: string) => ({
    scope: { kind: 'project', tenantId, projectId },
    envName: 'staging',
    name,
    value: 'acme-value',
    writeMode: 'create-new',
  });

  test('its person writes its secrets without `secrets:write`; anywhere else still needs it', async () => {
    const h = makeApp();
    const { testId, sharedId } = await h.seed();
    const own = await h.call('POST', '/v1/secrets', PERSON_TOKEN, secret(testId, 'acme.key'));
    expect(own.status).toBe(201);
    expect(h.secrets.names).toEqual(['acme.key']);
    refused(
      await h.call('POST', '/v1/secrets', OTHER_TOKEN, secret(testId, 'acme.other')),
      403,
      'permission-denied',
    );
    refused(
      await h.call('POST', '/v1/secrets', PERSON_TOKEN, secret(sharedId, 'acme.shared')),
      403,
      'permission-denied',
    );
    expect(h.secrets.names).toEqual(['acme.key']);
  });

  test('a key limited to it reads only its own facts', async () => {
    const h = makeApp();
    const { testId, sharedId } = await h.seed();
    const facts: Record<string, Record<string, unknown>> = {
      workspace: {},
      mine: { userId: PERSON },
      inTest: { projectId: testId },
      mineInTest: { projectId: testId, userId: PERSON },
      shared: { projectId: sharedId },
    };
    for (const [name, scope] of Object.entries(facts)) {
      const out = await h.memory.binding.writeFact({
        tenantId,
        type: 'acme.note',
        scope: { tenantId, ...scope },
        content: { name },
      });
      if (out.kind !== 'ok') throw new Error(`seed ${name}: ${out.kind}`);
    }
    const names = async (token: string) => {
      const res = await h.call('GET', '/v1/memory/facts?limit=100', token);
      expect(res.status).toBe(200);
      return (res.body.data as { content: { name: string } }[]).map((f) => f.content.name).sort();
    };
    expect(await names(PERSON_TEST_KEY)).toEqual(['inTest', 'mineInTest']);
    // A key limited to a shared project still reads workspace-wide facts and its person's own.
    expect(await names(PERSON_SHARED_KEY)).toEqual(
      expect.arrayContaining(['mine', 'shared', 'workspace']),
    );
  });
});
