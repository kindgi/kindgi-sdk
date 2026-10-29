// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * An approval addressed to one member (`approver`: a call that acts with
 * that member's own connection) is theirs: only they decide it, and among
 * the reviewers only they see it. A person who is the tenant's admin still
 * reads it, as they read every tier, but can't decide it: told so
 * (`named-approver-required`), not that it isn't there. The tenant-admin
 * check is made only when a read holds someone else's addressed approval.
 * A page of only someone else's still continues: the sealed cursor goes
 * past them, as past any approval the caller can't read.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Action, AuthzCheckBinding, Decision, Principal, ResourceRef } from '@kindgi/authz';
import { createEd25519ExportSigner, generateEd25519KeyPair } from '@kindgi/crypto';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createAeadCursorSealer, createApp } from '../src/index.js';
import type { Approval, HitlBinding, ReviewerBinding, RunHandlerBinding } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const PROJECT = randomUUID();
const OWNER = 'user-owner' as UserId;
const OTHER = 'user-other' as UserId;
const ADMIN = 'user-admin' as UserId;

function approval(id: string, approver?: UserId, createdAt = '2026-10-22T08:00:00.000Z'): Approval {
  return {
    id,
    tenantId,
    projectId: PROJECT,
    subjectKind: 'agent-tool-call',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    ...(approver !== undefined && {
      approver: { kind: 'member', userId: approver },
      connection: { app: 'acme', appName: 'Acme', account: 'owner@acme.example' },
    }),
  } as unknown as Approval;
}
// The open one acts with a company connection: shown, and anyone of the rank decides it.
const APPROVALS = [
  {
    ...approval('appr-open'),
    connection: { app: 'acme', appName: 'Acme', account: 'support@acme.example', name: 'support' },
  },
  approval('appr-owner', OWNER),
];
/** Each approval's exact `createdAt`, as the binding gives it for a cursor. */
const exactOf = (rows: readonly Approval[]) =>
  Object.fromEntries(
    rows.map((a) => [a.id, `${a.createdAt.replace('T', ' ').replace('Z', '')}456+00`]),
  );

/**
 * `pages`: what the binding answers, a page per ask (each but the last says
 * there's more); else every approval at once. `sealed`: cursors are sealed.
 */
function harness(
  o: { readonly pages?: readonly (readonly Approval[])[]; readonly sealed?: boolean } = {},
) {
  const adminChecks: { readonly actor: string; readonly allowed: boolean }[] = [];
  const submitted: { readonly reviewerId: string }[] = [];
  const asked: Record<string, unknown>[] = [];
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
    listApprovals: async (input: Record<string, unknown>) => {
      asked.push(input);
      if (o.pages === undefined) return { kind: 'ok', value: { approvals: APPROVALS } };
      const rows = o.pages[asked.length - 1] ?? [];
      return {
        kind: 'ok',
        value: {
          approvals: rows,
          exactCreatedAt: exactOf(rows),
          ...(asked.length < o.pages.length && { nextCursor: 'more' }),
        },
      };
    },
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
    ...(o.sealed === true && {
      cursorSealer: createAeadCursorSealer({
        keys: [{ kid: 'k', key: new Uint8Array(32).fill(7) }],
      }),
    }),
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
  return { call, listed, adminChecks, submitted, asked };
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

describe('listed a page at a time: approvals addressed to another never end the paging', () => {
  test('a fetched page of only theirs comes back empty, with a cursor that reaches the next one', async () => {
    const theirs = [
      approval('appr-owner-1', OWNER, '2026-10-22T08:00:00.001Z'),
      approval('appr-owner-2', OWNER, '2026-10-22T08:00:00.002Z'),
    ];
    const next = [approval('appr-open-3', undefined, '2026-10-22T08:00:00.003Z')];
    const h = harness({ pages: [theirs, next], sealed: true });
    const first = await h.call(OTHER, 'GET', '/v1/approvals?limit=2');
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ data: [], hasMore: true });
    const cursor = first.json.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));
    const second = await h.call(
      OTHER,
      'GET',
      `/v1/approvals?limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.status).toBe(200);
    // Asked to go on after the last one fetched, not the last one shown.
    expect((h.asked[1]?.after as { readonly id?: string } | undefined)?.id).toBe('appr-owner-2');
    expect((second.json.data as { id: string }[]).map((a) => a.id)).toEqual(['appr-open-3']);
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

  test('one with a company connection shows it, named, addressed to no one', async () => {
    const answer = await harness().call(OTHER, 'GET', '/v1/approvals/appr-open');
    expect(answer.json).not.toHaveProperty('approver');
    expect(answer.json.connection).toEqual({
      app: 'acme',
      appName: 'Acme',
      account: 'support@acme.example',
      name: 'support',
    });
    const owners = await harness().call(OWNER, 'GET', '/v1/approvals/appr-owner');
    expect(owners.json.connection).toEqual({
      app: 'acme',
      appName: 'Acme',
      account: 'owner@acme.example',
    });
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
  test('another reviewer finds no such approval, and nothing is submitted', async () => {
    const h = harness();
    const answer = await h.call(OTHER, 'POST', '/v1/approvals/appr-owner/complete', {
      decision: 'approve',
    });
    expect(answer.status).toBe(404);
    expect(answer.json.error).toMatchObject({ code: 'approval-not-found' });
    expect(h.submitted).toEqual([]);
  });

  test('the tenant admin, who reads it, is told only its approver decides it', async () => {
    const h = harness();
    const answer = await h.call(ADMIN, 'POST', '/v1/approvals/appr-owner/complete', {
      decision: 'approve',
    });
    expect(answer.status).toBe(403);
    expect(answer.json.error).toMatchObject({
      code: 'named-approver-required',
      message:
        'Only user user-owner can decide approval appr-owner: the call it gates acts with their own Acme account.',
    });
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
