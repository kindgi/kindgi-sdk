// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * A reviewer's inbox in one read: `GET /v1/approvals` takes several
 * statuses (`status=pending,escalated`, or repeated), `assignedTo=me` (the
 * caller's own reviewer row, as deciding resolves it) and `order=asc`
 * (oldest first). The binding narrows; the route keeps a page right from a
 * binding that doesn't, and says which order the page is in, so a client
 * can tell a runtime that still lists newest first.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { validateAgainst } from './support/openapi-schema.js';

import type { ListApprovalsBindingResult } from '../src/hitl-binding.js';
import { createApp } from '../src/index.js';
import type { HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { decodeCursor, encodeCursor } from '../src/routes/pagination.js';

const tenantId = randomUUID() as TenantId;
const REV1 = randomUUID();
const REV2 = randomUUID();
const REVIEWER = 'inbox-reviewer';
const NO_ROW = 'inbox-no-roster-row';
const resolveToken: TokenResolver = async (token) => {
  if (token === REVIEWER) return { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' };
  if (token === NO_ROW) return { tenantId, userId: 'user-2' as UserId, reviewerRole: 'admin' };
  return null;
};

function approval(status: string, createdAt: string, assignedTo?: string) {
  return {
    id: randomUUID(),
    tenantId,
    subjectKind: 'acme.refund',
    subjectRef: {},
    requiredRole: 'standard',
    status,
    ...(assignedTo !== undefined && { assignedTo }),
    createdAt,
    updatedAt: createdAt,
  };
}
const pending = approval('pending', '2026-10-09T12:00:00.000Z', REV1);
const escalated = approval('escalated', '2026-10-09T12:01:00.000Z', REV2);
const approved = approval('approved', '2026-10-09T12:02:00.000Z', REV1);
const ALL = [pending, escalated, approved];

/**
 * A binding that narrows like a store when `honours` (and says `order:
 * 'asc'`), or one from before these inputs that lists every approval newest
 * first.
 */
function harness(honours: boolean) {
  const seen: Record<string, any>[] = [];
  const hitlBinding = {
    listApprovals: async (input: Record<string, any>) => {
      seen.push(input);
      let rows = [...ALL].reverse();
      const result: Partial<ListApprovalsBindingResult> = {};
      if (honours) {
        if (input.statuses !== undefined)
          rows = rows.filter((a) => input.statuses.includes(a.status));
        if (input.assignedTo !== undefined)
          rows = rows.filter((a) => a.assignedTo === input.assignedTo);
        if (input.order === 'asc') {
          rows.reverse();
          Object.assign(result, { order: 'asc' });
        }
        Object.assign(result, {
          exactCreatedAt: Object.fromEntries(rows.map((a) => [a.id, a.createdAt])),
        });
      }
      return { kind: 'ok', value: { approvals: rows, ...result } };
    },
  } as unknown as HitlBinding;
  const app = createApp({
    ...createStubAppBindings(),
    hitlBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: {
      resolveReviewer: async ({ userId }: { userId: string }) =>
        userId === 'user-1' ? REV1 : null,
    } as never,
  });
  return async (path: string, token = REVIEWER) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any>, seen };
  };
}
const ids = (body: Record<string, any>) => body.data.map((a: { id: string }) => a.id);

describe('several statuses in one read', () => {
  test.each([
    ['comma-separated', '?status=pending,escalated'],
    ['repeated', '?status=pending&status=escalated'],
    ['with a repeat', '?status=pending,escalated,pending'],
  ])('%s: the binding gets them, de-duplicated, and the page has only those', async (_, query) => {
    for (const honours of [true, false]) {
      const { status, body, seen } = await harness(honours)(`/v1/approvals${query}`);
      expect(status).toBe(200);
      expect(seen[0]?.statuses).toEqual(['pending', 'escalated']);
      expect(ids(body).sort()).toEqual([pending.id, escalated.id].sort());
      expect(validateAgainst('ApprovalCollectionPage', body)).toEqual([]);
    }
  });

  test('one status also reaches a binding from before as `status`', async () => {
    const { seen } = await harness(true)('/v1/approvals?status=escalated');
    expect(seen[0]).toMatchObject({ status: 'escalated', statuses: ['escalated'] });
  });

  test('an unknown status: 400 bad-input naming it, the binding not called', async () => {
    const { status, body, seen } = await harness(true)('/v1/approvals?status=pending,open');
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad-input');
    expect(body.error.message).toContain('open');
    expect(seen).toEqual([]);
  });
});

describe('assignedTo=me', () => {
  test("the caller's own reviewer row, narrowed by the binding or the route", async () => {
    for (const honours of [true, false]) {
      const { status, body, seen } = await harness(honours)('/v1/approvals?assignedTo=me');
      expect(status).toBe(200);
      expect(seen[0]?.assignedTo).toBe(REV1);
      expect(ids(body).sort()).toEqual([pending.id, approved.id].sort());
    }
  });

  test('with the open statuses: what the reviewer has to do', async () => {
    const { body } = await harness(true)(
      '/v1/approvals?assignedTo=me&status=pending,assigned,in_review',
    );
    expect(ids(body)).toEqual([pending.id]);
  });

  test('a caller with no roster row has nothing assigned: an empty page, the binding not asked', async () => {
    const { status, body, seen } = await harness(true)('/v1/approvals?assignedTo=me', NO_ROW);
    expect(status).toBe(200);
    expect(body).toMatchObject({ data: [], hasMore: false });
    expect(seen).toEqual([]);
  });

  test('anything but `me`: 400 bad-input', async () => {
    const { status, body } = await harness(true)(`/v1/approvals?assignedTo=${REV2}`);
    expect([status, body.error.code]).toEqual([400, 'bad-input']);
  });
});

describe('order=asc', () => {
  test('oldest first, and the page says so; its cursor continues oldest first', async () => {
    const get = harness(true);
    const first = await get('/v1/approvals?order=asc&limit=1');
    expect(first.seen[0]?.order).toBe('asc');
    expect(ids(first.body)).toEqual([pending.id]);
    expect(first.body.order).toBe('asc');
    expect(validateAgainst('ApprovalCollectionPage', first.body)).toEqual([]);
    expect(first.body.nextCursor.startsWith('a.')).toBe(true);
    expect(decodeCursor(first.body.nextCursor.slice(2))).toEqual({
      createdAt: pending.createdAt,
      id: pending.id,
    });

    // The cursor alone carries the order.
    const next = await get(`/v1/approvals?cursor=${first.body.nextCursor}`);
    expect(next.status).toBe(200);
    expect(next.seen[1]).toMatchObject({
      order: 'asc',
      after: { createdAt: pending.createdAt, id: pending.id },
    });
  });

  test('newest first is the default, and the page says so', async () => {
    const { body, seen } = await harness(true)('/v1/approvals?limit=1');
    expect(seen[0]).not.toHaveProperty('order');
    expect(body.order).toBe('desc');
    expect(body.nextCursor.startsWith('a.')).toBe(false);
  });

  test("a binding that doesn't know `order` lists newest first: the page says `desc`", async () => {
    const { body } = await harness(false)('/v1/approvals?order=asc');
    expect(body.order).toBe('desc');
    expect(ids(body)).toEqual([approved.id, escalated.id, pending.id]);
  });

  test("a cursor can't continue the other order: 400 bad-input", async () => {
    const get = harness(true);
    const desc = encodeCursor({ createdAt: pending.createdAt, id: pending.id });
    for (const path of [
      `/v1/approvals?order=asc&cursor=${desc}`,
      `/v1/approvals?order=desc&cursor=a.${desc}`,
    ]) {
      const { status, body } = await get(path);
      expect([status, body.error.code], path).toEqual([400, 'bad-input']);
    }
    const { status } = await get('/v1/approvals?order=asc&cursor=2026-10-09T12:00:00.000Z');
    expect(status).toBe(400);
  });

  test('anything but asc or desc: 400 bad-input', async () => {
    const { status } = await harness(true)('/v1/approvals?order=oldest');
    expect(status).toBe(400);
  });
});
