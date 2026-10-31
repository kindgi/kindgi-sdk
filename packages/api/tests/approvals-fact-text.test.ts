// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/approvals/:id/complete` takes `factText` only with `approve`,
 * on the approval of a fact an agent wants to remember (`subjectKind:
 * fact`): the text the fact holds once approved. It's checked as the
 * agent's text is (`rememberedTextProblem`). Anything else is refused
 * before anything is recorded, and the decision carries the text back.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import { FACT_APPROVAL_SUBJECT, MAX_REMEMBERED_TEXT } from '@kindgi/memory';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  Approval,
  HitlBinding,
  RunHandlerBinding,
  SubmitReviewBindingInput,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'fact-text-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

function appFor(subjectKind: string, decided?: { factText: string }) {
  const submitted: SubmitReviewBindingInput[] = [];
  const approval = {
    id: 'appr-1',
    tenantId,
    subjectKind,
    subjectRef: {},
    requiredRole: 'standard',
    status: decided === undefined ? 'pending' : 'approved',
    description: 'Prefers replies in Portuguese.',
    provenanceRef: { runId: 'run-1' },
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
    ...(decided !== undefined && {
      decision: {
        decision: 'approve',
        decidedBy: 'user:user-1',
        reviewerId: 'rev-1',
        reviewerRoleAtDecision: 'admin',
        decidedAt: '2026-10-04T00:00:01.000Z',
        factText: decided.factText,
      },
    }),
  } as unknown as Approval;
  const hitlBinding = {
    getApproval: async () => ({ kind: 'ok', value: approval }),
    listApprovals: async () => ({ kind: 'ok', value: { approvals: [] } }),
    submitReview: async (input: SubmitReviewBindingInput) => {
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
            ...(input.factText !== undefined && { factText: input.factText }),
          },
        },
      };
    },
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  const stubs = createStubAppBindings();
  const app = createApp({
    ...stubs,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
  });
  return { app, submitted };
}

async function complete(app: ReturnType<typeof appFor>['app'], body: unknown) {
  const res = await app.request('/v1/approvals/appr-1/complete', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function messageOf(json: Record<string, unknown>): string {
  return (json.error as { message: string }).message;
}

describe("a fact's approval takes the reviewer's text", () => {
  test('approve with factText: recorded with the decision, and answered in it', async () => {
    const h = appFor(FACT_APPROVAL_SUBJECT);
    const answer = await complete(h.app, {
      decision: 'approve',
      factText: 'Prefers replies in Portuguese, except for invoices.',
    });
    expect(answer.status).toBe(200);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({
      decision: 'approve',
      factText: 'Prefers replies in Portuguese, except for invoices.',
    });
    expect(answer.json.decision).toMatchObject({
      factText: 'Prefers replies in Portuguese, except for invoices.',
    });
  });

  test('approve without factText: no text goes with the decision', async () => {
    const h = appFor(FACT_APPROVAL_SUBJECT);
    const answer = await complete(h.app, { decision: 'approve' });
    expect(answer.status).toBe(200);
    expect(h.submitted[0]).not.toHaveProperty('factText');
    expect(answer.json.decision).not.toHaveProperty('factText');
  });

  test('the approval read back shows the text its fact was approved with', async () => {
    const h = appFor(FACT_APPROVAL_SUBJECT, { factText: 'Prefers replies in Spanish.' });
    const res = await h.app.request('/v1/approvals/appr-1', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.description).toBe('Prefers replies in Portuguese.');
    expect(body.decision).toMatchObject({ factText: 'Prefers replies in Spanish.' });
  });

  test.each(['reject', 'escalate', 'withdraw'])(
    '%s with factText: 400 bad-input, nothing recorded',
    async (decision) => {
      const h = appFor(FACT_APPROVAL_SUBJECT);
      const answer = await complete(h.app, { decision, factText: 'Something else.' });
      expect(answer.status).toBe(400);
      expect(answer.json.error).toMatchObject({ code: 'bad-input' });
      expect(messageOf(answer.json)).toContain('`factText` goes only with `decision: approve`');
      expect(h.submitted).toEqual([]);
    },
  );

  test.each([
    ['a tool call', TOOL_CALL_GATE_SUBJECT],
    ['a custom wait', 'acme:custom-wait'],
    // The kind the runtime stores is never the wire's.
    ['the stored kind', 'memory-fact'],
  ])('factText on %s: 400 bad-input, nothing recorded', async (_name, subject) => {
    const h = appFor(subject);
    const answer = await complete(h.app, { decision: 'approve', factText: 'Something else.' });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'bad-input' });
    expect(messageOf(answer.json)).toContain(
      `Only the approval of a fact an agent wants to remember (\`subjectKind: ${FACT_APPROVAL_SUBJECT}\`) takes \`factText\``,
    );
    expect(h.submitted).toEqual([]);
  });

  test.each([
    ['only spaces', '   ', 'must not be empty'],
    ['empty', '', 'must not be empty'],
    ['too long', 'x'.repeat(MAX_REMEMBERED_TEXT + 1), `must be at most ${MAX_REMEMBERED_TEXT}`],
    ['not a string', 42, 'must be a string'],
  ])('factText %s: 400 bad-input, nothing recorded', async (_name, factText, says) => {
    const h = appFor(FACT_APPROVAL_SUBJECT);
    const answer = await complete(h.app, { decision: 'approve', factText });
    expect(answer.status).toBe(400);
    expect(answer.json.error).toMatchObject({ code: 'bad-input' });
    expect(messageOf(answer.json)).toContain(`\`factText\` ${says}`);
    expect(h.submitted).toEqual([]);
  });

  test('the cap counts characters, not UTF-16 units', async () => {
    const h = appFor(FACT_APPROVAL_SUBJECT);
    const factText = '🙂'.repeat(MAX_REMEMBERED_TEXT);
    const answer = await complete(h.app, { decision: 'approve', factText });
    expect(answer.status).toBe(200);
    expect(h.submitted[0]).toMatchObject({ factText });
  });
});
