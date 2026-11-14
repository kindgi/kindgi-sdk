// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/identity/me/permissions`: what the caller may do, so a console
 * hides what it can't. The binding says what the principal holds; the
 * route applies the API key's limits (a `member` key is never tenant
 * admin; a key limited to a project sees it alone and administers no org
 * or team), adds the reviewer role with what it decides and whether it
 * can, and the token's capabilities, and answers in one fixed order.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  type AuthzCheckBinding,
  CHECK_ONLY_ACTIONS,
  type Decision,
  OBJECT_ACTIONS,
} from '@kindgi/authz';
import type { ApiTokenId, EnvName, ReviewerId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  EnvBinding,
  LicenseStatusBinding,
  MyAccess,
  MyAccessBinding,
  ReviewerBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';
const P3 = '00000000-0000-4000-8000-0000000000b3';
const P4 = '00000000-0000-4000-8000-0000000000b4';

const ALICE = 'tok-alice'; // a tenant admin
const BOB = 'tok-bob'; // a project editor through a team, a senior reviewer
const ALICE_MEMBER_KEY = 'kgi_ak_alice-member';
const BOB_PROJECT_KEY = 'kgi_ak_bob-p1';
const ROLE_ONLY = 'tok-role-only'; // carries a reviewer role, no user
const DEPLOYMENT = 'tok-deployment'; // the deployment's own token, with capabilities
const CAROL = 'tok-carol'; // a viewer of one project, and runs two because everyone may
const CAROL_P3_KEY = 'kgi_ak_carol-p3';
const CAROL_READ_KEY = 'kgi_ak_carol-read'; // only reads

const noopRunHandler: RunHandlerBinding = {
  invokeAgent: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  invokeFlow: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
  resumeRun: async () => ({ kind: 'err', error: { code: 'bad-input', message: 'noop' } }),
};

const resolveToken: TokenResolver = async (token) => {
  switch (token) {
    case ALICE:
      return { tenantId, userId: 'alice' as UserId, scopes: [] };
    case BOB:
      return { tenantId, userId: 'bob' as UserId, scopes: [] };
    case ALICE_MEMBER_KEY:
      return {
        tenantId,
        userId: 'alice' as UserId,
        scopes: [],
        tokenId: 'k-am' as ApiTokenId,
        tokenRole: 'member',
      };
    case BOB_PROJECT_KEY:
      return {
        tenantId,
        userId: 'bob' as UserId,
        scopes: [],
        tokenId: 'k-bp' as ApiTokenId,
        tokenRole: 'admin',
        tokenProjectId: P1,
      };
    case ROLE_ONLY:
      return { tenantId, scopes: [], reviewerRole: 'admin' };
    case CAROL:
      return { tenantId, userId: 'carol' as UserId, scopes: [] };
    case CAROL_P3_KEY:
      return {
        tenantId,
        userId: 'carol' as UserId,
        scopes: [],
        tokenId: 'k-cp' as ApiTokenId,
        tokenRole: 'member',
        tokenProjectId: P3,
      };
    case CAROL_READ_KEY:
      return {
        tenantId,
        userId: 'carol' as UserId,
        scopes: [],
        tokenId: 'k-cr' as ApiTokenId,
        tokenRole: 'member',
        tokenReadOnly: true,
      };
    case DEPLOYMENT:
      return {
        tenantId,
        userId: 'alice' as UserId,
        scopes: ['tenant-admin'],
        capabilities: ['secrets:write', 'env:write', 'kindgi:system'],
      };
    default:
      return null;
  }
};

/** Tenant admin is Alice's alone; everything else is allowed. */
const authzCheckBinding: AuthzCheckBinding = {
  check: async (principal, action, resource) => {
    const allowed =
      !(action === 'admin' && resource.type === 'tenant') || principal.actor.id === 'alice';
    return {
      allowed,
      reason: 'test',
      evidence: { action, relation: '', resource: resource.id, actorSubject: principal.actor.id },
    } satisfies Decision;
  },
  checkBatch: async () => [],
};

/**
 * A roster row for anyone but Alice, even with no user: deciding without a
 * user is refused by the user check alone.
 */
const reviewerBinding: ReviewerBinding = {
  resolveReviewer: async ({ userId }) =>
    (userId as unknown as string | undefined) === 'alice' ? null : ('rev-x' as ReviewerId),
  resolveReviewerRole: async ({ userId }) =>
    (userId as unknown as string) === 'bob' ? 'senior' : null,
};

/** Bob's access, as a store would answer it: out of order, with an action the model doesn't have. */
const BOB_ACCESS: MyAccess = {
  tenantMember: true,
  projects: [
    {
      projectId: P2,
      name: 'Zeta',
      role: 'editor',
      via: [
        {
          kind: 'team',
          teamId: 't1',
          teamName: 'Support',
          role: 'editor',
          since: '2026-10-01T00:00:00.000Z',
        },
      ],
    },
    {
      projectId: P1,
      name: 'Alpha',
      role: 'viewer',
      via: [
        // An extra field a store might carry never reaches the answer.
        { kind: 'direct', role: 'viewer', internal: 'x' } as never,
      ],
    },
  ],
  orgs: [{ orgId: 'o1', name: 'Acme', role: 'admin' }],
  teams: [{ teamId: 't1', name: 'Support', role: 'admin' }],
  capabilities: {
    viewer: { agent: ['read'], run: ['read'] },
    runner: { agent: ['read', 'execute'], project: ['run', 'read'] },
    editor: {
      // Out of order, and `teleport` isn't an action: dropped.
      agent: ['publish', 'read', 'execute', 'write', 'teleport' as never],
      project: ['write', 'read'],
    },
  },
};

const ALICE_ACCESS: MyAccess = {
  projects: [{ projectId: P1, name: 'Alpha', role: 'admin', via: [{ kind: 'tenant-admin' }] }],
  orgs: [],
  teams: [],
  capabilities: { admin: { project: ['read', 'write', 'admin'] } },
};

/** A tenant config holding only the console's read-only line, under `under` (or failing to be read). */
function configWith(notice: string | Error | undefined, under = 'default'): EnvBinding {
  return {
    get: async ({ name, envName }: { name: string; envName: string }) => {
      if (notice instanceof Error) throw notice;
      return notice !== undefined && name === 'console.readOnlyNotice' && envName === under
        ? {
            scope: { kind: 'tenant', tenantId },
            envName: under,
            name,
            value: notice,
            revision: 1,
            createdAt: '2026-10-09T00:00:00.000Z',
            updatedAt: '2026-10-09T00:00:00.000Z',
          }
        : null;
    },
  } as unknown as EnvBinding;
}

/** Reads `GET /v1/identity/me/permissions`; `recorded` holds what the authorizer recorded. */
function harness(
  myAccess?: MyAccessBinding,
  envBinding?: EnvBinding,
  envName?: string,
  license?: LicenseStatusBinding,
) {
  const recorded: Decision[] = [];
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: noopRunHandler,
    reviewerBinding,
    ...(envName !== undefined && { envName: envName as EnvName }),
    ...(myAccess !== undefined && { myAccess }),
    ...(envBinding !== undefined && { envBinding }),
    ...(license !== undefined && { license }),
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        ...authzCheckBinding,
        recordDecision: (_principal, _action, _resource, decision) => {
          recorded.push(decision);
        },
      },
    },
  });
  const read = async (
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown>; retryAfter: string | null }> => {
    const res = await app.request('/v1/identity/me/permissions', {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      retryAfter: res.headers.get('retry-after'),
    };
  };
  return Object.assign(read, { recorded });
}

