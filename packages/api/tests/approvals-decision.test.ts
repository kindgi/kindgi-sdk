// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An approval says who decided it: `GET /v1/approvals/:id` and the list
 * carry the recorded decision (what, why, and who, as `decidedBy`). An
 * open approval, or one that ended without a decision, has none.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { Approval, HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'approvals-decision-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

const approval = (id: string, extra: Partial<Approval> = {}): Approval =>
  ({
    id,
    tenantId,
    subjectKind: 'tool-call:pending',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    ...extra,
  }) as unknown as Approval;

const rejected = approval('appr-rejected', {
  status: 'rejected',
  decidedAt: '2026-10-05T00:01:00.000Z',
  decision: {
    decision: 'reject',
    decidedBy: 'user:u-7',
    reviewerId: 'rev-7',
    reviewerRoleAtDecision: 'senior',
    decidedAt: '2026-10-05T00:01:00.000Z',
    rationale: 'not this refund',
  },
} as unknown as Partial<Approval>);
const expired = approval('appr-expired', {
  status: 'expired',
  decidedAt: '2026-10-05T00:02:00.000Z',
} as unknown as Partial<Approval>);
const open = approval('appr-open');
/** From a binding that doesn't record who decided. */
const undecidedBy = approval('appr-no-decider', {
  status: 'approved',
  decidedAt: '2026-10-05T00:03:00.000Z',
  decision: {
    decision: 'approve',
    reviewerId: 'rev-8',
    reviewerRoleAtDecision: 'standard',
    decidedAt: '2026-10-05T00:03:00.000Z',
  },
} as unknown as Partial<Approval>);

function app() {
  const all = [rejected, expired, open, undecidedBy];
  const hitlBinding = {
    getApproval: async (_t: TenantId, id: string) => {
      const found = all.find((a) => (a.id as unknown as string) === id);
      return found === undefined
        ? { kind: 'err', error: { code: 'approval-not-found', message: 'none' } }
        : { kind: 'ok', value: found };
    },
    listApprovals: async () => ({ kind: 'ok', value: { approvals: all } }),
    submitReview: async () => ({ kind: 'err', error: { code: 'invalid-transition', message: '' } }),
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  return createApp({
    ...createStubAppBindings(),
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
  });
}

async function get(path: string) {
  const res = await app().request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const decision = {
  decision: 'reject',
  decidedBy: 'user:u-7',
  reviewerId: 'rev-7',
  reviewerRoleAtDecision: 'senior',
  decidedAt: '2026-10-05T00:01:00.000Z',
  rationale: 'not this refund',
};

describe('an approval says who decided it', () => {
  test('a decided approval carries its decision', async () => {
    const answer = await get('/v1/approvals/appr-rejected');
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ status: 'rejected', decision });
  });

  test('an open approval, and one that expired, have no decision', async () => {
    expect((await get('/v1/approvals/appr-open')).json).not.toHaveProperty('decision');
    const ended = await get('/v1/approvals/appr-expired');
    expect(ended.json).toMatchObject({ status: 'expired' });
    expect(ended.json).not.toHaveProperty('decision');
  });

  test('the list carries each decision', async () => {
    const answer = await get('/v1/approvals');
    expect(answer.status).toBe(200);
    const rows = answer.json.data as Record<string, unknown>[];
    expect(rows.map((r) => [r.id, r.decision])).toEqual([
      ['appr-rejected', decision],
      ['appr-expired', undefined],
      ['appr-open', undefined],
      ['appr-no-decider', expect.not.objectContaining({ decidedBy: expect.anything() })],
    ]);
  });

  test("a binding that doesn't record who decided: the decision, without `decidedBy`", async () => {
    const answer = await get('/v1/approvals/appr-no-decider');
    expect(answer.json.decision).toEqual({
      decision: 'approve',
      reviewerId: 'rev-8',
      reviewerRoleAtDecision: 'standard',
      decidedAt: '2026-10-05T00:03:00.000Z',
    });
  });
});
