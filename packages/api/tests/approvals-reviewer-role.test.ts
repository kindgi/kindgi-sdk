// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who may use the approvals surface: a reviewer, whether the token says
 * so (`TokenResolution.reviewerRole`) or the reviewer roster does for the
 * token's user (`ReviewerBinding.resolveReviewerRole`): a session or an
 * API key of a registered reviewer. A caller that is neither gets 403;
 * `whoami` reports the role the approvals routes would use.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type {
  Approval,
  HitlBinding,
  ReviewerBinding,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const REVIEWER_USER = 'user-reviewer' as UserId;
const OTHER_USER = 'user-other' as UserId;

/** Tokens: a session of a registered reviewer, one of a user who isn't, one with no user, one that carries its role. */
const resolveToken: TokenResolver = async (token) => {
  if (token === 'session-reviewer') return { tenantId, userId: REVIEWER_USER };
  if (token === 'session-other') return { tenantId, userId: OTHER_USER };
  if (token === 'no-user') return { tenantId };
  if (token === 'carries-role') return { tenantId, userId: OTHER_USER, reviewerRole: 'admin' };
  return null;
};

const approval = (id: string, requiredRole: 'standard' | 'senior' | 'admin'): Approval =>
  ({
    id,
    tenantId,
    subjectKind: 'tool-call:pending',
    subjectRef: {},
    requiredRole,
    status: 'pending',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  }) as unknown as Approval;

function app() {
  const lookups: UserId[] = [];
  const reviewerBinding: ReviewerBinding = {
    resolveReviewer: async () => null,
    resolveReviewerRole: async ({ userId }) => {
      lookups.push(userId);
      return userId === REVIEWER_USER ? 'senior' : null;
    },
  };
  const hitlBinding = {
    getApproval: async () => ({ kind: 'ok', value: approval('appr-std', 'standard') }),
    listApprovals: async () => ({
      kind: 'ok',
      value: {
        approvals: [
          approval('appr-std', 'standard'),
          approval('appr-senior', 'senior'),
          approval('appr-admin', 'admin'),
        ],
      },
    }),
    submitReview: async () => ({ kind: 'err', error: { code: 'invalid-transition', message: '' } }),
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  const created = createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding,
    hitlBinding,
  });
  return { app: created, lookups };
}

async function get(h: ReturnType<typeof app>, path: string, token: string) {
  const res = await h.app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('the approvals surface, for a reviewer the roster names', () => {
  test("a registered reviewer's session lists the approvals of its role", async () => {
    const h = app();
    const answer = await get(h, '/v1/approvals', 'session-reviewer');
    expect(answer.status).toBe(200);
    expect((answer.json.data as { id: string }[]).map((a) => a.id)).toEqual([
      'appr-std',
      'appr-senior',
    ]);
    expect(h.lookups).toEqual([REVIEWER_USER]);
  });

  test("a user who isn't a reviewer, and a token with no user, are refused", async () => {
    const h = app();
    for (const token of ['session-other', 'no-user']) {
      const answer = await get(h, '/v1/approvals', token);
      expect(answer.status).toBe(403);
      expect(answer.json.error).toMatchObject({ code: 'permission-denied' });
    }
    // A token with no user has no roster entry to look up.
    expect(h.lookups).toEqual([OTHER_USER]);
  });

  test('a token that carries its role keeps it; the roster is not consulted', async () => {
    const h = app();
    const answer = await get(h, '/v1/approvals', 'carries-role');
    expect(answer.status).toBe(200);
    expect((answer.json.data as unknown[]).length).toBe(3);
    expect(h.lookups).toEqual([]);
  });

  test('a binding without the roster lookup: only a token that carries its role reviews', async () => {
    const h = app();
    const plain = createApp({
      ...createStubAppBindings(),
      resolveToken,
      runHandler: {} as RunHandlerBinding,
      reviewerBinding: { resolveReviewer: async () => null },
      hitlBinding: {
        listApprovals: async () => ({ kind: 'ok', value: { approvals: [] } }),
      } as unknown as HitlBinding,
    });
    const status = async (token: string) =>
      (await plain.request('/v1/approvals', { headers: { authorization: `Bearer ${token}` } }))
        .status;
    expect(await status('session-reviewer')).toBe(403);
    expect(await status('carries-role')).toBe(200);
    expect(h.lookups).toEqual([]);
  });

  test('whoami reports the role the approvals routes use', async () => {
    const h = app();
    expect((await get(h, '/v1/identity/whoami', 'session-reviewer')).json).toMatchObject({
      userId: REVIEWER_USER,
      reviewerRole: 'senior',
    });
    expect((await get(h, '/v1/identity/whoami', 'session-other')).json).not.toHaveProperty(
      'reviewerRole',
    );
  });
});
