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

import { type AuthzCheckBinding, type Decision, OBJECT_ACTIONS } from '@kindgi/authz';
import type { ApiTokenId, ReviewerId, TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  MyAccess,
  MyAccessBinding,
  ReviewerBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const P1 = '00000000-0000-4000-8000-0000000000b1';
const P2 = '00000000-0000-4000-8000-0000000000b2';

const ALICE = 'tok-alice'; // a tenant admin
const BOB = 'tok-bob'; // a project editor through a team, a senior reviewer
const ALICE_MEMBER_KEY = 'kgi_ak_alice-member';
const BOB_PROJECT_KEY = 'kgi_ak_bob-p1';
const ROLE_ONLY = 'tok-role-only'; // carries a reviewer role, no user
const DEPLOYMENT = 'tok-deployment'; // the deployment's own token, with capabilities

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

function harness(myAccess?: MyAccessBinding) {
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: noopRunHandler,
    reviewerBinding,
    ...(myAccess !== undefined && { myAccess }),
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  return async (token?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await app.request('/v1/identity/me/permissions', {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

const store: MyAccessBinding = {
  read: async ({ principal }) =>
    principal.kind === 'user' && principal.userId === 'alice' ? ALICE_ACCESS : BOB_ACCESS,
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
      reviewer: { role: 'senior', decides: ['standard', 'senior'], canDecide: true },
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
    expect(Object.keys(caps)).toEqual(['owner', 'admin', 'editor', 'viewer']);
    expect(Object.keys(caps.editor ?? {})).toEqual([
      'project',
      'agent',
      'flow',
      'tool',
      'guardrail',
      'eval_suite',
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
    // A role the store said nothing about allows nothing.
    expect(caps.owner?.agent).toEqual([]);
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
    expect(r.body.key).toEqual({ tokenId: 'k-am', role: 'member' });
    // Below the tenant, the principal's roles hold.
    expect((r.body.projects as { role: string }[])[0]?.role).toBe('admin');
  });

  test('a key limited to a project sees it alone, and administers no org or team', async () => {
    const r = await harness(store)(BOB_PROJECT_KEY);
    expect(r.body.key).toEqual({ tokenId: 'k-bp', role: 'admin', projectId: P1 });
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

  test("a store that can't be read: 503 authz-backend-unavailable", async () => {
    const r = await harness({
      read: async () => {
        throw new Error('fga down');
      },
    })(BOB);
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: 'authz-backend-unavailable' });
    expect(JSON.stringify(r.body)).not.toContain('fga down');
  });
});
