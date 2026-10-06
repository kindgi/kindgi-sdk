// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/approvals/:id/complete` resumes the run inline and says how
 * that went (`resume`): a decision whose run couldn't go on (a tool
 * version the turn started with is gone, say) isn't reported as plain
 * success. The decision stands either way.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import type { RunBinding } from '@kindgi/runtime';
import { createStubAppBindings } from '@kindgi/testing';
import type { TenantId, UserId } from '@kindgi/types';

import { createApp } from '../src/index.js';
import type { Approval, HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'inline-resume-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

function appWith(resumeRun: RunHandlerBinding['resumeRun']) {
  const approval = {
    id: 'appr-1',
    tenantId,
    subjectKind: TOOL_CALL_GATE_SUBJECT,
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    waitTokenId: 'wait-1',
    provenanceRef: { runId: 'run-1' },
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  } as unknown as Approval;
  const hitlBinding = {
    getApproval: async () => ({ kind: 'ok', value: approval }),
    listApprovals: async () => ({ kind: 'ok', value: { approvals: [] } }),
    submitReview: async (input: { decision: string }) => ({
      kind: 'ok',
      value: {
        kind: 'terminal',
        approval: { ...approval, status: 'approved' },
        decision: {
          id: 'dec-1',
          approvalId: approval.id,
          reviewerId: 'rev-1',
          decision: input.decision,
          reviewerRoleAtDecision: 'admin',
          decidedAt: '2026-10-06T00:00:01.000Z',
        },
      },
    }),
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    completeToken: async () => ({ kind: 'ok', value: undefined }),
  } as unknown as RunBinding;
  return createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: { resumeRun } as unknown as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
  });
}

async function approve(app: ReturnType<typeof appWith>) {
  const res = await app.request('/v1/approvals/appr-1/complete', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('an approval says how its run went on', () => {
  test('the run went on: resume ok', async () => {
    const answer = await approve(appWith(async () => ({ kind: 'ok', runId: 'run-1' as never })));
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ waitpointResolved: true, resume: { kind: 'ok' } });
  });

  test("the run couldn't go on: resume failed, with the run's error; the decision stands", async () => {
    const answer = await approve(
      appWith(async () => ({
        kind: 'err',
        error: {
          code: 'tool-version-unresolvable',
          message: 'this turn started with version 0.1.0 of tool "acme.post-update"',
        },
      })),
    );
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({
      kind: 'terminal',
      waitpointResolved: true,
      resume: {
        kind: 'failed',
        code: 'tool-version-unresolvable',
        message: 'this turn started with version 0.1.0 of tool "acme.post-update"',
      },
    });
  });

  test('a resume that throws is reported too', async () => {
    const answer = await approve(
      appWith(async () => {
        throw new Error('database unavailable');
      }),
    );
    expect(answer.json).toMatchObject({
      resume: { kind: 'failed', code: 'resume-failed', message: 'database unavailable' },
    });
  });
});
