// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tenant admin reads approvals at every tier: with authorization on, a
 * person who is the tenant's admin lists and gets approvals. With no roster
 * entry, they read as an `admin` reviewer. A reviewer below `admin` who is
 * one reads their own tier, and any tier they ask for. It's the set that may
 * register itself as an `admin` reviewer. The project filter still applies,
 * deciding stays the roster's, and an API key reads as its user does, within
 * its own limits. The tenant-admin check goes through the authorization
 * binding with the request's id, so a binding that records its checks
 * records it; it's made only where it changes what the roster gives, so a
 * reviewer reading their own tier records none.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type {
  Action,
  AuthzCheckBinding,
  AuthzCheckContext,
  Decision,
  Principal,
  ResourceRef,
} from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { OPERATIONS, createApp } from '../src/index.js';
import type {
  Approval,
  HitlBinding,
  ReviewerBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const ADMIN = 'user-admin' as UserId;
const ADMIN_STANDARD = 'user-admin-standard' as UserId;
const ADMIN_REVIEWER = 'user-admin-reviewer' as UserId;
const STANDARD = 'user-standard' as UserId;
const MEMBER = 'user-member' as UserId;
const KEY = 'key-no-user';
const MINE = randomUUID();
const THEIRS = randomUUID();

const resolveToken: TokenResolver = async (token) => {
  if (token === 'admin') return { tenantId, userId: ADMIN };
  if (token === 'admin-standard') return { tenantId, userId: ADMIN_STANDARD };
  if (token === 'admin-reviewer') return { tenantId, userId: ADMIN_REVIEWER };
  if (token === 'standard') return { tenantId, userId: STANDARD };
  if (token === 'member') return { tenantId, userId: MEMBER };
  if (token === 'key') return { tenantId, tokenId: KEY as never };
  // The tenant admin's own API keys: an admin one, a member one, one limited to a project.
  if (token === 'admin-key') {
    return { tenantId, userId: ADMIN, tokenId: 'key-a' as never, tokenRole: 'admin' };
  }
  if (token === 'admin-member-key') {
    return { tenantId, userId: ADMIN, tokenId: 'key-m' as never, tokenRole: 'member' };
  }
  if (token === 'admin-project-key') {
    return {
      tenantId,
      userId: ADMIN,
      tokenId: 'key-p' as never,
      tokenRole: 'admin',
      tokenProjectId: MINE,
    };
  }
  return null;
};

/** Who is the tenant's admin, by the binding: every caller but the member and the standard reviewer. */
const TENANT_ADMINS = new Set<string>([ADMIN, ADMIN_STANDARD, ADMIN_REVIEWER, KEY]);

function approval(id: string, requiredRole: Approval['requiredRole'], projectId: string): Approval {
  return {
    id,
    tenantId,
    projectId,
    subjectKind: 'tool-call:pending',
    subjectRef: {},
    requiredRole,
    status: 'pending',
    createdAt: '2026-10-14T08:00:00.000Z',
    updatedAt: '2026-10-14T08:00:00.000Z',
  } as unknown as Approval;
}
const APPROVALS = [
  approval('appr-standard', 'standard', MINE),
  approval('appr-admin', 'admin', MINE),
  approval('appr-theirs', 'standard', THEIRS),
];

interface Check {
  readonly actor: string;
  readonly action: Action;
  readonly resource: string;
  readonly allowed: boolean;
  readonly correlationId: string | undefined;
}

function harness() {
  const checks: Check[] = [];
  const recorded: Check[] = [];
  const decide = (p: Principal, action: Action, r: ResourceRef): Decision => {
    const allowed =
      action === 'admin'
        ? r.type === 'tenant' && TENANT_ADMINS.has(p.actor.id)
        : action === 'read' && r.type === 'project' && r.id === MINE;
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const entry = (
    p: Principal,
    action: Action,
    r: ResourceRef,
    allowed: boolean,
    ctx?: AuthzCheckContext,
  ): Check => ({
    actor: p.actor.id,
    action,
    resource: `${r.type}:${r.id}`,
    allowed,
    correlationId: ctx?.correlationId,
  });
  const binding: AuthzCheckBinding = {
    check: async (p, action, r, ctx) => {
      const d = decide(p, action, r);
      checks.push(entry(p, action, r, d.allowed, ctx));
      return d;
    },
    checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
    recordDecision: (p, action, r, d, ctx) => {
      recorded.push(entry(p, action, r, d.allowed, ctx));
    },
  };
  const reviewerBinding: ReviewerBinding = {
    resolveReviewer: async () => null,
    resolveReviewerRole: async ({ userId }) =>
      userId === ADMIN_STANDARD || userId === STANDARD
        ? 'standard'
        : userId === ADMIN_REVIEWER
          ? 'admin'
          : null,
  };
  const hitlBinding = {
    listApprovals: async (input: { requiredRole?: Approval['requiredRole'] }) => ({
      kind: 'ok',
      value: {
        approvals: APPROVALS.filter(
          (a) => input.requiredRole === undefined || a.requiredRole === input.requiredRole,
        ),
      },
    }),
    getApproval: async (_t: TenantId, id: string) => {
      const found = APPROVALS.find((a) => a.id === id);
      return found === undefined
        ? { kind: 'err', error: { code: 'approval-not-found', message: 'x' } }
        : { kind: 'ok', value: found };
    },
  } as unknown as HitlBinding;
  const app = createApp({
    ...createStubAppBindings(),
    hitlBinding,
    reviewerBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding: binding },
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      requestId: res.headers.get('x-request-id'),
      json: (await res.json()) as Record<string, unknown>,
    };
  };
  const ids = (json: Record<string, unknown>) => (json.data as { id: string }[]).map((a) => a.id);
  /** The tenant-admin checks the binding was asked, by whom, with what answer and which request's id. */
  const adminChecks = () => checks.filter((c) => c.action === 'admin');
  /** The tenant-admin refusals decided before the binding (an API key's limits), as recorded. */
  const adminRefusalsRecorded = () => recorded.filter((c) => c.action === 'admin');
  return { call, ids, adminChecks, adminRefusalsRecorded };
}

describe('a person who is the tenant admin, with no roster entry, reads as an admin reviewer', () => {
  test('the list: every tier, in the projects it may read', async () => {
    const h = harness();
    const answer = await h.call('admin', 'GET', '/v1/approvals');
    expect(answer.status).toBe(200);
    expect(h.ids(answer.json)).toEqual(['appr-standard', 'appr-admin']);
  });

  test("one approval: an admin-tier one is found; another project's is not", async () => {
    const h = harness();
    expect((await h.call('admin', 'GET', '/v1/approvals/appr-admin')).status).toBe(200);
    const theirs = await h.call('admin', 'GET', '/v1/approvals/appr-theirs');
    expect(theirs.status).toBe(404);
    expect(theirs.json.error).toMatchObject({ code: 'approval-not-found' });
  });

  test('the admin tier may be asked for', async () => {
    const h = harness();
    const answer = await h.call('admin', 'GET', '/v1/approvals?requiredRole=admin');
    expect(answer.status).toBe(200);
    expect(h.ids(answer.json)).toEqual(['appr-admin']);
  });

  test("the read's tenant-admin check goes through the binding once, with the request's id", async () => {
    const h = harness();
    const answer = await h.call('admin', 'GET', '/v1/approvals');
    expect(h.adminChecks()).toEqual([
      {
        actor: ADMIN,
        action: 'admin',
        resource: `tenant:${tenantId}`,
        allowed: true,
        correlationId: answer.requestId,
      },
    ]);
  });

  test("it can't decide, or sign an audit bundle: those stay the roster's", async () => {
    const h = harness();
    for (const [path, body] of [
      ['/v1/approvals/appr-standard/complete', { decision: 'approve' }],
      ['/v1/approvals/appr-standard/audit-bundle', {}],
    ] as const) {
      const answer = await h.call('admin', 'POST', path, body);
      expect(answer.status, path).toBe(403);
      expect(answer.json.error, path).toMatchObject({ code: 'permission-denied' });
    }
    // A write makes no tenant-admin check.
    expect(h.adminChecks()).toEqual([]);
  });

  test('its admin API key reads as it does', async () => {
    const h = harness();
    const answer = await h.call('admin-key', 'GET', '/v1/approvals');
    expect(answer.status).toBe(200);
    expect(h.ids(answer.json)).toEqual(['appr-standard', 'appr-admin']);
  });
});

describe('a reviewer below admin', () => {
  test('who is the tenant admin: its own tier, listed or one approval, with no tenant-admin check', async () => {
    const h = harness();
    const answer = await h.call('admin-standard', 'GET', '/v1/approvals');
    expect(h.ids(answer.json)).toEqual(['appr-standard']);
    expect((await h.call('admin-standard', 'GET', '/v1/approvals/appr-standard')).status).toBe(200);
    expect(h.adminChecks()).toEqual([]);
  });

  test('who is the tenant admin: any tier it asks for, one check each time', async () => {
    const h = harness();
    const listed = await h.call('admin-standard', 'GET', '/v1/approvals?requiredRole=admin');
    expect(listed.status).toBe(200);
    expect(h.ids(listed.json)).toEqual(['appr-admin']);
    const got = await h.call('admin-standard', 'GET', '/v1/approvals/appr-admin');
    expect(got.status).toBe(200);
    expect(h.adminChecks().map((c) => [c.actor, c.allowed])).toEqual([
      [ADMIN_STANDARD, true],
      [ADMIN_STANDARD, true],
    ]);
  });

  test("who isn't the tenant admin: its own tier, listed or one approval, and nothing recorded for reading it", async () => {
    const h = harness();
    const answer = await h.call('standard', 'GET', '/v1/approvals');
    expect(h.ids(answer.json)).toEqual(['appr-standard']);
    expect((await h.call('standard', 'GET', '/v1/approvals/appr-standard')).status).toBe(200);
    expect(h.adminChecks()).toEqual([]);
  });

  test("who isn't the tenant admin: answered as before, a 403 for the tier and a 404 for one approval", async () => {
    const h = harness();
    const listed = await h.call('standard', 'GET', '/v1/approvals?requiredRole=admin');
    expect(listed.status).toBe(403);
    expect(listed.json.error).toMatchObject({
      code: 'permission-denied',
      message: 'Role standard cannot query approvals scoped to admin.',
    });
    // Not found, as one in another project: nothing says it exists.
    const got = await h.call('standard', 'GET', '/v1/approvals/appr-admin');
    expect(got.status).toBe(404);
    expect(got.json.error).toMatchObject({ code: 'approval-not-found' });
    expect(h.adminChecks().map((c) => [c.actor, c.allowed])).toEqual([
      [STANDARD, false],
      [STANDARD, false],
    ]);
  });

  test('an admin reviewer reads as it did: no tenant-admin check', async () => {
    const h = harness();
    const answer = await h.call('admin-reviewer', 'GET', '/v1/approvals');
    expect(h.ids(answer.json)).toEqual(['appr-standard', 'appr-admin']);
    expect((await h.call('admin-reviewer', 'GET', '/v1/approvals/appr-admin')).status).toBe(200);
    expect(h.adminChecks()).toEqual([]);
  });
});

describe('the reads it opens', () => {
  test('are the list and one approval: any other GET under /v1/approvals must decide', () => {
    const gets = OPERATIONS.filter(
      (op) =>
        op.method === 'get' &&
        op.openapiPath.startsWith('/v1/approvals') &&
        !op.openapiPath.startsWith('/v1/approvals/reviewers'),
    ).map((op) => op.openapiPath);
    expect(gets.sort()).toEqual(['/v1/approvals', '/v1/approvals/{approvalId}']);
  });
});

describe('who still reads nothing', () => {
  test('an API key with no user, even an admin one: refused, with no tenant-admin check', async () => {
    const h = harness();
    for (const path of ['/v1/approvals', '/v1/approvals/appr-standard']) {
      const answer = await h.call('key', 'GET', path);
      expect(answer.status, path).toBe(403);
      expect(answer.json.error, path).toMatchObject({ code: 'permission-denied' });
    }
    expect(h.adminChecks()).toEqual([]);
  });

  test("the tenant admin's member key, and its key limited to a project: refused by the key's own limits", async () => {
    const h = harness();
    for (const token of ['admin-member-key', 'admin-project-key']) {
      const answer = await h.call(token, 'GET', '/v1/approvals');
      expect(answer.status, token).toBe(403);
      expect(answer.json.error, token).toMatchObject({ code: 'permission-denied' });
    }
    // The key's limit decides it before the binding is asked, and is recorded.
    expect(h.adminChecks()).toEqual([]);
    expect(h.adminRefusalsRecorded().map((c) => [c.actor, c.allowed])).toEqual([
      [ADMIN, false],
      [ADMIN, false],
    ]);
  });

  test("a person who isn't the tenant admin, or a reviewer: refused", async () => {
    const h = harness();
    const answer = await h.call('member', 'GET', '/v1/approvals');
    expect(answer.status).toBe(403);
    expect(answer.json.error).toMatchObject({ code: 'permission-denied' });
  });
});
