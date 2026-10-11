// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * The reviewer roster names people, so with authorization on only those
 * who decide approvals read it: a tenant admin, or a reviewer. A
 * project's viewer (or a key that takes no admin action) is refused, and
 * the refusal is recorded as the access audit records every refusal.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  ReviewerBinding,
  ReviewerRegistryBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const projectA = randomUUID();
const ADMIN = 'admin-token';
const VIEWER = 'viewer-token';
const REVIEWER = 'reviewer-token';
const ADMIN_MEMBER_KEY = 'admin-member-key';

const resolveToken: TokenResolver = async (token) => {
  if (token === ADMIN) return { tenantId, userId: 'admin-1' as UserId };
  if (token === VIEWER) return { tenantId, userId: 'viewer-1' as UserId };
  if (token === REVIEWER) return { tenantId, userId: 'rev-1' as UserId };
  if (token === ADMIN_MEMBER_KEY) {
    return {
      tenantId,
      userId: 'admin-1' as UserId,
      tokenId: 'key-1' as never,
      tokenRole: 'member',
    };
  }
  return null;
};

/** `action type:id` pairs each user holds. */
const GRANTS: Readonly<Record<string, readonly string[]>> = {
  'admin-1': [`admin tenant:${tenantId}`, `read tenant:${tenantId}`],
  'viewer-1': [`read tenant:${tenantId}`, `read project:${projectA}`],
  'rev-1': [`read tenant:${tenantId}`],
};

interface Recorded {
  readonly action: Action;
  readonly resource: string;
  readonly decision: Decision;
  readonly correlationId: string | undefined;
}

function harness() {
  const recorded: Recorded[] = [];
  const decide = (principal: unknown, action: Action, r: ResourceRef): Decision => {
    const who = (principal as { actor: { id: string } }).actor.id;
    const allowed = (GRANTS[who] ?? []).includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (p, action, r) => decide(p, action, r),
    checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
    recordDecision: (_p, action, r, decision, ctx) => {
      recorded.push({
        action,
        resource: `${r.type}:${r.id}`,
        decision,
        correlationId: ctx?.correlationId,
      });
    },
  };
  const reviewerRegistry: ReviewerRegistryBinding = {
    list: async () => ({
      data: [
        {
          id: 'r-1' as never,
          tenantId,
          userId: 'rev-1' as UserId,
          role: 'standard',
          displayName: 'Rae Viewer-of-approvals',
          createdAt: '2026-10-01T00:00:00.000Z' as never,
        },
      ],
    }),
    get: async () => null,
    register: async () => ({ kind: 'ok', reviewer: {} as never }),
    unregister: async () => ({ unregistered: false }),
  };
  const reviewerBinding: ReviewerBinding = {
    resolveReviewer: async () => null,
    resolveReviewerRole: async ({ userId }) => (userId === 'rev-1' ? 'standard' : null),
  };
  const app = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerRegistry,
    reviewerBinding,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  const call = async (
    token: string,
    method = 'GET',
    path = '/v1/approvals/reviewers',
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, recorded };
}

describe('who reads the reviewer roster', () => {
  test('a tenant admin reads it', async () => {
    const h = harness();
    const res = await h.call(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { userId: string }) => r.userId)).toEqual(['rev-1']);
  });

  test('a reviewer reads it', async () => {
    const h = harness();
    expect((await h.call(REVIEWER)).status).toBe(200);
  });

  test("a project's viewer is refused, the list and one entry alike, and each refusal is recorded", async () => {
    const h = harness();
    for (const path of ['/v1/approvals/reviewers', `/v1/approvals/reviewers/${randomUUID()}`]) {
      const res = await h.call(VIEWER, 'GET', path);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('permission-denied');
      expect(JSON.stringify(res.body)).not.toContain('Rae');
      const requestId = res.body.error.requestId;
      expect(
        h.recorded.some(
          (r) =>
            r.correlationId === requestId &&
            r.action === 'read' &&
            r.resource === `tenant:${tenantId}` &&
            r.decision.failing === 'actor',
        ),
        path,
      ).toBe(true);
    }
  });

  test("an admin's key that takes no admin action is refused too (the key decides, not the user)", async () => {
    const h = harness();
    const res = await h.call(ADMIN_MEMBER_KEY);
    expect(res.status).toBe(403);
    expect(
      h.recorded.filter((r) => r.correlationId === res.body.error.requestId).length,
    ).toBeGreaterThan(0);
  });

  test('registering still needs a tenant admin', async () => {
    const h = harness();
    expect(
      (
        await h.call(VIEWER, 'POST', '/v1/approvals/reviewers', {
          userId: 'viewer-1',
          role: 'standard',
        })
      ).status,
    ).toBe(403);
  });
});
