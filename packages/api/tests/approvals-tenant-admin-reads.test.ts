// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A tenant admin reads approvals: with authorization on, a person who is
 * the tenant's admin lists and gets approvals as an `admin` reviewer, with
 * no roster entry. It's the set that may register itself as one. The
 * project filter still applies, deciding stays the roster's, and an API
 * key with no user reads nothing it couldn't before. The tenant-admin
 * check goes through the authorization binding with the request's id, as
 * every check does, so a binding that records its checks records it.
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

import { createApp } from '../src/index.js';
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
const MEMBER = 'user-member' as UserId;
const KEY = 'key-admin';
const MINE = randomUUID();
const THEIRS = randomUUID();

const resolveToken: TokenResolver = async (token) => {
  if (token === 'admin') return { tenantId, userId: ADMIN };
  if (token === 'admin-standard') return { tenantId, userId: ADMIN_STANDARD };
  if (token === 'admin-reviewer') return { tenantId, userId: ADMIN_REVIEWER };
  if (token === 'member') return { tenantId, userId: MEMBER };
  if (token === 'key') return { tenantId, tokenId: KEY as never };
  return null;
};

/** Who is the tenant's admin: every caller but the member. */
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
  readonly correlationId: string | undefined;
}

function harness() {
  const checks: Check[] = [];
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
  const binding: AuthzCheckBinding = {
    check: async (p, action, r, ctx?: AuthzCheckContext) => {
      checks.push({
        actor: p.actor.id,
        action,
        resource: `${r.type}:${r.id}`,
        correlationId: ctx?.correlationId,
      });
      return decide(p, action, r);
    },
    checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
  };
  const reviewerBinding: ReviewerBinding = {
    resolveReviewer: async () => null,
    resolveReviewerRole: async ({ userId }) =>
      userId === ADMIN_STANDARD ? 'standard' : userId === ADMIN_REVIEWER ? 'admin' : null,
  };
  const hitlBinding = {
    listApprovals: async () => ({ kind: 'ok', value: { approvals: APPROVALS } }),
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
  /** The tenant-admin checks made, by whom and with which request's id. */
  const adminChecks = () => checks.filter((c) => c.action === 'admin');
  return { call, ids, adminChecks };
}

describe('a person who is the tenant admin reads approvals as an admin reviewer', () => {
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
  });

  test("the read's tenant-admin check goes through the binding, with the request's id", async () => {
    const h = harness();
    const answer = await h.call('admin', 'GET', '/v1/approvals');
    expect(h.adminChecks()).toEqual([
      {
        actor: ADMIN,
        action: 'admin',
        resource: `tenant:${tenantId}`,
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

  test('a reviewer below admin who is the tenant admin reads every tier too', async () => {
    const h = harness();
    const answer = await h.call('admin-standard', 'GET', '/v1/approvals');
    expect(h.ids(answer.json)).toEqual(['appr-standard', 'appr-admin']);
  });

  test('an admin reviewer reads as it did: no tenant-admin check', async () => {
    const h = harness();
    const answer = await h.call('admin-reviewer', 'GET', '/v1/approvals');
    expect(h.ids(answer.json)).toEqual(['appr-standard', 'appr-admin']);
    expect(h.adminChecks()).toEqual([]);
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

  test("a person who isn't the tenant admin, or a reviewer: refused", async () => {
    const h = harness();
    const answer = await h.call('member', 'GET', '/v1/approvals');
    expect(answer.status).toBe(403);
    expect(answer.json.error).toMatchObject({ code: 'permission-denied' });
  });
});
