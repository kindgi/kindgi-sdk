// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/approvals/:id/complete` on an agent's tool-call or session
 * gate takes a decision and an optional rationale, never a `value`: the
 * turn resumes on the decision alone, so a `value` that replaced it could
 * be read as anything. Refused before anything is recorded. Another
 * subject's approval still takes a `value` as its resume payload.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { SESSION_GATE_SUBJECT, TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import type { RunBinding } from '@kindgi/runtime';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { Approval, HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'agent-gate-value-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

function appFor(subjectKind: string) {
  const submitted: unknown[] = [];
  const resumedWith: unknown[] = [];
  const approval = {
    id: 'appr-1',
    tenantId,
    subjectKind,
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    waitTokenId: 'wait-1',
    provenanceRef: { runId: 'run-1' },
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  } as unknown as Approval;
  const hitlBinding = {
    getApproval: async () => ({ kind: 'ok', value: approval }),
    listApprovals: async () => ({ kind: 'ok', value: { approvals: [] } }),
    submitReview: async (input: { decision: string; rationale?: string }) => {
      submitted.push(input);
      return {
        kind: 'ok',
        value: {
          kind: 'terminal',
          approval: { ...approval, status: input.decision === 'approve' ? 'approved' : 'rejected' },
          decision: {
            id: 'dec-1',
            approvalId: approval.id,
            reviewerId: 'rev-1',
            decision: input.decision,
            reviewerRoleAtDecision: 'admin',
            decidedAt: '2026-10-04T00:00:01.000Z',
          },
        },
      };
    },
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    completeToken: async (_t: TenantId, _r: unknown, _token: string, value: unknown) => {
      resumedWith.push(value);
      return { kind: 'ok', value: undefined };
    },
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
  });
  return { app, submitted, resumedWith };
}

async function complete(app: ReturnType<typeof appFor>['app'], body: unknown) {
  const res = await app.request('/v1/approvals/appr-1/complete', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("an agent gate's approval takes no value", () => {
  test.each([
    ['tool call, reject + value', TOOL_CALL_GATE_SUBJECT, 'reject'],
    ['tool call, approve + value', TOOL_CALL_GATE_SUBJECT, 'approve'],
    ['session, reject + value', SESSION_GATE_SUBJECT, 'reject'],
  ])(
    '%s: 400 bad-input; nothing recorded, the run not resumed',
    async (_name, subject, decision) => {
      const h = appFor(subject);
      const answer = await complete(h.app, { decision, value: { maxCostUsd: 1.5 } });
      expect(answer.status).toBe(400);
      expect(answer.json.error).toMatchObject({ code: 'bad-input' });
      expect((answer.json.error as { message: string }).message).toContain(
        'takes a decision (approve or reject) and an optional rationale, not a `value`',
      );
      expect(h.submitted).toEqual([]);
      expect(h.resumedWith).toEqual([]);
    },
  );

  test('a reject without a value resumes the run with the decision, and who decided it', async () => {
    const h = appFor(TOOL_CALL_GATE_SUBJECT);
    const answer = await complete(h.app, { decision: 'reject', rationale: 'not this refund' });
    expect(answer.status).toBe(200);
    expect(h.resumedWith).toEqual([
      {
        decided: 'reject',
        rationale: 'not this refund',
        decidedBy: 'user:user-1',
        approvalId: 'appr-1',
      },
    ]);
  });

  test("another subject's approval still resumes with its value", async () => {
    const h = appFor('acme:custom-wait');
    const answer = await complete(h.app, { decision: 'approve', value: { limit: 3 } });
    expect(answer.status).toBe(200);
    expect(h.resumedWith).toEqual([{ limit: 3 }]);
  });
});
