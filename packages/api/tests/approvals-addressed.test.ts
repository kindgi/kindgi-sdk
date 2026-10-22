// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An approval addressed to one member (`approver`: a call that acts with
 * that member's own connection) is theirs: only they decide it, and among
 * the reviewers only they see it. A person who is the tenant's admin still
 * reads it, as they read every tier, but can't decide it. The tenant-admin
 * check is made only when a read holds someone else's addressed approval.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import { createEd25519ExportSigner, generateEd25519KeyPair } from '@kindgi/crypto';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { Approval, HitlBinding, ReviewerBinding, RunHandlerBinding } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID();
const OWNER = 'user-owner' as UserId;
const OTHER = 'user-other' as UserId;
const ADMIN = 'user-admin' as UserId;

function approval(id: string, approver?: UserId): Approval {
  return {
    id,
    tenantId,
    projectId: PROJECT,
    subjectKind: 'agent-tool-call',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    ...(approver !== undefined && {
      approver: { kind: 'member', userId: approver },
      connection: { app: 'acme', appName: 'Acme', account: 'owner@acme.example' },
    }),
  } as unknown as Approval;
}
const APPROVALS = [approval('appr-open'), approval('appr-owner', OWNER)];

function harness() {
  const adminChecks: { readonly actor: string; readonly allowed: boolean }[] = [];
  const submitted: { readonly reviewerId: string }[] = [];
  const decide = (p: Principal, action: Action, r: ResourceRef): Decision => {
    const allowed =
      action === 'admin'
        ? r.type === 'tenant' && p.actor.id === ADMIN
        : r.type === 'project' && r.id === PROJECT;
    if (action === 'admin') adminChecks.push({ actor: p.actor.id, allowed });
    return {
      allowed,
      reason: allowed ? 'test: granted' : 'test: not granted',
      evidence: { action, relation: '', resource: `${r.type}:${r.id}`, actorSubject: '' },
    };
  };
  const authzCheckBinding: AuthzCheckBinding = {
    check: async (p, action, r) => decide(p, action, r),
    checkBatch: async (p, action, rs) => rs.map((r) => decide(p, action, r)),
  };
  // Every caller is a standard reviewer with a row of their own.
  const reviewerBinding: ReviewerBinding = {
    resolveReviewer: async ({ userId }) => `rev-${userId}` as never,
    resolveReviewerRole: async () => 'standard',
  };
  const hitlBinding = {
    listApprovals: async () => ({ kind: 'ok', value: { approvals: APPROVALS } }),
    getApproval: async (_t: TenantId, id: string) => {
      const found = APPROVALS.find((a) => a.id === id);
      return found === undefined
        ? { kind: 'err', error: { code: 'approval-not-found', message: 'x' } }
        : { kind: 'ok', value: found };
    },
    submitReview: async (input: { readonly reviewerId: string }) => {
      submitted.push({ reviewerId: input.reviewerId });
      return { kind: 'err', error: { code: 'approval-already-decided', message: 'decided' } };
    },
  } as unknown as HitlBinding;
  const signer = createEd25519ExportSigner({ privateKey: generateEd25519KeyPair().privateKey });
  if (signer.kind !== 'ok') throw new Error(signer.error.message);
  const app = createApp({
    ...createStubAppBindings(),
    hitlBinding,
    reviewerBinding,
    resolveToken: async (token) =>
      token === 'reviewer-key'
        ? { tenantId, tokenId: 'key-1' as never, reviewerRole: 'admin' }
        : { tenantId, userId: token as UserId },
    runHandler: {} as RunHandlerBinding,
    exportSigning: signer.value,
    authz: { fgaApiUrl: 'http://fga.invalid', authzCheckBinding },
  });
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const listed = async (token: string) => {
    const answer = await call(token, 'GET', '/v1/approvals');
    expect(answer.status).toBe(200);
    return (answer.json.data as { id: string }[]).map((a) => a.id);
  };
  return { call, listed, adminChecks, submitted };
}

describe('listed: to its approver, and to the tenant admin', () => {
  test('its approver sees it, with no tenant-admin check', async () => {
    const h = harness();
    expect(await h.listed(OWNER)).toEqual(['appr-open', 'appr-owner']);
    expect(h.adminChecks).toEqual([]);
  });

  test('another reviewer of the same rank does not', async () => {
    const h = harness();
    expect(await h.listed(OTHER)).toEqual(['appr-open']);
    expect(h.adminChecks).toEqual([{ actor: OTHER, allowed: false }]);
  });

  test('a reviewer who is the tenant admin does, asked once', async () => {
    const h = harness();
    expect(await h.listed(ADMIN)).toEqual(['appr-open', 'appr-owner']);
    expect(h.adminChecks).toEqual([{ actor: ADMIN, allowed: true }]);
  });

  test('a key with a reviewer role and no user does not', async () => {
    const h = harness();
    expect(await h.listed('reviewer-key')).toEqual(['appr-open']);
  });
});

describe('one approval, and its audit bundle: its approver and the tenant admin', () => {
  test.each([
    [OWNER, 200],
    [OTHER, 404],
    [ADMIN, 200],
    ['reviewer-key', 404],
  ] as const)('GET as %s: %i', async (who, status) => {
    const h = harness();
    const answer = await h.call(who, 'GET', '/v1/approvals/appr-owner');
    expect(answer.status).toBe(status);
    if (status === 404) expect(answer.json.error).toMatchObject({ code: 'approval-not-found' });
    // One addressed to no one reads as before.
    expect((await h.call(who, 'GET', '/v1/approvals/appr-open')).status).toBe(200);
  });

  test('its audit bundle: not found for another reviewer; past that check for its approver', async () => {
    const h = harness();
    const other = await h.call(OTHER, 'POST', '/v1/approvals/appr-owner/audit-bundle', {});
    expect(other.status).toBe(404);
    expect(other.json.error).toMatchObject({ code: 'approval-not-found' });
    // Still pending: refused for that, not as unseen.
    const owner = await h.call(OWNER, 'POST', '/v1/approvals/appr-owner/audit-bundle', {});
    expect(owner.json.error).toMatchObject({ code: 'approval-not-decided' });
  });
});

describe('decided: by its approver alone', () => {
  test.each([OTHER, ADMIN])('%s finds no such approval, and nothing is submitted', async (who) => {
    const h = harness();
    const answer = await h.call(who, 'POST', '/v1/approvals/appr-owner/complete', {
      decision: 'approve',
    });
    expect(answer.status).toBe(404);
    expect(answer.json.error).toMatchObject({ code: 'approval-not-found' });
    expect(h.submitted).toEqual([]);
  });

  test('its approver decides it', async () => {
    const h = harness();
    await h.call(OWNER, 'POST', '/v1/approvals/appr-owner/complete', { decision: 'approve' });
    expect(h.submitted).toEqual([{ reviewerId: `rev-${OWNER}` }]);
  });

  test('one addressed to no one is decided as before', async () => {
    const h = harness();
    await h.call(OTHER, 'POST', '/v1/approvals/appr-open/complete', { decision: 'approve' });
    expect(h.submitted).toEqual([{ reviewerId: `rev-${OTHER}` }]);
  });
});
