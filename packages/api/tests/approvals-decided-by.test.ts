// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Who decided, and through what:
 *   - `GET /v1/approvals?decidedBy=me` lists the approvals the caller's own
 *     reviewer row decided, whether or not the binding filters them itself,
 *     and every page of it says so (`decidedBy: 'me'`), an empty one too;
 *   - a decision made in a session keeps the session's provider
 *     (`sessionProvider`: `site:<id>`, an identity provider), and one made
 *     with an API key keeps none; the decision on the wire carries it and
 *     the reviewer's name when they decided (`deciderName`).
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { RunBinding } from '@kindgi/runtime';
import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import { createApp } from '../src/index.js';
import type { Approval, HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const REV1 = randomUUID();
const REV2 = randomUUID();
/** Jane's key: a reviewer, with no session. */
const KEY = 'decided-by-key';
/** Jane signed in through a site: a session from `site:…`. */
const SITE_SESSION = 'decided-by-site-session';
/** Someone with no reviewer row. */
const NO_ROW = 'decided-by-no-row';
const SITE = `site:${randomUUID()}`;

const resolveToken: TokenResolver = async (token) => {
  if (token === KEY) return { tenantId, userId: 'u-jane' as UserId, reviewerRole: 'standard' };
  if (token === SITE_SESSION) {
    return {
      tenantId,
      userId: 'u-jane' as UserId,
      reviewerRole: 'standard',
      sessionId: randomUUID() as never,
      providerId: SITE,
    };
  }
  if (token === NO_ROW) return { tenantId, userId: 'u-sam' as UserId, reviewerRole: 'standard' };
  return null;
};

function decided(reviewerId: string, at: string) {
  return {
    id: randomUUID(),
    tenantId,
    subjectKind: 'acme.refund',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'approved',
    createdAt: at,
    updatedAt: at,
    decision: {
      decision: 'approve',
      decidedBy: `user:${reviewerId === REV1 ? 'u-jane' : 'u-ada'}`,
      reviewerId,
      reviewerRoleAtDecision: 'standard',
      decidedAt: at,
      sessionProvider: SITE,
      deciderName: reviewerId === REV1 ? 'Jane' : 'Ada',
    },
  };
}
const byJane = decided(REV1, '2026-10-12T10:00:00.000Z');
const byAda = decided(REV2, '2026-10-12T10:01:00.000Z');
const waiting = {
  ...decided(REV1, '2026-10-12T10:02:00.000Z'),
  status: 'pending',
  decision: undefined,
};

function harness(honours: boolean) {
  const listed: Record<string, any>[] = [];
  const submitted: Record<string, any>[] = [];
  const approval = {
    id: 'appr-1',
    tenantId,
    subjectKind: 'acme.refund',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    createdAt: '2026-10-12T10:00:00.000Z',
    updatedAt: '2026-10-12T10:00:00.000Z',
  } as unknown as Approval;
  const hitlBinding = {
    listApprovals: async (input: Record<string, any>) => {
      listed.push(input);
      let rows: Record<string, any>[] = [waiting, byAda, byJane];
      if (honours && input.decidedBy !== undefined) {
        rows = rows.filter((a) => a.decision?.reviewerId === input.decidedBy);
      }
      return { kind: 'ok', value: { approvals: rows } };
    },
    getApproval: async () => ({ kind: 'ok', value: approval }),
    submitReview: async (input: Record<string, any>) => {
      submitted.push(input);
      return {
        kind: 'ok',
        value: {
          kind: 'terminal',
          approval: { ...approval, status: 'approved' },
          decision: {
            id: 'dec-1',
            approvalId: approval.id,
            reviewerId: REV1,
            decision: input.decision,
            reviewerRoleAtDecision: 'standard',
            decidedAt: '2026-10-12T10:05:00.000Z',
          },
        },
      };
    },
    loadReviewDecision: async () => ({ kind: 'ok', value: null }),
  } as unknown as HitlBinding;
  const stubs = createStubAppBindings();
  const app = createApp({
    ...stubs,
    kernelBinding: {
      ...stubs.kernelBinding,
      run: {
        ...stubs.kernelBinding.run,
        completeToken: async () => ({ kind: 'ok', value: undefined }),
      } as unknown as RunBinding,
    },
    hitlBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: {
      resolveReviewer: async ({ userId }: { userId: string }) =>
        userId === 'u-jane' ? REV1 : null,
    } as never,
  });
  const call = async (path: string, token = KEY, body?: unknown) => {
    const res = await app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, listed, submitted };
}

const ids = (body: Record<string, any>) => body.data.map((a: { id: string }) => a.id);

describe('approvals the caller decided (?decidedBy=me)', () => {
  test.each([true, false])(
    'only theirs, whether the binding filters (%s) or the route does',
    async (honours) => {
      const h = harness(honours);
      const { status, body } = await h.call('/v1/approvals?decidedBy=me&status=approved');
      expect(status).toBe(200);
      expect(h.listed[0]?.decidedBy).toBe(REV1);
      expect(ids(body)).toEqual([byJane.id]);
      expect(body.decidedBy).toBe('me');
      expect(validateAgainst('ApprovalCollectionPage', body)).toEqual([]);
    },
  );

  test("every page says it filtered, an empty one and a later one too; a list without it doesn't", async () => {
    const h = harness(false);
    const pages = [
      // A later page: before a time, as a cursor from an older page is.
      await h.call('/v1/approvals?decidedBy=me&cursor=2026-10-12T10:05:00.000Z'),
      // Only pending ones: none decided, so none of them Jane's.
      await h.call('/v1/approvals?decidedBy=me&status=pending'),
      // No reviewer row: an empty page before the binding, for either filter.
      await h.call('/v1/approvals?decidedBy=me', NO_ROW),
      await h.call('/v1/approvals?assignedTo=me&decidedBy=me', NO_ROW),
    ];
    expect(h.listed[0]?.cursor).toBe('2026-10-12T10:05:00.000Z');
    for (const { status, body } of pages) {
      expect(status, JSON.stringify(body)).toBe(200);
      expect(body.decidedBy).toBe('me');
      expect(validateAgainst('ApprovalCollectionPage', body)).toEqual([]);
    }
    expect(pages.slice(1).map(({ body }) => body.data)).toEqual([[], [], []]);
    const unfiltered = await h.call('/v1/approvals');
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body).not.toHaveProperty('decidedBy');
  });

  test('the decision on the wire says through what, and under which name', async () => {
    const { body } = await harness(true).call('/v1/approvals?decidedBy=me&status=approved');
    expect(body.data[0].decision).toMatchObject({ sessionProvider: SITE, deciderName: 'Jane' });
  });

  test('a caller with no reviewer row decided nothing: an empty page, the binding never asked', async () => {
    const h = harness(true);
    const { status, body } = await h.call('/v1/approvals?decidedBy=me', NO_ROW);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
    expect(h.listed).toEqual([]);
  });

  test('only `me`', async () => {
    const { status, body } = await harness(true).call(`/v1/approvals?decidedBy=${REV2}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad-input');
  });
});

describe('a decision keeps the session it was made in', () => {
  test("a site session's provider goes with the decision", async () => {
    const h = harness(true);
    const done = await h.call('/v1/approvals/appr-1/complete', SITE_SESSION, {
      decision: 'approve',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(h.submitted[0]).toMatchObject({ reviewerId: REV1, sessionProvider: SITE });
  });

  test('an API key has no session: none', async () => {
    const h = harness(true);
    const done = await h.call('/v1/approvals/appr-1/complete', KEY, { decision: 'approve' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(h.submitted[0]).not.toHaveProperty('sessionProvider');
  });
});
