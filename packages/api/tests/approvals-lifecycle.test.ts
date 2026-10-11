// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An approval and the run waiting on it end together: a reviewer's
 * withdraw cancels the gate's waitpoint (`approval-withdrawn`), a decision
 * that lands after the run ended stands and says the run's status, a
 * refusal before recording names the ended run, and the approval carries
 * who asked, four eyes, why its run withdrew it and its escalation links.
 * The list takes a run, and its descendants.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { APPROVAL_WITHDRAWN_REASON, TOOL_CALL_GATE_SUBJECT } from '@kindgi/agents';
import type { RunBinding } from '@kindgi/runtime';
import type { TenantId, UserId } from '@kindgi/types';

import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type {
  Approval,
  HitlBinding,
  ListApprovalsBindingInput,
  RunHandlerBinding,
  TokenResolver,
} from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'lifecycle-token';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

const RUN = '9b1f0a52-6a5e-4b0e-8d0e-6f6ad7c1b001';

const approval = {
  id: 'appr-1',
  tenantId,
  subjectKind: TOOL_CALL_GATE_SUBJECT,
  subjectRef: {},
  requiredRole: 'standard',
  status: 'pending',
  waitTokenId: 'wait-1',
  provenanceRef: { runId: RUN },
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  requestedBy: 'user:requester',
  separateApprover: false,
  escalatedFrom: 'appr-0',
} as unknown as Approval;

type TokenAnswer =
  | { kind: 'ok'; value: undefined }
  | { kind: 'err'; error: Record<string, unknown> };

function harness(
  opts: {
    readonly token?: TokenAnswer;
    readonly submit?: { kind: 'err'; error: Record<string, unknown> };
    readonly listed?: Approval[];
  } = {},
) {
  const completed: unknown[][] = [];
  const cancelled: unknown[][] = [];
  const resumed: unknown[] = [];
  const lists: ListApprovalsBindingInput[] = [];
  const hitlBinding = {
    getApproval: async () => ({ kind: 'ok', value: approval }),
    listApprovals: async (input: ListApprovalsBindingInput) => {
      lists.push(input);
      return { kind: 'ok', value: { approvals: opts.listed ?? [] } };
    },
    submitReview: async (input: { decision: string }) =>
      opts.submit ?? {
        kind: 'ok',
        value: {
          kind: 'terminal',
          approval: {
            ...approval,
            status: input.decision === 'withdraw' ? 'withdrawn' : 'approved',
          },
          decision: {
            id: 'dec-1',
            approvalId: approval.id,
            reviewerId: 'rev-1',
            decision: input.decision,
            reviewerRoleAtDecision: 'admin',
            decidedAt: '2026-10-10T00:00:01.000Z',
          },
        },
      },
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  const stubs = createStubAppBindings();
  const answer = async () => opts.token ?? { kind: 'ok', value: undefined };
  const run = {
    ...stubs.kernelBinding.run,
    completeToken: async (...args: unknown[]) => {
      completed.push(args);
      return answer();
    },
    cancelToken: async (...args: unknown[]) => {
      cancelled.push(args);
      return answer();
    },
  } as unknown as RunBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    resolveToken,
    runHandler: {
      resumeRun: async (input: unknown) => {
        resumed.push(input);
        return { kind: 'ok', runId: RUN as never };
      },
    } as unknown as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
    hitlBinding,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { call, completed, cancelled, resumed, lists };
}

describe('deciding a gate approval', () => {
  test("withdraw cancels the run's waitpoint, so the run ends saying why", async () => {
    const h = harness();
    const r = await h.call('POST', '/v1/approvals/appr-1/complete', {
      decision: 'withdraw',
      rationale: 'Asked by mistake',
    });
    expect(r.status).toBe(200);
    expect(h.cancelled).toEqual([[tenantId, RUN, 'wait-1', APPROVAL_WITHDRAWN_REASON]]);
    expect(h.completed).toEqual([]);
    expect(h.resumed).toHaveLength(1);
    expect(r.json).toMatchObject({ waitpointResolved: true, approval: { status: 'withdrawn' } });
  });

  test('a decision recorded after the run ended stands, and says the run status', async () => {
    const h = harness({
      token: {
        kind: 'err',
        error: {
          code: 'run-already-terminal',
          message: 'run ended',
          runId: RUN,
          status: 'cancelled',
        },
      },
    });
    const r = await h.call('POST', '/v1/approvals/appr-1/complete', { decision: 'approve' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ waitpointResolved: false, runStatus: 'cancelled' });
    expect(h.resumed).toEqual([]);
  });

  test('a refusal before anything is recorded names the run that ended', async () => {
    const h = harness({
      submit: {
        kind: 'err',
        error: {
          code: 'run-already-terminal',
          message: 'Its run was cancelled.',
          runId: 'parent-run',
          status: 'cancelled',
        },
      },
    });
    const r = await h.call('POST', '/v1/approvals/appr-1/complete', { decision: 'approve' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({
      code: 'run-already-terminal',
      details: { runId: 'parent-run', status: 'cancelled' },
    });
    expect(h.completed).toEqual([]);
  });

  test('escalate leaves the waitpoint to the new approval', async () => {
    const h = harness();
    await h.call('POST', '/v1/approvals/appr-1/complete', { decision: 'escalate' });
    expect([...h.completed, ...h.cancelled]).toEqual([]);
  });
});

describe('the approval on the wire', () => {
  test('carries who asked, four eyes, and where it was escalated from', async () => {
    const h = harness();
    const r = await h.call('GET', '/v1/approvals/appr-1');
    expect(r.json).toMatchObject({
      requestedBy: 'user:requester',
      separateApprover: false,
      escalatedFrom: 'appr-0',
    });
    expect(r.json).not.toHaveProperty('withdrawnBecause');
  });
});

describe('the list, by run', () => {
  test('runId, and includeDescendants with it', async () => {
    const h = harness();
    await h.call('GET', `/v1/approvals?runId=${RUN}&includeDescendants=true`);
    await h.call('GET', `/v1/approvals?runId=${RUN}`);
    expect(h.lists.map((l) => l.run)).toEqual([
      { runId: RUN, includeDescendants: true },
      { runId: RUN, includeDescendants: false },
    ]);
  });

  test('a run id that is not one, a bad flag, or descendants without a run: 400', async () => {
    const h = harness();
    for (const [query, message] of [
      ['runId=nope', '`runId` must be a run id (a UUID)'],
      [`runId=${RUN}&includeDescendants=yes`, '`includeDescendants` must be `true` or `false`'],
      ['includeDescendants=true', '`includeDescendants` needs a `runId`'],
    ] as const) {
      const r = await h.call('GET', `/v1/approvals?${query}`);
      expect(r.status, query).toBe(400);
      expect(r.json.error?.message).toBe(message);
    }
  });
});
