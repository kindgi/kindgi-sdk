// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `GET /v1/conversations`' next cursor carries the binding's exact position
 * (`ConversationPage.next`: `openedAt` to the microsecond) when it gives
 * one, and the last row's otherwise (a binding from before `next`). A JS
 * `Date` keeps milliseconds, so a cursor built from the row's `openedAt`
 * alone skipped the conversations opened earlier in the same millisecond.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { ConversationBinding, ConversationId, ConversationPage } from '@kindgi/agents';
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

function harness(page: Omit<ConversationPage, 'data'>) {
  const seen: unknown[] = [];
  const stubs = createStubAppBindings();
  const conversationBinding = {
    ...stubs.conversationBinding,
    listConversationsPage: async (input: unknown) => {
      seen.push(input);
      return { kind: 'ok', value: { data: [conversation], ...page } };
    },
  } as unknown as ConversationBinding;
  const app = createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
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
