// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * `POST /v1/conversations/{id}/unregister` (T273 M-4): a tombstone, by the
 * binding; it answers the conversation with `unregisteredAt`. The route
 * loads the conversation first (unknown or unregistered already: 404, before
 * any check; authorization is in route-authz-conversations.test.ts). A
 * runtime whose binding can't unregister answers 501; a malformed id is 400.
 */

import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import type { Conversation, ConversationBinding } from '@kindgi/agents';
import type { TenantId } from '@kindgi/types';
import { createStubAppBindings } from '../src/testing/index.js';

import { createApp } from '../src/index.js';
import type { RunHandlerBinding, TokenResolver } from '../src/index.js';

const tenantId = randomUUID() as TenantId;
const TOKEN = 'conversations-unregister-token';
const resolveToken: TokenResolver = async (token) => (token === TOKEN ? { tenantId } : null);

function stored(id: string): Conversation {
  return {
    id,
    tenantId,
    agentId: 'acme.desk',
    agentVersion: '1.0.0',
    title: 'Refund',
    scope: { tenantId },
    openedAt: '2026-10-01T00:00:00.000Z',
    turnCount: 2,
  } as unknown as Conversation;
}

const notFound = (conversationId: string) =>
  ({
    kind: 'err',
    error: {
      code: 'conversation-not-found',
      message: `No conversation with id "${conversationId}"`,
    },
  }) as never;

function app(
  unregister?: ConversationBinding['unregisterConversation'],
  // Any id is found unless the test says otherwise.
  get: ConversationBinding['getConversation'] = async (_t, id) => ({
    kind: 'ok',
    value: stored(id as unknown as string),
  }),
) {
  const stubs = createStubAppBindings();
  const { unregisterConversation: _stubbed, ...rest } = stubs.conversationBinding;
  const conversationBinding = {
    ...rest,
    getConversation: get,
    ...(unregister !== undefined && { unregisterConversation: unregister }),
  } as ConversationBinding;
  return createApp({
    ...stubs,
    conversationBinding,
    resolveToken,
    runHandler: {} as RunHandlerBinding,
  });
}

async function unregister(built: ReturnType<typeof app>, id: string) {
  const res = await built.request(`/v1/conversations/${id}/unregister`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('unregistering a conversation', () => {
  test('the binding tombstones it; the answer has unregisteredAt', async () => {
    const id = randomUUID();
    const asked: string[] = [];
    const built = app(async (_t, conversationId) => {
      asked.push(conversationId as unknown as string);
      return {
        kind: 'ok',
        value: {
          id: conversationId,
          tenantId,
          agentId: 'acme.desk',
          agentVersion: '1.0.0',
          title: 'Refund',
          scope: { tenantId },
          openedAt: '2026-10-01T00:00:00.000Z',
          turnCount: 2,
          unregisteredAt: '2026-10-07T12:00:00.000Z',
        } as unknown as Conversation,
      };
    });
    const answer = await unregister(built, id);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ id, unregisteredAt: '2026-10-07T12:00:00.000Z' });
    expect(asked).toEqual([id]);
  });

  test('not found (or unregistered already): 404, and the binding never asked to unregister', async () => {
    const asked: string[] = [];
    const built = app(
      async (_t, conversationId) => {
        asked.push(conversationId as unknown as string);
        return notFound(conversationId as unknown as string);
      },
      async (_t, conversationId) => notFound(conversationId as unknown as string),
    );
    const answer = await unregister(built, randomUUID());
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe('conversation-not-found');
    expect(asked).toEqual([]);
  });

  test("a runtime that can't unregister: 501", async () => {
    const answer = await unregister(app(), randomUUID());
    expect(answer.status).toBe(501);
    expect(answer.body.error.code).toBe('conversation-unregister-unsupported');
  });

  test('a malformed id: 400, as the other conversation routes', async () => {
    const answer = await unregister(
      app(async () => ({ kind: 'err' }) as never),
      'not-a-uuid',
    );
    expect(answer.status).toBe(400);
  });
});
