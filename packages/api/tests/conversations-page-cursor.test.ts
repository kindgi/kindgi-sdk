// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/conversations`' next cursor carries the binding's exact position
 * (`ConversationPage.next`: `openedAt` to the microsecond) when it gives
 * one, and the last row's otherwise (a binding from before `next`). A JS
 * `Date` keeps milliseconds, so a cursor built from the row's `openedAt`
 * alone skipped the conversations opened earlier in the same millisecond.
 *
 * From a binding that sorts by last activity (its page's `order`), the
 * cursor is the binding's position (`nextByActivity`) and says so, a page
 * with more but no position is the binding's fault (a 500), and a cursor
 * from the other sort (handed out before an upgrade, or after a downgrade)
 * is refused.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ConversationBinding, ConversationId, ConversationPage } from '@kindgi/agents';
import { type Logger, createLogger } from '@kindgi/log';
import type { TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';
import { decodeCursor, encodeCursor } from '../src/routes/pagination.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'conversations-page-cursor';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

const conversation = {
  id: randomUUID(),
  tenantId,
  agentId: 'acme.desk-agent',
  agentVersion: '1.0.0',
  title: 'Order A-100',
  scope: {},
  openedAt: '2026-10-09T12:00:00.123Z',
  turnCount: 0,
};

function harness(
  page: Omit<ConversationPage, 'data'>,
  row: Record<string, unknown> = conversation,
  logger?: Logger,
) {
  const seen: unknown[] = [];
  const stubs = createStubAppBindings();
  const conversationBinding = {
    ...stubs.conversationBinding,
    listConversationsPage: async (input: unknown) => {
      seen.push(input);
      return { kind: 'ok', value: { data: [row], ...page } };
    },
  } as unknown as ConversationBinding;
  const app = createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
    ...(logger !== undefined && { logger }),
  });
  return async (query = '') => {
    const res = await app.request(`/v1/conversations?limit=1${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    return { status: res.status, body: (await res.json()) as Record<string, any>, seen };
  };
}

describe("GET /v1/conversations' next cursor", () => {
  test("the binding's exact position (microseconds) when it gives one", async () => {
    const next = {
      openedAt: '2026-10-09T12:00:00.123456Z',
      id: conversation.id as ConversationId,
    };
    const { status, body } = await harness({ hasMore: true, next })();
    expect(status).toBe(200);
    expect(decodeCursor(body.nextCursor)).toEqual({ createdAt: next.openedAt, id: next.id });
    // The row itself keeps its millisecond `openedAt`.
    expect(body.data[0].openedAt).toBe('2026-10-09T12:00:00.123Z');
  });

  test("the last row's position from a binding without `next`", async () => {
    const { body } = await harness({ hasMore: true })();
    expect(decodeCursor(body.nextCursor)).toEqual({
      createdAt: conversation.openedAt,
      id: conversation.id,
    });
  });

  test('none on the last page', async () => {
    const { body } = await harness({ hasMore: false })();
    expect(body).not.toHaveProperty('nextCursor');
  });

  test('a cursor reaches the binding as given, microseconds and all', async () => {
    const cursor = encodeCursor({ createdAt: '2026-10-09T12:00:00.123456Z', id: conversation.id });
    const { status, seen } = await harness({ hasMore: false })(`&cursor=${cursor}`);
    expect(status).toBe(200);
    expect(seen[0]).toMatchObject({
      before: { openedAt: '2026-10-09T12:00:00.123456Z', id: conversation.id },
    });
  });

  test('a cursor whose time is not a time: 400 bad-input, the binding not called', async () => {
    const cursor = encodeCursor({ createdAt: 'not-a-time', id: conversation.id });
    const { status, body, seen } = await harness({ hasMore: false })(`&cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('bad-input');
    expect(seen).toEqual([]);
  });
});

