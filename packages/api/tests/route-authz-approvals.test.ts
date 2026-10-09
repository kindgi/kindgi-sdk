// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Approvals and authorization (T243 A): on top of the reviewer role, a
 * reviewer sees and decides only approvals whose project it may read (the
 * approval's, else its run's). Another project's approval is not found,
 * as one above the reviewer's tier is, so neither leaks it exists.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, ResourceRef } from '@kindgi/authz';
import type { KernelRunRecord, RunBinding } from '@kindgi/runtime';
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
const TOKEN = 'route-authz-approvals';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId } : null;
const MINE = randomUUID();
const THEIRS = randomUUID();
const RUN_IN_THEIRS = randomUUID();

function approval(extra: Partial<Approval>): Approval {
  return {
    id: randomUUID(),
    tenantId,
    requiredRole: 'standard',
    status: 'pending',
    createdAt: '2026-10-07T08:00:00.000Z',
    ...extra,
  } as unknown as Approval;
}
const mine = approval({ projectId: MINE as never });
const theirs = approval({ provenanceRef: { runId: RUN_IN_THEIRS } as never });

function harness(grants: readonly string[]) {
  const decide = (action: Action, r: ResourceRef): Decision => {
    const allowed = grants.includes(`${action} ${r.type}:${r.id}`);
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const stubs = createStubAppBindings();
  const run = {
    ...stubs.kernelBinding.run,
    getRun: async (_t: TenantId, runId: string) =>
      runId === RUN_IN_THEIRS ? ({ projectId: THEIRS } as KernelRunRecord) : null,
  } as unknown as RunBinding;
  const hitl = {
    listApprovals: async () => ({ kind: 'ok', value: { approvals: [mine, theirs] } }),
    getApproval: async (_t: TenantId, id: string) => {
      const found = [mine, theirs].find((a) => a.id === id);
      return found === undefined
        ? { kind: 'err', error: { code: 'approval-not-found', message: 'x' } }
        : { kind: 'ok', value: found };
    },
  } as unknown as HitlBinding;
  const reviewers = {
    resolveReviewerRole: async () => 'admin',
  } as unknown as ReviewerBinding;
  const app = createApp({
    ...stubs,
    kernelBinding: { ...stubs.kernelBinding, run },
    hitlBinding: hitl,
    reviewerBinding: reviewers,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    authz: {
      fgaApiUrl: 'http://fga.invalid',
      authzCheckBinding: {
        check: async (_p, action, r) => decide(action, r),
        checkBatch: async (_p, action, rs) => rs.map((r) => decide(action, r)),
      } satisfies AuthzCheckBinding,
    },
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  return { call };
}

describe('a reviewer reaches only approvals in projects it may read', () => {
  test('the list holds only those (by the approval or its run)', async () => {
    const { call } = harness([`read project:${MINE}`]);
    const res = await call('GET', '/v1/approvals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((a) => a.id)).toEqual([mine.id]);
  });

  test("another project's approval is not found: read and complete (the audit bundle shares the check)", async () => {
    const { call } = harness([`read project:${MINE}`]);
    for (const [method, path, body] of [
      ['GET', `/v1/approvals/${theirs.id}`, undefined],
      ['POST', `/v1/approvals/${theirs.id}/complete`, { decision: 'approve' }],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(await res.json()), path).toContain('approval-not-found');
    }
  });

  test('its own project: found', async () => {
    const { call } = harness([`read project:${MINE}`]);
    expect((await call('GET', `/v1/approvals/${mine.id}`)).status).toBe(200);
  });
});
