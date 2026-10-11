// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/approvals`' next cursor continues after the last approval shown,
 * at its exact `createdAt` (the binding's `exactCreatedAt`: Postgres keeps
 * microseconds) and its id, so approvals created in the same millisecond on
 * either side of a page boundary are each listed once. A binding without
 * `exactCreatedAt` gets the bare-time cursor it took before, and a bare-time
 * cursor a client holds from before still answers. Also `GET /v1/runs`: a
 * cursor whose time is not a time is refused.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { TenantId, UserId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import type { ListApprovalsBindingResult } from '../src/hitl-binding.js';
import { createApp } from '../src/index.js';
import type { HitlBinding, RunHandlerBinding, TokenResolver } from '../src/index.js';
import { decodeCursor, encodeCursor } from '../src/routes/pagination.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'approvals-page-cursor';
const resolveToken: TokenResolver = async (token) =>
  token === TOKEN ? { tenantId, userId: 'user-1' as UserId, reviewerRole: 'admin' } : null;

function approval(createdAt: string) {
  return {
    id: randomUUID(),
    tenantId,
    subjectKind: 'acme.refund',
    subjectRef: {},
    requiredRole: 'standard',
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}
const first = approval('2026-10-09T12:00:00.123Z');
const second = approval('2026-10-09T12:00:00.123Z');

function harness(result: Partial<ListApprovalsBindingResult> = {}) {
  const seen: Record<string, unknown>[] = [];
  const stubs = createStubAppBindings();
  const hitlBinding = {
    listApprovals: async (input: Record<string, unknown>) => {
      seen.push(input);
      return { kind: 'ok', value: { approvals: [first, second], ...result } };
    },
  } as unknown as HitlBinding;
  const app = createApp({
    ...stubs,
    hitlBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    reviewerBinding: { resolveReviewer: async () => 'rev-1' } as never,
  });
  return async (path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: (await res.json()) as Record<string, any>, seen };
  };
}

describe("GET /v1/approvals' next cursor", () => {
  test('continues after the last approval shown, at its exact createdAt and id', async () => {
    const exact = {
      [first.id]: '2026-10-09 12:00:00.123456+00',
      [second.id]: '2026-10-09 12:00:00.1234+00',
    };
    const { status, body } = await harness({ exactCreatedAt: exact })('/v1/approvals?limit=1');
    expect(status).toBe(200);
    expect(body.data.map((a: { id: string }) => a.id)).toEqual([first.id]);
    expect(decodeCursor(body.nextCursor)).toEqual({
      createdAt: '2026-10-09 12:00:00.123456+00',
      id: first.id,
    });
    // The approval itself keeps its millisecond `createdAt`.
    expect(body.data[0].createdAt).toBe('2026-10-09T12:00:00.123Z');
  });

  test('from a binding without exactCreatedAt: the bare time, as before', async () => {
    const { body } = await harness()('/v1/approvals?limit=1');
    expect(body.nextCursor).toBe('2026-10-09T12:00:00.123Z');
  });

  test('a position cursor reaches the binding as `after`', async () => {
    const cursor = encodeCursor({ createdAt: '2026-10-09 12:00:00.123456+00', id: first.id });
    const { status, seen } = await harness()(`/v1/approvals?cursor=${cursor}`);
    expect(status).toBe(200);
    expect(seen[0]?.after).toEqual({ createdAt: '2026-10-09 12:00:00.123456+00', id: first.id });
    expect(seen[0]).not.toHaveProperty('cursor');
  });

  test('a bare-time cursor from before reaches the binding as `cursor`', async () => {
    const { status, seen } = await harness()('/v1/approvals?cursor=2026-10-09T12:00:00.123Z');
    expect(status).toBe(200);
    expect(seen[0]?.cursor).toBe('2026-10-09T12:00:00.123Z');
    expect(seen[0]).not.toHaveProperty('after');
  });

  test.each([
    ['not a cursor', 'not-a-cursor'],
    ['a position whose time is not a time', encodeCursor({ createdAt: 'nope', id: first.id })],
  ])('%s: 400 bad-input, the binding not called', async (_name, cursor) => {
    const { status, body, seen } = await harness()(`/v1/approvals?cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad-input');
    expect(seen).toEqual([]);
  });
});

describe("GET /v1/runs' cursor", () => {
  test('a cursor whose time is not a time: 400 bad-input', async () => {
    const stubs = createStubAppBindings();
    const app = createApp({ ...stubs, resolveToken, runHandler: {} as RunHandlerBinding });
    const cursor = encodeCursor({ createdAt: 'nope', id: randomUUID() });
    const res = await app.request(`/v1/runs?cursor=${cursor}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-input');
  });
});