describe('GET /v1/conversations sorted by last activity', () => {
  const active = { ...conversation, lastActivityAt: '2026-10-09T12:30:00.456Z' };
  const byActivity = { order: 'last-activity' } as const;

  test("each row's lastActivityAt, as the binding gives it", async () => {
    const { status, body } = await harness({ ...byActivity, hasMore: false }, active)();
    expect(status).toBe(200);
    expect(body.data[0].lastActivityAt).toBe('2026-10-09T12:30:00.456Z');
  });

  test('none from a binding that keeps none', async () => {
    const { body } = await harness({ hasMore: false })();
    expect(body.data[0]).not.toHaveProperty('lastActivityAt');
  });

  test("the cursor: the binding's exact position (microseconds), marked as this sort", async () => {
    const nextByActivity = {
      lastActivityAt: '2026-10-09 12:30:00.456789+00',
      id: conversation.id as ConversationId,
    };
    const { status, body } = await harness(
      { ...byActivity, hasMore: true, nextByActivity },
      active,
    )();
    expect(status).toBe(200);
    expect(decodeCursor(body.nextCursor)).toEqual({
      createdAt: nextByActivity.lastActivityAt,
      id: nextByActivity.id,
      order: 'last-activity',
    });
  });

  test('a page with more but no `nextByActivity`: 500, logged, no cursor from the row', async () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const { status, body } = await harness({ ...byActivity, hasMore: true }, active, logger)();
    expect(status).toBe(500);
    expect(body.error.code).toBe('internal-server-error');
    expect(body).not.toHaveProperty('nextCursor');
    const logged = lines
      .map((line) => JSON.parse(line) as { message?: string; requestId?: string })
      .find((r) => r.message === 'unhandled error' && r.requestId === body.error.requestId);
    expect(logged).toBeDefined();
    expect(lines.join('\n')).toContain('has more but no `nextByActivity`');
  });

  test('the last page needs no `nextByActivity`', async () => {
    const { status, body } = await harness({ ...byActivity, hasMore: false }, active)();
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('nextCursor');
  });

  test('a cursor of this sort reaches the binding as `beforeActivity`, as given', async () => {
    const cursor = encodeCursor({
      createdAt: '2026-10-09 12:30:00.456789+00',
      id: conversation.id,
      order: 'last-activity',
    });
    const { status, seen } = await harness(
      { ...byActivity, hasMore: false },
      active,
    )(`&cursor=${cursor}`);
    expect(status).toBe(200);
    expect(seen[0]).toMatchObject({
      beforeActivity: { lastActivityAt: '2026-10-09 12:30:00.456789+00', id: conversation.id },
    });
    expect(seen[0]).not.toHaveProperty('before');
  });

  test('a cursor from before the sort (by opening): 400, start again', async () => {
    const cursor = encodeCursor({ createdAt: '2026-10-09T12:00:00.123Z', id: conversation.id });
    const { status, body } = await harness(
      { ...byActivity, hasMore: true },
      active,
    )(`&cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'bad-input',
      message: '`cursor` is from before this list sorted by last activity: start again without it',
    });
  });

  test('a cursor of this sort, to a binding that sorts by opening: 400, start again', async () => {
    const cursor = encodeCursor({
      createdAt: '2026-10-09T12:30:00.456Z',
      id: conversation.id,
      order: 'last-activity',
    });
    const { status, body, seen } = await harness({ hasMore: true })(`&cursor=${cursor}`);
    expect(seen[0]).toMatchObject({ beforeActivity: { id: conversation.id } });
    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      code: 'bad-input',
      message:
        "`cursor` is from a list sorted by last activity, which this one isn't: start again without it",
    });
  });

  test('a cursor of a sort the list never had: 400 malformed, the binding not called', async () => {
    const cursor = encodeCursor({
      createdAt: '2026-10-09T12:30:00.456Z',
      id: conversation.id,
      order: 'title',
    });
    const { status, body, seen } = await harness(
      { ...byActivity, hasMore: false },
      active,
    )(`&cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: 'bad-input', message: '`cursor` is malformed' });
    expect(seen).toEqual([]);
  });
});