/**
 * Carol views Alpha, which everyone may run as well, and holds no role on
 * Beta, which everyone may run: the store lists both. Gamma comes back
 * with neither a role nor `everyone`, which no store should answer.
 */
const CAROL_ACCESS: MyAccess = {
  projects: [
    { projectId: P3, name: 'Beta', via: [{ kind: 'everyone' }] },
    { projectId: P4, name: 'Gamma', via: [] },
    {
      projectId: P1,
      name: 'Alpha',
      role: 'viewer',
      via: [{ kind: 'direct', role: 'viewer' }, { kind: 'everyone' }],
    },
  ],
  orgs: [],
  teams: [],
  capabilities: { viewer: { project: ['read'] } },
  everyoneCapabilities: {
    // Out of order, and `teleport` isn't an action: dropped.
    flow: ['execute'],
    project: ['run', 'teleport' as never],
    agent: ['execute'],
  },
};

const store: MyAccessBinding = {
  read: async ({ principal }) =>
    principal.kind === 'user' && principal.userId === 'alice'
      ? ALICE_ACCESS
      : principal.kind === 'user' && principal.userId === 'carol'
        ? CAROL_ACCESS
        : BOB_ACCESS,
};

describe('GET /v1/identity/me/permissions', () => {
  test('without the binding: 501 permissions-unsupported, pointing at whoami', async () => {
    const r = await harness()(BOB);
    expect(r.status).toBe(501);
    expect(r.body.error).toMatchObject({ code: 'permissions-unsupported' });
    expect(String((r.body.error as { message: string }).message)).toContain('whoami');
  });

  test('without a token: 401', async () => {
    expect((await harness(store)()).status).toBe(401);
  });

  test("a caller's projects, orgs, teams and reviewer role, in a fixed order", async () => {
    const r = await harness(store)(BOB);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      tenantId,
      tenant: { admin: false, member: true },
      reviewer: { role: 'senior', id: 'rev-x', decides: ['standard', 'senior'], canDecide: true },
      tokenCapabilities: [],
      orgs: [{ orgId: 'o1', name: 'Acme', role: 'admin' }],
      teams: [{ teamId: 't1', name: 'Support', role: 'admin' }],
    });
    expect(r.body.key).toBeUndefined();
    // By name: Alpha, then Zeta. `via` carries only the wire fields.
    expect(r.body.projects).toEqual([
      { projectId: P1, name: 'Alpha', role: 'viewer', via: [{ kind: 'direct', role: 'viewer' }] },
      {
        projectId: P2,
        name: 'Zeta',
        role: 'editor',
        via: [
          {
            kind: 'team',
            teamId: 't1',
            teamName: 'Support',
            role: 'editor',
            since: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    ]);
  });

  test('capabilities: every role and project type, actions in the model order, unknown ones dropped', async () => {
    const caps = (await harness(store)(BOB)).body.capabilities as Record<
      string,
      Record<string, string[]>
    >;
    expect(Object.keys(caps)).toEqual(['owner', 'admin', 'editor', 'runner', 'viewer']);
    expect(Object.keys(caps.editor ?? {})).toEqual([
      'project',
      'agent',
      'flow',
      'tool',
      'guardrail',
      'test_set',
      'trigger',
      'conversation',
      'secret',
      'env',
      'mcp_endpoint',
      'run',
    ]);
    expect(caps.editor?.agent).toEqual(
      OBJECT_ACTIONS.agent.filter((a) => ['read', 'write', 'execute', 'publish'].includes(a)),
    );
    expect(caps.editor?.project).toEqual(['read', 'write']);
    expect(caps.viewer?.run).toEqual(['read']);
    // A runner runs: `run` on the project, after the actions before it.
    expect(caps.runner?.project).toEqual(['read', 'run']);
    // A role the store said nothing about allows nothing.
    expect(caps.owner?.agent).toEqual([]);
  });

  test("a project's check-only actions (`call`, `execute`) are never reported", async () => {
    // The runtime's store reports what the model allows; a project's
    // check-only actions are asked of a project, never listed for a role.
    const reporting: MyAccessBinding = {
      read: async () => ({
        ...ALICE_ACCESS,
        capabilities: {
          admin: {
            project: ['call', 'read', 'execute', 'write', 'admin', 'delete', 'run'] as never,
          },
        },
      }),
    };
    const caps = (await harness(reporting)(ALICE)).body.capabilities as Record<
      string,
      Record<string, string[]>
    >;
    expect(caps.admin?.project).toEqual([...OBJECT_ACTIONS.project]);
    for (const action of CHECK_ONLY_ACTIONS.project ?? []) {
      expect(OBJECT_ACTIONS.project as readonly string[]).not.toContain(action);
      expect(caps.admin?.project).not.toContain(action);
    }
    // The schema lists exactly OBJECT_ACTIONS (role-capabilities-shape.test.ts).
  });

  test('a tenant admin is one', async () => {
    const r = await harness(store)(ALICE);
    expect(r.body.tenant).toEqual({ admin: true });
    expect(r.body.reviewer).toBeUndefined();
  });

  test("a tenant admin's member key isn't one, and says what it is", async () => {
    const r = await harness(store)(ALICE_MEMBER_KEY);
    expect(r.status).toBe(200);
    expect(r.body.tenant).toEqual({ admin: false });
    expect(r.body.key).toEqual({ tokenId: 'k-am', role: 'member', readOnly: false });
    // Below the tenant, the principal's roles hold.
    expect((r.body.projects as { role: string }[])[0]?.role).toBe('admin');
  });

  test('a key limited to a project sees it alone, and administers no org or team', async () => {
    const r = await harness(store)(BOB_PROJECT_KEY);
    expect(r.body.key).toEqual({ tokenId: 'k-bp', role: 'admin', projectId: P1, readOnly: false });
    expect((r.body.projects as { projectId: string }[]).map((p) => p.projectId)).toEqual([P1]);
    expect(r.body.orgs).toEqual([{ orgId: 'o1', name: 'Acme', role: 'member' }]);
    expect(r.body.teams).toEqual([{ teamId: 't1', name: 'Support', role: 'member' }]);
  });

  test("a reviewer role without a user can't decide, and holds no project", async () => {
    const r = await harness(store)(ROLE_ONLY);
    expect(r.body.reviewer).toEqual({
      role: 'admin',
      decides: ['standard', 'senior', 'admin'],
      canDecide: false,
    });
    expect(r.body.projects).toEqual([]);
  });

  test("the token's capabilities, sorted", async () => {
    const r = await harness(store)(DEPLOYMENT);
    expect(r.body.tokenCapabilities).toEqual(['env:write', 'kindgi:system', 'secrets:write']);
  });

  describe("the console's read-only line, from the tenant config", () => {
    const READ_ONLY = "You're looking at Kindgi's own workspace, read-only.";

    test('served to every caller, as a tenant admin set it', async () => {
      const r = await harness(store, configWith(READ_ONLY))(BOB);
      expect(r.body.readOnlyNotice).toBe(READ_ONLY);
    });

    test('a tenant setting: read under `default`, whatever env the runtime serves', async () => {
      // Set before the runtime served `prod`, under `default`: it still shows.
      expect((await harness(store, configWith(READ_ONLY), 'prod')(BOB)).body).toEqual(
        expect.objectContaining({ readOnlyNotice: READ_ONLY }),
      );
      // Under the served env: not where a setting lives.
      expect(
        (await harness(store, configWith(READ_ONLY, 'prod'), 'prod')(BOB)).body.readOnlyNotice,
      ).toBeUndefined();
    });

    test('absent when none is set, or with no tenant config', async () => {
      expect(
        (await harness(store, configWith(undefined))(BOB)).body.readOnlyNotice,
      ).toBeUndefined();
      expect((await harness(store)(BOB)).body.readOnlyNotice).toBeUndefined();
      expect((await harness(store, configWith('  \n '))(BOB)).body.readOnlyNotice).toBeUndefined();
    });

    test('one line, cut at 280 characters', async () => {
      expect(
        (await harness(store, configWith('Read-only\n  here. '))(BOB)).body.readOnlyNotice,
      ).toBe('Read-only here.');
      const long = (await harness(store, configWith('x'.repeat(400)))(BOB)).body.readOnlyNotice;
      expect(long).toBe(`${'x'.repeat(279)}…`);
      // 280 code points of emoji (560 UTF-16 units): cut whole, never mid-pair.
      const emoji = (await harness(store, configWith('🔒'.repeat(300)))(BOB)).body.readOnlyNotice;
      expect(emoji).toBe(`${'🔒'.repeat(279)}…`);
      expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });

    test("a config that can't be read leaves it out; the permissions still answer", async () => {
      const r = await harness(store, configWith(new Error('env down')))(BOB);
      expect(r.status).toBe(200);
      expect(r.body.readOnlyNotice).toBeUndefined();
      expect(r.body.projects).toHaveLength(2);
    });
  });

  test("a store that can't be read: 503 authz-backend-unavailable, with Retry-After", async () => {
    const r = await harness({
      read: async () => {
        throw new Error('fga down');
      },
    })(BOB);
    expect(r.status).toBe(503);
    expect(r.retryAfter).toBe('5');
    expect(r.body.error).toMatchObject({ code: 'authz-backend-unavailable' });
    expect(JSON.stringify(r.body)).not.toContain('fga down');
  });

  describe('a project everyone in the workspace may run', () => {
    test('one reached only that way: in everyoneCanRunProjects; every one in `projects` keeps its role', async () => {
      const r = await harness(store)(CAROL);
      expect(r.status).toBe(200);
      expect(r.body.projects).toEqual([
        {
          projectId: P1,
          name: 'Alpha',
          role: 'viewer',
          via: [{ kind: 'direct', role: 'viewer' }, { kind: 'everyone' }],
        },
      ]);
      expect(r.body.everyoneCanRunProjects).toEqual([{ projectId: P3, name: 'Beta' }]);
    });

    test('one with neither a role nor `everyone` is in neither list', async () => {
      const body = JSON.stringify((await harness(store)(CAROL)).body);
      expect(body).not.toContain(P4);
      expect(body).not.toContain('Gamma');
    });

    test('everyoneCapabilities: every project type, actions in the model order, unknown ones dropped', async () => {
      const body = (await harness(store)(CAROL)).body as {
        capabilities: Record<string, Record<string, string[]>>;
        everyoneCapabilities: Record<string, string[]>;
      };
      const caps = body.everyoneCapabilities;
      // The types a role's capabilities list, in the same order.
      expect(Object.keys(caps)).toEqual(Object.keys(body.capabilities.viewer ?? {}));
      expect(Object.keys(caps)).toContain('trigger');
      expect(caps.project).toEqual(['run']);
      expect(caps.agent).toEqual(OBJECT_ACTIONS.agent.filter((a) => a === 'execute'));
      expect(caps.flow).toEqual(OBJECT_ACTIONS.flow.filter((a) => a === 'execute'));
      expect(caps.run).toEqual([]);
    });

    test('absent where the store says nothing of it, as an older server', async () => {
      const r = await harness(store)(BOB);
      expect(r.status).toBe(200);
      expect('everyoneCapabilities' in r.body).toBe(false);
      expect('everyoneCanRunProjects' in r.body).toBe(false);
    });

    test('a key limited to a project everyone may run lists that project alone', async () => {
      const r = await harness(store)(CAROL_P3_KEY);
      expect(r.status).toBe(200);
      expect(r.body.key).toEqual({
        tokenId: 'k-cp',
        role: 'member',
        projectId: P3,
        readOnly: false,
      });
      expect(r.body.projects).toEqual([]);
      expect(r.body.everyoneCanRunProjects).toEqual([{ projectId: P3, name: 'Beta' }]);
    });

    test('a key that only reads runs none: no project is listed as one everyone may run', async () => {
      const r = await harness(store)(CAROL_READ_KEY);
      expect(r.status).toBe(200);
      expect(r.body.key).toEqual({ tokenId: 'k-cr', role: 'member', readOnly: true });
      expect(r.body.projects.length).toBeGreaterThan(0);
      expect(r.body.projects.every((p: { role: string }) => p.role === 'viewer')).toBe(true);
      expect('everyoneCanRunProjects' in r.body).toBe(false);
    });
  });
});

describe('licenseOperatorOnly: whether GET /v1/license refuses the caller whatever its role', () => {
  const status = () => ({ mode: 'development' as const });
  const OTHER_TENANT = randomUUID() as TenantId;

  test('a deployment serving several tenants: true for its tenant admin, and nothing recorded', async () => {
    const read = harness(store, undefined, undefined, { status, soleTenant: () => null });
    const answer = await read(ALICE);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ tenant: { admin: true }, licenseOperatorOnly: true });
    expect(read.recorded).toEqual([]);
  });

  test("a deployment that doesn't say it serves one tenant: true", async () => {
    const read = harness(store, undefined, undefined, { status });
    expect((await read(ALICE)).body.licenseOperatorOnly).toBe(true);
  });

  test('a deployment serving another tenant alone: true', async () => {
    const read = harness(store, undefined, undefined, { status, soleTenant: () => OTHER_TENANT });
    expect((await read(ALICE)).body.licenseOperatorOnly).toBe(true);
  });

  test('the one tenant the deployment serves: false, for its admin and its other callers alike', async () => {
    const read = harness(store, undefined, undefined, { status, soleTenant: async () => tenantId });
    expect((await read(ALICE)).body).toMatchObject({
      tenant: { admin: true },
      licenseOperatorOnly: false,
    });
    expect((await read(BOB)).body).toMatchObject({
      tenant: { admin: false },
      licenseOperatorOnly: false,
    });
  });

  test("the deployment's own token: false, even where the deployment serves several tenants", async () => {
    const read = harness(store, undefined, undefined, { status, soleTenant: () => null });
    expect((await read(DEPLOYMENT)).body.licenseOperatorOnly).toBe(false);
  });

  test('no license: absent', async () => {
    const answer = await harness(store)(ALICE);
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty('licenseOperatorOnly');
  });

  test("tenants that can't be read: absent, and the rest of the answer as ever", async () => {
    const read = harness(store, undefined, undefined, {
      status,
      soleTenant: async () => {
        throw new Error('connection refused');
      },
    });
    const answer = await read(ALICE);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ tenantId, tenant: { admin: true } });
    expect(answer.body).not.toHaveProperty('licenseOperatorOnly');
  });
});
